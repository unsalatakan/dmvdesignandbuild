/* DMV Design and Build — Project Portal server
 * No dependencies needed. Requires Node.js 18 or newer.
 * Run with:  node server.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
/* Persistent storage: on Railway, attach a Volume — its mount path is provided
 * automatically via RAILWAY_VOLUME_MOUNT_PATH so data survives deploys. */
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(STORAGE_DIR, 'data', 'db.json');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ================= Cloudflare R2 file storage (optional) =================
 * Set these env vars to store uploads in R2 instead of the local disk:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * If they are not set, files are stored locally (good for local dev). */
const R2 = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET)
  ? {
      accountId: process.env.R2_ACCOUNT_ID,
      accessKey: process.env.R2_ACCESS_KEY_ID,
      secret: process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET,
    }
  : null;
const R2_HOST = R2 ? R2.accountId + '.r2.cloudflarestorage.com' : null;

const FILE_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmacBuf = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function amzDates() {
  const amzdate = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  return { amzdate, datestamp: amzdate.slice(0, 8) };
}
function r2SigningKey(datestamp) {
  return hmacBuf(hmacBuf(hmacBuf(hmacBuf('AWS4' + R2.secret, datestamp), 'auto'), 's3'), 'aws4_request');
}

/* Signed request to R2 (AWS Signature V4, no SDK needed). */
async function r2Request(method, key, body = null, contentType = null) {
  const { amzdate, datestamp } = amzDates();
  const payloadHash = sha256hex(body || '');
  const uri = '/' + R2.bucket + '/' + key;
  const signHdrs = { host: R2_HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate };
  if (contentType) signHdrs['content-type'] = contentType;
  const names = Object.keys(signHdrs).sort();
  const canonical = [method, uri, '', names.map((n) => n + ':' + signHdrs[n] + '\n').join(''), names.join(';'), payloadHash].join('\n');
  const scope = datestamp + '/auto/s3/aws4_request';
  const sts = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonical)].join('\n');
  const sig = hmacBuf(r2SigningKey(datestamp), sts).toString('hex');
  const headers = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, authorization: 'AWS4-HMAC-SHA256 Credential=' + R2.accessKey + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + sig };
  if (contentType) headers['content-type'] = contentType;
  const resp = await fetch('https://' + R2_HOST + uri, { method, headers, body: body || undefined });
  if (!resp.ok && resp.status !== 404) throw new Error('R2 ' + method + ' failed (' + resp.status + ')');
  return resp;
}

/* Short-lived presigned download URL (browser fetches straight from R2). */
function r2PresignGet(key, expires = 300) {
  const { amzdate, datestamp } = amzDates();
  const scope = datestamp + '/auto/s3/aws4_request';
  const q = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', R2.accessKey + '/' + scope],
    ['X-Amz-Date', amzdate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).sort().join('&');
  const uri = '/' + R2.bucket + '/' + key;
  const canonical = ['GET', uri, q, 'host:' + R2_HOST + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonical)].join('\n');
  const sig = hmacBuf(r2SigningKey(datestamp), sts).toString('hex');
  return 'https://' + R2_HOST + uri + '?' + q + '&X-Amz-Signature=' + sig;
}

/* Store / delete an uploaded file (R2 when configured, local disk otherwise). */
async function storeFile(f) {
  if (!f) return;
  const type = FILE_TYPES[path.extname(f.filename).toLowerCase()] || 'application/octet-stream';
  if (R2) await r2Request('PUT', f.filename, f.buffer, type);
  else fs.writeFileSync(path.join(UPLOAD_DIR, f.filename), f.buffer);
}
async function deleteFile(name) {
  if (R2) { try { await r2Request('DELETE', name); } catch {} }
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch {}
}

