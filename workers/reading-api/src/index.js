// reading-api: full Worker code (drop-in)
//
// REQUIRED BINDINGS (Dashboard → Workers → reading-api → Settings):
// - D1 database:           DB
// - R2 bucket:             PHOTOS
// - KV (optional cache):   AGG_KV          (optional; can omit, code checks existence)
// - Plaintext/Secret:      ADMIN_TOKEN     (e.g., "bagelbar")
// - (optional) AI binding: AI              (for future analysis features)
//
// Endpoints:
//   POST   /v1/uploads
//   POST   /v1/upload-file?key=...
//   GET    /v1/photo?key=...
//   POST   /v1/children/:id/entries
//   GET    /v1/children/:id/entries
//   GET    /v1/children/:id/daily-stats
//   DELETE /v1/entries/:id?admin=TOKEN
//   GET    /v1/leaderboard?month=YYYY-MM
//   GET    /dev/seed

function withCORS(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin');
  return new Response(res.body, { status: res.status, headers: h });
}

const json = (obj, status = 200) =>
  withCORS(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
const bad = (m, s = 400) => json({ error: m }, s);
const uid = () => crypto.randomUUID();

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === '/') return withCORS(new Response('Reading API up ✅'));
    if (path === '/health') return json({ ok: true });

    if (path === '/dev/seed' && method === 'GET') {
      if (!env.DB) return bad('D1 binding DB not configured', 500);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS child (
          id TEXT PRIMARY KEY,
          household_id TEXT, name TEXT NOT NULL, primary_unit TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS goal (
          id TEXT PRIMARY KEY,
          child_id TEXT NOT NULL, unit TEXT NOT NULL, target_value INTEGER NOT NULL,
          starts_on TEXT NOT NULL, ends_on TEXT, created_by TEXT, created_at INTEGER NOT NULL
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS reading_entry (
          id TEXT PRIMARY KEY,
          child_id TEXT NOT NULL,
          date TEXT NOT NULL,
          pages INTEGER NOT NULL DEFAULT 0,
          minutes INTEGER NOT NULL DEFAULT 0,
          book_title TEXT,
          book_author TEXT,
          notes TEXT,
          photo_key TEXT,
          status TEXT,
          created_by TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        )`)
      ]);

      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO child (id, household_id, name, primary_unit, created_at, updated_at)
                        VALUES ('child-1','home-1','Linda','pages',?,?)`).bind(now, now),
        env.DB.prepare(`INSERT OR IGNORE INTO child (id, household_id, name, primary_unit, created_at, updated_at)
                        VALUES ('child-2','home-1','Lara','pages',?,?)`).bind(now, now),
      ]);

      await env.DB.batch([
        env.DB.prepare(`INSERT OR REPLACE INTO goal (id, child_id, unit, target_value, starts_on, created_by, created_at)
                        VALUES ('goal-1','child-1','pages',20,'2025-10-25','parent',?)`).bind(now),
        env.DB.prepare(`INSERT OR REPLACE INTO goal (id, child_id, unit, target_value, starts_on, created_by, created_at)
                        VALUES ('goal-2','child-2','pages',15,'2025-10-25','parent',?)`).bind(now),
      ]);

      return json({ ok: true, seeded: ['child-1','child-2','goal-1','goal-2'] });
    }

    if (path === '/v1/uploads' && method === 'POST') {
      return json({ key: `photos/${uid()}` });
    }

    if (path === '/v1/upload-file' && method === 'POST') {
      if (!env.PHOTOS) return bad('R2 binding PHOTOS not configured', 500);
      const key = url.searchParams.get('key');
      if (!key) return bad('missing key');

      const ct = req.headers.get('content-type') || '';
      let buf, contentType;
      if (ct.startsWith('multipart/form-data')) {
        const form = await req.formData();
        const f = form.get('file');
        if (!f || typeof f === 'string') return bad('missing file');
        buf = await f.arrayBuffer();
        contentType = f.type || 'application/octet-stream';
      } else {
        buf = await req.arrayBuffer();
        if (!buf.byteLength) return bad('empty body');
        contentType = req.headers.get('content-type') || 'application/octet-stream';
      }

      await env.PHOTOS.put(key, buf, { httpMetadata: { contentType } });
      return json({ ok: true, key });
    }

    if (path === '/v1/photo' && method === 'GET') {
      if (!env.PHOTOS) return bad('R2 binding PHOTOS not configured', 500);
      const key = url.searchParams.get('key');
      if (!key) return bad('missing key');
      const obj = await env.PHOTOS.get(key);
      if (!obj) return withCORS(new Response('Not found', { status: 404 }));
      const h = new Headers();
      h.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
      h.set('cache-control', 'public, max-age=86400');
      return withCORS(new Response(obj.body, { status: 200, headers: h }));
    }

    {
      const m = path.match(/^\/v1\/children\/([^/]+)\/entries$/);
      if (m && method === 'POST') {
        if (!env.DB) return bad('D1 binding DB not configured', 500);
        const childId = m[1];
        const d = await req.json().catch(() => ({}));

        const date = (typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) ? d.date : null;
        const pages = Number.isInteger(d.pages) ? d.pages : 0;
        const minutes = Number.isInteger(d.minutes) ? d.minutes : 0;
        if (!date) return bad('date (YYYY-MM-DD) required');
        if (pages === 0 && minutes === 0) return bad('pages or minutes required');

        const now = Date.now();
        const entryId = uid();
        await env.DB.prepare(
          `INSERT INTO reading_entry
            (id, child_id, date, pages, minutes, book_title, book_author, notes, photo_key, status, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'ok','child',?,?)`
        ).bind(
          entryId, childId, date, pages, minutes,
          d.book_title ?? null, d.book_author ?? null, d.notes ?? null, d.photo_key ?? null,
          now, now
        ).run();

        if (env.AGG_KV) await env.AGG_KV.delete(`stats:${childId}:30d`);
        return json({ id: entryId });
      }
    }

    {
      const m = path.match(/^\/v1\/children\/([^/]+)\/entries$/);
      if (m && method === 'GET') {
        if (!env.DB) return bad('D1 binding DB not configured', 500);
        const childId = m[1];
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
        const rows = await env.DB.prepare(
          `SELECT re.id, re.child_id, re.date, re.pages, re.minutes, re.book_title, re.photo_key, re.notes, re.created_at,
                  c.name AS child_name
             FROM reading_entry re
             JOIN child c ON c.id = re.child_id
            WHERE re.child_id = ? AND re.deleted_at IS NULL
            ORDER BY re.created_at DESC
            LIMIT ?`
        ).bind(childId, limit).all();
        return json(rows.results || []);
      }
    }

    {
      const m = path.match(/^\/v1\/children\/([^/]+)\/daily-stats$/);
      if (m && method === 'GET') {
        if (!env.DB) return bad('D1 binding DB not configured', 500);
        const childId = m[1];
        const cacheKey = `stats:${childId}:30d`;

        if (env.AGG_KV) {
          const cached = await env.AGG_KV.get(cacheKey, 'json');
          if (cached) return json(cached);
        }

        const res = await env.DB.prepare(
          `WITH days AS (
             SELECT date FROM reading_entry
              WHERE child_id = ? AND deleted_at IS NULL
             GROUP BY date ORDER BY date DESC LIMIT 30
           )
           SELECT d.date,
                  COALESCE(SUM(re.pages),0)   AS pages,
                  COALESCE(SUM(re.minutes),0) AS minutes
             FROM days d
             LEFT JOIN reading_entry re
               ON re.child_id = ? AND re.date = d.date AND re.deleted_at IS NULL
            GROUP BY d.date
            ORDER BY d.date ASC`
        ).bind(childId, childId).all();

        const rows = res.results || [];
        const out = [];
        for (const r of rows) {
          const g = await env.DB.prepare(
            `SELECT unit, target_value
               FROM goal
              WHERE child_id = ? AND starts_on <= ? AND (ends_on IS NULL OR ? < ends_on)
              ORDER BY starts_on DESC LIMIT 1`
          ).bind(childId, r.date, r.date).first();
          const unit = g?.unit || null;
          const goal = g?.target_value ?? null;
          const met = unit === 'pages' ? (r.pages   >= (goal ?? Infinity))
                   : unit === 'minutes' ? (r.minutes >= (goal ?? Infinity))
                   : false;
          out.push({ date: r.date, pages: r.pages, minutes: r.minutes, unit, goal, met });
        }

        if (env.AGG_KV) await env.AGG_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 300 });
        return json(out);
      }
    }

    if (path === '/v1/leaderboard' && method === 'GET') {
      if (!env.DB) return bad('D1 binding DB not configured', 500);
      const month = url.searchParams.get('month') || new Date().toISOString().slice(0,7);
      if (!/^\d{4}-\d{2}$/.test(month)) return bad('month must be YYYY-MM');
      const start = month + '-01';
      const [Y,M] = month.split('-').map(Number);
      const next = (M===12) ? `${Y+1}-01-01` : `${Y}-${String(M+1).padStart(2,'0')}-01`;

      const rows = await env.DB.prepare(
        `SELECT c.id, c.name, COALESCE(SUM(re.pages),0) AS pages
           FROM child c
      LEFT JOIN reading_entry re
             ON re.child_id = c.id
            AND re.date >= ? AND re.date < ?
            AND re.deleted_at IS NULL
        GROUP BY c.id, c.name
        ORDER BY pages DESC, c.name ASC`
      ).bind(start, next).all();
      return json(rows.results || []);
    }

    {
      const m = path.match(/^\/v1\/entries\/([^/]+)$/);
      if (m && method === 'DELETE') {
        if (!env.DB) return bad('D1 binding DB not configured', 500);
        const tokenHeader = req.headers.get('x-admin') || '';
        const tokenQuery  = url.searchParams.get('admin') || '';
        const required    = env.ADMIN_TOKEN || '';
        if (!required || (tokenHeader !== required && tokenQuery !== required)) {
          return bad('forbidden', 403);
        }

        const entryId = m[1];
        const row = await env.DB.prepare(
          `SELECT child_id FROM reading_entry WHERE id = ? AND deleted_at IS NULL`
        ).bind(entryId).first();
        if (!row) return json({ ok: true, already_deleted: true });

        const now = Date.now();
        await env.DB.prepare(
          `UPDATE reading_entry SET deleted_at = ?, updated_at = ? WHERE id = ?`
        ).bind(now, now, entryId).run();

        if (env.AGG_KV) await env.AGG_KV.delete(`stats:${row.child_id}:30d`);
        return json({ ok: true });
      }
    }

    return withCORS(new Response('Not found', { status: 404 }));
  }
}
