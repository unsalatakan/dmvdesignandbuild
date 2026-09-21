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
/* Our own company name. Used to name the general-spending bucket, and to tell the
 * check scanner that this name on a check is always the payer, never the payee. */
const COMPANY_NAME = process.env.COMPANY_NAME || 'DMV Design and Build';
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

/* ================= tax ID encryption =================
 * Contractor EIN/SSN is encrypted at rest with AES-256-GCM so the raw number never
 * sits in db.json. The key comes from env var TAXID_KEY (any passphrase; it is
 * stretched with scrypt). Lose the key and the stored numbers are unrecoverable —
 * only the last 4 digits, which are kept in the clear for matching, survive. */
const TAXID_KEY = (process.env.TAXID_KEY || '').trim();
let taxKey = null;
function taxKeyOrNull() {
  if (!TAXID_KEY) return null;
  if (!taxKey) taxKey = crypto.scryptSync(TAXID_KEY, 'dmv-portal-taxid', 32);
  return taxKey;
}
function encryptTaxId(plain) {
  const key = taxKeyOrNull();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decryptTaxId(blob) {
  const key = taxKeyOrNull();
  if (!key || !blob) return null;
  try {
    const [iv, tag, data] = String(blob).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }   // wrong key, or the value was tampered with
}

/* ================= tiny JSON database ================= */
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
let db;
function nextId() { return db.seq++; }
function loadDb() {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  else db = { users: [], projects: [], seq: 1 };
  if (!db.sessions) db.sessions = {};
  if (!db.todos) db.todos = [];        // general to-do list, not tied to any job
  if (!db.receipts) db.receipts = [];  // receipt inbox, waiting to be filed to a job
  if (!db.contractors) db.contractors = [];
  if (!db.checks) db.checks = [];
  /* A standing bucket for spending that belongs to no job — fuel, tools, office,
   * anything general. It is a project so receipts, checks and invoices all work on
   * it unchanged, but it is flagged so it stays out of job lists, the map and every
   * contract-value or profit figure. */
  if (!db.projects.some((p) => p.overhead)) {
    db.projects.push({
      id: nextId(), overhead: true,
      name: COMPANY_NAME + ' — General',
      address: '', lockbox: null, price: 0, startDate: null, status: 'active',
      customerId: null, pmId: null, lat: null, lng: null,
      contractFile: null, contractName: null, planFile: null, planName: null,
      materialFileName: null, materials: [], notes: [], payments: [], dues: [], invoices: [], photos: [],
      created: new Date().toISOString(),
    });
    saveDb();
  }
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
function loginFailed(ip, username) {
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0; sendLoginAlert(ip, username); }
  loginAttempts.set(ip, a);
}

/* ================= security alert emails =================
 * Sends an email (via Resend, https://resend.com) when an IP gets blocked
 * for repeated failed logins. Set env var RESEND_API_KEY to enable.
 * Optional: ALERT_EMAIL (recipient), RESEND_FROM (verified sender). */
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'info@dmv-designandbuild.com';
const RESEND_FROM = process.env.RESEND_FROM || 'DMV Portal Security <onboarding@resend.dev>';
const alertsSent = new Map(); // ip -> last alert timestamp (max 1 email per IP per hour)

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) { console.log('Email skipped (RESEND_API_KEY not set):', subject); return; }
  if (!to) return;
  console.log('Sending email to', to, '—', subject);
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(8000),
    }).then(async (r) => { if (!r.ok) console.error('Email rejected by Resend (' + r.status + '):', await r.text()); else console.log('Email sent to', to); });
  } catch (e) { console.error('Email failed:', e.message); }
}