/* ================= tiny JSON database ================= */
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
let db;
function nextId() { return db.seq++; }
function loadDb() {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  else db = { users: [], projects: [], seq: 1 };
  if (!db.sessions) db.sessions = {};
  if (!db.users.some((u) => u.role === 'admin')) {
    db.users.push({ id: nextId(), username: 'dmv', password: hash('dmv123'), role: 'admin', name: 'DMV Design and Build' });
    saveDb();
  }
}
/* Atomic save: write to a temp file first, then rename over the real one,
 * so a crash mid-write can never corrupt the database. */
function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
loadDb();

/* ================= sessions (stored in db so logins survive deploys) ================= */
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
function pruneSessions() {
  const now = Date.now();
  for (const sid of Object.keys(db.sessions)) if (db.sessions[sid].expires < now) delete db.sessions[sid];
}
function getSession(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = db.sessions[m[1]];
  if (!s || s.expires < Date.now()) return null;
  const u = db.users.find((x) => x.id === s.userId);
  return u ? { id: u.id, username: u.username, role: u.role, name: u.name } : null;
}
function createSession(res, user) {
  const sid = crypto.randomBytes(24).toString('hex');
  pruneSessions();
  db.sessions[sid] = { userId: user.id, expires: Date.now() + SESSION_TTL };
  saveDb();
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
}
function destroySession(req, res) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m && db.sessions[m[1]]) { delete db.sessions[m[1]]; saveDb(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
}

/* ================= login rate limiting ================= */
const loginAttempts = new Map(); // ip -> { count, until }
function loginBlocked(ip) {
  const a = loginAttempts.get(ip);
  return a && a.until > Date.now();
}
function loginFailed(ip) {
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0; }
  loginAttempts.set(ip, a);
}

/* ================= helpers ================= */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 60 * 1024 * 1024) { reject(new Error('File too large (max 60 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---- multipart/form-data parser ---- */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Bad multipart request');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}, files = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    let start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break; // final boundary
    if (buf.slice(start, start + 2).toString() === '\r\n') start += 2;
    let next = buf.indexOf(boundary, start);
    if (next === -1) break;
    let part = buf.slice(start, next);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.slice(0, headEnd).toString();
      const body = part.slice(headEnd + 4);
      const nameM = /name="([^"]*)"/.exec(head);
      const fileM = /filename="([^"]*)"/.exec(head);
      if (nameM) {
        if (fileM && fileM[1]) {
          const original = fileM[1];
          const safe = Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '_' + original.replace(/[^a-zA-Z0-9._-]/g, '_');
          files[nameM[1]] = { filename: safe, originalname: original, size: body.length, buffer: body };
        } else if (!fileM) {
          fields[nameM[1]] = body.toString('utf8');
        }
      }
    }
    pos = next;
  }
  return { fields, files };
}

/* ---- minimal XLSX (zip) reader ---- */
function unzip(buf) {
  const files = {};
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString();
    // local header
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of ref) { if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64); else break; } return n - 1; };

