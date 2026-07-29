/* =========================================================
   CODEA — Customer Manager (PWA)
   All data is stored in localStorage AND optionally synced to
   a REST endpoint (Settings → Database URL).
   ========================================================= */

const STORE_KEY = 'codea_customers';
const AUTH_KEY  = 'codea_auth';
const CFG_KEY   = 'codea_config';

// ---------- CONFIG ----------
const defaultCfg = {
  dbUrl: 'https://codea-b9d61-default-rtdb.firebaseio.com/',
  storageBucket: 'codea-b9d61.firebasestorage.app',  // Firebase Storage bucket
  currency: '$',
  user: 'admin',
  pass: 'codea123'
};
const MAX_PHOTOS = 10;
const MAX_FILES  = 5;
function getCfg(){ return { ...defaultCfg, ...(JSON.parse(localStorage.getItem(CFG_KEY)||'{}')) }; }
function setCfg(c){ localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

// ---------- DATA STORAGE ----------
function loadCustomers(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
  catch { return []; }
}
function saveCustomers(list){
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
  syncToRemote(list); // fire-and-forget
}

// ---------- REMOTE SYNC (Firebase Realtime DB + generic REST) ----------
// Detects Firebase URLs and auto-appends /codea.json path.
function buildRemoteUrl(base){
  if (!base) return null;
  let url = base.trim().replace(/\/+$/, ''); // strip trailing slash
  // Firebase Realtime Database needs .json for REST access
  if (/firebaseio\.com$|firebasedatabase\.app$/.test(url.split('/')[2] || '')) {
    // If no path segment beyond host, add /codea.json
    const path = url.split('/').slice(3).join('/');
    if (!path) url += '/codea.json';
    else if (!path.endsWith('.json')) url += '.json';
  }
  return url;
}

let _syncStatus = 'idle'; // idle | syncing | error | ok
function setSyncStatus(s){
  _syncStatus = s;
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const labels = { idle:'', syncing:'• Syncing…', ok:'• Synced', error:'• Sync error — tap' };
  const colors = { idle:'#6b7896', syncing:'#4f8bff', ok:'#22d3a5', error:'#ff5c7a' };
  el.textContent = labels[s] || '';
  el.style.color = colors[s] || '#6b7896';
  el.style.cursor = s === 'error' ? 'pointer' : 'default';
  el.onclick = s === 'error' ? () => {
    const msg = _lastSyncError || 'Unknown error';
    alert('Sync error:\n\n' + msg + '\n\nCheck: 1) Internet, 2) Firebase URL in Settings, 3) Firebase Rules allow write.');
  } : null;
}

// Strip transient/heavy fields before syncing. Firebase Realtime DB has a 32MB write limit
// and base64-encoded photos in _local can easily exceed that.
function sanitizeForSync(list){
  return (list||[]).map(c => {
    const clean = { ...c };
    // Strip transient photo fields (_local base64 preview, _uploading flag)
    if (Array.isArray(clean.photos)){
      clean.photos = clean.photos.map(p => {
        const { _local, _uploading, ...rest } = p || {};
        // If url is a huge data: URL, drop it — Firebase Storage should have a real url
        if (rest.url && rest.url.startsWith('data:') && rest.url.length > 100000){
          rest.url = ''; // don't sync massive base64 blobs
        }
        return rest;
      });
    }
    if (Array.isArray(clean.files)){
      clean.files = clean.files.map(f => {
        const { _local, _uploading, ...rest } = f || {};
        return rest;
      });
    }
    // Strip legacy heavy photo field
    if (clean.photo && clean.photo.startsWith('data:') && clean.photo.length > 100000){
      clean.photo = '';
    }
    return clean;
  });
}

let _syncTimer = null;
let _lastSyncError = '';
async function syncToRemote(list){
  const cfg = getCfg();
  const url = buildRemoteUrl(cfg.dbUrl);
  if (!url) return;

  // Debounce: if many saves happen in a row (e.g. after each photo upload),
  // batch them into one write 400ms later.
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    setSyncStatus('syncing');
    try {
      const cleaned = sanitizeForSync(list);
      const payload = { customers: cleaned, updatedAt: new Date().toISOString() };
      const body = JSON.stringify(payload);
      const sizeMB = (body.length / 1024 / 1024).toFixed(2);
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      if (!r.ok) {
        const txt = await r.text().catch(()=>'');
        _lastSyncError = `HTTP ${r.status} (payload ${sizeMB}MB) ${txt.slice(0,120)}`;
        throw new Error(_lastSyncError);
      }
      _lastSyncError = '';
      setSyncStatus('ok');
      setTimeout(()=>{ if (_syncStatus==='ok') setSyncStatus('idle'); }, 2000);
    } catch(e){
      console.error('🔴 Sync failed:', e.message);
      _lastSyncError = e.message;
      setSyncStatus('error');
    }
  }, 400);
}
window.getLastSyncError = () => _lastSyncError;

async function fetchFromRemote(){
  const cfg = getCfg();
  const url = buildRemoteUrl(cfg.dbUrl);
  if (!url) return { ok:false, reason:'no-url' };
  setSyncStatus('syncing');
  try {
    // Never allow browser/service-worker HTTP cache for live Firebase data.
    const r = await fetch(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const j = await r.json();
    setSyncStatus('ok');
    setTimeout(()=>{ if (_syncStatus==='ok') setSyncStatus('idle'); }, 2000);

    // Case 1: proper object { customers: [...], updatedAt: ... }
    if (j && typeof j === 'object' && !Array.isArray(j)){
      // Firebase omits empty/missing arrays entirely. Only wipe local data if
      // the remote payload EXPLICITLY declares customers (as array).
      if (Array.isArray(j.customers)) return { ok:true, data:j.customers };
      // Remote has updatedAt but no customers -> treat as "nothing new", keep local
      return { ok:true, data:null, keepLocal:true };
    }
    // Case 2: bare array at the root
    if (Array.isArray(j)) return { ok:true, data:j };
    // Case 3: completely empty node
    if (j === null) return { ok:true, data:[] };
    return { ok:false, reason:'unknown-shape' };
  } catch(e){
    console.warn('Remote fetch failed', e);
    _lastSyncError = e.message;
    setSyncStatus('error');
    return { ok:false, reason:e.message };
  }
}

// ---------- FIREBASE STORAGE ----------
// Upload a file to Firebase Storage via REST (no SDK needed).
// Returns { url, path, name, size, type } or throws.
async function uploadToStorage(file, folder /* 'photos' | 'files' */, customerId){
  const cfg = getCfg();
  const bucket = (cfg.storageBucket || '').trim();
  if (!bucket) throw new Error('Storage bucket not configured');

  // Safe filename
  const safeName = String(file.name || 'upload').replace(/[^\w.\-]/g, '_');
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const path = `codea/${customerId}/${folder}/${stamp}_${safeName}`;
  const encPath = encodeURIComponent(path);

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?uploadType=media&name=${encPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  if (!res.ok){
    const txt = await res.text().catch(()=>'');
    throw new Error('Upload failed: HTTP '+res.status+' '+txt);
  }
  const meta = await res.json();
  // Public download URL
  const token = meta.downloadTokens ? meta.downloadTokens.split(',')[0] : '';
  const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(meta.name)}?alt=media${token?'&token='+token:''}`;
  return {
    url: downloadUrl,
    path: meta.name,
    name: file.name,
    size: file.size,
    type: file.type,
    uploadedAt: new Date().toISOString()
  };
}

// Delete a file from Firebase Storage
async function deleteFromStorage(path){
  const cfg = getCfg();
  const bucket = (cfg.storageBucket || '').trim();
  if (!bucket || !path) return;
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}`;
  try {
    await fetch(url, { method: 'DELETE' });
  } catch(e){ console.warn('Storage delete failed', e); }
}

// Test storage by doing a real round-trip: upload a tiny probe file, then delete it.
async function testStorage(){
  const cfg = getCfg();
  const bucket = (cfg.storageBucket || '').trim();
  if (!bucket) return { ok:false, msg:'No bucket set' };
  const probeName = `codea/_probe_${Date.now()}.txt`;
  const encName = encodeURIComponent(probeName);
  const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?uploadType=media&name=${encName}`;
  const deleteUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encName}`;
  try {
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: new Blob(['ok'], { type: 'text/plain' })
    });
    if (!r.ok){
      const txt = await r.text().catch(()=>'');
      if (r.status === 404) return { ok:false, msg:'❌ Bucket not found — check name' };
      if (r.status === 403) return { ok:false, msg:'❌ Permission denied — update Storage Rules' };
      return { ok:false, msg:`❌ HTTP ${r.status} ${txt.slice(0,80)}` };
    }
    // Cleanup probe file
    fetch(deleteUrl, { method:'DELETE' }).catch(()=>{});
    return { ok:true, msg:'✅ Read/write working' };
  } catch(e){
    return { ok:false, msg:'❌ '+e.message };
  }
}