async function sendLoginAlert(ip, username) {
  if ((alertsSent.get(ip) || 0) > Date.now() - 60 * 60 * 1000) { console.log('Login alert throttled for', ip); return; }
  alertsSent.set(ip, Date.now());
  let loc = 'Unknown';
  try {
    const r = await fetch('https://ipwho.is/' + encodeURIComponent(ip), { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j && j.success) loc = [j.city, j.region, j.country].filter(Boolean).join(', ') + (j.connection && j.connection.isp ? ' — ' + j.connection.isp : '');
  } catch {}
  await sendEmail(ALERT_EMAIL, '⚠ Portal security: repeated failed logins blocked (' + ip + ')',
    'Someone was blocked after 5 failed login attempts on the portal.\n\n'
    + 'IP address: ' + ip + '\n'
    + 'Location: ' + loc + '\n'
    + 'Last username tried: ' + (username || '(empty)') + '\n'
    + 'Time: ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' (ET)\n\n'
    + 'The IP is blocked for 15 minutes. If these alerts keep coming, consider changing your passwords.');
}

/* ================= customer notifications =================
 * Emails the assigned customer when new documents or photos are added.
 * Max one email per project per type per hour, so photo batches = one email.
 * Requires the customer to have an email set, and RESEND_FROM to use a
 * domain verified in Resend (onboarding@resend.dev can't email customers). */
const notifySent = new Map(); // "projectId:kind" -> last timestamp
function notifyCustomer(p, kind, detail) {
  const c = db.users.find((u) => u.id === p.customerId && u.role === 'customer');
  if (!c || !c.email) return;
  const key = p.id + ':' + kind;
  if ((notifySent.get(key) || 0) > Date.now() - 60 * 60 * 1000) return;
  notifySent.set(key, Date.now());
  sendEmail(c.email, 'Update on your project: ' + p.name,
    'Hi ' + c.name + ',\n\n' + detail + '\n\nLog in to the portal to take a look.\n\n— DMV Design and Build\ninfo@dmv-designandbuild.com');
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
  const pm = db.users.find((u) => u.id === p.pmId && u.role === 'pm');
  const base = { ...p, customerName: customer ? customer.name : null, pmName: pm ? pm.name : null };
  // customers see the contract price and nothing else money-related:
  // no material costs, no internal notes, no receipts, no payment schedule
  if (user.role === 'customer') { const { materials, notes, payments, dues, invoices, ...rest } = base; return rest; }
  // delivery sees where the job is and what it has cost — not what it sells for,
  // not what has been paid in, and not the material order list
  if (user.role === 'delivery') {
    const { materials, notes, payments, dues, price, ...rest } = base;
    return rest;
  }
  return base;
}
function canAccess(p, user) {
  if (user.role === 'admin') return true;
  if (user.role === 'delivery') return true;          // needs every address to deliver to
  if (user.role === 'pm') return p.pmId === user.id;
  return p.customerId === user.id;
}
function findProject(id, user) {
  const p = db.projects.find((x) => x.id === Number(id));
  if (!p) return { error: [404, 'Project not found'] };
  if (!canAccess(p, user)) return { error: [403, 'No access'] };
  return { p };
}

const routes = [];
function route(method, pattern, handler, opts = {}) { routes.push({ method, pattern, handler, ...opts }); }

route('POST', /^\/api\/login$/, async (req, res, m, body) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  if (loginBlocked(ip)) return json(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
  const { username, password } = body || {};
  const u = db.users.find((x) => x.username === String(username || '').trim().toLowerCase() && x.password === hash(password || ''));
  if (!u) { loginFailed(ip, String(username || '')); return json(res, 401, { error: 'Invalid username or password' }); }
  loginAttempts.delete(ip);
  const user = { id: u.id, username: u.username, role: u.role, name: u.name };
  createSession(res, user);
  json(res, 200, user);
}, { public: true });

route('POST', /^\/api\/logout$/, (req, res) => { destroySession(req, res); json(res, 200, { ok: true }); }, { public: true });
route('GET', /^\/api\/me$/, (req, res, m, b, user) => json(res, 200, user || null), { public: true });

/* change own password (any logged-in user) */
route('PUT', /^\/api\/password$/, (req, res, m, body, user) => {
  const { current, next } = body || {};
  if (!next || String(next).length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
  const u = db.users.find((x) => x.id === user.id);
  if (!u || u.password !== hash(current || '')) return json(res, 400, { error: 'Current password is incorrect' });
  u.password = hash(String(next));
  saveDb(); json(res, 200, { ok: true });
});

/* customers */
route('GET', /^\/api\/customers$/, (req, res, m, b, user) => {
  json(res, 200, db.users.filter((u) => u.role === 'customer').map(({ password, ...u }) => ({
    ...u, projectCount: db.projects.filter((p) => p.customerId === u.id).length,
  })));
}, { staff: true });

route('POST', /^\/api\/customers$/, (req, res, m, body) => {
  const { name, username, password, email } = body || {};
  if (!name || !username || !password) return json(res, 400, { error: 'Name, username and password are required' });
  const uname = String(username).trim().toLowerCase();
  if (db.users.some((u) => u.username === uname)) return json(res, 400, { error: 'Username already exists' });
  const c = { id: nextId(), username: uname, password: hash(password), role: 'customer', name: String(name).trim(), email: email ? String(email).trim() : null };
  db.users.push(c); saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('PUT', /^\/api\/customers\/(\d+)$/, (req, res, m, body) => {
  const c = db.users.find((u) => u.id === Number(m[1]) && u.role === 'customer');
  if (!c) return json(res, 404, { error: 'Customer not found' });
  if (body.name) c.name = String(body.name).trim();
  if (body.password) c.password = hash(body.password);
  if (body.email !== undefined) c.email = String(body.email || '').trim() || null;
  saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('DELETE', /^\/api\/customers\/(\d+)$/, (req, res, m) => {
  db.users = db.users.filter((u) => !(u.id === Number(m[1]) && u.role === 'customer'));
  db.projects.forEach((p) => { if (p.customerId === Number(m[1])) p.customerId = null; });
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* project managers */
route('GET', /^\/api\/pms$/, (req, res, m, b, user) => {
  json(res, 200, db.users.filter((u) => u.role === 'pm').map(({ password, ...u }) => ({
    ...u, projectCount: db.projects.filter((p) => p.pmId === u.id).length,
  })));
}, { staff: true });

route('POST', /^\/api\/pms$/, (req, res, m, body) => {
  const { name, username, password, email } = body || {};
  if (!name || !username || !password) return json(res, 400, { error: 'Name, username and password are required' });
  const uname = String(username).trim().toLowerCase();
  if (db.users.some((u) => u.username === uname)) return json(res, 400, { error: 'Username already exists' });
  const c = { id: nextId(), username: uname, password: hash(password), role: 'pm', name: String(name).trim(), email: email ? String(email).trim() : null };
  db.users.push(c); saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('PUT', /^\/api\/pms\/(\d+)$/, (req, res, m, body) => {
  const c = db.users.find((u) => u.id === Number(m[1]) && u.role === 'pm');
  if (!c) return json(res, 404, { error: 'Project manager not found' });
  if (body.name) c.name = String(body.name).trim();
  if (body.password) c.password = hash(body.password);
  if (body.email !== undefined) c.email = String(body.email || '').trim() || null;
  saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('DELETE', /^\/api\/pms\/(\d+)$/, (req, res, m) => {
  db.users = db.users.filter((u) => !(u.id === Number(m[1]) && u.role === 'pm'));
  db.projects.forEach((p) => { if (p.pmId === Number(m[1])) p.pmId = null; });
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* delivery crew logins */
route('GET', /^\/api\/delivery$/, (req, res) => {
  json(res, 200, db.users.filter((u) => u.role === 'delivery').map(({ password, ...u }) => u));
}, { admin: true });

route('POST', /^\/api\/delivery$/, (req, res, m, body) => {
  const { name, username, password } = body || {};
  if (!name || !username || !password) return json(res, 400, { error: 'Name, username and password are required' });
  if (db.users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
    return json(res, 400, { error: 'That username is already taken' });
  }
  const c = { id: nextId(), username: String(username).trim(), password: hash(password), role: 'delivery', name: String(name).trim() };
  db.users.push(c); saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('PUT', /^\/api\/delivery\/(\d+)$/, (req, res, m, body) => {
  const c = db.users.find((u) => u.id === Number(m[1]) && u.role === 'delivery');
  if (!c) return json(res, 404, { error: 'Delivery user not found' });
  if (body.name) c.name = String(body.name).trim();
  if (body.password) c.password = hash(body.password);
  saveDb();
  const { password: _, ...out } = c;
  json(res, 200, out);
}, { admin: true });

route('DELETE', /^\/api\/delivery\/(\d+)$/, (req, res, m) => {
  db.users = db.users.filter((u) => !(u.id === Number(m[1]) && u.role === 'delivery'));
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* projects */
route('GET', /^\/api\/projects$/, (req, res, m, b, user) => {
  const list = db.projects.filter((p) => canAccess(p, user));
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
    lockbox: (fields.lockbox || '').trim() || null,
    price: Number(fields.price) || 0,
    startDate: fields.startDate || null,
    status: ['talks', 'upcoming', 'active', 'done'].includes(fields.status) ? fields.status : 'active',
    customerId: fields.customerId ? Number(fields.customerId) : null,
    pmId: fields.pmId ? Number(fields.pmId) : null,
    lat: geo.lat, lng: geo.lng,
    contractFile: files.contract ? files.contract.filename : null,
    contractName: files.contract ? files.contract.originalname : null,
    planFile: files.plan ? files.plan.filename : null,
    planName: files.plan ? files.plan.originalname : null,
    materialFileName: null, materials: [], notes: [], payments: [], dues: [], invoices: [], photos: [],
    created: new Date().toISOString(),
  };
  db.projects.push(p); saveDb();
  if (files.contract || files.plan) notifyCustomer(p, 'doc', 'New documents were uploaded to your project "' + p.name + '".');
  json(res, 200, projectOut(p, user));
}, { admin: true, multipart: true });

route('PUT', /^\/api\/projects\/(\d+)$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const { fields, files } = body;
  if (fields.name) p.name = fields.name;
  if (fields.lockbox !== undefined) p.lockbox = (fields.lockbox || '').trim() || null;
  if (fields.price !== undefined) p.price = Number(fields.price) || 0;
  if (fields.startDate !== undefined) p.startDate = fields.startDate || null;
  if (fields.status !== undefined && ['talks', 'upcoming', 'active', 'done'].includes(fields.status)) p.status = fields.status;
  if (fields.customerId !== undefined) p.customerId = fields.customerId ? Number(fields.customerId) : null;
  if (fields.pmId !== undefined) p.pmId = fields.pmId ? Number(fields.pmId) : null;
  if (fields.address && fields.address !== p.address) {
    p.address = fields.address;
    const geo = await geocode(fields.address);
    p.lat = geo.lat; p.lng = geo.lng;
  }
  if (files.contract) { await storeFile(files.contract); p.contractFile = files.contract.filename; p.contractName = files.contract.originalname; }
  if (files.plan) { await storeFile(files.plan); p.planFile = files.plan.filename; p.planName = files.plan.originalname; }
  saveDb();
  if (files.contract || files.plan) notifyCustomer(p, 'doc', 'New documents were uploaded to your project "' + p.name + '".');
  json(res, 200, projectOut(p, user));
}, { staff: true, multipart: true });

route('DELETE', /^\/api\/projects\/(\d+)$/, (req, res, m) => {
  const target = db.projects.find((p) => p.id === Number(m[1]));
  if (target && target.overhead) return json(res, 400, { error: 'The general spending bucket cannot be deleted.' });
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
}, { staff: true, multipart: true });

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
}, { staff: true });

/* ---- expense categories ----
 * Every job cost carries one. They drive the P&L and the year-end tax summary, so
 * the list is deliberately short and maps onto the lines a contractor actually files. */
const EXPENSE_CATEGORIES = [
  'Materials', 'Subcontractor', 'Labor', 'Permits & Fees', 'Equipment Rental',
  'Tools', 'Fuel & Vehicle', 'Insurance', 'Office & Admin', 'Other',
];
const cleanCategory = (v) => {
  const want = String(v || '').trim().toLowerCase();
  return EXPENSE_CATEGORIES.find((c) => c.toLowerCase() === want) || 'Other';
};

route('GET', /^\/api\/expense-categories$/, (req, res) => {
  json(res, 200, EXPENSE_CATEGORIES);
}, { crew: true });

/* ---- receipt scanning ----
 * Sends a receipt photo/PDF to Claude and gets back the vendor, total and date.
 * Set env var ANTHROPIC_API_KEY to enable; without it the endpoint reports
 * "not configured" and the invoice form simply stays on manual entry. */
const SCAN_MODEL = process.env.SCAN_MODEL || 'claude-haiku-4-5-20251001';
/* Hosting dashboards happily store a key with stray quotes or whitespace around it,
 * which the API then rejects as invalid. Clean it up rather than fail mysteriously. */
const SCAN_KEY = (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const SCAN_MEDIA = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const SCAN_PROMPT = 'This is a receipt or supplier invoice for a construction job. '
  + 'Reply with ONLY a JSON object, no prose and no code fence, using exactly these keys: '
  + '"vendor" (the business that was paid, e.g. "The Home Depot"), '
  + '"amount" (the grand total actually charged, as a plain number with no currency symbol or commas), '
  + '"date" (the transaction date as YYYY-MM-DD), '
  + '"desc" (a short description of what was bought, 6 words or fewer), '
  + '"category" (exactly one of: ' + EXPENSE_CATEGORIES.join(', ') + '). '
  + 'Use null for any field you cannot read with confidence. Never guess at the amount.';

/* Reads one receipt. Returns the parsed fields, or throws with a message fit to show. */
async function scanReceipt(f) {
  if (!SCAN_KEY) { const e = new Error('Receipt scanning is not set up on this server.'); e.code = 503; throw e; }
  const ext = path.extname(f.originalname).toLowerCase();
  const media = SCAN_MEDIA[ext];
  if (!media) {
    // HEIC is what an iPhone shoots by default; the browser converts it before upload,
    // so reaching here means that conversion did not happen.
    const e = new Error(/\.hei[cf]$/.test(ext)
      ? 'iPhone HEIC photo could not be converted for scanning'
      : 'Receipt must be a PDF or an image');
    e.code = 400; throw e;
  }
  if (f.buffer.length > 4.5 * 1024 * 1024) {
    const e = new Error('Photo too large to scan (' + (f.buffer.length / 1048576).toFixed(1) + ' MB, max 4.5 MB)');
    e.code = 400; throw e;
  }

  const source = { type: 'base64', media_type: media, data: f.buffer.toString('base64') };
  const content = [
    media === 'application/pdf' ? { type: 'document', source } : { type: 'image', source },
    { type: 'text', text: SCAN_PROMPT },
  ];
  const unreadable = () => { const e = new Error('Could not read the receipt. Enter the details by hand.'); e.code = 502; return e; };
  let out;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': SCAN_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: SCAN_MODEL, max_tokens: 300, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Receipt scan rejected (' + r.status + '):', detail);
      // these two are setup problems, not unreadable receipts — say so plainly
      if (r.status === 401 || r.status === 403) {
        const e = new Error('The API key is being rejected. Check ANTHROPIC_API_KEY on the server.');
        e.code = 502; throw e;
      }
      if (r.status === 400 && /credit/i.test(detail)) {
        const e = new Error('Out of API credits. Top up at console.anthropic.com.');
        e.code = 502; throw e;
      }
      if (r.status === 429) { const e = new Error('Scanning is rate limited right now. Try again in a moment.'); e.code = 502; throw e; }
      throw unreadable();
    }
    out = await r.json();
  } catch (e) {
    if (e.code) throw e;
    console.error('Receipt scan failed:', e.message);
    throw unreadable();
  }
  const text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);          // tolerate a stray code fence or lead-in
  if (!match) throw unreadable();
  let g;
  try { g = JSON.parse(match[0]); } catch { throw unreadable(); }
  // keep a leading minus so a refund/credit total is rejected rather than flipped positive
  const amount = Number(String(g.amount ?? '').replace(/[^0-9.-]/g, ''));
  return {
    vendor: g.vendor ? String(g.vendor).trim().slice(0, 80) : null,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(g.date || '')) ? g.date : null,
    desc: g.desc ? String(g.desc).trim().slice(0, 120) : null,
    category: cleanCategory(g.category),
  };
}

route('POST', /^\/api\/scan-receipt$/, async (req, res, m, body) => {
  const f = body.files && body.files.receipt;
  if (!f) return json(res, 400, { error: 'No file uploaded' });
  try { json(res, 200, await scanReceipt(f)); }
  catch (e) { json(res, e.code || 502, { error: e.message }); }
}, { staff: true, multipart: true });

/* invoices — money going OUT on a job: subs, suppliers, permits.
 * Internal only; the PDF is optional so a cost can be logged before the paperwork lands. */
const INVOICE_FILE_RE = /\.(pdf|png|jpe?g|webp|heic|heif)$/i;

route('POST', /^\/api\/projects\/(\d+)\/invoices$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const { fields, files } = body;
  const amount = Number(fields.amount);
  if (!amount || amount <= 0) return json(res, 400, { error: 'A valid cost is required' });
  const f = files.invoice;
  if (f && !INVOICE_FILE_RE.test(f.originalname)) return json(res, 400, { error: 'Invoice must be a PDF or an image' });
  if (f) await storeFile(f);
  p.invoices = p.invoices || [];
  const inv = {
    id: nextId(),
    desc: String(fields.desc || '').trim() || 'Invoice',
    paidTo: String(fields.paidTo || '').trim(),
    category: cleanCategory(fields.category),
    amount,
    date: fields.date || new Date().toISOString().slice(0, 10),
    file: f ? f.filename : null,
    fileName: f ? f.originalname : null,
    created: new Date().toISOString(),
  };
  p.invoices.push(inv); saveDb(); json(res, 200, inv);
}, { staff: true, multipart: true });

route('PUT', /^\/api\/projects\/(\d+)\/invoices\/(\d+)$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const inv = (p.invoices || []).find((x) => x.id === Number(m[2]));
  if (!inv) return json(res, 404, { error: 'Invoice not found' });
  const { fields, files } = body;
  if (fields.desc !== undefined) inv.desc = String(fields.desc).trim() || 'Invoice';
  if (fields.paidTo !== undefined) inv.paidTo = String(fields.paidTo).trim();
  if (fields.category !== undefined) inv.category = cleanCategory(fields.category);
  if (fields.date !== undefined) inv.date = fields.date || inv.date;
  if (fields.amount !== undefined) {
    const amount = Number(fields.amount);
    if (!amount || amount <= 0) return json(res, 400, { error: 'A valid cost is required' });
    inv.amount = amount;
  }
  const f = files.invoice;
  if (f) {
    if (!INVOICE_FILE_RE.test(f.originalname)) return json(res, 400, { error: 'Invoice must be a PDF or an image' });
    await storeFile(f);
    if (inv.file) await deleteFile(inv.file);   // replace, don't orphan the old one
    inv.file = f.filename; inv.fileName = f.originalname;
  }
  saveDb(); json(res, 200, inv);
}, { staff: true, multipart: true });

route('DELETE', /^\/api\/projects\/(\d+)\/invoices\/(\d+)$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const inv = (p.invoices || []).find((x) => x.id === Number(m[2]));
  if (inv && inv.file) await deleteFile(inv.file);
  p.invoices = (p.invoices || []).filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { staff: true });

/* ---- receipt inbox ----
 * Capture receipts on site without picking a job. Each one is scanned on upload,
 * sits in the inbox with editable fields, then gets filed to a job — which moves it
 * into that job's invoices, file and all. Staff only, like invoices themselves. */
route('GET', /^\/api\/receipts$/, (req, res) => {
  const list = (db.receipts || []).slice().sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
  json(res, 200, list);
}, { crew: true });

route('POST', /^\/api\/receipts$/, async (req, res, m, body, user) => {
  const f = body.files && body.files.receipt;
  if (!f) return json(res, 400, { error: 'No file uploaded' });
  if (!INVOICE_FILE_RE.test(f.originalname)) return json(res, 400, { error: 'Receipt must be a PDF or an image' });
  await storeFile(f);
  // a failed scan must never lose the receipt — it just lands with blank fields
  let g = { vendor: null, amount: null, date: null, desc: null };
  let scanError = null;
  try { g = await scanReceipt(f); }
  catch (e) { scanError = e.message; }
  db.receipts = db.receipts || [];
  const r = {
    id: nextId(),
    file: f.filename, fileName: f.originalname,
    desc: g.desc || '', paidTo: g.vendor || '', amount: g.amount || null,
    category: cleanCategory(g.category),
    date: g.date || new Date().toISOString().slice(0, 10),
    scanned: !scanError, scanError,
    uploaded: new Date().toISOString(), by: user.name,
  };
  db.receipts.push(r); saveDb(); json(res, 200, r);
}, { crew: true, multipart: true });

/* Read a stored file back out, wherever it lives. */
async function readStoredFile(name) {
  const fp = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(fp)) return fs.readFileSync(fp);
  if (R2) {
    try { const r = await fetch(r2PresignGet(name)); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {}
  }
  return null;
}

/* Try reading a receipt again — for when the first attempt hit a rate limit or a
 * hiccup. Only fills fields that are still empty, so corrections aren't overwritten. */
route('POST', /^\/api\/receipts\/(\d+)\/rescan$/, async (req, res, m) => {
  const r = (db.receipts || []).find((x) => x.id === Number(m[1]));
  if (!r) return json(res, 404, { error: 'Receipt not found' });
  const buffer = await readStoredFile(r.file);
  if (!buffer) return json(res, 400, { error: 'The receipt file could not be found on this server' });
  try {
    const g = await scanReceipt({ originalname: r.file, buffer });
    if (!r.desc && g.desc) r.desc = g.desc;
    if (!r.paidTo && g.vendor) r.paidTo = g.vendor;
    if (!r.amount && g.amount) r.amount = g.amount;
    if (g.date) r.date = g.date;
    r.scanned = true; r.scanError = null;
    saveDb(); json(res, 200, r);
  } catch (e) {
    r.scanError = e.message; saveDb();
    json(res, e.code || 502, { error: e.message });
  }
}, { crew: true });

route('PUT', /^\/api\/receipts\/(\d+)$/, (req, res, m, body) => {
  const r = (db.receipts || []).find((x) => x.id === Number(m[1]));
  if (!r) return json(res, 404, { error: 'Receipt not found' });
  if (body.desc !== undefined) r.desc = String(body.desc).trim();
  if (body.paidTo !== undefined) r.paidTo = String(body.paidTo).trim();
  if (body.category !== undefined) r.category = cleanCategory(body.category);
  if (body.date !== undefined) r.date = body.date || r.date;
  if (body.amount !== undefined) {
    const a = Number(body.amount);
    r.amount = Number.isFinite(a) && a > 0 ? a : null;
  }
  saveDb(); json(res, 200, r);
}, { crew: true });

/* File a receipt to a job: it becomes that job's invoice and leaves the inbox. */
route('POST', /^\/api\/receipts\/(\d+)\/assign$/, (req, res, m, body, user) => {
  const r = (db.receipts || []).find((x) => x.id === Number(m[1]));
  if (!r) return json(res, 404, { error: 'Receipt not found' });
  const { p, error } = findProject(body.projectId, user);
  if (error) return json(res, error[0], { error: error[1] });
  if (!r.amount || r.amount <= 0) return json(res, 400, { error: 'Enter the cost before filing this receipt' });
  p.invoices = p.invoices || [];
  const inv = {
    id: nextId(),
    desc: r.desc || 'Receipt',
    paidTo: r.paidTo || '',
    category: cleanCategory(r.category),
    amount: r.amount,
    date: r.date,
    file: r.file, fileName: r.fileName,
    receiptId: r.id,                    // so the Receipts tab can still show it once filed
    filedBy: user.name, filedAt: new Date().toISOString(),
    created: new Date().toISOString(),
  };
  p.invoices.push(inv);
  db.receipts = db.receipts.filter((x) => x.id !== r.id);   // the file moves with it, so don't delete it
  saveDb(); json(res, 200, { ok: true, projectId: p.id, invoice: inv });
}, { crew: true });

route('DELETE', /^\/api\/receipts\/(\d+)$/, async (req, res, m) => {
  const r = (db.receipts || []).find((x) => x.id === Number(m[1]));
  if (r && r.file) await deleteFile(r.file);
  db.receipts = (db.receipts || []).filter((x) => x.id !== Number(m[1]));
  saveDb(); json(res, 200, { ok: true });
}, { crew: true });

/* ---- checks ----
 * A check written to a contractor, often covering several jobs at once. The photo is
 * read for the check number, who it was made out to, and the handwritten line items;
 * each line then gets pointed at a job, which files it as that job's cost. */
/* Every check is drawn on the company's own account, so the pre-printed company name
 * is always the payer. Saying so stops the scanner grabbing it as the payee — it is
 * the largest, clearest name on the page and otherwise an easy thing to mistake. */
const CHECK_PROMPT ='This is a photograph of a business check or its carbon-copy stub. '
  + 'The check is always written FROM "' + COMPANY_NAME + '" (also appearing as "'
  + COMPANY_NAME + ' LLC"), whose name is pre-printed on the check. That pre-printed name '
  + 'is the payer and is NEVER the payee — ignore it when looking for who was paid. '
  + 'The payee is the OTHER name: handwritten after "Pay to the order of", or handwritten at the top of a stub. '
  + 'Reply with ONLY a JSON object, no prose and no code fence, using exactly these keys: '
  + '"number" (the check number, usually printed in the top-right corner, digits only), '
  + '"payee" (who the check was written to — never the pre-printed company name above), '
  + '"date" (the date on the check as YYYY-MM-DD), '
  + '"total" (the total amount of the check as a plain number, or null if not clearly written), '
  + '"lines" (an array of the individual items written on it, each {"desc": short label as written, "amount": number}). '
  + 'The writing may be handwritten and untidy — transcribe what you see, do not tidy names up. '
  + 'Use null for any field you cannot read with confidence, and an empty array if there are no itemised lines. '
  + 'Never guess at an amount.';

async function scanCheck(f) {
  if (!SCAN_KEY) { const e = new Error('Check scanning is not set up on this server.'); e.code = 503; throw e; }
  const media = SCAN_MEDIA[path.extname(f.originalname).toLowerCase()];
  if (!media) { const e = new Error('Check must be a PDF or an image'); e.code = 400; throw e; }
  if (f.buffer.length > 4.5 * 1024 * 1024) {
    const e = new Error('Photo too large to scan (' + (f.buffer.length / 1048576).toFixed(1) + ' MB, max 4.5 MB)');
    e.code = 400; throw e;
  }
  const source = { type: 'base64', media_type: media, data: f.buffer.toString('base64') };
  const content = [
    media === 'application/pdf' ? { type: 'document', source } : { type: 'image', source },
    { type: 'text', text: CHECK_PROMPT },
  ];
  const unreadable = () => { const e = new Error('Could not read the check. Enter the details by hand.'); e.code = 502; return e; };
  let out;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': SCAN_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: SCAN_MODEL, max_tokens: 800, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Check scan rejected (' + r.status + '):', detail);
      if (r.status === 401 || r.status === 403) { const e = new Error('The API key is being rejected. Check ANTHROPIC_API_KEY on the server.'); e.code = 502; throw e; }
      if (r.status === 400 && /credit/i.test(detail)) { const e = new Error('Out of API credits. Top up at console.anthropic.com.'); e.code = 502; throw e; }
      if (r.status === 429) { const e = new Error('Scanning is rate limited right now. Try again in a moment.'); e.code = 502; throw e; }
      throw unreadable();
    }
    out = await r.json();
  } catch (e) {
    if (e.code) throw e;
    console.error('Check scan failed:', e.message);
    throw unreadable();
  }
  const text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw unreadable();
  let g;
  try { g = JSON.parse(match[0]); } catch { throw unreadable(); }
  const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
  // backstop: if it came back with our own company as the payee, it read the payer
  const bare = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(llc|inc|corp)$/, '');
  let payee = g.payee ? String(g.payee).trim().slice(0, 80) : null;
  if (payee && bare(payee) === bare(COMPANY_NAME)) payee = null;
  return {
    number: g.number ? digitsOnly(g.number).slice(0, 12) : null,
    payee,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(g.date || '')) ? g.date : null,
    total: num(g.total),
    lines: Array.isArray(g.lines)
      ? g.lines.slice(0, 30)
        .map((l) => ({ desc: String(l.desc || '').trim().slice(0, 120), amount: num(l.amount) }))
        .filter((l) => l.desc || l.amount)
      : [],
  };
}

/* ---- contractors ----
 * Subs and vendors you write checks to. Tax ID is encrypted at rest and never
 * leaves the server except through the explicit reveal endpoint. Admin only. */
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
/* Money adds up in binary floating point, which drifts (0.1+0.2). Round every
 * total to cents so the API never reports 5652.4800000000005. */
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

function contractorOut(c) {
  const { taxIdEnc, ...rest } = c;                      // ciphertext never goes to the browser
  const checks = (db.checks || []).filter((k) => k.contractorId === c.id);
  return {
    ...rest,
    hasTaxId: !!taxIdEnc,
    checkCount: checks.length,
    paidTotal: cents(checks.reduce((s, k) => s + (k.lines || []).reduce((a, l) => a + (l.amount || 0), 0), 0)),
  };
}

route('GET', /^\/api\/contractors$/, (req, res) => {
  const list = (db.contractors || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  json(res, 200, list.map(contractorOut));
}, { admin: true });

route('POST', /^\/api\/contractors$/, (req, res, m, body) => {
  const name = String(body.name || '').trim();
  if (!name) return json(res, 400, { error: 'Contractor name is required' });
  if ((db.contractors || []).some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return json(res, 400, { error: 'A contractor with that name already exists' });
  }
  // Name is the only thing that can block a save. A tax ID that can't be stored is
  // reported back as a warning rather than losing everything else they typed.
  const raw = digitsOnly(body.taxId);
  let warning = null;
  let store = raw;
  if (raw && !taxKeyOrNull()) { store = ''; warning = 'Contractor saved, but the tax ID was not stored: TAXID_KEY is not set on this server.'; }
  else if (raw && raw.length !== 9) { store = ''; warning = 'Contractor saved, but the tax ID was not stored: an EIN or SSN must be 9 digits.'; }
  const c = {
    id: nextId(),
    name,
    taxIdType: body.taxIdType === 'ssn' ? 'ssn' : 'ein',
    taxIdEnc: store ? encryptTaxId(store) : null,
    taxIdLast4: store ? store.slice(-4) : null,
    phone: String(body.phone || '').trim(),
    email: String(body.email || '').trim(),
    notes: String(body.notes || '').trim(),
    created: new Date().toISOString(),
  };
  db.contractors = db.contractors || [];
  db.contractors.push(c); saveDb(); json(res, 200, { ...contractorOut(c), warning });
}, { admin: true });

route('PUT', /^\/api\/contractors\/(\d+)$/, (req, res, m, body) => {
  const c = (db.contractors || []).find((x) => x.id === Number(m[1]));
  if (!c) return json(res, 404, { error: 'Contractor not found' });
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return json(res, 400, { error: 'Contractor name is required' });
    if ((db.contractors || []).some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) {
      return json(res, 400, { error: 'A contractor with that name already exists' });
    }
    c.name = name;
  }
  if (body.taxIdType !== undefined) c.taxIdType = body.taxIdType === 'ssn' ? 'ssn' : 'ein';
  if (body.phone !== undefined) c.phone = String(body.phone).trim();
  if (body.email !== undefined) c.email = String(body.email).trim();
  if (body.notes !== undefined) c.notes = String(body.notes).trim();
  let warning = null;
  if (body.taxId !== undefined) {
    const raw = digitsOnly(body.taxId);
    if (!raw) { c.taxIdEnc = null; c.taxIdLast4 = null; }          // cleared on purpose
    else if (!taxKeyOrNull()) warning = 'Changes saved, but the tax ID was not stored: TAXID_KEY is not set on this server.';
    else if (raw.length !== 9) warning = 'Changes saved, but the tax ID was not stored: an EIN or SSN must be 9 digits.';
    else { c.taxIdEnc = encryptTaxId(raw); c.taxIdLast4 = raw.slice(-4); }
  }
  saveDb(); json(res, 200, { ...contractorOut(c), warning });
}, { admin: true });

/* The only path by which a full tax ID leaves the server. */
route('POST', /^\/api\/contractors\/(\d+)\/reveal$/, (req, res, m, b, user) => {
  const c = (db.contractors || []).find((x) => x.id === Number(m[1]));
  if (!c) return json(res, 404, { error: 'Contractor not found' });
  if (!c.taxIdEnc) return json(res, 400, { error: 'No tax ID on file' });
  const plain = decryptTaxId(c.taxIdEnc);
  if (!plain) return json(res, 400, { error: 'Could not decrypt — TAXID_KEY is missing or has changed.' });
  console.log('Tax ID revealed for contractor "' + c.name + '" by ' + user.name);   // leaves a trail
  const fmt = c.taxIdType === 'ssn'
    ? plain.slice(0, 3) + '-' + plain.slice(3, 5) + '-' + plain.slice(5)
    : plain.slice(0, 2) + '-' + plain.slice(2);
  json(res, 200, { taxId: fmt });
}, { admin: true });

route('DELETE', /^\/api\/contractors\/(\d+)$/, (req, res, m) => {
  const id = Number(m[1]);
  if ((db.checks || []).some((k) => k.contractorId === id)) {
    return json(res, 400, { error: 'This contractor has checks on file. Delete those first.' });
  }
  db.contractors = (db.contractors || []).filter((x) => x.id !== id);
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* Checks: upload → scan → confirm payee → point each line at a job.
 * A line is just a job and an amount. The text written beside it on the check is
 * kept only as a hint for picking the job, and to auto-match where it is obvious. */

/* Match a handwritten line like "Rockville Nosh Permit" to a job called "Rockville
 * Nosh". Only returns a job when exactly one matches, so an ambiguous scrawl is
 * left for a human rather than guessed at. */
function matchProjectForLine(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!words.length) return null;
  const hits = db.projects.filter((p) => {
    const pw = String(p.name).toLowerCase().match(/[a-z0-9]+/g) || [];
    const meaningful = pw.filter((w) => w.length > 2 && !['job', 'the', 'and', 'st', 'ave', 'rd'].includes(w));
    if (!meaningful.length) return false;
    return meaningful.every((w) => words.includes(w));      // every distinctive word appears
  });
  return hits.length === 1 ? hits[0] : null;
}

/* Build the job-cost entry a check line creates. Description is just the check
 * reference — the job and amount carry the meaning. */
function invoiceForLine(k, line, contractorName) {
  return {
    id: nextId(),
    desc: k.number ? 'Check #' + k.number : 'Check payment',
    paidTo: contractorName || k.payee || '',
    category: cleanCategory(line.category || 'Subcontractor'),
    amount: line.amount,
    date: k.date,
    file: k.file, fileName: k.fileName,
    checkId: k.id, checkNumber: k.number,
    created: new Date().toISOString(),
  };
}

function checkOut(k) {
  const c = (db.contractors || []).find((x) => x.id === k.contractorId);
  return {
    ...k,
    contractorName: c ? c.name : null,
    total: cents((k.lines || []).reduce((s, l) => s + (l.amount || 0), 0)),
  };
}

route('GET', /^\/api\/checks$/, (req, res) => {
  const list = (db.checks || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  json(res, 200, list.map(checkOut));
}, { admin: true });

route('GET', /^\/api\/checks\/(\d+)$/, (req, res, m) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  json(res, 200, checkOut(k));
}, { admin: true });

/* A check can arrive two ways: photographed and scanned, or typed in by hand when
 * there's no photo to take. The photo is optional and can be attached later. */
route('POST', /^\/api\/checks$/, async (req, res, m, body, user) => {
  const { fields, files } = body;
  const f = files && files.check;
  let g = { number: null, payee: null, date: null, total: null, lines: [] };
  let scanError = null;
  if (f) {
    if (!INVOICE_FILE_RE.test(f.originalname)) return json(res, 400, { error: 'Check must be a PDF or an image' });
    await storeFile(f);
    try { g = await scanCheck(f); }
    catch (e) { scanError = e.message; }        // a failed scan still keeps the photo
  }
  // anything typed in by hand beats what the scanner made of it
  const typedContractor = fields.contractorId ? Number(fields.contractorId) : null;
  if (typedContractor && !(db.contractors || []).some((c) => c.id === typedContractor)) {
    return json(res, 404, { error: 'Contractor not found' });
  }
  const payee = String(fields.payee || '').trim() || g.payee || '';
  // match the payee against contractors already on file (case/spacing tolerant)
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = typedContractor
    ? db.contractors.find((c) => c.id === typedContractor)
    : (payee ? (db.contractors || []).find((c) => norm(c.name) === norm(payee)) : null);
  const k = {
    id: nextId(),
    number: String(fields.number || '').trim() || g.number || '',
    payee,
    contractorId: hit ? hit.id : null,
    date: fields.date || g.date || new Date().toISOString().slice(0, 10),
    file: f ? f.filename : null, fileName: f ? f.originalname : null,
    lines: (g.lines || []).map((l) => ({ id: nextId(), readAs: l.desc, amount: l.amount, projectId: null, invoiceId: null, auto: false })),
    scanned: f ? !scanError : true,     // nothing to scan on a hand-logged check
    scanError,
    uploaded: new Date().toISOString(), by: user.name,
  };
  // file any line whose written text points unambiguously at one job
  for (const line of k.lines) {
    if (!line.amount) continue;
    const p = matchProjectForLine(line.readAs);
    if (!p) continue;
    const inv = invoiceForLine(k, line, hit ? hit.name : null);
    p.invoices = p.invoices || [];
    p.invoices.push(inv);
    line.projectId = p.id; line.invoiceId = inv.id; line.auto = true;
  }
  db.checks = db.checks || [];
  db.checks.push(k); saveDb();
  json(res, 200, { ...checkOut(k), payeeMatched: !!hit });
}, { admin: true, multipart: true });

route('PUT', /^\/api\/checks\/(\d+)$/, (req, res, m, body) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  if (body.number !== undefined) k.number = String(body.number).trim();
  if (body.payee !== undefined) k.payee = String(body.payee).trim();
  if (body.date !== undefined) k.date = body.date || k.date;
  if (body.contractorId !== undefined) {
    const id = body.contractorId ? Number(body.contractorId) : null;
    if (id && !(db.contractors || []).some((c) => c.id === id)) return json(res, 404, { error: 'Contractor not found' });
    k.contractorId = id;
  }
  // carry the header changes down to every job cost this check created
  const c = (db.contractors || []).find((x) => x.id === k.contractorId);
  const ids = (k.lines || []).map((l) => l.invoiceId).filter(Boolean);
  if (ids.length) {
    for (const p of db.projects) {
      for (const inv of p.invoices || []) {
        if (!ids.includes(inv.id)) continue;
        inv.desc = k.number ? 'Check #' + k.number : 'Check payment';
        inv.checkNumber = k.number;
        inv.date = k.date;
        inv.paidTo = c ? c.name : (k.payee || '');
      }
    }
  }
  saveDb(); json(res, 200, checkOut(k));
}, { admin: true });

/* Add / edit / remove a line. Editing a line that is already filed to a job
 * keeps that job's invoice in step, so the two can never disagree. */
function syncLineInvoice(line) {
  if (!line.invoiceId) return;
  for (const p of db.projects) {
    const inv = (p.invoices || []).find((x) => x.id === line.invoiceId);
    if (inv) { inv.amount = line.amount; return; }
  }
}

/* Add a job cost to a check. Job and amount can come in together, which is how a
 * hand-logged check gets built up — one line per job. */
route('POST', /^\/api\/checks\/(\d+)\/lines$/, (req, res, m, body) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return json(res, 400, { error: 'A valid amount is required' });
  const line = { id: nextId(), readAs: '', amount, projectId: null, invoiceId: null, auto: false };
  if (body.projectId) {
    const p = db.projects.find((x) => x.id === Number(body.projectId));
    if (!p) return json(res, 404, { error: 'Project not found' });
    const c = (db.contractors || []).find((x) => x.id === k.contractorId);
    const inv = invoiceForLine(k, line, c ? c.name : null);
    p.invoices = p.invoices || [];
    p.invoices.push(inv);
    line.projectId = p.id; line.invoiceId = inv.id;
  }
  k.lines = k.lines || [];
  k.lines.push(line);
  saveDb(); json(res, 200, checkOut(k));
}, { admin: true });

/* Attach (or replace) the photo on a check that was logged by hand. */
route('POST', /^\/api\/checks\/(\d+)\/photo$/, async (req, res, m, body) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  const f = body.files && body.files.check;
  if (!f) return json(res, 400, { error: 'No file uploaded' });
  if (!INVOICE_FILE_RE.test(f.originalname)) return json(res, 400, { error: 'Check must be a PDF or an image' });
  await storeFile(f);
  if (k.file) await deleteFile(k.file);
  k.file = f.filename; k.fileName = f.originalname;
  // keep the job costs pointing at the newly attached image
  const ids = (k.lines || []).map((l) => l.invoiceId).filter(Boolean);
  if (ids.length) for (const p of db.projects) {
    for (const inv of p.invoices || []) if (ids.includes(inv.id)) { inv.file = k.file; inv.fileName = k.fileName; }
  }
  saveDb(); json(res, 200, checkOut(k));
}, { admin: true, multipart: true });

route('PUT', /^\/api\/checks\/(\d+)\/lines\/(\d+)$/, (req, res, m, body) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  const line = (k.lines || []).find((l) => l.id === Number(m[2]));
  if (!line) return json(res, 404, { error: 'Line not found' });
  if (body.amount !== undefined) {
    const a = Number(body.amount);
    line.amount = Number.isFinite(a) && a > 0 ? a : null;
  }
  if (body.projectId !== undefined) {
    const newId = body.projectId ? Number(body.projectId) : null;
    if (newId !== line.projectId) {
      // pull the old job's invoice before filing against the new one
      if (line.invoiceId) {
        for (const p of db.projects) {
          const before = (p.invoices || []).length;
          p.invoices = (p.invoices || []).filter((x) => x.id !== line.invoiceId);
          if (p.invoices.length !== before) break;
        }
        line.invoiceId = null;
      }
      line.projectId = null;
      if (newId) {
        const p = db.projects.find((x) => x.id === newId);
        if (!p) return json(res, 404, { error: 'Project not found' });
        if (!line.amount) return json(res, 400, { error: 'Enter the amount before assigning this line to a job' });
        const c = (db.contractors || []).find((x) => x.id === k.contractorId);
        const inv = invoiceForLine(k, line, c ? c.name : null);
        p.invoices = p.invoices || [];
        p.invoices.push(inv);
        line.projectId = p.id; line.invoiceId = inv.id; line.auto = false;   // a human chose this one
      }
    }
  }
  syncLineInvoice(line);
  saveDb(); json(res, 200, checkOut(k));
}, { admin: true });

