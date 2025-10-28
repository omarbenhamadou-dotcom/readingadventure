/* Shared helpers */
const C = window.APP_CONFIG;

function $(sel,root=document){ return root.querySelector(sel) }
function $all(sel,root=document){ return Array.from(root.querySelectorAll(sel)) }

function fmtDateYMD(d=new Date()){
  const yyyy = d.getFullYear(); const mm = String(d.getMonth()+1).padStart(2,'0'); const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}
function fmtHuman(ts){
  // ts may be ms or string date (YYYY-MM-DD). Try both.
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts)) {
    const [Y,M,D] = ts.split('-').map(Number);
    const d = new Date(Date.UTC(Y, M-1, D));
    return d.toLocaleDateString(undefined,{weekday:'short',year:'numeric',month:'short',day:'numeric'});
  }
  const n = Number(ts);
  const d = isNaN(n) ? new Date(ts) : new Date(n);
  return d.toLocaleDateString(undefined,{weekday:'short',year:'numeric',month:'short',day:'numeric'});
}

async function apiGET(base, path){
  const r = await fetch(base + path, { method:'GET' });
  if (!r.ok) throw new Error(await r.text());
  const ct = r.headers.get('content-type')||'';
  return ct.includes('application/json') ? r.json() : r.text();
}

async function apiPOSTjson(base, path, obj){
  const r = await fetch(base + path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiPOSTform(base, path, formData){
  const r = await fetch(base + path, { method:'POST', body: formData });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// R2 upload 2-step
async function uploadWithHandshake(base, file){
  let key = null;
  // 1) ask for key
  try{
    const res = await apiPOSTjson(base, "/v1/uploads", {});
    key = res.key;
  }catch(e){
    throw new Error("Upload handshake failed: " + e.message);
  }
  // 2) send multipart
  const fd = new FormData();
  fd.append('file', file, file.name || 'photo.jpg');
  try{
    await apiPOSTform(base, `/v1/upload-file?key=${encodeURIComponent(key)}`, fd);
  }catch(e){
    throw new Error("Upload file failed: " + e.message);
  }
  return key;
}

// Merge and sort entries by created_at desc
function mergeEntries(arrays){
  const merged = arrays.flat();
  merged.sort((a,b)=> (b.created_at||0) - (a.created_at||0));
  return merged;
}