function humanSize(bytes){
  if (!bytes) return '0 B';
  const k = 1024, units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(bytes)/Math.log(k)), units.length-1);
  return (bytes/Math.pow(k,i)).toFixed(i?1:0) + ' ' + units[i];
}
function fileIcon(type){
  if (!type) return '📄';
  if (type.startsWith('image/')) return '🖼️';
  if (type === 'application/pdf') return '📕';
  if (type.includes('word')) return '📘';
  if (type.includes('sheet') || type.includes('excel')) return '📗';
  if (type.includes('zip') || type.includes('rar')) return '🗃️';
  return '📄';
}

// Force a full sync push right now (bypasses debounce)
window.forceSyncNow = async function(){
  const cfg = getCfg();
  const url = buildRemoteUrl(cfg.dbUrl);
  if (!url){ alert('No database URL set in Settings.'); return; }
  const list = loadCustomers();
  setSyncStatus('syncing');
  try {
    const cleaned = sanitizeForSync(list);
    const payload = { customers: cleaned, updatedAt: new Date().toISOString() };
    const body = JSON.stringify(payload);
    const sizeMB = (body.length / 1024 / 1024).toFixed(2);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!r.ok){
      const txt = await r.text().catch(()=>'');
      _lastSyncError = `HTTP ${r.status} (${sizeMB}MB) ${txt.slice(0,120)}`;
      setSyncStatus('error');
      alert('Sync failed:\n\n' + _lastSyncError);
      return false;
    }
    _lastSyncError = '';
    setSyncStatus('ok');
    alert(`✅ Synced ${list.length} customer(s) to Firebase (${sizeMB} MB uploaded).`);
    return true;
  } catch(e){
    _lastSyncError = e.message;
    setSyncStatus('error');
    alert('Sync failed:\n\n' + e.message);
    return false;
  }
};

// Force pull from remote (overwrites local if remote has data)
window.forcePullNow = async function(){
  const remote = await fetchFromRemote();
  if (!remote || !remote.ok){
    alert('Pull failed: ' + (remote?.reason || 'unknown'));
    return;
  }
  if (Array.isArray(remote.data)){
    localStorage.setItem(STORE_KEY, JSON.stringify(remote.data));
    alert(`✅ Pulled ${remote.data.length} customer(s) from Firebase.`);
    navigate('dashboard');
  } else {
    alert('⚠️ Firebase has no customers to pull. Your local data was not changed.');
  }
};

// Test connection button helper
async function testConnection(){
  const cfg = getCfg();
  const url = buildRemoteUrl(cfg.dbUrl);
  if (!url) return { ok:false, msg:'No URL set' };
  try {
    const r = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) return { ok:false, msg:'HTTP '+r.status+' — check permissions' };
    const j = await r.json();
    const count = (j && j.customers) ? j.customers.length : 0;
    return { ok:true, msg:'✅ Connected! '+count+' customer(s) in remote DB.' };
  } catch(e){
    return { ok:false, msg:'❌ Connection failed: '+e.message };
  }
}
window.testConnection = testConnection;

// ---------- AUTH ----------
function isLoggedIn(){ return sessionStorage.getItem(AUTH_KEY) === '1'; }
function setLoggedIn(v){ sessionStorage.setItem(AUTH_KEY, v ? '1' : '0'); }

function showLogin(){
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('app').style.display='none';
}
function showApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='block';
  navigate('dashboard');
}

document.getElementById('loginForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const cfg = getCfg();
  if (u === cfg.user && p === cfg.pass){
    setLoggedIn(true);
    // Pull latest from remote. IMPORTANT: only overwrite local if remote actually has data,
    // otherwise we'd nuke any customers the user added offline.
    const local = loadCustomers();
    const remote = await fetchFromRemote();
    if (remote && remote.ok && Array.isArray(remote.data)){
      // Merge: prefer whichever side has more recent data per customer id
      const merged = mergeCustomerLists(local, remote.data);
      localStorage.setItem(STORE_KEY, JSON.stringify(merged));
    }
    // If remote returned no customers but we HAVE local ones, push them up.
    showApp();
    setTimeout(() => {
      const cur = loadCustomers();
      if (cur.length > 0) syncToRemote(cur);
    }, 600);
  } else {
    alert('Wrong username or password');
  }
});

// Merge two customer arrays by id, keeping the version with newer updatedAt.
function mergeCustomerLists(a, b){
  const map = new Map();
  (a||[]).forEach(c => { if (c && c.id) map.set(c.id, c); });
  (b||[]).forEach(c => {
    if (!c || !c.id) return;
    const existing = map.get(c.id);
    if (!existing){ map.set(c.id, c); return; }
    const eu = existing.updatedAt || existing.createdAt || '';
    const nu = c.updatedAt || c.createdAt || '';
    if (nu > eu) map.set(c.id, c);
  });
  return Array.from(map.values());
}

document.getElementById('logoutBtn').addEventListener('click', ()=>{
  setLoggedIn(false);
  showLogin();
});

// ---------- NAVIGATION ----------
const views = ['dashboard','customers','form','detail','settings'];
function navigate(v, ctx){
  views.forEach(x=>{
    const el = document.getElementById(x+'View');
    if (el) el.style.display = (x===v?'block':'none');
  });
  document.querySelectorAll('.bottom-nav button').forEach(b=>{
    b.classList.toggle('active', b.dataset.view===v);
  });
  const titles = { dashboard:'Dashboard', customers:'Customers', form: ctx?.id?'Edit Customer':'Add Customer', detail:'Customer', settings:'Settings' };
  document.getElementById('pageTitle').textContent = titles[v] || 'Codea';

  if (v==='dashboard') renderDashboard();
  if (v==='customers') renderCustomers();
  if (v==='form') openForm(ctx?.id);
  if (v==='detail') renderDetail(ctx?.id);
  if (v==='settings') openSettings();
}

document.querySelectorAll('.bottom-nav button').forEach(b=>{
  b.addEventListener('click', ()=> navigate(b.dataset.view));
});
document.getElementById('fab').addEventListener('click', ()=> navigate('form'));

// ---------- HELPERS ----------
function fmt(n){ const c=getCfg().currency; const v=Number(n||0); return `${c}${v.toFixed(2)}`; }
function computeStatus(total,received){
  const t=Number(total||0), r=Number(received||0);
  if (r <= 0) return 'unpaid';
  if (r >= t) return 'paid';
  return 'partial';
}
function uid(){ return 'c_'+Date.now()+'_'+Math.random().toString(36).slice(2,7); }
function today(){ return new Date().toISOString().slice(0,10); }
function paymentTotal(payments){
  return (payments||[]).reduce((sum,p)=> sum + Number(p.amount||0), 0);
}
function sortPayments(payments){
  return [...(payments||[])].sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')) || String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
}
function lastPaymentDate(record){
  const arr = sortPayments(record?.payments||[]);
  return arr.length ? (arr[arr.length-1].date || today()) : (record?.date || '-');
}

// ---------- PROFIT HELPERS (photos + files) ----------
function customerProfit(c){
  const photos = c.photos || [];
  const files  = c.files  || [];
  const photoProfit = photos.reduce((s,p)=> s + (Number(p.price||0) - Number(p.cost||0)), 0);
  const fileProfit  = files .reduce((s,f)=> s + (Number(f.price||0) - Number(f.cost||0)), 0);
  return photoProfit + fileProfit;
}
function customerItemsCount(c){
  const photos = (c.photos || []).filter(p => Number(p.price||0) > 0 || Number(p.cost||0) > 0).length;
  const files  = (c.files  || []).filter(f => Number(f.price||0) > 0 || Number(f.cost||0) > 0).length;
  return photos + files;
}
function customerRetail(c){
  const p = (c.photos || []).reduce((s,p) => s + Number(p.price||0), 0);
  const f = (c.files  || []).reduce((s,f) => s + Number(f.price||0), 0);
  return p + f;
}
function customerCost(c){
  const p = (c.photos || []).reduce((s,p) => s + Number(p.cost||0), 0);
  const f = (c.files  || []).reduce((s,f) => s + Number(f.cost||0), 0);
  return p + f;
}
function saleDate(c){
  // Use createdAt for profit-by-day grouping (per user choice)
  return (c.createdAt || c.updatedAt || '').slice(0,10) || today();
}

// ---------- DASHBOARD ----------
function renderDashboard(){
  const list = loadCustomers();
  let received=0, total=0;
  list.forEach(c=>{ received+=Number(c.received||0); total+=Number(c.total||0); });
  document.getElementById('statCustomers').textContent = list.length;
  document.getElementById('statReceived').textContent  = fmt(received);
  document.getElementById('statOwed').textContent      = fmt(Math.max(0,total-received));
  document.getElementById('statTotal').textContent     = fmt(total);

  // Profit metrics
  const todayStr = today();
  let profitToday = 0, itemsToday = 0;
  let profitTotal = 0, retailTotal = 0, itemsTotal = 0;
  list.forEach(c => {
    const p = customerProfit(c);
    const n = customerItemsCount(c);
    profitTotal += p;
    retailTotal += customerRetail(c);
    itemsTotal  += n;
    if (saleDate(c) === todayStr){
      profitToday += p;
      itemsToday  += n;
    }
  });
  const avgMargin = retailTotal > 0 ? (profitTotal / retailTotal * 100) : 0;
  document.getElementById('statProfitToday').textContent = fmt(profitToday);
  document.getElementById('statProfitTodaySub').textContent = `${itemsToday} item${itemsToday===1?'':'s'} sold today`;
  document.getElementById('statProfitTotal').textContent = fmt(profitTotal);
  document.getElementById('statProfitTotalSub').textContent = `${avgMargin.toFixed(1)}% avg margin • ${itemsTotal} items`;

  // Recent customers
  const recent = [...list].sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,5);
  const el = document.getElementById('recentList');
  if (recent.length===0){
    el.innerHTML = `<div class="empty">No customers yet. Tap ➕ to add one.</div>`;
  } else {
    el.innerHTML = recent.map(cardHTML).join('');
    attachCardClicks(el);
  }

  // Top-selling items
  renderTopItems(list);

  // Profit chart
  renderProfitChart(list);
}