route('DELETE', /^\/api\/checks\/(\d+)\/lines\/(\d+)$/, (req, res, m) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  const line = (k.lines || []).find((l) => l.id === Number(m[2]));
  if (line && line.invoiceId) {
    for (const p of db.projects) p.invoices = (p.invoices || []).filter((x) => x.id !== line.invoiceId);
  }
  k.lines = (k.lines || []).filter((l) => l.id !== Number(m[2]));
  saveDb(); json(res, 200, checkOut(k));
}, { admin: true });

route('DELETE', /^\/api\/checks\/(\d+)$/, async (req, res, m) => {
  const k = (db.checks || []).find((x) => x.id === Number(m[1]));
  if (!k) return json(res, 404, { error: 'Check not found' });
  // remove every job cost this check created, then the file itself
  const ids = (k.lines || []).map((l) => l.invoiceId).filter(Boolean);
  if (ids.length) for (const p of db.projects) p.invoices = (p.invoices || []).filter((x) => !ids.includes(x.id));
  if (k.file) await deleteFile(k.file);
  db.checks = (db.checks || []).filter((x) => x.id !== k.id);
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* ================= reports =================
 * Cash basis: money counts on the day it moved, which is how most small contractors
 * file. Income = payments actually received. Expenses = job costs on their dated day.
 * This is a management report, not a set of books — there is no ledger behind it. */
const inRange = (d, from, to) => {
  const day = String(d || '').slice(0, 10);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
};

route('GET', /^\/api\/reports\/pl$/, (req, res, m, b, user, query) => {
  const from = query.from || '';
  const to = query.to || '';
  let income = 0;
  const byCategory = {};
  const byJob = [];
  for (const p of db.projects) {
    const received = (p.payments || [])
      .filter((x) => inRange(x.date || x.created, from, to))
      .reduce((s, x) => s + (x.amount || 0), 0);
    const costs = (p.invoices || []).filter((x) => inRange(x.date || x.created, from, to));
    const spent = costs.reduce((s, x) => s + (x.amount || 0), 0);
    for (const c of costs) {
      const k = cleanCategory(c.category);
      byCategory[k] = cents((byCategory[k] || 0) + (c.amount || 0));
    }
    income = cents(income + received);
    if (received || spent) {
      byJob.push({
        id: p.id, name: p.name, overhead: !!p.overhead,
        price: p.price || 0, received: cents(received), spent: cents(spent),
        net: cents(received - spent),
      });
    }
  }
  const expenses = cents(Object.values(byCategory).reduce((s, v) => s + v, 0));
  byJob.sort((a, b2) => b2.net - a.net);
  json(res, 200, {
    from, to, basis: 'cash',
    income, expenses, net: cents(income - expenses),
    byCategory: EXPENSE_CATEGORIES.map((c) => ({ category: c, amount: byCategory[c] || 0 }))
      .filter((x) => x.amount),
    byJob,
  });
}, { admin: true });

/* Lifetime profitability per job — contract value against everything it has cost. */
route('GET', /^\/api\/reports\/jobs$/, (req, res) => {
  const rows = db.projects.filter((p) => !p.overhead).map((p) => {
    const spent = cents((p.invoices || []).reduce((s, x) => s + (x.amount || 0), 0));
    const received = cents((p.payments || []).reduce((s, x) => s + (x.amount || 0), 0));
    const price = p.price || 0;
    return {
      id: p.id, name: p.name, status: p.status, customerName:
        (db.users.find((u) => u.id === p.customerId) || {}).name || null,
      price, spent, received,
      profit: cents(price - spent),
      margin: price ? Math.round(((price - spent) / price) * 1000) / 10 : null,
      unbilled: cents(price - received),
    };
  });
  json(res, 200, rows);
}, { admin: true });

/* 1099-NEC summary. The reporting threshold rose from $600 to $2,000 for payments
 * made from 2026 onward, so it is looked up per year rather than hard-coded. */
const nec1099Threshold = (year) => (Number(year) >= 2026 ? 2000 : 600);

route('GET', /^\/api\/reports\/1099$/, (req, res, m, b, user, query) => {
  const year = String(query.year || new Date().getFullYear());
  const threshold = nec1099Threshold(year);
  const rows = (db.contractors || []).map((c) => {
    const checks = (db.checks || []).filter((k) => k.contractorId === c.id && String(k.date).slice(0, 4) === year);
    const paid = cents(checks.reduce((s, k) => s + (k.lines || []).reduce((a, l) => a + (l.amount || 0), 0), 0));
    return {
      id: c.id, name: c.name,
      taxIdType: c.taxIdType, taxIdLast4: c.taxIdLast4, hasTaxId: !!c.taxIdEnc,
      checkCount: checks.length, paid,
      reportable: paid >= threshold,
    };
  }).filter((r) => r.paid > 0).sort((a, b2) => b2.paid - a.paid);
  json(res, 200, {
    year, threshold,
    totalPaid: cents(rows.reduce((s, r) => s + r.paid, 0)),
    reportableCount: rows.filter((r) => r.reportable).length,
    missingTaxId: rows.filter((r) => r.reportable && !r.hasTaxId).length,
    rows,
  });
}, { admin: true });

/* general to-do — admin's own list, not attached to any job */
route('GET', /^\/api\/todos$/, (req, res) => {
  json(res, 200, db.todos || []);
}, { admin: true });

route('POST', /^\/api\/todos$/, (req, res, m, body) => {
  if (!body.text || !String(body.text).trim()) return json(res, 400, { error: 'To-do text required' });
  const t = { id: nextId(), text: String(body.text).trim(), done: false, created: new Date().toISOString() };
  db.todos = db.todos || [];
  db.todos.push(t); saveDb(); json(res, 200, t);
}, { admin: true });

route('PUT', /^\/api\/todos\/(\d+)$/, (req, res, m, body) => {
  const t = (db.todos || []).find((x) => x.id === Number(m[1]));
  if (!t) return json(res, 404, { error: 'To-do not found' });
  if (body.done !== undefined) t.done = !!body.done;
  if (body.text !== undefined) {
    if (!String(body.text).trim()) return json(res, 400, { error: 'To-do text required' });
    t.text = String(body.text).trim();
  }
  saveDb(); json(res, 200, t);
}, { admin: true });

route('DELETE', /^\/api\/todos\/(\d+)$/, (req, res, m) => {
  db.todos = (db.todos || []).filter((x) => x.id !== Number(m[1]));
  saveDb(); json(res, 200, { ok: true });
}, { admin: true });

/* notes */
route('POST', /^\/api\/projects\/(\d+)\/notes$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  if (!body.text || !String(body.text).trim()) return json(res, 400, { error: 'Note text required' });
  const n = { id: nextId(), text: String(body.text).trim(), done: false, created: new Date().toISOString() };
  p.notes.push(n); saveDb(); json(res, 200, n);
}, { staff: true });

route('PUT', /^\/api\/projects\/(\d+)\/notes\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const n = p.notes.find((x) => x.id === Number(m[2]));
  if (!n) return json(res, 404, { error: 'Note not found' });
  if (body.done !== undefined) n.done = !!body.done;
  if (body.text !== undefined) n.text = String(body.text).trim();
  saveDb(); json(res, 200, n);
}, { staff: true });

