// ai-homework Worker (robust migration with table rebuild fallback)
// Bindings required:
// - D1 database:  DB
// - R2 bucket:    PHOTOS
// - (optional) ADMIN_TOKEN for deletes
// - (optional) Workers AI binding: AI

function withCORS(res){
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin','*');
  h.set('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers','Content-Type, Authorization, X-Admin');
  return new Response(res.body,{status:res.status,headers:h});
}
const json = (o,s=200)=>withCORS(new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}}));
const bad  = (m,s=400)=>json({error:m},s);
const uid  = ()=>crypto.randomUUID();

async function tableInfo(DB, name){
  const r = await DB.prepare(`PRAGMA table_info(${name})`).all();
  return (r?.results||[]).map(c=>({name:c.name,type:c.type,notnull:c.notnull,pk:c.pk,default:c.dflt_value}));
}
async function hasColumn(DB, table, col){
  const cols = await tableInfo(DB, table).catch(()=>[]);
  return cols.some(c => c.name === col);
}

const REQUIRED_HW_COLS = [
  'id','child_id','date','title','notes','photo_key','created_at','updated_at','deleted_at'
];

async function ensureChildTable(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS child(
    id TEXT PRIMARY KEY,
    household_id TEXT,
    name TEXT NOT NULL,
    primary_unit TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

async function tryEnsureHomeworkTable(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS homework_entry ( id TEXT PRIMARY KEY )`).run();
  const adds = {
    child_id:  `ALTER TABLE homework_entry ADD COLUMN child_id TEXT`,
    date:      `ALTER TABLE homework_entry ADD COLUMN date TEXT`,
    title:     `ALTER TABLE homework_entry ADD COLUMN title TEXT`,
    notes:     `ALTER TABLE homework_entry ADD COLUMN notes TEXT`,
    photo_key: `ALTER TABLE homework_entry ADD COLUMN photo_key TEXT`,
    created_at:`ALTER TABLE homework_entry ADD COLUMN created_at INTEGER`,
    updated_at:`ALTER TABLE homework_entry ADD COLUMN updated_at INTEGER`,
    deleted_at:`ALTER TABLE homework_entry ADD COLUMN deleted_at INTEGER`,
  };
  for (const col of Object.keys(adds)) {
    try {
      const exists = await hasColumn(DB,'homework_entry',col);
      if (!exists) await DB.prepare(adds[col]).run();
    } catch {}
  }
}

async function rebuildHomeworkTableIfNeeded(DB){
  const cols = await tableInfo(DB,'homework_entry').catch(()=>[]);
  const names = new Set(cols.map(c=>c.name));
  const missing = REQUIRED_HW_COLS.filter(c => !names.has(c));
  if (missing.length === 0) return { rebuilt:false };

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS _new_homework_entry(
      id TEXT PRIMARY KEY,
      child_id TEXT,
      date TEXT,
      title TEXT,
      notes TEXT,
      photo_key TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER
    )`).run();

  const existing = REQUIRED_HW_COLS.filter(c => names.has(c) && c !== 'id');
  const oldCols = ['id', ...existing].join(', ');
  const newCols = ['id', ...existing].join(', ');

  try {
    await DB.prepare(`INSERT INTO _new_homework_entry (${newCols}) SELECT ${oldCols} FROM homework_entry`).run();
  } catch (e) {
    const rows = await DB.prepare(`SELECT * FROM homework_entry`).all().catch(()=>({results:[]}));
    for (const r of (rows.results||[])) {
      await DB.prepare(`
        INSERT OR IGNORE INTO _new_homework_entry
          (id, child_id, date, title, notes, photo_key, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        r.id || uid(),
        r.child_id ?? null,
        r.date ?? null,
        r.title ?? null,
        r.notes ?? null,
        r.photo_key ?? null,
        r.created_at ?? null,
        r.updated_at ?? null,
        r.deleted_at ?? null
      ).run();
    }
  }

  await DB.prepare(`DROP TABLE homework_entry`).run();
  await DB.prepare(`ALTER TABLE _new_homework_entry RENAME TO homework_entry`).run();

  return { rebuilt:true, missing };
}

async function ensureHomeworkSchema(DB){
  await tryEnsureHomeworkTable(DB);
  const cols = await tableInfo(DB,'homework_entry').catch(()=>[]);
  const names = new Set(cols.map(c=>c.name));
  const stillMissing = REQUIRED_HW_COLS.filter(c => !names.has(c));

  if (stillMissing.length) {
    const r = await rebuildHomeworkTableIfNeeded(DB);
    return { ensured:true, rebuilt:r.rebuilt, stillMissing: r.missing || stillMissing };
  }
  return { ensured:true, rebuilt:false, stillMissing: [] };
}

export default {
  async fetch(req, env) {
    try {
      if (req.method === 'OPTIONS') return withCORS(new Response(null,{status:204}));
      const url = new URL(req.url);
      const { pathname: path, searchParams } = url;
      const method = req.method;

      if (path==='/' || path==='/health') return json({ok:true});
      if (path==='/debug/env' && method==='GET') {
        return json({has_DB:!!env.DB,has_PHOTOS:!!env.PHOTOS,has_ADMIN_TOKEN:!!env.ADMIN_TOKEN});
      }
      if (path==='/debug/schema' && method==='GET') {
        if (!env.DB) return bad('D1 binding DB not configured',500);
        const childCols = await tableInfo(env.DB,'child').catch(()=>[]);
        const hwCols    = await tableInfo(env.DB,'homework_entry').catch(()=>[]);
        return json({child: childCols.map(c=>c.name), homework_entry: hwCols.map(c=>c.name)});
      }

      if (path==='/dev/seed' && method==='GET') {
        if (!env.DB) return bad('D1 binding DB not configured',500);
        await ensureChildTable(env.DB);
        const now = Date.now();
        await env.DB.prepare(`INSERT OR IGNORE INTO child(id,household_id,name,primary_unit,created_at,updated_at)
                              VALUES ('child-1','home-1','Linda','pages',?,?)`).bind(now,now).run();
        await env.DB.prepare(`INSERT OR IGNORE INTO child(id,household_id,name,primary_unit,created_at,updated_at)
                              VALUES ('child-2','home-1','Lara','pages',?,?)`).bind(now,now).run();
        return json({ok:true,seeded:['child-1','child-2']});
      }

      if (path==='/dev/migrate' && (method==='POST'||method==='GET')) {
        if (!env.DB) return bad('D1 binding DB not configured',500);
        await ensureChildTable(env.DB);
        const result = await ensureHomeworkSchema(env.DB);
        const hwCols = await tableInfo(env.DB,'homework_entry').catch(()=>[]);
        return json({ok:true, ...result, homework_entry_columns: hwCols.map(c=>c.name)});
      }

      if (path==='/v1/uploads' && method==='POST') {
        if (!env.PHOTOS) return bad('R2 binding PHOTOS not configured',500);
        return json({key:`photos/${uid()}`});
      }

      if (path==='/v1/upload-file' && method==='POST') {
        if (!env.PHOTOS) return bad('R2 binding PHOTOS not configured',500);
        const key = searchParams.get('key'); if (!key) return bad('missing key');
        const ct  = req.headers.get('content-type') || '';
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
        return json({ok:true,key});
      }

      if (path==='/v1/photo' && method==='GET') {
        if (!env.PHOTOS) return bad('R2 binding PHOTOS not configured',500);
        const key = searchParams.get('key'); if (!key) return bad('missing key');
        const obj = await env.PHOTOS.get(key);
        if (!obj) return withCORS(new Response('Not found',{status:404}));
        const h = new Headers();
        h.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
        h.set('cache-control','public, max-age=86400');
        return withCORS(new Response(obj.body,{status:200,headers:h}));
      }

      if (path==='/v1/homework/submit' && method==='POST') {
        if (!env.DB) return bad('D1 binding DB not configured',500);
        await ensureChildTable(env.DB);
        const mig = await ensureHomeworkSchema(env.DB);
        if (mig.stillMissing && mig.stillMissing.length) {
          return bad('schema not ready: missing '+mig.stillMissing.join(','), 500);
        }

        const d = await req.json().catch(()=>({}));
        const childId = String(d.child_id||'').trim();
        const date = (typeof d.date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) ? d.date : null;
        if (!childId) return bad('child_id required');
        if (!date) return bad('date (YYYY-MM-DD) required');
        if (!d.title && !d.notes && !d.photo_key) return bad('provide at least one of: title, notes, photo_key');

        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO homework_entry
            (id, child_id, date, title, notes, photo_key, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
        `).bind(uid(), childId, date, d.title??null, d.notes??null, d.photo_key??null, now, now).run();

        return json({ok:true});
      }

      if (path === '/v1/homework/analyze' && method === 'POST') {
        if (!env.AI) return bad('Workers AI binding missing', 500);
        const body = await req.json().catch(()=>({}));
        const { notes, photo_key, child_name } = body;
        if (!photo_key) return bad('photo_key required');

        const encouragement = await env.AI.run("@cf/mistral/mistral-7b-instruct", {
          prompt: `You are a kind teacher. A child named ${child_name || 'the student'} just submitted homework.
The child wrote: "${notes}". Write a short, warm, positive message praising their effort and suggesting one improvement.`
        });

        return json({
          ok: true,
          feedback: encouragement?.response || "Great job!"
        });
      }

      if (path==='/v1/homework/list' && method==='GET') {
        if (!env.DB) return bad('D1 binding DB not configured',500);
        await ensureChildTable(env.DB);
        const mig = await ensureHomeworkSchema(env.DB);
        if (mig.stillMissing && mig.stillMissing.length) {
          return bad('schema not ready: missing '+mig.stillMissing.join(','), 500);
        }

        const limit = Math.min(parseInt(searchParams.get('limit')||'100',10), 200);
        const r = await env.DB.prepare(`
          SELECT he.id, he.child_id, he.date, he.title, he.notes, he.photo_key, he.created_at,
                 c.name AS child_name
            FROM homework_entry he
            LEFT JOIN child c ON c.id = he.child_id
           WHERE he.deleted_at IS NULL
           ORDER BY he.created_at DESC
           LIMIT ?
        `).bind(limit).all();
        return json(r.results || []);
      }

      {
        const m = path.match(/^\/v1\/homework\/([^/]+)$/);
        if (m && method==='DELETE') {
          if (!env.DB) return bad('D1 binding DB not configured',500);
          const tok = req.headers.get('x-admin')||'';
          const q   = searchParams.get('admin')||'';
          const need= env.ADMIN_TOKEN || '';
          if (!need || (tok!==need && q!==need)) return bad('forbidden',403);
          const id = m[1];
          const now= Date.now();
          await env.DB.prepare(`UPDATE homework_entry SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`).bind(now,now,id).run();
          return json({ok:true});
        }
      }

      return withCORS(new Response('Not found',{status:404}));
    } catch (e) {
      return json({error:'unhandled',message:e?.message||String(e),stack:(e?.stack||'').split('\n').slice(0,5).join(' | ')},500);
    }
  }
}