function renderTopItems(list){
  const el = document.getElementById('topItemsList');
  if (!el) return;
  const items = [];
  list.forEach(c => {
    (c.photos || []).forEach(p => {
      const price = Number(p.price || 0);
      if (price > 0){
        items.push({
          name: p.name || 'Item',
          url:  p.url || p._local || '',
          icon: '',
          cost: Number(p.cost||0),
          price,
          profit: price - Number(p.cost||0),
          customer: c.name || '(no name)',
          customerId: c.id
        });
      }
    });
    (c.files || []).forEach(f => {
      const price = Number(f.price || 0);
      if (price > 0){
        items.push({
          name: f.name || 'File',
          url:  '',
          icon: fileIcon(f.type),
          cost: Number(f.cost||0),
          price,
          profit: price - Number(f.cost||0),
          customer: c.name || '(no name)',
          customerId: c.id
        });
      }
    });
  });
  items.sort((a,b)=> b.profit - a.profit);
  const top = items.slice(0, 5);
  if (top.length === 0){
    el.innerHTML = `<div class="empty">Add items with cost &amp; price to see your top earners.</div>`;
    return;
  }
  el.innerHTML = top.map(it => {
    const margin = it.price > 0 ? (it.profit / it.price * 100) : 0;
    const thumb = it.url
      ? `<img class="card-photo" src="${it.url}" alt="">`
      : (it.icon ? `<div class="card-photo" style="display:flex;align-items:center;justify-content:center;font-size:24px">${it.icon}</div>` : `<div class="card-photo"></div>`);
    return `
      <div class="card top-item-card" onclick="navigate('detail',{id:'${it.customerId}'})">
        ${thumb}
        <div class="card-body">
          <div class="card-name">${escapeHTML(it.name)}</div>
          <div class="card-sub">${escapeHTML(it.customer)} • ${margin.toFixed(0)}% margin</div>
        </div>
        <div class="card-right">
          <div class="card-amount" style="color:var(--success)">+${fmt(it.profit)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">${fmt(it.price)}</div>
        </div>
      </div>`;
  }).join('');
}

function renderProfitChart(list){
  const canvas = document.getElementById('profitChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  // High-DPI
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = 180;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + 'px';
  ctx.scale(dpr, dpr);

  // Build 14-day buckets
  const days = 14;
  const buckets = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--){
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    buckets.push({ date: d.toISOString().slice(0,10), profit: 0 });
  }
  const idx = Object.fromEntries(buckets.map((b, i) => [b.date, i]));
  list.forEach(c => {
    const d = saleDate(c);
    if (d in idx) buckets[idx[d]].profit += customerProfit(c);
  });

  const W = cssW, H = cssH;
  const padL = 40, padR = 12, padT = 14, padB = 24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const maxVal = Math.max(1, ...buckets.map(b => b.profit));

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++){
    const y = padT + (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
  }
  // Y labels
  ctx.fillStyle = '#6b7896';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++){
    const v = maxVal - (maxVal / 4) * i;
    const y = padT + (chartH / 4) * i;
    ctx.fillText(fmt(v), padL - 6, y);
  }

  // Gradient fill under line
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, 'rgba(79, 139, 255, 0.35)');
  grad.addColorStop(1, 'rgba(79, 139, 255, 0.02)');

  const stepX = chartW / (buckets.length - 1);
  const points = buckets.map((b, i) => ({
    x: padL + stepX * i,
    y: padT + chartH - (b.profit / maxVal) * chartH
  }));

  // Area
  ctx.beginPath();
  ctx.moveTo(points[0].x, padT + chartH);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length-1].x, padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = '#4f8bff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Points
  points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = buckets[i].profit > 0 ? '#22d3a5' : '#4f8bff';
    ctx.fill();
  });

  // X labels (every other day)
  ctx.fillStyle = '#6b7896';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  buckets.forEach((b, i) => {
    if (i % 2 !== 0 && i !== buckets.length - 1) return;
    const label = b.date.slice(5); // MM-DD
    ctx.fillText(label, points[i].x, padT + chartH + 6);
  });
}

// ---------- CUSTOMERS LIST ----------
function renderCustomers(){
  const q = (document.getElementById('searchInput').value||'').toLowerCase();
  const list = loadCustomers().filter(c=>{
    if (!q) return true;
    return (c.name||'').toLowerCase().includes(q) || (c.phone||'').toLowerCase().includes(q);
  }).sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));
  const el = document.getElementById('customerList');
  if (list.length===0){ el.innerHTML = `<div class="empty">No customers found.</div>`; return; }
  el.innerHTML = list.map(cardHTML).join('');
  attachCardClicks(el);
}
document.getElementById('searchInput').addEventListener('input', renderCustomers);