route('DELETE', /^\/api\/projects\/(\d+)\/notes\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  p.notes = p.notes.filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { staff: true });

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
}, { staff: true });

route('DELETE', /^\/api\/projects\/(\d+)\/payments\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const gone = (p.payments || []).find((x) => x.id === Number(m[2]));
  // if this receipt came from a scheduled payment, put that one back to unpaid
  if (gone && gone.dueId) {
    const due = (p.dues || []).find((d) => d.id === gone.dueId);
    if (due) due.paidOn = null;
  }
  p.payments = (p.payments || []).filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { staff: true });

/* payments due — the schedule of what the customer still owes and when.
 * Each entry is typed in by hand: label, amount, due date. Marking one paid also
 * files it into Payments Received so the two never drift apart. */
route('POST', /^\/api\/projects\/(\d+)\/dues$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return json(res, 400, { error: 'A valid amount is required' });
  p.dues = p.dues || [];
  const due = {
    id: nextId(),
    label: String(body.label || '').trim() || 'Payment',
    amount,
    dueDate: body.dueDate || null,
    paidOn: null,
    created: new Date().toISOString(),
  };
  p.dues.push(due); saveDb();
  json(res, 200, due);   // internal only — the customer is deliberately not told
}, { staff: true });

route('PUT', /^\/api\/projects\/(\d+)\/dues\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const due = (p.dues || []).find((x) => x.id === Number(m[2]));
  if (!due) return json(res, 404, { error: 'Payment not found' });
  if (body.label !== undefined) due.label = String(body.label).trim() || 'Payment';
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!amount || amount <= 0) return json(res, 400, { error: 'A valid amount is required' });
    due.amount = amount;
  }
  if (body.dueDate !== undefined) due.dueDate = body.dueDate || null;
  if (body.paid !== undefined) {
    if (body.paid && !due.paidOn) {
      // record it as money received, tagged back to this scheduled payment
      due.paidOn = body.paidOn || new Date().toISOString().slice(0, 10);
      p.payments = p.payments || [];
      p.payments.push({
        id: nextId(), amount: due.amount, date: due.paidOn,
        note: due.label, dueId: due.id, created: new Date().toISOString(),
      });
    } else if (!body.paid && due.paidOn) {
      due.paidOn = null;
      p.payments = (p.payments || []).filter((x) => x.dueId !== due.id);
    }
  }
  saveDb(); json(res, 200, due);
}, { staff: true });