function parseXlsx(buf) {
  const files = unzip(buf);
  // shared strings
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString();
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      const ts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      shared.push(xmlDecode(ts.map((t) => t.replace(/<t[^>]*>|<\/t>/g, '')).join('')));
    }
  }
  // worksheet list with names (workbook.xml + its rels), so we can prefer a "Summary" tab
  const sheetsByName = []; // { name, path } in workbook order
  if (files['xl/workbook.xml'] && files['xl/_rels/workbook.xml.rels']) {
    const wbRels = {};
    for (const rel of files['xl/_rels/workbook.xml.rels'].toString().match(/<Relationship [^>]*\/>/g) || []) {
      const id = /Id="([^"]+)"/.exec(rel);
      const target = /Target="([^"]+)"/.exec(rel);
      if (id && target) wbRels[id[1]] = 'xl/' + target[1].replace(/^\//, '').replace(/^xl\//, '');
    }
    for (const sh of files['xl/workbook.xml'].toString().match(/<sheet [^>]*\/>/g) || []) {
      const name = /name="([^"]+)"/.exec(sh);
      const rid = /r:id="([^"]+)"/.exec(sh);
      if (name && rid && wbRels[rid[1]] && files[wbRels[rid[1]]]) sheetsByName.push({ name: xmlDecode(name[1]), path: wbRels[rid[1]] });
    }
  }
  // prefer a sheet named "Summary" (our material takeoff template), else the first sheet
  let sheetPath = null;
  const summarySheet = sheetsByName.find((s) => /summary|material list|order/i.test(s.name));
  if (summarySheet) sheetPath = summarySheet.path;
  else if (sheetsByName.length) sheetPath = sheetsByName[0].path;
  if (!sheetPath || !files[sheetPath]) {
    sheetPath = 'xl/worksheets/sheet1.xml';
    if (!files[sheetPath]) {
      const cand = Object.keys(files).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
      if (cand) sheetPath = cand;
    }
  }
  if (!files[sheetPath]) throw new Error('No worksheet found in file');
  const sheet = files[sheetPath].toString();
  // hyperlinks: ref -> target (via sheet rels)
  const linkByRef = {};
  const relsPath = 'xl/worksheets/_rels/' + sheetPath.split('/').pop() + '.rels';
  const relTargets = {};
  if (files[relsPath]) {
    for (const rel of files[relsPath].toString().match(/<Relationship [^>]*\/>/g) || []) {
      const id = /Id="([^"]+)"/.exec(rel);
      const target = /Target="([^"]+)"/.exec(rel);
      if (id && target) relTargets[id[1]] = xmlDecode(target[1]);
    }
  }
  for (const hl of sheet.match(/<hyperlink [^>]*\/>/g) || []) {
    const ref = /ref="([^"]+)"/.exec(hl);
    const rid = /r:id="([^"]+)"/.exec(hl);
    const loc = /location="([^"]+)"/.exec(hl);
    if (ref) linkByRef[ref[1]] = rid && relTargets[rid[1]] ? relTargets[rid[1]] : loc ? loc[1] : '';
  }
  // rows
  const rows = [];
  const links = {}; // rowIdx -> array of urls present in that row
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const rowNum = Number((/r="(\d+)"/.exec(rowXml) || [])[1] || rows.length + 1);
    const row = [];
    for (const cellXml of rowXml.match(/<c [^>]*\/>|<c [^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (/r="([A-Z]+\d+)"/.exec(cellXml) || [])[1];
      const type = (/t="([^"]+)"/.exec(cellXml) || [])[1];
      let value = '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(cellXml);
      const is = /<is>[\s\S]*?<\/is>/.exec(cellXml);
      if (type === 's' && v) value = shared[Number(v[1])] ?? '';
      else if (type === 'inlineStr' && is) value = xmlDecode((is[0].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<t[^>]*>|<\/t>/g, '')).join(''));
      else if (v) value = xmlDecode(v[1]);
      const ci = ref ? colIndex(ref) : row.length;
      row[ci] = value;
      if (ref && linkByRef[ref]) {
        (links[rowNum - 1] = links[rowNum - 1] || [])[ci] = linkByRef[ref];
        if (!value) row[ci] = linkByRef[ref];
      }
    }
    rows[rowNum - 1] = row;
  }
  return { rows: rows.map((r) => r || []), links };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return { rows, links: {} };
}