function cardHTML(c){
  const remaining = Math.max(0, Number(c.total||0)-Number(c.received||0));
  const status = computeStatus(c.total,c.received);
  const firstPhoto = (c.photos && c.photos[0]?.url) || c.photo || '';
  const photoCount = (c.photos || []).length || (c.photo ? 1 : 0);
  const fileCount  = (c.files || []).length;
  const profit = customerProfit(c);
  const retail = customerRetail(c);
  const margin = retail > 0 ? (profit / retail * 100) : 0;
  const attachHint = [
    photoCount ? `🖼️${photoCount}` : '',
    fileCount  ? `📎${fileCount}`  : ''
  ].filter(Boolean).join(' ');
  const profitHint = profit !== 0 ? `<span style="color:${profit>0?'var(--success)':'var(--danger)'};font-weight:600"> • ${profit>0?'+':''}${fmt(profit)} ${retail>0?`(${margin.toFixed(0)}%)`:''}</span>` : '';
  return `
    <div class="card" data-id="${c.id}">
      ${firstPhoto ? `<img class="card-photo" src="${firstPhoto}" alt="">` : `<div class="card-photo"></div>`}
      <div class="card-body">
        <div class="card-name">${escapeHTML(c.name||'(no name)')}</div>
        <div class="card-sub">${escapeHTML(c.service||'')} ${attachHint ? '• '+attachHint : ''}${profitHint}</div>
      </div>
      <div class="card-right">
        <div class="card-amount">${fmt(c.total)}</div>
        <span class="badge ${status}">${status}</span>
        <div style="font-size:11px;color:#6b7280;margin-top:2px">Left: ${fmt(remaining)}</div>
      </div>
    </div>`;
}
function attachCardClicks(container){
  container.querySelectorAll('.card').forEach(el=>{
    el.addEventListener('click', ()=> navigate('detail', { id: el.dataset.id }));
  });
}
function escapeHTML(s){ return String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- FORM ----------
// Working state for the form: draft photos/files before save.
let formState = {
  customerId: '',
  photos: [],   // [{ url, path, name, size, type, uploadedAt, _local?: dataURL, _uploading?: boolean }]
  files: []
};

function openForm(id){
  formState = { customerId: '', photos: [], files: [] };
  document.getElementById('customerForm').reset();
  document.getElementById('customerId').value = '';
  document.getElementById('fDate').value = today();
  document.getElementById('fRemaining').value = fmt(0);
  document.getElementById('fStatus').value = 'unpaid';

  if (id){
    const c = loadCustomers().find(x=>x.id===id);
    if (c){
      formState.customerId = c.id;
      formState.photos = (c.photos || (c.photo ? [{ url:c.photo, name:'photo.jpg', type:'image/jpeg' }] : [])).slice();
      formState.files = (c.files || []).slice();
      document.getElementById('customerId').value = c.id;
      document.getElementById('fName').value = c.name||'';
      document.getElementById('fPhone').value = c.phone||'';
      document.getElementById('fService').value = c.service||'';
      document.getElementById('fTotal').value = c.total||0;
      document.getElementById('fReceived').value = c.received||0;
      document.getElementById('fDate').value = c.date||today();
      document.getElementById('fNotes').value = c.notes||'';
      updateRemaining();
    }
  }
  if (!formState.customerId) formState.customerId = uid();
  renderPhotoGrid();
  renderFileList();
}

function renderPhotoGrid(){
  const grid = document.getElementById('photoGrid');
  const count = formState.photos.length;
  const badge = document.getElementById('photoCount');
  badge.textContent = `${count} / ${MAX_PHOTOS}`;
  badge.classList.toggle('full', count >= MAX_PHOTOS);
  document.getElementById('addPhotoBtn').classList.toggle('disabled', count >= MAX_PHOTOS);

  grid.innerHTML = formState.photos.map((p, i) => {
    const cost   = Number(p.cost   || 0);
    const price  = Number(p.price  || 0);
    const profit = price - cost;
    const margin = price > 0 ? (profit / price * 100) : 0;
    return `
    <div class="item-card">
      <div class="item-photo">
        <img src="${p._local || p.url}" alt="${escapeHTML(p.name||'')}" onclick="openLightbox(${i},'photo')">
        ${p._uploading ? '<div class="uploading"><div class="spinner"></div><div>Uploading…</div></div>' : `
          <div class="thumb-actions">
            <button type="button" class="thumb-btn" onclick="event.stopPropagation();openLightbox(${i},'photo')" title="Preview"><svg width="14" height="14"><use href="#i-search"/></svg></button>
            <button type="button" class="thumb-btn" onclick="event.stopPropagation();downloadPhoto(${i},'form')" title="Download"><svg width="14" height="14"><use href="#i-download"/></svg></button>
            <button type="button" class="thumb-btn danger" onclick="event.stopPropagation();removePhoto(${i})" title="Delete"><svg width="14" height="14"><use href="#i-trash"/></svg></button>
          </div>
        `}
      </div>
      <div class="item-fields">
        <input type="text" placeholder="Item name" value="${escapeHTML(p.name||'')}" oninput="updateItemField(${i},'name',this.value)" class="item-name-input" />
        <div class="item-price-row">
          <div class="item-price-col">
            <label>Cost</label>
            <input type="number" step="0.01" min="0" value="${cost || ''}" placeholder="0" oninput="updateItemField(${i},'cost',this.value)" />
          </div>
          <div class="item-price-col">
            <label>Retail</label>
            <input type="number" step="0.01" min="0" value="${price || ''}" placeholder="0" oninput="updateItemField(${i},'price',this.value)" />
          </div>
        </div>
        <div class="item-profit-row ${profit>0?'positive':(profit<0?'negative':'')}">
          <span>Profit: <b>${fmt(profit)}</b></span>
          ${price>0 ? `<span class="item-margin">${margin.toFixed(0)}%</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  updateItemsTotal();
}

window.updateItemField = function(index, field, value){
  const p = formState.photos[index]; if (!p) return;
  if (field === 'name') p.name = value;
  else p[field] = Number(value) || 0;

  // Live update the profit row without full re-render (avoids losing input focus)
  const cards = document.querySelectorAll('#photoGrid .item-card');
  const card = cards[index];
  if (card){
    const cost = Number(p.cost || 0);
    const price = Number(p.price || 0);
    const profit = price - cost;
    const margin = price > 0 ? (profit / price * 100) : 0;
    const row = card.querySelector('.item-profit-row');
    if (row){
      row.className = 'item-profit-row ' + (profit>0?'positive':(profit<0?'negative':''));
      row.innerHTML = `<span>Profit: <b>${fmt(profit)}</b></span>${price>0?`<span class="item-margin">${margin.toFixed(0)}%</span>`:''}`;
    }
  }
  updateItemsTotal();
};

// Auto-fill customer 'total' from sum of item prices
function updateItemsTotal(){
  // Photos (items)
  const photoPrice = formState.photos.reduce((s,p) => s + Number(p.price||0), 0);
  const photoCost  = formState.photos.reduce((s,p) => s + Number(p.cost ||0), 0);
  // Files (deliverables)
  const filePrice  = formState.files.reduce((s,f) => s + Number(f.price||0), 0);
  const fileCost   = formState.files.reduce((s,f) => s + Number(f.cost ||0), 0);

  const totalPrice = photoPrice + filePrice;
  const totalCost  = photoCost + fileCost;
  const profit     = totalPrice - totalCost;

  const tot = document.getElementById('fTotal');
  if (tot && totalPrice > 0){
    tot.value = totalPrice.toFixed(2);
    tot.readOnly = true;
    tot.style.background = 'var(--bg-2)';
  } else if (tot) {
    tot.readOnly = false;
    tot.style.background = '';
  }

  const summary = document.getElementById('itemsSummary');
  const hasAny = formState.photos.length > 0 || formState.files.length > 0;
  if (summary){
    if (!hasAny){
      summary.style.display = 'none';
    } else {
      summary.style.display = 'grid';
      summary.innerHTML = `
        <div class="items-sum-cell"><span>Total Retail</span><b>${fmt(totalPrice)}</b></div>
        <div class="items-sum-cell"><span>Total Cost</span><b>${fmt(totalCost)}</b></div>
        <div class="items-sum-cell ${profit>=0?'positive':'negative'}"><span>Profit</span><b>${fmt(profit)}</b></div>
      `;
    }
  }
  updateRemaining();
}

function renderFileList(){
  const list = document.getElementById('fileList');
  const count = formState.files.length;
  const badge = document.getElementById('fileCount');
  badge.textContent = `${count} / ${MAX_FILES}`;
  badge.classList.toggle('full', count >= MAX_FILES);
  document.getElementById('addFileBtn').classList.toggle('disabled', count >= MAX_FILES);

  list.innerHTML = formState.files.map((f, i) => {
    const cost   = Number(f.cost  || 0);
    const price  = Number(f.price || 0);
    const profit = price - cost;
    const margin = price > 0 ? (profit / price * 100) : 0;
    return `
    <div class="file-card">
      <div class="file-card-header">
        <div class="file-icon-lg">${fileIcon(f.type)}</div>
        <div class="file-card-body">
          <input type="text" placeholder="File name" value="${escapeHTML(f.name||'')}" oninput="updateFileField(${i},'name',this.value)" class="file-name-input" />
          <div class="file-meta">${humanSize(f.size)}${f._uploading ? ' • Uploading…' : ''}</div>
        </div>
        <div class="file-actions">
          ${f._uploading ? '<div class="spinner" style="margin:5px"></div>' : `
            ${f.url ? `<button type="button" onclick="previewFile('${f.url}','${escapeHTML(f.type||'')}','${escapeHTML(f.name||'')}')" title="Preview"><svg width="14" height="14"><use href="#i-search"/></svg></button>` : ''}
            ${f.url ? `<button type="button" onclick="downloadFile(${i},'form')" title="Download"><svg width="14" height="14"><use href="#i-download"/></svg></button>` : ''}
            <button type="button" class="del" onclick="removeFile(${i})" title="Delete"><svg width="14" height="14"><use href="#i-trash"/></svg></button>
          `}
        </div>
      </div>
      <div class="item-price-row" style="margin-top:6px">
        <div class="item-price-col">
          <label>Cost</label>
          <input type="number" step="0.01" min="0" value="${cost || ''}" placeholder="0" oninput="updateFileField(${i},'cost',this.value)" />
        </div>
        <div class="item-price-col">
          <label>Retail</label>
          <input type="number" step="0.01" min="0" value="${price || ''}" placeholder="0" oninput="updateFileField(${i},'price',this.value)" />
        </div>
      </div>
      <div class="item-profit-row ${profit>0?'positive':(profit<0?'negative':'')}" style="padding:2px 6px 0">
        <span>Profit: <b>${fmt(profit)}</b></span>
        ${price>0 ? `<span class="item-margin">${margin.toFixed(0)}%</span>` : ''}
      </div>
    </div>`;
  }).join('');

  updateItemsTotal();
}

window.updateFileField = function(index, field, value){
  const f = formState.files[index]; if (!f) return;
  if (field === 'name') f.name = value;
  else f[field] = Number(value) || 0;

  // Live update the profit row without full re-render (keeps focus in input)
  const cards = document.querySelectorAll('#fileList .file-card');
  const card = cards[index];
  if (card){
    const cost = Number(f.cost || 0);
    const price = Number(f.price || 0);
    const profit = price - cost;
    const margin = price > 0 ? (profit / price * 100) : 0;
    const row = card.querySelector('.item-profit-row');
    if (row){
      row.className = 'item-profit-row ' + (profit>0?'positive':(profit<0?'negative':''));
      row.style.padding = '2px 6px 0';
      row.innerHTML = `<span>Profit: <b>${fmt(profit)}</b></span>${price>0?`<span class="item-margin">${margin.toFixed(0)}%</span>`:''}`;
    }
  }
  updateItemsTotal();
};

window.removePhoto = async function(i){
  const p = formState.photos[i];
  if (!p) return;
  if (!confirm(`Delete photo "${p.name || 'this photo'}"? This cannot be undone.`)) return;
  if (p.path) deleteFromStorage(p.path); // fire-and-forget cloud cleanup
  formState.photos.splice(i, 1);
  renderPhotoGrid();
};
window.removeFile = async function(i){
  const f = formState.files[i];
  if (!f) return;
  if (!confirm(`Delete file "${f.name}"? This cannot be undone.`)) return;
  if (f.path) deleteFromStorage(f.path);
  formState.files.splice(i, 1);
  renderFileList();
};

window.renamePhoto = function(i){
  const p = formState.photos[i]; if (!p) return;
  const newName = prompt('Rename photo:', p.name || 'photo.jpg');
  if (!newName || !newName.trim()) return;
  p.name = newName.trim();
  renderPhotoGrid();
};
window.renameFile = function(i){
  const f = formState.files[i]; if (!f) return;
  const newName = prompt('Rename file:', f.name || 'file');
  if (!newName || !newName.trim()) return;
  f.name = newName.trim();
  renderFileList();
};

// Download helpers ---------------------------------------------
async function downloadUrl(url, filename){
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'download';
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  } catch(e){
    // Fallback: open in a new tab
    window.open(url, '_blank');
  }
}
window.downloadPhoto = function(index, source){
  const arr = source === 'detail' ? (window._detailPhotos || []) : formState.photos;
  const p = arr[index]; if (!p) return;
  const url = p.url || p._local; if (!url) return;
  downloadUrl(url, p.name || `photo-${index+1}.jpg`);
};
window.downloadFile = function(index, source){
  const arr = source === 'detail' ? (window._detailFiles || []) : formState.files;
  const f = arr[index]; if (!f || !f.url) return;
  downloadUrl(f.url, f.name);
};

// Downscale an image file to a Blob (for photo uploads)
function downscaleImage(file, maxDim = 1600, quality = 0.85){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim){
          const s = maxDim / Math.max(width, height);
          width = Math.round(width * s);
          height = Math.round(height * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('Canvas encoding failed'));
          blob.name = file.name || 'photo.jpg';
          resolve(blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Read file as data URL (for local preview / fallback)
function readAsDataURL(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Handle multi-photo add
document.getElementById('photoInput').addEventListener('change', async e => {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // reset for re-selection
  const cfg = getCfg();
  const hasStorage = !!cfg.storageBucket;

  for (const file of files){
    if (formState.photos.length >= MAX_PHOTOS){
      alert(`Maximum ${MAX_PHOTOS} photos reached.`);
      break;
    }
    let blob;
    try { blob = await downscaleImage(file); }
    catch (err) { console.warn('Downscale failed', err); blob = file; }

    // Local preview (data URL) so user sees it immediately
    const localUrl = await readAsDataURL(blob);
    const rawName = (blob.name || file.name || 'photo.jpg').replace(/\.[^.]+$/, '');
    const entry = {
      _local: localUrl,
      _uploading: hasStorage,
      name: rawName,
      cost: 0,
      price: 0,
      size: blob.size,
      type: blob.type || 'image/jpeg'
    };
    formState.photos.push(entry);
    renderPhotoGrid();

    if (hasStorage){
      try {
        const uploaded = await uploadToStorage(blob, 'photos', formState.customerId);
        Object.assign(entry, uploaded);
        entry._uploading = false;
      } catch(err){
        console.warn('Photo upload failed, keeping local copy', err);
        entry._uploading = false;
        entry.url = localUrl; // fallback: keep base64 (stored in DB)
      }
      renderPhotoGrid();
    } else {
      // No storage configured — keep as base64 in DB
      entry.url = localUrl;
      renderPhotoGrid();
    }
  }
});

// Handle multi-file add
document.getElementById('fileInput').addEventListener('change', async e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  const cfg = getCfg();
  const hasStorage = !!cfg.storageBucket;

  if (!hasStorage){
    alert('Enable Firebase Storage in Settings first to attach files. Photos work locally, but files must go to cloud storage.');
    return;
  }

  for (const file of files){
    if (formState.files.length >= MAX_FILES){
      alert(`Maximum ${MAX_FILES} files reached.`);
      break;
    }
    if (file.size > 20 * 1024 * 1024){
      alert(`"${file.name}" is over 20 MB — skipped.`);
      continue;
    }
    const rawName = (file.name || 'file').replace(/\.[^.]+$/, '');
    const entry = {
      _uploading: true,
      name: rawName,
      cost: 0,
      price: 0,
      size: file.size,
      type: file.type
    };
    formState.files.push(entry);
    renderFileList();
    try {
      const uploaded = await uploadToStorage(file, 'files', formState.customerId);
      Object.assign(entry, uploaded);
      entry._uploading = false;
    } catch(err){
      alert('File upload failed: ' + err.message);
      const i = formState.files.indexOf(entry);
      if (i > -1) formState.files.splice(i, 1);
    }
    renderFileList();
  }
});
function updateRemaining(){
  const t = Number(document.getElementById('fTotal').value||0);
  const r = Number(document.getElementById('fReceived').value||0);
  document.getElementById('fRemaining').value = fmt(Math.max(0,t-r));
  document.getElementById('fStatus').value = computeStatus(t,r);
}
document.getElementById('fTotal').addEventListener('input', updateRemaining);
document.getElementById('fReceived').addEventListener('input', updateRemaining);

document.getElementById('cancelBtn').addEventListener('click', ()=> navigate('customers'));

document.getElementById('customerForm').addEventListener('submit', e=>{
  e.preventDefault();
  const id = document.getElementById('customerId').value || uid();
  const list = loadCustomers();
  const existing = list.find(x=>x.id===id);
  const total = Number(document.getElementById('fTotal').value||0);
  const enteredReceived = Number(document.getElementById('fReceived').value||0);
  const enteredDate = document.getElementById('fDate').value || today();
  const payments = (existing?.payments || []).map(p => ({ ...p }));

  // If received amount changed in the main form, log the difference as a payment entry.
  if (!existing && enteredReceived > 0){
    payments.push({ date: enteredDate, amount: enteredReceived, note:'Initial payment', createdAt: new Date().toISOString() });
  } else if (existing && enteredReceived !== Number(existing.received||0)) {
    const delta = enteredReceived - Number(existing.received||0);
    if (delta !== 0){
      payments.push({ date: enteredDate, amount: delta, note: delta > 0 ? 'Payment added from edit form' : 'Payment adjustment', createdAt: new Date().toISOString() });
    }
  }

  const finalReceived = payments.length ? paymentTotal(payments) : enteredReceived;

  // Strip transient client-only fields before storing
  const cleanAttachments = arr => (arr||[]).filter(x => !x._uploading).map(x => {
    const { _local, _uploading, ...rest } = x;
    // Ensure a usable URL; if only _local exists, keep it as url (base64 fallback)
    if (!rest.url && _local) rest.url = _local;
    return rest;
  });
  const photos = cleanAttachments(formState.photos);
  const files  = cleanAttachments(formState.files);

  // If items OR files have prices, use their sum as the total (auto-calculated)
  const itemsRetail = photos.reduce((s,p)=> s + Number(p.price||0), 0);
  const filesRetail = files .reduce((s,f)=> s + Number(f.price||0), 0);
  const attachRetail = itemsRetail + filesRetail;
  const finalTotal = attachRetail > 0 ? attachRetail : total;

  const record = {
    id,
    name: document.getElementById('fName').value.trim(),
    phone: document.getElementById('fPhone').value.trim(),
    service: document.getElementById('fService').value.trim(),
    total: finalTotal,
    received: finalReceived,
    date: payments.length ? sortPayments(payments).slice(-1)[0].date : enteredDate,
    notes: document.getElementById('fNotes').value.trim(),
    photos,        // items with { name, cost, price, url, path, ... }
    files,
    photo: photos[0]?.url || '',
    status: computeStatus(finalTotal, finalReceived),
    payments,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existing) Object.assign(existing, record);
  else list.push(record);
  saveCustomers(list);
  navigate('detail', { id });
});

// ---------- DETAIL ----------
function renderDetail(id){
  const c = loadCustomers().find(x=>x.id===id);
  if (!c){ navigate('customers'); return; }
  const sortedPayments = sortPayments(c.payments||[]);
  const paidTotal = sortedPayments.length ? paymentTotal(sortedPayments) : Number(c.received||0);
  const remaining = Math.max(0, Number(c.total||0)-paidTotal);
  const status = computeStatus(c.total, paidTotal);
  const lastDate = sortedPayments.length ? (sortedPayments[sortedPayments.length - 1].date || '-') : (c.date || '-');
  const paymentsHTML = sortedPayments.slice().reverse().map((p, idx)=>`
    <div class="payment-item">
      <div class="payment-item-left">
        <div class="payment-item-title">Payment ${sortedPayments.length - idx}</div>
        <div class="payment-item-sub">${escapeHTML(p.date || '-')} ${p.note ? '• ' + escapeHTML(p.note) : ''}</div>
      </div>
      <b>${fmt(p.amount)}</b>
    </div>`).join('') || `<div class="empty" style="padding:10px">No payments logged.</div>`;

  // Normalise photos/files (backward compat)
  const photos = (c.photos && c.photos.length) ? c.photos : (c.photo ? [{url:c.photo,name:'photo.jpg',type:'image/jpeg'}] : []);
  const files  = c.files || [];
  window._detailPhotos = photos; // for lightbox

  window._detailFiles = files; // for downloads

  // Profit summary for this customer
  const custProfit = customerProfit(c);
  const custRetail = customerRetail(c);
  const custCost   = customerCost(c);
  const custMargin = custRetail > 0 ? (custProfit / custRetail * 100) : 0;
  const hasItems = photos.some(p => Number(p.price||0) > 0 || Number(p.cost||0) > 0);

  const profitSummaryHTML = hasItems ? `
    <div class="customer-profit-summary">
      <div class="cps-cell">
        <div class="cps-label">Retail</div>
        <div class="cps-value">${fmt(custRetail)}</div>
      </div>
      <div class="cps-cell">
        <div class="cps-label">Cost</div>
        <div class="cps-value">${fmt(custCost)}</div>
      </div>
      <div class="cps-cell ${custProfit>=0?'positive':'negative'}">
        <div class="cps-label">Profit</div>
        <div class="cps-value">${fmt(custProfit)}</div>
      </div>
      <div class="cps-cell ${custMargin>=0?'positive':'negative'}">
        <div class="cps-label">Margin</div>
        <div class="cps-value">${custMargin.toFixed(0)}%</div>
      </div>
    </div>` : '';

  const photosHTML = photos.length ? `
    <div class="detail-photos-section">
      <h3>Items (${photos.length})</h3>
      <div class="detail-items-grid">
        ${photos.map((p,i)=>{
          const cost = Number(p.cost||0);
          const price = Number(p.price||0);
          const prof = price - cost;
          const margin = price > 0 ? (prof / price * 100) : 0;
          return `
          <div class="detail-item-card">
            <div class="detail-item-photo">
              <img src="${p.url}" alt="${escapeHTML(p.name||'')}" onclick="openLightboxDetail(${i})">
              <div class="thumb-actions">
                <button type="button" class="thumb-btn" onclick="event.stopPropagation();openLightboxDetail(${i})" title="Preview"><svg width="14" height="14"><use href="#i-search"/></svg></button>
                <button type="button" class="thumb-btn" onclick="event.stopPropagation();downloadPhoto(${i},'detail')" title="Download"><svg width="14" height="14"><use href="#i-download"/></svg></button>
                <button type="button" class="thumb-btn danger" onclick="event.stopPropagation();deletePhotoFromDetail('${c.id}',${i})" title="Delete"><svg width="14" height="14"><use href="#i-trash"/></svg></button>
              </div>
            </div>
            <div class="detail-item-info">
              <div class="detail-item-name">${escapeHTML(p.name||'Item')}</div>
              ${(cost>0||price>0) ? `
                <div class="detail-item-prices">
                  <div class="dip cost"><span>Cost</span><b>${fmt(cost)}</b></div>
                  <div class="dip retail"><span>Retail</span><b>${fmt(price)}</b></div>
                  <div class="dip profit ${prof>=0?'positive':'negative'}"><span>Profit</span><b>${fmt(prof)}${price>0?` (${margin.toFixed(0)}%)`:''}</b></div>
                </div>
              ` : `<div class="detail-item-noprice">No cost / price set</div>`}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const filesHTML = files.length ? `
    <div class="detail-files-section">
      <h3>Attached Files (${files.length})</h3>
      <div class="detail-items-grid">
        ${files.map((f,i)=>{
          const fcost = Number(f.cost||0);
          const fprice = Number(f.price||0);
          const fprof = fprice - fcost;
          const fmargin = fprice > 0 ? (fprof / fprice * 100) : 0;
          return `
          <div class="detail-item-card">
            <div class="detail-item-photo file-icon-big">${fileIcon(f.type)}</div>
            <div class="detail-item-info">
              <div class="detail-item-name">${escapeHTML(f.name||'File')}</div>
              <div class="file-meta" style="margin-bottom:6px">${humanSize(f.size)}</div>
              ${(fcost>0||fprice>0) ? `
                <div class="detail-item-prices">
                  <div class="dip cost"><span>Cost</span><b>${fmt(fcost)}</b></div>
                  <div class="dip retail"><span>Retail</span><b>${fmt(fprice)}</b></div>
                  <div class="dip profit ${fprof>=0?'positive':'negative'}"><span>Profit</span><b>${fmt(fprof)}${fprice>0?` (${fmargin.toFixed(0)}%)`:''}</b></div>
                </div>` : `<div class="detail-item-noprice">No cost / price set</div>`}
              <div class="file-actions" style="margin-top:8px">
                <button type="button" onclick="previewFile('${f.url}','${escapeHTML(f.type||'')}','${escapeHTML(f.name||'')}')" title="Preview">
                  <svg width="14" height="14"><use href="#i-search"/></svg>
                </button>
                <button type="button" onclick="downloadFile(${i},'detail')" title="Download">
                  <svg width="14" height="14"><use href="#i-download"/></svg>
                </button>
                <button type="button" class="del" onclick="deleteFileFromDetail('${c.id}',${i})" title="Delete">
                  <svg width="14" height="14"><use href="#i-trash"/></svg>
                </button>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  document.getElementById('detailContent').innerHTML = `
    <div class="detail-card">
      ${profitSummaryHTML}
      ${photosHTML}
      ${filesHTML}
      <div class="detail-body">
        <h2>${escapeHTML(c.name)}</h2>
        <div class="phone">${escapeHTML(c.phone||'')}</div>
        <div class="detail-row"><span class="k">Service</span><span class="v">${escapeHTML(c.service||'-')}</span></div>
        <div class="detail-row"><span class="k">Total</span><span class="v">${fmt(c.total)}</span></div>
        <div class="detail-row"><span class="k">Total Paid</span><span class="v">${fmt(paidTotal)}</span></div>
        <div class="detail-row"><span class="k">Remaining</span><span class="v" style="color:${remaining>0?'#dc2626':'#059669'}">${fmt(remaining)}</span></div>
        <div class="detail-row"><span class="k">Payment Entries</span><span class="v">${sortedPayments.length}</span></div>
        <div class="detail-row"><span class="k">Last Payment Date</span><span class="v">${escapeHTML(lastDate)}</span></div>
        <div class="detail-row"><span class="k">Status</span><span class="v"><span class="badge ${status}">${status}</span></span></div>
        ${c.notes ? `<div class="detail-row"><span class="k">Notes</span><span class="v" style="max-width:60%;text-align:right">${escapeHTML(c.notes)}</span></div>` : ''}

        <div class="detail-actions">
          <button class="btn primary" onclick="navigate('form',{id:'${c.id}'})">
            <svg width="15" height="15" style="vertical-align:-3px;margin-right:6px"><use href="#i-edit"/></svg>Edit
          </button>
          <button class="btn ghost" onclick="printInvoice('${c.id}')">
            <svg width="15" height="15" style="vertical-align:-3px;margin-right:6px"><use href="#i-doc"/></svg>Invoice PDF
          </button>
          <button class="btn danger" onclick="deleteCustomer('${c.id}')">
            <svg width="15" height="15" style="vertical-align:-3px;margin-right:6px"><use href="#i-trash"/></svg>Delete
          </button>
        </div>
      </div>
    </div>

    <div class="payments-section">
      <h3>Payment History</h3>
      <div class="payments-summary">
        <div class="payment-summary-card">
          <div class="payment-summary-label">Total Paid</div>
          <div class="payment-summary-value">${fmt(paidTotal)}</div>
        </div>
        <div class="payment-summary-card">
          <div class="payment-summary-label">Payments</div>
          <div class="payment-summary-value">${sortedPayments.length}</div>
        </div>
        <div class="payment-summary-card">
          <div class="payment-summary-label">Last Date</div>
          <div class="payment-summary-value">${escapeHTML(lastDate)}</div>
        </div>
      </div>
      ${paymentsHTML}
      <div class="add-payment-form">
        <input type="number" id="newPayAmt" placeholder="Amount" step="0.01" min="0" />
        <input type="date" id="newPayDate" value="${today()}" />
        <input type="text" id="newPayNote" placeholder="Note (optional)" />
        <button class="btn primary" onclick="addPayment('${c.id}')">+ Add</button>
      </div>
    </div>
  `;
}

window.addPayment = function(id){
  const amt = Number(document.getElementById('newPayAmt').value||0);
  if (amt<=0){ alert('Enter an amount'); return; }
  const payDate = document.getElementById('newPayDate').value || today();
  const note = document.getElementById('newPayNote').value.trim();
  const list = loadCustomers();
  const c = list.find(x=>x.id===id); if (!c) return;
  c.payments = c.payments || [];
  c.payments.push({ date: payDate, amount: amt, note, createdAt: new Date().toISOString() });
  c.received = paymentTotal(c.payments);
  c.date = lastPaymentDate(c);
  c.status = computeStatus(c.total, c.received);
  c.updatedAt = new Date().toISOString();
  saveCustomers(list);
  renderDetail(id);
};

window.deleteCustomer = function(id){
  if (!confirm('Delete this customer permanently? This will also delete uploaded photos and files.')) return;
  const list = loadCustomers();
  const c = list.find(x=>x.id===id);
  if (c){
    // Fire-and-forget cleanup of cloud storage
    (c.photos || []).forEach(p => p.path && deleteFromStorage(p.path));
    (c.files  || []).forEach(f => f.path && deleteFromStorage(f.path));
  }
  const filtered = list.filter(x=>x.id!==id);
  saveCustomers(filtered);
  navigate('customers');
};

// ---------- LIGHTBOX (photo viewer) ----------
let _lbIndex = 0;
let _lbSource = 'photo'; // 'photo' (form) | 'detail'
window.openLightbox = function(index, source){
  _lbIndex = index;
  _lbSource = source;
  showLightbox();
};
window.openLightboxDetail = function(index){
  _lbIndex = index;
  _lbSource = 'detail';
  showLightbox();
};
function currentLightboxPhotos(){
  return _lbSource === 'detail' ? (window._detailPhotos || []) : formState.photos;
}
function showLightbox(){
  const photos = currentLightboxPhotos();
  if (!photos.length) return;
  const p = photos[_lbIndex];
  const src = p.url || p._local;
  let box = document.getElementById('lightbox');
  if (!box){
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    document.body.appendChild(box);
  }
  box.innerHTML = `
    <button class="lb-close" onclick="closeLightbox()">×</button>
    ${photos.length>1?`<button class="lb-nav prev" onclick="lbNav(-1)">‹</button>`:''}
    ${photos.length>1?`<button class="lb-nav next" onclick="lbNav(1)">›</button>`:''}
    <img src="${src}" alt="">
    <div class="lb-info">${_lbIndex+1} / ${photos.length} • ${escapeHTML(p.name||'')}</div>
  `;
  box.style.display = 'flex';
  box.onclick = (e)=>{ if (e.target === box) closeLightbox(); };
}
window.lbNav = function(dir){
  const photos = currentLightboxPhotos();
  _lbIndex = (_lbIndex + dir + photos.length) % photos.length;
  showLightbox();
};
window.closeLightbox = function(){
  const box = document.getElementById('lightbox');
  if (box) box.remove();
};
document.addEventListener('keydown', e => {
  if (document.getElementById('lightbox')){
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') lbNav(1);
    if (e.key === 'ArrowLeft') lbNav(-1);
  }
  if (document.getElementById('filePreview')){
    if (e.key === 'Escape') closeFilePreview();
  }
});

// ---------- DELETE PHOTO/FILE DIRECTLY FROM DETAIL VIEW ----------
window.deletePhotoFromDetail = function(customerId, index){
  const list = loadCustomers();
  const c = list.find(x => x.id === customerId); if (!c) return;
  const photos = c.photos || (c.photo ? [{url:c.photo,name:'photo.jpg',type:'image/jpeg'}] : []);
  const p = photos[index]; if (!p) return;
  if (!confirm(`Delete photo "${p.name || 'this photo'}"? This cannot be undone.`)) return;
  if (p.path) deleteFromStorage(p.path);
  photos.splice(index, 1);
  c.photos = photos;
  c.photo = photos[0]?.url || '';
  c.updatedAt = new Date().toISOString();
  saveCustomers(list);
  renderDetail(customerId);
};
window.deleteFileFromDetail = function(customerId, index){
  const list = loadCustomers();
  const c = list.find(x => x.id === customerId); if (!c) return;
  const files = c.files || [];
  const f = files[index]; if (!f) return;
  if (!confirm(`Delete file "${f.name}"? This cannot be undone.`)) return;
  if (f.path) deleteFromStorage(f.path);
  files.splice(index, 1);
  c.files = files;
  c.updatedAt = new Date().toISOString();
  saveCustomers(list);
  renderDetail(customerId);
};

// ---------- FILE PREVIEW MODAL ----------
// Shows PDFs inline via <iframe>, images via <img>, other files fall back to "open in new tab".
window.previewFile = function(url, type, name){
  if (!url) return;
  let content = '';
  const isImg = (type||'').startsWith('image/');
  const isPDF = (type||'').includes('pdf') || (name||'').toLowerCase().endsWith('.pdf');
  if (isImg){
    content = `<img src="${url}" alt="${escapeHTML(name)}">`;
  } else if (isPDF){
    content = `<iframe src="${url}" allow="fullscreen"></iframe>`;
  } else {
    content = `
      <div class="fp-fallback">
        <div style="font-size:56px;margin-bottom:14px">${fileIcon(type)}</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">${escapeHTML(name)}</div>
        <div style="color:#a8b3cf;font-size:13px;margin-bottom:20px">This file type cannot be previewed inline.</div>
        <a href="${url}" target="_blank" class="btn primary" style="text-decoration:none;display:inline-block">
          <svg width="15" height="15" style="vertical-align:-3px;margin-right:6px"><use href="#i-download"/></svg>Open in new tab
        </a>
      </div>`;
  }
  let box = document.getElementById('filePreview');
  if (!box){
    box = document.createElement('div');
    box.id = 'filePreview';
    box.className = 'file-preview-modal';
    document.body.appendChild(box);
  }
  box.innerHTML = `
    <div class="fp-inner">
      <div class="fp-header">
        <div class="fp-title">${escapeHTML(name)}</div>
        <div class="fp-actions">
          <a href="${url}" target="_blank" class="btn ghost" style="padding:8px 14px;font-size:13px;text-decoration:none">
            <svg width="14" height="14" style="vertical-align:-3px;margin-right:4px"><use href="#i-download"/></svg>Download
          </a>
          <button type="button" class="fp-close" onclick="closeFilePreview()">×</button>
        </div>
      </div>
      <div class="fp-body">${content}</div>
    </div>
  `;
  box.style.display = 'flex';
  box.onclick = (e) => { if (e.target === box) closeFilePreview(); };
};
window.closeFilePreview = function(){
  const b = document.getElementById('filePreview');
  if (b) b.remove();
};

// ---------- INVOICE PDF ----------
// Robust logo loader: fetch → dataURL. Uses <img> element as fallback if fetch fails.
async function loadLogoForPDF(){
  if (window._codeaLogoCache) return window._codeaLogoCache;

  // Try each candidate path; the first that works wins.
  const candidates = ['icons/invoice-logo.png', './icons/invoice-logo.png', 'icons/logo-wide.png', 'icons/logo.png', './icons/logo-wide.png', './icons/logo.png'];

  for (const path of candidates){
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      const blob = await res.blob();
      // Load into an Image so we know width/height for aspect-correct sizing
      const dataUrl = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.onerror = () => r(null);
        fr.readAsDataURL(blob);
      });
      if (!dataUrl) continue;
      const img = await new Promise(r => {
        const i = new Image();
        i.onload = () => r(i);
        i.onerror = () => r(null);
        i.src = dataUrl;
      });
      if (!img) continue;

      // Re-render onto a white canvas so jsPDF gets a clean opaque PNG
      // (fixes PDF transparency issues + guarantees consistent color rendering).
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth  * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext('2d');
      // Use a dark fill for the invoice mark so its transparent edges blend into the navy invoice header.
      ctx.fillStyle = /invoice-logo/.test(path) ? '#0a0f1e' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const finalDataUrl = canvas.toDataURL('image/png');

      window._codeaLogoCache = {
        dataUrl: finalDataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight
      };
      return window._codeaLogoCache;
    } catch(e){
      console.warn('Logo load failed for', path, e);
    }
  }
  // Last-resort: try the visible topbar logo already on the page
  const el = document.querySelector('.topbar-logo, .brand-logo');
  if (el && el.complete && el.naturalWidth > 0){
    try {
      const canvas = document.createElement('canvas');
      canvas.width  = el.naturalWidth  * 2;
      canvas.height = el.naturalHeight * 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      window._codeaLogoCache = {
        dataUrl: canvas.toDataURL('image/png'),
        width: el.naturalWidth,
        height: el.naturalHeight
      };
      return window._codeaLogoCache;
    } catch(e){ console.warn('Fallback logo draw failed', e); }
  }
  return null;
}

window.printInvoice = async function(id){
  const c = loadCustomers().find(x=>x.id===id); if (!c) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });

  // A4 landscape reference
  const PAGE_W = 595, PAGE_H = 842;
  const MARGIN = 40;

  // --- BRAND HEADER BAR (deep navy) ---
  doc.setFillColor(10, 15, 30);            // navy
  doc.rect(0, 0, PAGE_W, 120, 'F');
  // Accent cyan strip
  doc.setFillColor(0, 226, 255);
  doc.rect(0, 118, PAGE_W, 3, 'F');

  // --- LOGO (centered vertically in navy band) ---
  const logo = await loadLogoForPDF();
  if (logo){
    const maxH = 60;
    const maxW = 220;
    const ratio = logo.width / logo.height;
    let h = maxH, w = h * ratio;
    if (w > maxW){ w = maxW; h = w / ratio; }
    try {
      doc.addImage(logo.dataUrl, 'PNG', MARGIN, (120 - h) / 2, w, h);
    } catch(e){ console.warn('addImage failed', e); }
  } else {
    // Text fallback
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(28); doc.setTextColor(230, 240, 255);
    doc.text('CODEA', MARGIN, 70);
    doc.setFont('helvetica', 'normal');
  }

  // --- INVOICE TITLE (right side of header) ---
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24); doc.setTextColor(230, 240, 255);
  doc.text('INVOICE', PAGE_W - MARGIN, 62, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9); doc.setTextColor(150, 175, 220);
  doc.text('Codea — Customer Manager', PAGE_W - MARGIN, 80, { align: 'right' });
  const invNo = 'INV-' + (c.id||'').slice(-6).toUpperCase();
  doc.text('No. ' + invNo, PAGE_W - MARGIN, 95, { align: 'right' });

  // --- METADATA BOXES ---
  let y = 150;
  const boxW = (PAGE_W - MARGIN*2 - 20) / 2;

  // Billed To box
  doc.setFillColor(248, 250, 255);
  doc.roundedRect(MARGIN, y, boxW, 90, 6, 6, 'F');
  doc.setFontSize(9); doc.setTextColor(120, 130, 160);
  doc.text('BILLED TO', MARGIN + 14, y + 20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14); doc.setTextColor(15, 23, 42);
  doc.text(c.name || '-', MARGIN + 14, y + 42, { maxWidth: boxW - 28 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10); doc.setTextColor(90, 100, 130);
  let by = y + 60;
  if (c.phone) { doc.text(c.phone, MARGIN + 14, by); by += 14; }

  // Invoice details box
  const rx = MARGIN + boxW + 20;
  doc.setFillColor(248, 250, 255);
  doc.roundedRect(rx, y, boxW, 90, 6, 6, 'F');
  doc.setFontSize(9); doc.setTextColor(120, 130, 160);
  doc.text('INVOICE DETAILS', rx + 14, y + 20);
  doc.setFontSize(10); doc.setTextColor(60, 70, 90);
  doc.text('Date:', rx + 14, y + 40);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
  doc.text(c.date || today(), rx + 90, y + 40);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 70, 90);
  doc.text('Status:', rx + 14, y + 58);
  const status = computeStatus(c.total, c.received);
  const statusColors = { paid:[34,197,94], partial:[245,158,11], unpaid:[239,68,68] };
  const sc = statusColors[status] || [100,100,100];
  doc.setFillColor(sc[0], sc[1], sc[2]);
  doc.roundedRect(rx + 90, y + 46, 60, 16, 8, 8, 'F');
  doc.setTextColor(255,255,255); doc.setFontSize(9); doc.setFont('helvetica','bold');
  doc.text(status.toUpperCase(), rx + 120, y + 57, { align:'center' });
  doc.setFont('helvetica','normal');
  doc.setFontSize(10); doc.setTextColor(60, 70, 90);
  doc.text('Invoice #:', rx + 14, y + 76);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
  doc.text(invNo, rx + 90, y + 76);
  doc.setFont('helvetica', 'normal');

  y += 110;

  // --- LINE ITEMS TABLE ---
  doc.setFillColor(10, 15, 30);
  doc.rect(MARGIN, y, PAGE_W - MARGIN*2, 28, 'F');
  doc.setFontSize(10); doc.setTextColor(230, 240, 255); doc.setFont('helvetica','bold');
  doc.text('DESCRIPTION', MARGIN + 14, y + 18);
  doc.text('AMOUNT', PAGE_W - MARGIN - 14, y + 18, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 28;

  // Row
  doc.setFillColor(255, 255, 255);
  doc.rect(MARGIN, y, PAGE_W - MARGIN*2, 36, 'F');
  doc.setTextColor(30, 41, 59); doc.setFontSize(11);
  doc.text(c.service || '-', MARGIN + 14, y + 22, { maxWidth: 380 });
  doc.setFont('helvetica', 'bold');
  doc.text(fmt(c.total), PAGE_W - MARGIN - 14, y + 22, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 36;

  // Separator under items
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 20;

  // --- TOTALS BLOCK (right-aligned) ---
  const remaining = Math.max(0, Number(c.total||0) - Number(c.received||0));
  const totalsX = PAGE_W - MARGIN - 220;

  doc.setFontSize(11); doc.setTextColor(90, 100, 130);
  doc.text('Subtotal', totalsX, y);
  doc.setTextColor(15, 23, 42);
  doc.text(fmt(c.total), PAGE_W - MARGIN, y, { align: 'right' });
  y += 20;

  doc.setTextColor(90, 100, 130);
  doc.text('Payments Total', totalsX, y);
  doc.setTextColor(34, 197, 94);
  doc.text('- ' + fmt(c.received), PAGE_W - MARGIN, y, { align: 'right' });
  y += 12;

  doc.setDrawColor(226, 232, 240);
  doc.line(totalsX, y, PAGE_W - MARGIN, y);
  y += 20;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14); doc.setTextColor(10, 15, 30);
  doc.text('BALANCE DUE', totalsX, y);
  doc.setTextColor(remaining > 0 ? 239 : 34, remaining > 0 ? 68 : 197, remaining > 0 ? 68 : 94);
  doc.text(fmt(remaining), PAGE_W - MARGIN, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 40;

  // --- PAYMENT HISTORY ---
  const payments = (c.payments || []).slice();
  if (payments.length > 0){
    doc.setFontSize(11); doc.setTextColor(120, 130, 160); doc.setFont('helvetica','bold');
    doc.text('PAYMENT HISTORY', MARGIN, y);
    doc.setFont('helvetica', 'normal');
    y += 14;
    doc.setDrawColor(226, 232, 240);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 14;

    doc.setFontSize(10); doc.setTextColor(60, 70, 90);
    payments.forEach((p, i) => {
      if (y > 760){ doc.addPage(); y = MARGIN; }
      doc.setTextColor(90, 100, 130);
      doc.text(`#${i+1}`, MARGIN, y);
      doc.setTextColor(30, 41, 59);
      doc.text(p.date || '-', MARGIN + 30, y);
      if (p.note) {
        doc.setTextColor(120, 130, 160);
        doc.text(p.note, MARGIN + 130, y, { maxWidth: 260 });
      }
      doc.setFont('helvetica', 'bold'); doc.setTextColor(34, 197, 94);
      doc.text(fmt(p.amount), PAGE_W - MARGIN, y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      y += 16;
    });
    y += 10;
  }

  // --- NOTES ---
  if (c.notes){
    if (y > 720){ doc.addPage(); y = MARGIN; }
    doc.setFontSize(10); doc.setTextColor(120, 130, 160); doc.setFont('helvetica','bold');
    doc.text('NOTES', MARGIN, y); y += 12;
    doc.setFont('helvetica','normal'); doc.setTextColor(60, 70, 90);
    doc.text(c.notes, MARGIN, y + 10, { maxWidth: PAGE_W - MARGIN*2 });
    y += 40;
  }

  // --- FOOTER ---
  const footerY = PAGE_H - 40;
  doc.setDrawColor(226, 232, 240);
  doc.line(MARGIN, footerY - 20, PAGE_W - MARGIN, footerY - 20);
  doc.setFontSize(9); doc.setTextColor(120, 130, 160);
  doc.text('Thank you for choosing Codea.', MARGIN, footerY);
  doc.text('Generated ' + new Date().toLocaleDateString(), PAGE_W - MARGIN, footerY, { align: 'right' });

  // Save
  const filename = `invoice-${(c.name||'customer').replace(/\s+/g,'_')}-${invNo}.pdf`;
  doc.save(filename);
};

// ---------- SETTINGS ----------
function openSettings(){
  const cfg = getCfg();
  document.getElementById('dbUrl').value = cfg.dbUrl;
  document.getElementById('storageBucket').value = cfg.storageBucket || '';
  document.getElementById('currencySym').value = cfg.currency;
  document.getElementById('newUser').value = '';
  document.getElementById('newPass').value = '';
  document.getElementById('connResult').textContent = '';
}
document.getElementById('saveSettingsBtn').addEventListener('click', ()=>{
  const cfg = getCfg();
  cfg.dbUrl = document.getElementById('dbUrl').value.trim();
  cfg.storageBucket = document.getElementById('storageBucket').value.trim().replace(/^gs:\/\//,'').replace(/\/$/,'');
  cfg.currency = document.getElementById('currencySym').value || '$';
  const nu = document.getElementById('newUser').value.trim();
  const np = document.getElementById('newPass').value;
  if (nu) cfg.user = nu;
  if (np) cfg.pass = np;
  setCfg(cfg);
  alert('Settings saved.');
  navigate('dashboard');
});

document.getElementById('testConnBtn').addEventListener('click', async ()=>{
  // Save current values so tests use them
  const cfg = getCfg();
  cfg.dbUrl = document.getElementById('dbUrl').value.trim();
  cfg.storageBucket = document.getElementById('storageBucket').value.trim().replace(/^gs:\/\//,'').replace(/\/$/,'');
  setCfg(cfg);
  const resultEl = document.getElementById('connResult');
  resultEl.textContent = 'Testing…';
  resultEl.style.color = '#4f8bff';
  const [dbR, storageR] = await Promise.all([testConnection(), testStorage()]);
  const dbMsg = 'DB: ' + dbR.msg;
  const stMsg = 'Storage: ' + storageR.msg;
  resultEl.innerHTML = `<span style="color:${dbR.ok?'#22d3a5':'#ff5c7a'}">${dbMsg}</span><br><span style="color:${storageR.ok?'#22d3a5':'#ff5c7a'}">${stMsg}</span>`;
});

document.getElementById('exportBtn').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(loadCustomers(),null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'codea-data.json'; a.click();
});
document.getElementById('importBtn').addEventListener('click', ()=> document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e=>{
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (Array.isArray(data)){ saveCustomers(data); alert('Imported '+data.length+' records.'); navigate('dashboard'); }
      else alert('Invalid file.');
    } catch { alert('Invalid JSON.'); }
  };
  r.readAsText(f);
});
document.getElementById('clearBtn').addEventListener('click', ()=>{
  if (confirm('Delete ALL customer data permanently?')) { saveCustomers([]); navigate('dashboard'); }
});

// ---------- BOOT ----------
if (isLoggedIn()) showApp(); else showLogin();