route('DELETE', /^\/api\/projects\/(\d+)\/dues\/(\d+)$/, (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const id = Number(m[2]);
  p.dues = (p.dues || []).filter((x) => x.id !== id);
  p.payments = (p.payments || []).filter((x) => x.dueId !== id);  // drop its auto-filed receipt too
  saveDb(); json(res, 200, { ok: true });
}, { staff: true });

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
  p.photos.push(ph); saveDb();
  notifyCustomer(p, 'photo', 'New photos were just added to your project "' + p.name + '".');
  json(res, 200, ph);
}, { crew: true, multipart: true });

route('DELETE', /^\/api\/projects\/(\d+)\/photos\/(\d+)$/, async (req, res, m, body, user) => {
  const { p, error } = findProject(m[1], user);
  if (error) return json(res, error[0], { error: error[1] });
  const ph = (p.photos || []).find((x) => x.id === Number(m[2]));
  if (ph) { await deleteFile(ph.file); if (ph.thumb) await deleteFile(ph.thumb); }
  p.photos = (p.photos || []).filter((x) => x.id !== Number(m[2]));
  saveDb(); json(res, 200, { ok: true });
}, { crew: true });

/* protected file downloads */
route('GET', /^\/api\/file\/([^/]+)$/, (req, res, m, b, user) => {
  const name = path.basename(decodeURIComponent(m[1]));
  // check images are admin-only wherever they appear
  if ((db.checks || []).some((k) => k.file === name)) {
    if (user.role !== 'admin') return json(res, 403, { error: 'No access' });
    const fp2 = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(fp2)) {
      res.writeHead(200, { 'Content-Type': FILE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream' });
      return fs.createReadStream(fp2).pipe(res);
    }
    if (R2) { res.writeHead(302, { Location: r2PresignGet(name) }); return res.end(); }
    return json(res, 404, { error: 'File not found' });
  }
  // unfiled receipts belong to no job yet — staff can open them, nobody else
  const inInbox = (db.receipts || []).some((r) => r.file === name);
  if (inInbox && user.role === 'customer') return json(res, 403, { error: 'No access' });
  if (!inInbox) {
    const owner = db.projects.find((p) => [p.contractFile, p.planFile].includes(name)
      || (p.photos || []).some((ph) => ph.file === name || ph.thumb === name)
      || (p.invoices || []).some((iv) => iv.file === name));
    if (!owner || !canAccess(owner, user)) return json(res, 403, { error: 'No access' });
    // invoices are internal cost records — never served to the customer, even on their own job
    if (user.role === 'customer' && (owner.invoices || []).some((iv) => iv.file === name)) {
      return json(res, 403, { error: 'No access' });
    }
  }
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

/* ================= daily database backups =================
 * Copies db.json to R2 (backups/db-YYYY-MM-DD.json) on boot and every 24h.
 * Keeps ~30 days: each run deletes the copy from 31 days ago.
 * Without R2 configured, backs up to a local backups/ folder instead. */
async function backupDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const today = new Date().toISOString().slice(0, 10);
    const data = fs.readFileSync(DATA_FILE);
    if (R2) {
      await r2Request('PUT', 'backups/db-' + today + '.json', data, 'application/json');
      const old = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
      await r2Request('DELETE', 'backups/db-' + old + '.json');
      console.log('Database backed up to R2: backups/db-' + today + '.json');
    } else {
      const dir = path.join(STORAGE_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'db-' + today + '.json'), data);
      const files = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort();
      while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
      console.log('Database backed up locally: backups/db-' + today + '.json');
    }
  } catch (e) { console.error('Backup failed:', e.message); }
}
backupDb();
setInterval(backupDb, 24 * 60 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURI(req.url.split('?')[0]);
    // query string, for report date ranges and the like
    const query = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
    if (!urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);

    const user = getSession(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(urlPath);
      if (!m) continue;
      if (!r.public && !user) return json(res, 401, { error: 'Not logged in' });
      // explicit allow-lists — a new role must be granted access deliberately,
      // never inherit it by virtue of not being a customer
      if (r.admin && (!user || user.role !== 'admin')) return json(res, 403, { error: 'Admins only' });
      if (r.staff && (!user || !['admin', 'pm'].includes(user.role))) return json(res, 403, { error: 'Staff only' });
      if (r.crew && (!user || !['admin', 'pm', 'delivery'].includes(user.role))) return json(res, 403, { error: 'Staff only' });
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        const ct = req.headers['content-type'] || '';
        if (r.multipart && ct.includes('multipart/form-data')) body = parseMultipart(raw, ct);
        else if (r.multipart) body = { fields: {}, files: {} };
        else body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
      return await r.handler(req, res, m, body, user, query);
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
  console.log('  Storage: ' + (R2 ? 'Cloudflare R2 (bucket: ' + R2.bucket + ')' : 'local disk'));
  console.log('  Email: ' + (process.env.RESEND_API_KEY ? 'enabled, sending as ' + RESEND_FROM : 'DISABLED — RESEND_API_KEY not set'));
  // show only the shape of the key — enough to spot a bad paste, never the secret itself
  console.log('  Receipt scanning: ' + (SCAN_KEY
    ? 'enabled (' + SCAN_MODEL + ') — key ' + SCAN_KEY.slice(0, 14) + '…' + SCAN_KEY.slice(-4) + ', ' + SCAN_KEY.length + ' chars'
    : 'DISABLED — ANTHROPIC_API_KEY not set'));
  console.log('  Contractor tax IDs: ' + (taxKeyOrNull()
    ? 'encrypted at rest'
    : 'CANNOT BE STORED — TAXID_KEY not set'));
  console.log('');
});