/* ---- material list extraction ---- */
function parsePrice(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
const looksLikeLink = (s) => /^https?:\/\//i.test(String(s).trim()) || /^www\./i.test(String(s).trim());
function rowLink(r, links, i, preferCol) {
  let link = preferCol !== -1 && preferCol !== undefined ? String(r[preferCol] || '').trim() : '';
  if (links[i] && !looksLikeLink(link)) {
    const hl = preferCol !== -1 && links[i][preferCol] ? links[i][preferCol] : Object.values(links[i]).find(Boolean);
    if (hl) link = hl;
  }
  if (!looksLikeLink(link)) { const found = r.find((c) => looksLikeLink(c)); link = found ? String(found).trim() : ''; }
  if (link && /^www\./i.test(link)) link = 'https://' + link;
  return looksLikeLink(link) ? link : '';
}

/* Material-takeoff template (Summary tab): Category | Item | Quantity | Unit | Unit Cost | Total Cost | Supplier Link.
 * Subtotal rows (no unit/total cost) and the grand-total row are skipped. */
function extractTakeoff(keep, links) {
  let headerAt = -1, H = null;
  for (let k = 0; k < Math.min(keep.length, 15); k++) {
    const heads = keep[k].r.map((c) => String(c).trim().toLowerCase());
    const has = (fn) => heads.findIndex(fn);
    const cat = has((h) => h === 'category');
    const item = has((h) => h === 'item' || h === 'material' || h === 'description');
    const qty = has((h) => h.startsWith('quantity') || h === 'qty' || h.startsWith('qty'));
    if (cat !== -1 && item !== -1 && qty !== -1) {
      H = {
        cat, item, qty,
        unit: has((h) => h === 'unit' || h === 'uom'),
        price: has((h) => h.startsWith('unit cost') || h.startsWith('unit price')),
        total: has((h) => h.startsWith('total cost') || h.startsWith('total price')),
        link: has((h) => h.includes('link') || h.includes('supplier')),
      };
      headerAt = k;
      break;
    }
  }
  if (!H) return null;
  const materials = [];
  for (const { r, i } of keep.slice(headerAt + 1)) {
    const name = String(r[H.item] || '').trim();
    const allText = r.map((c) => String(c)).join(' ');
    if (/grand total/i.test(allText)) continue;         // grand-total row
    if (!name) continue;                                 // notes / spacer rows
    const price = H.price !== -1 ? parsePrice(r[H.price]) : 0;
    const totalCost = H.total !== -1 ? parsePrice(r[H.total]) : 0;
    if (!price && !totalCost) continue;                  // subtotal / info-only row: nothing to order
    const qty = parsePrice(r[H.qty]) || 1;
    materials.push({
      category: H.cat !== -1 ? String(r[H.cat] || '').trim() || 'Other' : 'Other',
      name,
      unit: H.unit !== -1 ? String(r[H.unit] || '').trim() : '',
      qty,
      price: price || (qty ? totalCost / qty : totalCost),
      link: rowLink(r, links, i, H.link),
    });
  }
  return materials.length ? materials : null;
}

function extractMaterials(parsed) {
  let { rows, links } = parsed;
  const keep = [];
  rows.forEach((r, i) => { if (r.some((c) => String(c).trim() !== '')) keep.push({ r, i }); });
  if (!keep.length) return { materials: [], error: 'The file is empty' };
  const takeoff = extractTakeoff(keep, links);
  if (takeoff) return { materials: takeoff };
  const heads = keep[0].r.map((c) => String(c).trim().toLowerCase());
  const findCol = (...keys) => heads.findIndex((h) => keys.some((k) => h.includes(k)));
  let cName = findCol('material', 'item', 'name', 'description', 'product');
  let cLink = findCol('link', 'url', 'purchase', 'website', 'store');
  let cPrice = findCol('price', 'cost');
  let cQty = findCol('qty', 'quantity', 'count', 'units');
  const hasHeader = cName !== -1 || cPrice !== -1 || cLink !== -1;
  const dataRows = hasHeader ? keep.slice(1) : keep;
  if (cName === -1) cName = 0;
  const materials = dataRows
    .map(({ r, i }) => {
      let price = 0;
      if (cPrice !== -1) price = parsePrice(r[cPrice]);
      else { const nums = r.filter((c, ci) => ci !== cName && !looksLikeLink(c) && parsePrice(c) > 0); if (nums.length) price = parsePrice(nums[nums.length - 1]); }
      return {
        category: 'Other',
        name: String(r[cName] || '').trim(),
        unit: '',
        link: rowLink(r, links, i, cLink),
        price,
        qty: cQty !== -1 ? parsePrice(r[cQty]) || 1 : 1,
      };
    })
    .filter((m) => m.name && !looksLikeLink(m.name));
  return { materials };
}

/* ---- geocoding (OpenStreetMap Nominatim) ---- */
async function geocode(address) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
    const r = await fetch(url, { headers: { 'User-Agent': 'DMV-Design-Build-Portal/1.0 (info@dmv-designandbuild.com)' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j && j[0]) return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
  } catch (e) { console.error('Geocode failed:', e.message); }
  return { lat: null, lng: null };
}

/* ================= API handlers ================= */
function projectOut(p, user) {
  const customer = db.users.find((u) => u.id === p.customerId);
  const base = { ...p, customerName: customer ? customer.name : null };
  if (user.role === 'customer') { const { materials, notes, payments, ...rest } = base; return rest; }
  return base;
}
function findProject(id, user) {
  const p = db.projects.find((x) => x.id === Number(id));
  if (!p) return { error: [404, 'Project not found'] };
  if (user.role !== 'admin' && p.customerId !== user.id) return { error: [403, 'No access'] };
  return { p };
}

const routes = [];
function route(method, pattern, handler, opts = {}) { routes.push({ method, pattern, handler, ...opts }); }

route('POST', /^\/api\/login$/, async (req, res, m, body) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  if (loginBlocked(ip)) return json(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
  const { username, password } = body || {};
  const u = db.users.find((x) => x.username === String(username || '').trim().toLowerCase() && x.password === hash(password || ''));
  if (!u) { loginFailed(ip); return json(res, 401, { error: 'Invalid username or password' }); }
  loginAttempts.delete(ip);
  const user = { id: u.id, username: u.username, role: u.role, name: u.name };
  createSession(res, user);
  json(res, 200, user);
}, { public: true });

route('POST', /^\/api\/logout$/, (req, res) => { destroySession(req, res); json(res, 200, { ok: true }); }, { public: true });
route('GET', /^\/api\/me$/, (req, res, m, b, user) => json(res, 200, user || null), { public: true });

/* customers */
route('GET', /^\/api\/customers$/, (req, res, m, b, user) => {
  json(res, 200, db.users.filter((u) => u.role === 'customer').map(({ password, ...u }) => ({
    ...u, projectCount: db.projects.filter((p) => p.customerId === u.id).length,
  })));
}, { admin: true });

route('POST', /^\/api\/customers$/, (req, res, m, body) => {
  const { name, username, password } = body || {};
  if (!name || !username || !password) return json(res, 400, { error: 'Name, username and password are required' });
  const uname = String(username).trim().toLowerCase();
  if (db.users.some((u) => u.username === uname)) return json(res, 400, { error: 'Username already exists' });
  const c = { id: nextId(), username: uname, password: hash(password), role: 'customer', name: String(name).trim() };
  db.users.push(c); saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('PUT', /^\/api\/customers\/(\d+)$/, (req, res, m, body) => {
  const c = db.users.find((u) => u.id === Number(m[1]) && u.role === 'customer');
  if (!c) return json(res, 404, { error: 'Customer not found' });
  if (body.name) c.name = String(body.name).trim();
  if (body.password) c.password = hash(body.password);
  saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('DELETE', /^\/api\/customers\/(\d+)$/, (req, res, m) => {
  db.users = db.users.filter((u) => !(u.id === Number(m[1]) && u.role === 'customer'));
  db.projects.forEach((p) => { if (p.customerId === Number(m[1])) p.customerId = null; });
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* projects */
route('GET', /^\/api\/projects$/, (req, res, m, b, user) => {
  const list = user.role === 'admin' ? db.projects : db.projects.filter((p) => p.customerId === user.id);
  json(res, 200, list.map((p) => projectOut(p, user)));
});

route('GET', /^\/api\/projects\/(\d+)$/, (req, res, m, b, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  json(res, 200, projectOut(p, user));
});

route('POST', /^\/api\/projects$/, async (req, res, m, body, user) => {
  const { fields, files } = body;
  if (!fields.name || !fields.address) return json(res, 400, { error: 'Name and address are required' });
  await storeFile(files.contract);
  await storeFile(files.plan);
  const geo = await geocode(fields.address);
  const p = {
    id: nextId(),
    name: fields.name, address: fields.address,
    price: Number(fields.price) || 0,
    startDate: fields.startDate || null,
    customerId: fields.customerId ? Number(fields.customerId) : null,
    lat: geo.lat, lng: geo.lng,
    contractFile: files.contract ? files.contract.filename : null,
    contractName: files.contract ? files.contract.originalname : null,
    planFile: files.plan ? files.plan.filename : null,
    planName: files.plan ? files.plan.originalname : null,
    materialFileName: null, materials: [], notes: [], payments: [], photos: [],
    created: new Date().toISOString(),
  };
  db.projects.push(p); saveDb();
  json(res, 200, projectOut(p, user));
}, { admin: true, multipart: true });

route('PUT', /^\/api\/projects\/(\d+)$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const { fields, files } = body;
  if (fields.name) p.name = fields.name;
  if (fields.price !== undefined) p.price = Number(fields.price) || 0;
  if (fields.startDate !== undefined) p.startDate = fields.startDate || null;
  if (fields.customerId !== undefined) p.customerId = fields.customerId ? Number(fields.customerId) : null;
  if (fields.address && fields.address !== p.address) {
    p.address = fields.address;
    const geo = await geocode(fields.address);
    p.lat = geo.lat; p.lng = geo.lng;
  }
  if (files.contract) { await storeFile(files.contract); p.contractFile = files.contract.filename; p.contractName = files.contract.originalname; }
  if (files.plan) { await storeFile(files.plan); p.planFile = files.plan.filename; p.planName = files.plan.originalname; }
  saveDb();
  json(res, 200, projectOut(p, user));
}, { admin: true, multipart: true });

route('DELETE', /^\/api\/projects\/(\d+)$/, (req, res, m) => {
  db.projects = db.projects.filter((p) => p.id !== Number(m[1]));
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* materials */
route('POST', /^\/api\/projects\/(\d+)\/materials$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const file = body.files.excel;
  if (!file) return json(res, 400, { error: 'No file uploaded' });
  let parsed;
  try {
    if (/\.csv$/i.test(file.originalname)) parsed = parseCsv(file.buffer.toString('utf8'));
    else parsed = parseXlsx(file.buffer);
  } catch (e) {
    return json(res, 400, { error: 'Could not read the file. Please upload an .xlsx or .csv file. (' + e.message + ')' });
  }
  const { materials, error: exErr } = extractMaterials(parsed);
  if (exErr) return json(res, 400, { error: exErr });
  if (!materials.length) return json(res, 400, { error: 'No materials found. Make sure the sheet has a column with material names.' });
  p.materials = materials.map((mat) => ({ id: nextId(), ...mat, ordered: false }));
  p.materialFileName = file.originalname;
  saveDb();
  json(res, 200, projectOut(p, user));
}, { admin: true, multipart: true });

route('PUT', /^\/api\/projects\/(\d+)\/materials\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const mat = p.materials.find((x) => x.id === Number(m[2]));
  if (!mat) return json(res, 404, { error: 'Material not found' });
  if (body.ordered !== undefined) {
    mat.ordered = !!body.ordered;
    mat.orderedAt = mat.ordered ? new Date().toISOString() : null;
  }
  saveDb(); json(res, 200, mat);
}, { admin: true });

/* notes */
route('POST', /^\/api\/projects\/(\d+)\/notes$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  if (!body.text || !String(body.text).trim()) return json(res, 400, { error: 'Note text required' });
  const n = { id: nextId(), text: String(body.text).trim(), done: false, created: new Date().toISOString() };
  p.notes.push(n); saveDb(); json(res, 200, n);
}, { admin: true });

route('PUT', /^\/api\/projects\/(\d+)\/notes\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const n = p.notes.find((x) => x.id === Number(m[2]));
  if (!n) return json(res, 404, { error: 'Note not found' });
  if (body.done !== undefined) n.done = !!body.done;
  if (body.text !== undefined) n.text = String(body.text).trim();
  saveDb(); json(res, 200, n);
}, { admin: true });

route('DELETE', /^\/api\/projects\/(\d+)\/notes\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  p.notes = p.notes.filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* payments */
route('POST', /^\/api\/projects\/(\d+)\/payments$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return json(res, 400, { error: 'A valid amount is required' });
  p.payments = p.payments || [];
  const pay = {
    id: nextId(),
    amount,
    date: body.date || new Date().toISOString().slice(0, 10),
    note: String(body.note || '').trim(),
    created: new Date().toISOString(),
  };
  p.payments.push(pay); saveDb(); json(res, 200, pay);
}, { admin: true });

route('DELETE', /^\/api\/projects\/(\d+)\/payments\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  p.payments = (p.payments || []).filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* photos */
route('POST', /^\/api\/projects\/(\d+)\/photos$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const f = body.files.photo;
  if (!f) return json(res, 400, { error: 'No photo uploaded' });
  if (!/\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.originalname)) return json(res, 400, { error: 'Only image files are allowed' });
  await storeFile(f);
  const t = body.files.thumb && /\.(jpe?g|png|webp)$/i.test(body.files.thumb.filename) ? body.files.thumb : null;
  if (t) await storeFile(t);
  p.photos = p.photos || [];
  const ph = { id: nextId(), file: f.filename, thumb: t ? t.filename : null, name: f.originalname, uploaded: new Date().toISOString() };
  p.photos.push(ph); saveDb(); json(res, 200, ph);
}, { admin: true, multipart: true });

route('DELETE', /^\/api\/projects\/(\d+)\/photos\/(\d+)$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const ph = (p.photos || []).find((x) => x.id === Number(m[2]));
  if (ph) { await deleteFile(ph.file); if (ph.thumb) await deleteFile(ph.thumb); }
  p.photos = (p.photos || []).filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* protected file downloads */
route('GET', /^\/api\/file\/([^/]+)$/, (req, res, m, b, user) => {
  const name = path.basename(decodeURIComponent(m[1]));
  const owner = db.projects.find((p) => [p.contractFile, p.planFile].includes(name) || (p.photos || []).some((ph) => ph.file === name || ph.thumb === name));
  if (user.role !== 'admin' && (!owner || owner.customerId !== user.id)) return json(res, 403, { error: 'No access' });
  const fp = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(fp)) {
    res.writeHead(200, { 'Content-Type': FILE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(fp).pipe(res);
  }
  if (R2) { res.writeHead(302, { Location: r2PresignGet(name) }); return res.end(); }
  return json(res, 404, { error: 'File not found' });
});

/* ================= static files + server ================= */
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function serveStatic(req, res, urlPath) {
  let fp = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) fp = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURI(req.url.split('?')[0]);
    if (!urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);

    const user = getSession(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(urlPath);
      if (!m) continue;
      if (!r.public && !user) return json(res, 401, { error: 'Not logged in' });
      if (r.admin && (!user || user.role !== 'admin')) return json(res, 403, { error: 'Admins only' });
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        const ct = req.headers['content-type'] || '';
        if (r.multipart && ct.includes('multipart/form-data')) body = parseMultipart(raw, ct);
        else if (r.multipart) body = { fields: {}, files: {} };
        else body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
      return await r.handler(req, res, m, body, user);
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Server error: ' + e.message });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  DMV Design and Build — Project Portal');
  console.log('  Running at:  http://localhost:' + PORT);
  console.log('  Admin login: dmv / dmv123');
  console.log('');
});
