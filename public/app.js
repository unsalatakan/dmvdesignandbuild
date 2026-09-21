/* DMV Design and Build — portal frontend */
let ME = null;
let homeMap = null, bigMap = null;
let todoTab = 'open'; // which tab of the home to-do panel is selected

/* job statuses */
const STATUS = { talks: ['In Talks', '#d99417'], upcoming: ['Upcoming', '#8a63d2'], active: ['In Progress', '#1d9d5c'], done: ['Completed', '#64748b'] };
/* order + wording used by the Jobs page overview table */
const STATUS_TABLE = [
  ['active', 'Ongoing Jobs', 'Work is underway on site'],
  ['upcoming', 'Signed — Starting Soon', 'Contract signed, not started yet'],
  ['talks', 'In Talks — Not Signed', 'Quoted or in discussion, no contract yet'],
  ['done', 'Completed', 'Finished and closed out'],
];
const statusOf = (p) => (STATUS[p.status] ? p.status : 'active');
const statusBadge = (p) => { const [label, color] = STATUS[statusOf(p)]; return `<span class="badge" style="background:${color};color:#fff">${label}</span>`; };

/* Role shorthands, kept in one place so a permission question has one answer.
 *   staff    = admin or project manager (the money and ordering side)
 *   crew     = staff plus the delivery guy (site work: photos, receipts)
 *   delivery = sees where jobs are and what they cost, never what they sell for */
let IS_STAFF = false, IS_CREW = false, IS_DELIVERY = false;
function setRoleFlags() {
  IS_STAFF = ['admin', 'pm'].includes(ME.role);
  IS_CREW = IS_STAFF || ME.role === 'delivery';
  IS_DELIVERY = ME.role === 'delivery';
}

/* The general-spending bucket is a project under the hood so receipts, checks and
 * invoices work on it unchanged — but it is not a job, so it stays out of job lists,
 * totals and the map. These two helpers are the only place that distinction lives. */
const realJobs = (list) => list.filter((p) => !p.overhead);
const overheadOf = (list) => list.find((p) => p.overhead) || null;

const EXPENSE_CATEGORIES = ['Materials', 'Subcontractor', 'Labor', 'Permits & Fees',
  'Equipment Rental', 'Tools', 'Fuel & Vehicle', 'Insurance', 'Office & Admin', 'Other'];
const categoryOptions = (sel) => EXPENSE_CATEGORIES
  .map((c) => `<option value="${c}" ${c === (sel || 'Other') ? 'selected' : ''}>${c}</option>`).join('');

/* Money summed in binary floating point drifts; round every total to cents. */
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

const $ = (s) => document.querySelector(s);
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

/* ---------- scheduled payments ("what's still owed") ----------
 * dues = [{ id, label, amount, dueDate, paidOn }]. Unpaid entries are what the
 * job — and the home page — report as due. */
const todayISO = () => new Date().toISOString().slice(0, 10);
const openDues = (p) => (p.dues || []).filter((d) => !d.paidOn);
const dueTotal = (p) => openDues(p).reduce((s, d) => s + (d.amount || 0), 0);
const isOverdue = (d) => !!(!d.paidOn && d.dueDate && d.dueDate < todayISO());
/* Plain-English "when" for a due date: Overdue by 3 days / Due today / Due in 5 days. */
function dueWhen(d) {
  if (d.paidOn) return 'Paid ' + fmtDate(d.paidOn);
  if (!d.dueDate) return 'No due date';
  const days = Math.round((new Date(d.dueDate + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}
/* The single next thing to chase on a job: soonest due date first, undated last. */
function nextDue(p) {
  return openDues(p).slice().sort((a, b) =>
    (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;
}

/* One-tap links to a job's contract and arch plan, for tables and lists.
 * Clicks are stopped from bubbling so these work inside a clickable job row/card. */
function fileChips(p) {
  const chip = (file, name, icon, label) => file
    ? `<a class="mini-chip" href="#" data-file-view="${file}" data-file-name="${esc(name || label)}" title="${esc(name || label)}">${icon} ${label}</a>`
    : `<span class="mini-chip off" title="Not uploaded">${icon} ${label}</span>`;
  return chip(p.contractFile, p.contractName, '📄', 'Contract') + chip(p.planFile, p.planName, '📐', 'Plan');
}

/* Copy-to-clipboard for any element carrying data-lb (a lockbox code). */
function wireLockboxCopy(root = document) {
  root.querySelectorAll('[data-lb]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(el.dataset.lb);
        const old = el.textContent;
        el.textContent = '✓ Copied';
        setTimeout(() => { el.textContent = old; }, 1200);
      } catch { /* clipboard blocked — the code is on screen anyway */ }
    })
  );
}

/* ---------- open an address in the device's native maps app ---------- */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/.test(navigator.userAgent);
/* Builds the best "open in maps" URL for this device.
 * iOS -> Apple Maps · Android -> geo: (lets the user pick Google Maps/Waze) · desktop -> Google Maps in a tab. */
function mapsUrl(address, lat, lng) {
  const q = encodeURIComponent(address || '');
  const hasPin = lat != null && lng != null;
  // maps.apple.com is a universal link: iOS hands it straight to the Maps app,
  // and it still works if it ever gets opened in a plain browser.
  if (IS_IOS) return 'https://maps.apple.com/?q=' + q + (hasPin ? '&ll=' + lat + ',' + lng : '');
  if (IS_ANDROID) return hasPin ? `geo:${lat},${lng}?q=${lat},${lng}(${q})` : 'geo:0,0?q=' + q;
  return 'https://www.google.com/maps/search/?api=1&query=' + (hasPin ? `${lat},${lng}` : q);
}
/* Renders an address as a tappable link. Stops click bubbling so it works inside job cards. */
function addrLink(p, extraClass = '') {
  const href = mapsUrl(p.address, p.lat, p.lng);
  const target = IS_ANDROID ? '' : ' target="_blank" rel="noopener"';
  return `<a class="addr-link ${extraClass}" href="${esc(href)}"${target} onclick="event.stopPropagation()" title="Open in Maps">${esc(p.address)}</a>`;
}

async function api(url, opts = {}) {
  if (opts.json) {
    opts.body = JSON.stringify(opts.json);
    opts.headers = { 'Content-Type': 'application/json' };
    delete opts.json;
  }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------- auth / boot ---------- */
async function boot() {
  ME = await api('/api/me');
  if (ME) showApp(); else showLogin();
}
function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}
function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  setRoleFlags();
  const roleLabel = { admin: ' (Admin)', pm: ' (Project Manager)', delivery: ' (Delivery)' }[ME.role] || '';
  $('#whoami').textContent = ME.name + roleLabel;
  const links = [['#/home', 'Home'], ['#/jobs', ME.role === 'customer' ? 'My Jobs' : 'Jobs']];
  if (IS_STAFF) links.push(['#/orders', 'Orders']);          // material ordering is admin/PM work
  if (IS_CREW) links.push(['#/receipts', 'Receipts']);
  links.push(['#/photos', 'Photos']);
  if (ME.role === 'admin') links.push(['#/reports', 'Reports'], ['#/contractors', 'Contractors'], ['#/customers', 'Customers'], ['#/managers', 'Managers']);
  $('#navLinks').innerHTML = links.map(([h, t]) => `<a href="${h}" data-h="${h}">${t}</a>`).join('');
  if (!location.hash || location.hash === '#/') location.hash = '#/home';
  route();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    ME = await api('/api/login', { method: 'POST', json: { username: $('#loginUser').value, password: $('#loginPass').value } });
    showApp();
  } catch (err) { $('#loginError').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.hash = ''; location.reload(); });

$('#pwBtn').addEventListener('click', () => {
  openModal(`
    <h2>Change Password</h2>
    <form id="pwForm" class="form-grid">
      <div class="full"><label class="f">Current Password</label><input class="f" type="password" name="current" required autocomplete="current-password" /></div>
      <div class="full"><label class="f">New Password (min 6 characters)</label><input class="f" type="password" name="next" required minlength="6" autocomplete="new-password" /></div>
      <div class="full"><label class="f">Confirm New Password</label><input class="f" type="password" name="confirm" required autocomplete="new-password" /></div>
      <div class="modal-actions full">
        <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn gold">Change Password</button>
      </div>
      <div class="error full" id="pwErr"></div>
    </form>`);
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.next !== f.confirm) { $('#pwErr').textContent = 'New passwords do not match'; return; }
    try {
      await api('/api/password', { method: 'PUT', json: { current: f.current, next: f.next } });
      closeModal(); alert('Password changed.');
    } catch (err) { $('#pwErr').textContent = err.message; }
  });
});

/* ---------- theme toggle ---------- */
function paintThemeBtn() {
  const light = document.documentElement.classList.contains('light');
  $('#themeBtn').textContent = light ? '🌙 Dark Mode' : '☀️ Light Mode';
  $('#themeColor').setAttribute('content', light ? '#f5f7fb' : '#0a1628');
}
$('#themeBtn').addEventListener('click', () => {
  const light = document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', light ? 'light' : 'dark');
  paintThemeBtn();
});
paintThemeBtn();

/* ---------- mobile menu ---------- */
function closeMenu() { $('#sidebar').classList.remove('open'); $('#navBack').classList.remove('show'); }
$('#menuBtn').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
  $('#navBack').classList.toggle('show', $('#sidebar').classList.contains('open'));
});
$('#navBack').addEventListener('click', closeMenu);
$('#navLinks').addEventListener('click', closeMenu);

/* ---------- router ---------- */
window.addEventListener('hashchange', route);
function route() {
  if (!ME) return;
  const h = location.hash || '#/home';
  document.querySelectorAll('#navLinks a').forEach((a) => a.classList.toggle('active', h.startsWith(a.dataset.h)));
  const jobPhotosMatch = h.match(/^#\/job\/(\d+)\/photos/);
  if (jobPhotosMatch) return renderJobPhotos(Number(jobPhotosMatch[1]));
  const jobMatch = h.match(/^#\/job\/(\d+)/);
  if (jobMatch) return renderJob(Number(jobMatch[1]));
  if (h.startsWith('#/jobs')) return renderJobs();
  if (h.startsWith('#/orders') && IS_STAFF) return renderOrders();
  if (h.startsWith('#/receipts') && IS_CREW) return renderReceipts();
  const checkMatch = h.match(/^#\/check\/(\d+)/);
  if (checkMatch && ME.role === 'admin') return renderCheck(Number(checkMatch[1]));
  const contractorMatch = h.match(/^#\/contractor\/(\d+)/);
  if (contractorMatch && ME.role === 'admin') return renderContractor(Number(contractorMatch[1]));
  if (h.startsWith('#/contractors') && ME.role === 'admin') return renderContractors();
  if (h.startsWith('#/reports') && ME.role === 'admin') return renderReports();
  if (h.startsWith('#/managers') && ME.role === 'admin') return renderManagers();
  if (h.startsWith('#/photos')) return renderPhotos();
  if (h.startsWith('#/customers') && ME.role === 'admin') return renderCustomers();
  renderHome();
}

/* ---------- HOME: finance chart (no libraries, plain SVG) ---------- */
function financeChartSVG(projects) {
  const totalContract = projects.reduce((s, p) => s + (p.price || 0), 0);
  const events = []; // { d: 'YYYY-MM-DD', con, rec, sp } — all pulled from each job's data
  projects.forEach((p) => {
    if (p.price) {
      // contract value becomes receivable on the job's start date (fallback: date the job was created)
      const d = String(p.startDate || p.created || '').slice(0, 10);
      if (d) events.push({ d, con: p.price, rec: 0, sp: 0 });
    }
    (p.payments || []).forEach((x) => {
      const d = String(x.date || x.created || '').slice(0, 10);
      if (d) events.push({ d, con: 0, rec: x.amount || 0, sp: 0 });
    });
    (p.materials || []).filter((m) => m.ordered).forEach((m) => {
      const d = String(m.orderedAt || p.created || new Date().toISOString()).slice(0, 10);
      events.push({ d, con: 0, rec: 0, sp: (m.price || 0) * (m.qty || 1) });
    });
  });
  if (!events.length && !totalContract) return '<div class="muted" style="color:var(--ch-label)">No jobs with prices, payments or material orders yet — the chart will appear once there is activity.</div>';
  const today = new Date().toISOString().slice(0, 10);
  let dates = [...new Set([...events.map((e) => e.d), today])].sort();
  if (dates.length === 1) dates = [dates[0], today > dates[0] ? today : dates[0]]; // ensure a segment
  let pts = dates.map((d) => {
    let con = 0, rec = 0, sp = 0;
    events.forEach((e) => { if (e.d <= d) { con += e.con; rec += e.rec; sp += e.sp; } });
    return { t: Date.parse(d), d, rec, sp, out: Math.max(con - rec, 0) };
  });
  if (pts.length === 1) pts = [pts[0], { ...pts[0], t: pts[0].t + 86400000 }];
  const W = 760, H = 280, L = 62, R = 16, T = 16, B = 34;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const yMax = Math.max(totalContract, ...pts.map((p) => Math.max(p.out, p.rec, p.sp)), 1) * 1.08;
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / yMax) * (H - T - B);
  const line = (key) => pts.map((p) => `${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
  const dots = (key, color) => pts.map((p) => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p[key]).toFixed(1)}" r="3.5" style="fill:${color};stroke:var(--ch-dotring)" stroke-width="1.5"/>`).join('');
  const kfmt = (v) => v >= 1000000 ? '$' + (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + Math.round(v);
  const dfmt = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const gridY = [0.25, 0.5, 0.75, 1].map((f) => {
    const v = yMax * f, y = Y(v).toFixed(1);
    return `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" style="stroke:var(--ch-grid)"/><text x="${L - 8}" y="${Number(y) + 4}" text-anchor="end" style="fill:var(--ch-label)" font-size="11">${kfmt(v)}</text>`;
  }).join('');
  const xLabels = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]
    .filter((p, i, a) => a.findIndex((x) => x.t === p.t) === i)
    .map((p) => `<text x="${X(p.t).toFixed(1)}" y="${H - 10}" text-anchor="middle" style="fill:var(--ch-label)" font-size="11">${dfmt(p.t)}</text>`).join('');
  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      ${gridY}${xLabels}
      <line x1="${L}" y1="${Y(0)}" x2="${W - R}" y2="${Y(0)}" style="stroke:var(--ch-axis)"/>
      <polyline points="${line('out')}" fill="none" style="stroke:var(--ch-ink)" stroke-width="2.5" stroke-dasharray="7 6" stroke-linejoin="round"/>
      <polyline points="${line('sp')}" fill="none" stroke="#ff5c5c" stroke-width="2.5" stroke-linejoin="round"/>
      <polyline points="${line('rec')}" fill="none" stroke="#34d17b" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots('out', 'var(--ch-ink)')}${dots('sp', '#ff5c5c')}${dots('rec', '#34d17b')}
    </svg>
    <div class="chart-legend">
      <span><span class="sw" style="border-top-style:dashed;border-color:var(--ch-ink)"></span>Receivable (outstanding)</span>
      <span><span class="sw" style="border-color:#ff5c5c"></span>Material spending</span>
      <span><span class="sw" style="border-color:#34d17b"></span>Money received</span>
    </div>`;
}

/* ---------- HOME ---------- */
async function renderHome() {
  const all = await api('/api/projects');
  const overhead = overheadOf(all);
  const projects = realJobs(all);              // jobs only — overhead is not a job
  const totalValue = projects.reduce((s, p) => s + (p.price || 0), 0);
  const isAdmin = IS_STAFF; // admin or project manager — not delivery
  const received = isAdmin ? projects.reduce((s, p) => s + (p.payments || []).reduce((a, x) => a + (x.amount || 0), 0), 0) : null;
  const toOrderCost = isAdmin ? projects.reduce((s, p) => s + (p.materials || []).filter((m) => !m.ordered).reduce((a, m) => a + (m.price || 0) * (m.qty || 1), 0), 0) : null;
  // every unpaid scheduled payment across all jobs, soonest first
  const allDues = projects
    .flatMap((p) => openDues(p).map((d) => ({ ...d, projectName: p.name, projectId: p.id })))
    .sort((a, b) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || String(a.dueDate).localeCompare(String(b.dueDate)));
  const duesTotal = allDues.reduce((s, d) => s + (d.amount || 0), 0);
  const overdueCount = allDues.filter(isOverdue).length;
  // general to-do list — admin's own, not attached to any job
  const todos = ME.role === 'admin' ? await api('/api/todos').catch(() => []) : [];
  const recentPhotos = projects
    .flatMap((p) => (p.photos || []).map((ph) => ({ ...ph, projectName: p.name, projectId: p.id })))
    .sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
  // the delivery guy gets the map and nothing else — it is the only thing he needs
  if (IS_DELIVERY) {
    $('#main').innerHTML = `
      <div class="page-head"><h1>Welcome, ${esc(ME.name)}</h1></div>
      <div class="panel map-card" id="mapCard">
        <h3>Job Map</h3>
        <div class="map-hint">Click map to expand ⛶</div>
        <div id="homemap"></div>
      </div>`;
    homeMap = drawMap('homemap', projects, false);
    setTimeout(() => homeMap.invalidateSize(), 120);
    $('#mapCard').addEventListener('click', () => openFullMap(projects));
    return;
  }

  $('#main').innerHTML = `
    ${isAdmin ? '' : `<div class="page-head"><h1>Welcome, ${esc(ME.name)}</h1></div>`}
    <div class="cards">
      <div class="stat"><div class="num">${projects.length}</div><div class="lbl">${isAdmin ? 'Active Jobs' : 'My Jobs'}</div></div>
      ${isAdmin ? `
      <div class="stat"><div class="num" style="color:var(--amber)">${money(totalValue - received)}</div><div class="lbl">Outstanding</div></div>
      <div class="stat"><div class="num" style="color:var(--green)">${money(received)}</div><div class="lbl">Received</div></div>` : ''}
      ${isAdmin ? `<div class="stat ${overdueCount ? 'stat-alert' : ''}"><div class="num" style="color:${duesTotal ? 'var(--red)' : 'inherit'}">${money(duesTotal)}</div><div class="lbl">Payments Due${overdueCount ? ` — ${overdueCount} overdue` : ''}</div></div>` : ''}
      <div class="stat"><div class="num">${money(totalValue)}</div><div class="lbl">Total Contract Value</div></div>
      ${toOrderCost !== null ? `<div class="stat"><div class="num">${money(toOrderCost)}</div><div class="lbl">Materials To Order Cost</div></div>` : ''}
      ${isAdmin && overhead ? (() => {
        const spent = (overhead.invoices || []).reduce((s, x) => s + (x.amount || 0), 0);
        return `<div class="stat" style="cursor:pointer" onclick="location.hash='#/job/${overhead.id}'">
          <div class="num">${money(spent)}</div><div class="lbl">General Spending</div></div>`;
      })() : ''}
    </div>
    ${isAdmin && allDues.length ? (() => {
      const jobCount = new Set(allDues.map((d) => d.projectId)).size;
      return `
    <div class="panel">
      <h3>Payments Due <span class="muted" style="font-size:13px;text-transform:none;letter-spacing:0">— ${money(duesTotal)} across ${jobCount} job${jobCount === 1 ? '' : 's'}</span></h3>
      <table>
        <thead><tr><th>Job</th><th>Payment</th><th>Due</th><th class="right">Amount</th><th>Status</th></tr></thead>
        <tbody>
          ${allDues.map((d) => `
          <tr>
            <td><a href="#/job/${d.projectId}">${esc(d.projectName)}</a></td>
            <td>${esc(d.label)}</td>
            <td>${d.dueDate ? fmtDate(d.dueDate) : '<span class="muted">—</span>'}</td>
            <td class="right"><b>${money(d.amount)}</b></td>
            <td><span class="badge ${isOverdue(d) ? 'badge-red' : 'badge-amber'}">${dueWhen(d)}</span></td>
          </tr>`).join('')}
          <tr class="totals-row"><td colspan="3">Total due</td><td class="right" style="color:var(--red)">${money(duesTotal)}</td><td></td></tr>
        </tbody>
      </table>
    </div>`; })() : ''}
    ${isAdmin ? `
    <div class="home-duo">
    <div class="panel chart-panel">
      <h3>Cash Flow — Receivable vs. Spending vs. Received</h3>
      ${financeChartSVG(projects)}
    </div>
    <div class="panel todo-panel">
      ${(() => {
        const jobNotes = (done) => projects.reduce((s, p) => s + (p.notes || []).filter((n) => !!n.done === done).length, 0);
        const openCount = jobNotes(false) + todos.filter((t) => !t.done).length;
        const doneCount = jobNotes(true) + todos.filter((t) => t.done).length;
        const isAdminUser = ME.role === 'admin';
        /* General items sit above the per-job ones, so what isn't tied to a job doesn't get buried. */
        const generalGroup = (done) => {
          const shown = todos.filter((t) => !!t.done === done);
          if (!isAdminUser || !shown.length) return '';
          return `
          <div class="todo-job todo-general">
            <h4>📌 General <span class="muted">— ${shown.length} ${done ? 'completed' : 'open'}</span></h4>
            ${shown.map((t) => `
            <div class="note-row ${t.done ? 'done' : ''}">
              <input type="checkbox" data-gtodo="${t.id}" ${t.done ? 'checked' : ''} />
              <span class="note-text">${esc(t.text)}</span>
              <button class="del" data-gdel="${t.id}" title="Delete">✕</button>
            </div>`).join('')}
          </div>`;
        };
        const list = (done) => {
          const jobs = projects
            .map((p) => ({ ...p, shown: (p.notes || []).filter((n) => !!n.done === done) }))
            .filter((p) => p.shown.length);
          const general = generalGroup(done);
          if (!jobs.length && !general) {
            return `<div class="muted">${done ? 'Nothing completed yet.' : 'No open to-do items. Add a general one above, or add notes on a job page.'}</div>`;
          }
          return general + jobs.map((p) => `
          <div class="todo-job">
            <h4><a href="#/job/${p.id}">${esc(p.name)}</a> <span class="muted">— ${p.shown.length} ${done ? 'completed' : 'open'}</span></h4>
            ${p.shown.map((n) => `
            <div class="note-row ${n.done ? 'done' : ''}">
              <input type="checkbox" data-hnote="${p.id}:${n.id}" ${n.done ? 'checked' : ''} />
              <span class="note-text">${esc(n.text)}</span>
            </div>`).join('')}
          </div>`).join('');
        };
        return `
      <div class="todo-head">
        <h3>To-Do</h3>
        <div class="todo-tabs">
          <button class="todo-tab ${todoTab === 'open' ? 'active' : ''}" data-ttab="open">Open${openCount ? ' (' + openCount + ')' : ''}</button>
          <button class="todo-tab ${todoTab === 'done' ? 'active' : ''}" data-ttab="done">Completed${doneCount ? ' (' + doneCount + ')' : ''}</button>
        </div>
      </div>
      ${isAdminUser ? `
      <div class="note-add">
        <input id="gtodoText" placeholder="Add a general to-do — not tied to any job…" />
        <button class="btn gold" id="gtodoAdd">Add</button>
      </div>
      <div class="error" id="gtodoErr"></div>` : ''}
      <div ${todoTab === 'open' ? '' : 'hidden'} data-tpane="open">${list(false)}</div>
      <div ${todoTab === 'done' ? '' : 'hidden'} data-tpane="done">${list(true)}</div>`;
      })()}
    </div>
    </div>` : ''}
    ${recentPhotos.length ? `
    <div class="panel">
      <h3>Photos <span class="muted" style="font-size:13px">— ${recentPhotos.length}</span></h3>
      <div class="photo-grid" id="homePhotoGrid">
        ${recentPhotos.map((ph, i) => `
        <div class="photo-item" data-rview="${i}">
          <img src="/api/file/${ph.thumb || ph.file}" alt="${esc(ph.name)}" loading="lazy" />
          <a class="photo-tag" href="#/job/${ph.projectId}" onclick="event.stopPropagation()">${esc(ph.projectName)}</a>
        </div>`).join('')}
      </div>
      <a href="#/photos" class="muted" id="allPhotosLink" style="display:none;margin-top:10px">View all ${recentPhotos.length} photos →</a>
    </div>` : ''}
    <div class="panel map-card" id="mapCard">
      <h3>Job Map</h3>
      <div class="map-hint">Click map to expand ⛶</div>
      <div id="homemap"></div>
    </div>`;
  document.querySelectorAll('input[data-hnote]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const [pid, nid] = cb.dataset.hnote.split(':');
      await api(`/api/projects/${pid}/notes/${nid}`, { method: 'PUT', json: { done: cb.checked } });
      renderHome();
    })
  );

  // general to-do (admin only)
  if ($('#gtodoAdd')) {
    const addTodo = async () => {
      const text = $('#gtodoText').value.trim();
      if (!text) return;
      try {
        await api('/api/todos', { method: 'POST', json: { text } });
        renderHome();
      } catch (err) { $('#gtodoErr').textContent = err.message; }
    };
    $('#gtodoAdd').addEventListener('click', addTodo);
    $('#gtodoText').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });
  }
  document.querySelectorAll('input[data-gtodo]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      await api('/api/todos/' + cb.dataset.gtodo, { method: 'PUT', json: { done: cb.checked } });
      renderHome();
    })
  );
  document.querySelectorAll('[data-gdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this to-do?')) return;
      await api('/api/todos/' + b.dataset.gdel, { method: 'DELETE' });
      renderHome();
    })
  );
  document.querySelectorAll('.todo-tab').forEach((b) =>
    b.addEventListener('click', () => {
      todoTab = b.dataset.ttab;
      document.querySelectorAll('.todo-tab').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('[data-tpane]').forEach((p) => (p.hidden = p.dataset.tpane !== todoTab));
    })
  );
  homeMap = drawMap('homemap', projects, false);
  setTimeout(() => homeMap.invalidateSize(), 120);
  $('#mapCard').addEventListener('click', () => openFullMap(projects));
  document.querySelectorAll('[data-rview]').forEach((d) =>
    d.addEventListener('click', (e) => {
      if (e.target.closest('.photo-tag')) return;
      openLightbox(recentPhotos, Number(d.dataset.rview));
    })
  );
  /* cap the home photo grid at 2 rows (adapts to screen width) */
  const pg = document.getElementById('homePhotoGrid');
  if (pg) {
    const capRows = () => {
      if (!document.body.contains(pg)) { window.removeEventListener('resize', capRows); return; }
      const cols = getComputedStyle(pg).gridTemplateColumns.split(' ').length;
      const max = cols * 2;
      [...pg.children].forEach((el, i) => (el.style.display = i < max ? '' : 'none'));
      const link = document.getElementById('allPhotosLink');
      if (link) link.style.display = recentPhotos.length > max ? 'block' : 'none';
    };
    capRows();
    window.addEventListener('resize', capRows);
  }
}

function drawMap(elId, projects, interactivePopups) {
  const located = projects.filter((p) => p.lat && p.lng);
  const map = L.map(elId, { scrollWheelZoom: interactivePopups });
  L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps'
  }).addTo(map);
  let group = null;
  if (located.length) {
    group = L.featureGroup(located.map((p) => {
      const [label, color] = STATUS[statusOf(p)];
      const m = L.circleMarker([p.lat, p.lng], { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).bindPopup(
        `<div class="map-popup"><a href="#/job/${p.id}">${esc(p.name)}</a><br>${addrLink(p)}<br>Starts: ${fmtDate(p.startDate)}<br><b style="color:${color}">${label}</b></div>`
      );
      return m;
    }));
    group.addTo(map);
    map.fitBounds(group.getBounds().pad(0.25), { maxZoom: 13 });
  } else {
    map.setView([38.9, -77.03], 9); // DMV area default
  }
  // re-measure once layout settles, so the map never renders partially (mobile fix)
  const fixSize = () => {
    map.invalidateSize();
    if (group) map.fitBounds(group.getBounds().pad(0.25), { maxZoom: 13 });
  };
  setTimeout(fixSize, 150);
  setTimeout(fixSize, 500);
  if (window.ResizeObserver) {
    const el = document.getElementById(elId);
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    map.on('unload', () => ro.disconnect());
  }
  return map;
}

function openFullMap(projects) {
  $('#mapFull').classList.remove('hidden');
  if (bigMap) { bigMap.remove(); bigMap = null; }
  bigMap = drawMap('bigmap', projects, true);
  setTimeout(() => bigMap.invalidateSize(), 60);
}
$('#mapCloseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#mapFull').classList.add('hidden');
  if (bigMap) { bigMap.remove(); bigMap = null; }
});
window.addEventListener('hashchange', () => { $('#mapFull').classList.add('hidden'); if (bigMap) { bigMap.remove(); bigMap = null; } });

/* ---------- JOBS LIST ---------- */
let jobsFilter = 'all', jobsQuery = '';
async function renderJobs() {
  const projects = realJobs(await api('/api/projects'));
  const isAdmin = IS_STAFF; // admin or project manager — not delivery
  const card = (p) => `
      <div class="job-card" onclick="location.hash='#/job/${p.id}'">
        <h4>${esc(p.name)}</h4>
        <div class="addr">📍 ${addrLink(p)}</div>
        <div class="job-meta">
          ${IS_DELIVERY ? '' : `<span><b>${money(p.price)}</b></span>`}
          <span>Starts <b>${fmtDate(p.startDate)}</b></span>
          ${statusBadge(p)}
          ${isAdmin && dueTotal(p) ? `<span class="badge ${openDues(p).some(isOverdue) ? 'badge-red' : 'badge-amber'}">${money(dueTotal(p))} due</span>` : ''}
          ${isAdmin && p.pmName ? `<span class="badge" style="background:#2c6bd7;color:#fff">👷 ${esc(p.pmName)}</span>` : ''}
        </div>
        ${p.lockbox ? `<div class="job-meta" style="margin-top:8px">
          <span class="lockbox-code" data-lb="${esc(p.lockbox)}" title="Tap to copy">🔒 ${esc(p.lockbox)}</span>
        </div>` : ''}
        <div class="job-meta file-cell" style="margin-top:8px">${fileChips(p)}</div>
        ${isAdmin ? `<div class="job-meta" style="margin-top:8px">
          <span>${(p.materials || []).filter((m) => !m.ordered).length} materials to order</span>
          <span>${(p.notes || []).filter((n) => !n.done).length} open notes</span>
        </div>` : ''}
      </div>`;
  const buildBody = () => {
    const q = jobsQuery.trim().toLowerCase();
    const shown = projects.filter((p) =>
      (jobsFilter === 'all' || statusOf(p) === jobsFilter) &&
      (!q || [p.name, p.address, p.customerName].some((v) => v && v.toLowerCase().includes(q))));
    if (!projects.length) return '<div class="panel muted">No jobs yet.' + (isAdmin ? ' Click “+ New Project” to create your first job.' : '') + '</div>';
    if (!shown.length) return '<div class="panel muted">No jobs match your search.</div>';
    if (!isAdmin) return `<div class="job-grid">${shown.map(card).join('')}</div>`;
    /* group jobs under their customer */
    const groups = new Map();
    for (const p of shown) {
      const key = p.customerName || 'Unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const names = [...groups.keys()].sort((a, b) =>
      (a === 'Unassigned') - (b === 'Unassigned') || a.localeCompare(b));
    return names.map((n) => {
      const list = groups.get(n);
      const total = list.reduce((s, p) => s + (p.price || 0), 0);
      return `
      <section class="cust-group">
        <div class="cust-head">
          <h3>👤 ${esc(n)}</h3>
          <span class="muted">${list.length} job${list.length === 1 ? '' : 's'} — ${money(total)}</span>
        </div>
        <div class="job-grid">${list.map(card).join('')}</div>
      </section>`;
    }).join('');
  };
  const chip = (k, label) => `<button class="todo-tab ${jobsFilter === k ? 'active' : ''}" data-jf="${k}">${label}</button>`;

  /* overview table — always shows every job, independent of the filter chips below */
  const overview = () => {
    const groups = STATUS_TABLE
      .map(([key, title, note]) => ({ key, title, note, items: projects.filter((p) => statusOf(p) === key) }))
      .filter((g) => g.key !== 'done' || g.items.length);
    return `
    <div class="panel">
      <h3>Job Status Overview</h3>
      <div class="status-summary">
        ${groups.map((g) => `<div class="status-sum" style="border-left-color:${STATUS[g.key][1]}">
          <div class="n">${g.items.length}</div>
          <div class="l">${g.title}</div>
          <div class="v">${money(g.items.reduce((s, p) => s + (p.price || 0), 0))}</div>
        </div>`).join('')}
      </div>
      <table class="overview-table">
        <thead><tr>
          <th>Status</th><th>Job</th><th>Address</th><th>Lockbox</th><th>Files</th><th class="right">Price</th><th>Start Date</th><th>Customer</th>
        </tr></thead>
        <tbody>
          ${groups.map((g) => `
            <tr class="totals-row"><td colspan="8">${g.title} — ${g.items.length} job${g.items.length === 1 ? '' : 's'} <span class="muted">· ${g.note}</span></td></tr>
            ${g.items.length ? g.items.map((p) => `
            <tr>
              <td>${statusBadge(p)}</td>
              <td><a href="#/job/${p.id}">${esc(p.name)}</a></td>
              <td>${addrLink(p)}</td>
              <td>${p.lockbox ? `<span class="lockbox-code" data-lb="${esc(p.lockbox)}" title="Tap to copy">🔒 ${esc(p.lockbox)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="file-cell">${fileChips(p)}</td>
              <td class="right">${money(p.price)}</td>
              <td>${fmtDate(p.startDate)}</td>
              <td>${p.customerName ? esc(p.customerName) : '<span class="muted">—</span>'}</td>
            </tr>`).join('')
            : '<tr><td colspan="8" class="muted">None right now.</td></tr>'}
          `).join('')}
        </tbody>
      </table>
    </div>`;
  };

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${isAdmin ? 'Jobs' : 'My Jobs'}</h1>
      ${ME.role === 'admin' ? '<button class="btn gold" id="newProjBtn">+ New Project</button>' : ''}
    </div>
    ${isAdmin && projects.length ? overview() : ''}
    ${isAdmin ? `
    <div class="jobs-controls">
      <input type="search" id="jobsSearch" placeholder="Search jobs by name, address or customer…" value="${esc(jobsQuery)}" />
      <div class="todo-tabs">
        ${chip('all', 'All')}${Object.entries(STATUS).map(([k, [label]]) => chip(k, label)).join('')}
      </div>
    </div>` : ''}
    <div id="jobsList">${buildBody()}</div>`;
  wireLockboxCopy();
  if (isAdmin) {
    if (ME.role === 'admin') $('#newProjBtn').addEventListener('click', () => projectModal());
    const refresh = () => { $('#jobsList').innerHTML = buildBody(); wireLockboxCopy($('#jobsList')); };
    $('#jobsSearch').addEventListener('input', (e) => { jobsQuery = e.target.value; refresh(); });
    document.querySelectorAll('[data-jf]').forEach((b) =>
      b.addEventListener('click', () => {
        jobsFilter = b.dataset.jf;
        document.querySelectorAll('[data-jf]').forEach((x) => x.classList.toggle('active', x === b));
        refresh();
      })
    );
  }
}

/* ---------- ORDERS (admin) ---------- */
async function renderOrders() {
  const projects = await api('/api/projects');
  const jobs = projects
    .map((p) => ({ ...p, open: (p.materials || []).filter((m) => !m.ordered) }))
    .filter((p) => (p.materials || []).length);
  const totalOpen = jobs.reduce((s, p) => s + p.open.length, 0);
  const totalCost = jobs.reduce((s, p) => s + p.open.reduce((a, m) => a + (m.price || 0) * (m.qty || 1), 0), 0);
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Orders</h1>
      <div class="muted">${totalOpen} item${totalOpen === 1 ? '' : 's'} to order — ${money(totalCost)}</div>
    </div>
    ${jobs.length ? `<div class="order-grid">
      ${jobs.map((p) => {
        const cost = p.open.reduce((a, m) => a + (m.price || 0) * (m.qty || 1), 0);
        const cats = [...new Set(p.open.map((m) => m.category || 'Other'))];
        return `
        <div class="panel order-block">
          <h3><a href="#/job/${p.id}">${esc(p.name)}</a></h3>
          <div class="muted" style="margin-bottom:10px">${p.open.length ? `${cats.length} order${cats.length === 1 ? '' : 's'} (${cats.map(esc).join(', ')}) — ${p.open.length} item${p.open.length === 1 ? '' : 's'} — <b style="color:var(--red)">${money(cost)}</b>` : '✓ All materials ordered'}</div>
          ${p.open.length ? `
          <table>
            <thead><tr><th style="width:36px"></th><th>Material</th><th class="right">Qty</th><th class="right">Cost</th><th>Link</th></tr></thead>
            <tbody>
              ${cats.map((c) => `
              <tr class="totals-row"><td colspan="5">📦 ${esc(c)}</td></tr>
              ${p.open.filter((m) => (m.category || 'Other') === c).map((m) => `
              <tr>
                <td><input type="checkbox" data-omid="${p.id}:${m.id}" style="width:17px;height:17px;accent-color:var(--gold)" /></td>
                <td>${esc(m.name)}</td>
                <td class="right">${m.qty || 1}${m.unit ? ' ' + esc(m.unit) : ''}</td>
                <td class="right">${money((m.price || 0) * (m.qty || 1))}</td>
                <td>${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">Buy ↗</a>` : '<span class="muted">—</span>'}</td>
              </tr>`).join('')}`).join('')}
            </tbody>
          </table>` : ''}
        </div>`;
      }).join('')}
    </div>` : '<div class="panel muted">No material lists uploaded yet. Upload a takeoff Excel on a job page and its items to order will show up here.</div>'}`;
  document.querySelectorAll('input[data-omid]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const [pid, mid] = cb.dataset.omid.split(':');
      await api(`/api/projects/${pid}/materials/${mid}`, { method: 'PUT', json: { ordered: cb.checked } });
      renderOrders();
    })
  );
}

/* ---------- PHOTOS (all users) ---------- */
async function renderPhotos() {
  const projects = await api('/api/projects');
  const jobs = projects
    .map((p) => ({ ...p, photos: (p.photos || []).slice().sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded))) }))
    .filter((p) => p.photos.length);
  const total = jobs.reduce((s, p) => s + p.photos.length, 0);
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Photos</h1>
      <div class="muted">${total} photo${total === 1 ? '' : 's'} across ${jobs.length} job${jobs.length === 1 ? '' : 's'}</div>
    </div>
    ${jobs.length ? jobs.map((p, ji) => `
    <div class="panel">
      <h3><a class="photo-job-link" href="#/job/${p.id}">${esc(p.name)}</a> <span class="muted">— ${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}</span></h3>
      <div class="photo-grid">
        ${p.photos.map((ph, i) => `
        <div class="photo-item" data-pj="${ji}" data-pi="${i}">
          <img src="/api/file/${ph.thumb || ph.file}" alt="${esc(ph.name)}" loading="lazy" />
        </div>`).join('')}
      </div>
    </div>`).join('') : '<div class="panel muted">No photos yet. Upload photos on a job page and they will show up here.</div>'}`;
  document.querySelectorAll('[data-pj]').forEach((d) =>
    d.addEventListener('click', () => openLightbox(jobs[Number(d.dataset.pj)].photos, Number(d.dataset.pi)))
  );
}

/* ---------- PROJECT CREATE / EDIT MODAL ---------- */
async function projectModal(p) {
  const customers = await api('/api/customers');
  const pms = await api('/api/pms');
  const isEdit = !!p;
  openModal(`
    <h2>${isEdit ? 'Edit Project' : 'New Project'}</h2>
    <form id="projForm" class="form-grid">
      <div class="full"><label class="f">Project Name *</label><input class="f" name="name" required value="${isEdit ? esc(p.name) : ''}" /></div>
      <div class="full"><label class="f">Address * (used to pin the job on the map)</label><input class="f" name="address" required value="${isEdit ? esc(p.address) : ''}" /></div>
      <div class="full"><label class="f">Lockbox Code / Access Info</label><input class="f" name="lockbox" placeholder="e.g. 1234 — back door lockbox" value="${isEdit && p.lockbox ? esc(p.lockbox) : ''}" /></div>
      <div><label class="f">Price ($)</label><input class="f" name="price" type="number" step="0.01" min="0" value="${isEdit ? p.price : ''}" /></div>
      <div><label class="f">Job Start Date</label><input class="f" name="startDate" type="date" value="${isEdit && p.startDate ? p.startDate : ''}" /></div>
      <div><label class="f">Status</label>
        <select class="f" name="status">
          ${Object.entries(STATUS).map(([k, [label]]) => `<option value="${k}" ${isEdit && statusOf(p) === k ? 'selected' : (!isEdit && k === 'active' ? 'selected' : '')}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="full"><label class="f">Customer</label>
        <select class="f" name="customerId">
          <option value="">— No customer assigned —</option>
          ${customers.map((c) => `<option value="${c.id}" ${isEdit && p.customerId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="full"><label class="f">Project Manager</label>
        <select class="f" name="pmId">
          <option value="">— No manager assigned —</option>
          ${pms.map((c) => `<option value="${c.id}" ${isEdit && p.pmId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div><label class="f">Contract ${isEdit && p.contractName ? '(current: ' + esc(p.contractName) + ')' : ''}</label><input class="f" name="contract" type="file" /></div>
      <div><label class="f">Arch Plan PDF ${isEdit && p.planName ? '(current: ' + esc(p.planName) + ')' : ''}</label><input class="f" name="plan" type="file" accept=".pdf" /></div>
      <div class="modal-actions full">
        <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn gold">${isEdit ? 'Save Changes' : 'Create Project'}</button>
      </div>
      <div class="error full" id="projErr"></div>
    </form>`);
  $('#projForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving… (locating address)';
    try {
      const saved = await api(isEdit ? '/api/projects/' + p.id : '/api/projects', { method: isEdit ? 'PUT' : 'POST', body: fd });
      closeModal();
      location.hash = '#/job/' + saved.id;
      if (isEdit) route();
    } catch (err) { $('#projErr').textContent = err.message; btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Create Project'; }
  });
}

/* ---------- JOB DETAIL ---------- */
async function renderJob(id) {
  let p;
  try { p = await api('/api/projects/' + id); }
  catch { $('#main').innerHTML = '<div class="panel">Job not found.</div>'; return; }
  const isAdmin = IS_STAFF; // admin or project manager — not delivery
  const mats = p.materials || [];
  const toOrder = mats.filter((m) => !m.ordered);
  const totAll = mats.reduce((s, m) => s + m.price * (m.qty || 1), 0);
  const totOrder = toOrder.reduce((s, m) => s + m.price * (m.qty || 1), 0);
  // group by category — each category = one supplier order to place
  const catNames = [...new Set(mats.map((m) => m.category || 'Other'))];
  const groups = catNames.map((c) => {
    const items = mats.filter((m) => (m.category || 'Other') === c);
    return {
      name: c, items,
      open: items.filter((m) => !m.ordered).length,
      total: items.reduce((s, m) => s + m.price * (m.qty || 1), 0),
    };
  });
  const ordersToPlace = groups.filter((g) => g.open > 0).length;
  const pays = (p.payments || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const paid = pays.reduce((s, x) => s + (x.amount || 0), 0);
  const balance = (p.price || 0) - paid;
  const today = new Date().toISOString().slice(0, 10);
  const dues = (p.dues || []).slice().sort((a, b) =>
    (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || String(a.dueDate).localeCompare(String(b.dueDate)));
  const owed = dueTotal(p);
  const next = nextDue(p);
  const overdueTotal = openDues(p).filter(isOverdue).reduce((s, d) => s + d.amount, 0);
  // invoices — money going out on this job, newest first
  const invoices = (p.invoices || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const invTotal = invoices.reduce((s, x) => s + (x.amount || 0), 0);
  const profit = (p.price || 0) - invTotal;
  const vendors = [...new Set(invoices.map((x) => x.paidTo).filter(Boolean))].sort();

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${esc(p.name)}</h1>
      <div>
        ${isAdmin ? `<button class="btn" id="editProjBtn">Edit</button>` : ''}${ME.role === 'admin' ? ` <button class="btn danger" id="delProjBtn">Delete</button>` : ''}
      </div>
    </div>

    ${isAdmin && owed ? `
    <div class="due-banner ${overdueTotal ? 'overdue' : ''}">
      <div class="due-banner-main">
        <div class="due-banner-lbl">${overdueTotal ? '⚠️ Payment Overdue' : 'Payment Due'}</div>
        <div class="due-banner-amt">${money(owed)}</div>
      </div>
      <div class="due-banner-side">
        ${next ? `<div><b>${esc(next.label)}</b> — ${money(next.amount)}</div>
        <div class="due-banner-when">${dueWhen(next)}${next.dueDate ? ' · ' + fmtDate(next.dueDate) : ''}</div>` : ''}
        ${openDues(p).length > 1 ? `<div class="due-banner-when">${openDues(p).length} payments outstanding</div>` : ''}
      </div>
    </div>` : ''}

    ${p.overhead ? `
    <div class="panel">
      <div class="muted">Spending that belongs to no single job — fuel, tools, office, general supplies.
      Pick this in the job dropdown on a receipt or a check line.</div>
    </div>` : `
    <div class="panel">
      <div class="info-grid">
        <div><div class="k">Address</div><div class="v">${addrLink(p, 'addr-big')}</div></div>
        <div><div class="k">Lockbox Code</div><div class="v">${p.lockbox ? `<span class="lockbox-code" data-lb="${esc(p.lockbox)}" title="Tap to copy">🔒 ${esc(p.lockbox)}</span>` : '<span class="muted">—</span>'}</div></div>
        ${IS_DELIVERY ? '' : `<div><div class="k">Price</div><div class="v">${money(p.price)}</div></div>`}
        <div><div class="k">Job Start Date</div><div class="v">${fmtDate(p.startDate)}</div></div>
        <div><div class="k">Customer</div><div class="v">${esc(p.customerName || '—')}</div></div>
      </div>
      <div style="margin-top:16px">
        ${p.contractFile ? `<a class="file-chip" href="#" data-file-view="${p.contractFile}" data-file-name="${esc(p.contractName || '')}">📄 Contract — ${esc(p.contractName)}</a>` : '<span class="muted" style="margin-right:12px">No contract uploaded.</span>'}
        ${p.planFile ? `<a class="file-chip" href="#" data-file-view="${p.planFile}" data-file-name="${esc(p.planName || '')}">📐 Arch Plan — ${esc(p.planName)}</a>` : '<span class="muted">No arch plan uploaded.</span>'}
      </div>
      ${!p.lat && isAdmin ? '<div class="muted" style="margin-top:10px">⚠️ Address could not be located on the map. Edit the project and refine the address.</div>' : ''}
    </div>`}

    ${p.lat && p.lng ? `
    <div class="panel">
      <h3>Location</h3>
      <div id="jobmap"></div>
    </div>` : ''}

    <div class="panel">
      <h3><a class="photo-job-link" href="#/job/${p.id}/photos">Photos${(p.photos || []).length ? ' (' + p.photos.length + ')' : ''} ›</a></h3>
      ${IS_CREW ? `
      <div style="margin-bottom:14px">${photoUploaderHtml()}</div>` : ''}
      ${(p.photos || []).length ? `
      <div class="photo-grid" id="jobPhotoGrid">
        ${p.photos.map((ph) => `
        <div class="photo-item" data-view="${p.photos.indexOf(ph)}">
          <img src="/api/file/${ph.thumb || ph.file}" alt="${esc(ph.name)}" loading="lazy" />
          ${IS_CREW ? `<button class="photo-del" data-delphoto="${ph.id}" title="Delete photo">✕</button>` : ''}
        </div>`).join('')}
      </div>
      <a href="#/job/${p.id}/photos" class="muted" id="jobPhotosMore" style="display:none;margin-top:10px">View all ${p.photos.length} photos →</a>` : '<div class="muted">No photos yet.</div>'}
    </div>

    ${isAdmin && !p.overhead ? `
    <div class="panel">
      <h3>Payment Schedule${owed ? ` <span class="muted" style="font-size:13px;text-transform:none;letter-spacing:0">— ${money(owed)} still due</span>` : ''}</h3>
      ${dues.length ? `
      <table class="dues-table">
        <thead><tr><th>Payment</th><th>Due</th><th class="right">Amount</th><th>Status</th><th style="width:36px"></th></tr></thead>
        <tbody>
          ${dues.map((d) => `
          <tr class="${d.paidOn ? 'ordered' : ''}">
            <td><b>${esc(d.label)}</b></td>
            <td>${d.dueDate ? fmtDate(d.dueDate) : '<span class="muted">—</span>'}</td>
            <td class="right"><b>${money(d.amount)}</b></td>
            <td>${d.paidOn
              ? `<span class="badge">✓ Paid ${fmtDate(d.paidOn)}</span>`
              : `<span class="badge ${isOverdue(d) ? 'badge-red' : 'badge-amber'}">${dueWhen(d)}</span>`}</td>
            <td class="right">
              <button class="del" data-duepaid="${d.id}" data-now="${d.paidOn ? 1 : 0}" title="${d.paidOn ? 'Mark as unpaid' : 'Mark as paid'}">${d.paidOn ? '↺' : '✓'}</button>
              <button class="del" data-deldue="${d.id}" title="Delete">✕</button>
            </td>
          </tr>`).join('')}
          ${owed ? `<tr class="totals-row"><td colspan="2">Still due</td><td class="right" style="color:var(--red)">${money(owed)}</td><td colspan="2"></td></tr>` : ''}
        </tbody>
      </table>` : '<div class="muted">No payments scheduled yet. Add one below to start tracking what is owed and when.</div>'}
      <div class="form-grid" style="margin-top:16px">
        <div><label class="f">What For (e.g. Deposit, Draw 2, Final)</label><input class="f" id="dueLabel" placeholder="Payment" /></div>
        <div><label class="f">Amount ($)</label><input class="f" id="dueAmount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div><label class="f">Due Date</label><input class="f" id="dueDate" type="date" /></div>
        <div style="display:flex;align-items:flex-end;justify-content:flex-end"><button class="btn gold" id="dueAddBtn">+ Schedule Payment</button></div>
        <div class="error full" id="dueErr"></div>
      </div>
    </div>` : ''}

    ${isAdmin && !p.overhead ? `
    <div class="panel">
      <h3>Payments Received</h3>
      <div class="info-grid" style="margin-bottom:16px">
        <div><div class="k">Contract Price</div><div class="v">${money(p.price)}</div></div>
        <div><div class="k">Received</div><div class="v" style="color:var(--green)">${money(paid)}</div></div>
        <div><div class="k">Balance Due</div><div class="v" style="color:${balance > 0 ? 'var(--red)' : 'var(--green)'}">${money(balance)}</div></div>
      </div>
      ${pays.length ? `
      <table>
        <thead><tr><th>Date</th><th>For</th><th class="right">Amount</th><th style="width:36px"></th></tr></thead>
        <tbody>
          ${pays.map((x) => `
          <tr>
            <td>${fmtDate(x.date)}</td>
            <td>${esc(x.note || '—')}</td>
            <td class="right"><b>${money(x.amount)}</b></td>
            <td class="right"><button class="del" data-delpay="${x.id}" title="Delete payment">✕</button></td>
          </tr>`).join('')}
          <tr class="totals-row"><td colspan="2">Total received (${pays.length} payment${pays.length === 1 ? '' : 's'})</td><td class="right" style="color:var(--green)">${money(paid)}</td><td></td></tr>
        </tbody>
      </table>` : '<div class="muted">No payments recorded yet.</div>'}
      <div class="form-grid" style="margin-top:16px">
        <div><label class="f">Amount ($)</label><input class="f" id="payAmount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div><label class="f">Date Received</label><input class="f" id="payDate" type="date" value="${today}" /></div>
        <div class="full"><label class="f">What For (e.g. deposit, framing complete)</label><input class="f" id="payNote" placeholder="Optional" /></div>
        <div class="full" style="text-align:right"><button class="btn gold" id="payAddBtn">+ Add Payment</button></div>
      </div>
    </div>` : ''}

    <div class="panel">
      <h3>Invoices &amp; Job Costs</h3>
      <div class="info-grid" style="margin-bottom:16px">
        ${IS_DELIVERY ? '' : `<div><div class="k">Contract Price</div><div class="v">${money(p.price)}</div></div>`}
        <div><div class="k">Total Invoiced</div><div class="v" style="color:var(--red)">${money(invTotal)}</div></div>
        ${IS_DELIVERY ? '' : `<div><div class="k">Profit So Far</div><div class="v" style="color:${profit >= 0 ? 'var(--green)' : 'var(--red)'}">${money(profit)}</div></div>`}
      </div>
      ${invoices.length ? `
      <table class="inv-table">
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Paid To</th><th>Invoice</th><th class="right">Cost</th><th style="width:36px"></th></tr></thead>
        <tbody>
          ${invoices.map((x) => `
          <tr>
            <td>${fmtDate(x.date)}</td>
            <td>${esc(x.desc)}</td>
            <td><span class="cat-chip">${esc(x.category || 'Other')}</span></td>
            <td>${x.paidTo ? esc(x.paidTo) : '<span class="muted">—</span>'}</td>
            <td>${x.file
              ? `<a class="mini-chip" href="#" data-file-view="${x.file}" data-file-name="${esc(x.fileName || '')}" title="Open">📄 View</a>`
              : '<span class="muted">—</span>'}</td>
            <td class="right"><b>${money(x.amount)}</b></td>
            <td class="right">${isAdmin ? `<button class="del" data-delinv="${x.id}" title="Delete invoice">✕</button>` : ''}</td>
          </tr>`).join('')}
          <tr class="totals-row">
            <td colspan="5">Total cost (${invoices.length} invoice${invoices.length === 1 ? '' : 's'})</td>
            <td class="right" style="color:var(--red)">${money(invTotal)}</td><td></td>
          </tr>
        </tbody>
      </table>` : `<div class="muted">No costs recorded on this job yet.${isAdmin ? ' Add one below to start tracking what it is costing you.' : ''}</div>`}
      ${isAdmin ? `
      <div class="form-grid" style="margin-top:16px">
        <div class="full"><label class="f">Description *</label><input class="f" id="invDesc" placeholder="e.g. Electrical rough-in" /></div>
        <div><label class="f">Cost ($) *</label><input class="f" id="invAmount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div><label class="f">Paid To</label>
          <input class="f" id="invPaidTo" list="invVendors" placeholder="Sub or supplier" />
          <datalist id="invVendors">${vendors.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>
        </div>
        <div><label class="f">Category</label><select class="f" id="invCategory">${categoryOptions('Materials')}</select></div>
        <div><label class="f">Date</label><input class="f" id="invDate" type="date" value="${today}" /></div>
        <div><label class="f">Invoice PDF or Photo (optional)</label>
          <input class="f" id="invFile" type="file" accept=".pdf,image/*" />
          <div class="scan-status" id="invScan"></div>
        </div>
        <div class="full" style="text-align:right"><button class="btn gold" id="invAddBtn">+ Add Invoice</button></div>
        <div class="error full" id="invErr"></div>
      </div>` : ''}
    </div>

    ${isAdmin && !p.overhead ? `
    <div class="panel">
      <h3>Material List ${p.materialFileName ? '— from ' + esc(p.materialFileName) : ''}</h3>
      <div style="margin-bottom:14px">
        <input type="file" id="matFile" accept=".xlsx,.xls,.csv" style="display:none" />
        <button class="btn gold" id="matUploadBtn">⬆ Upload Material Takeoff Excel</button>
        <span class="muted"> Reads the Summary tab of a material takeoff workbook (Category, Item, Quantity, Unit Cost…) or any simple list with name / link / price columns. Re-uploading replaces the list.</span>
      </div>
      ${mats.length ? `
      <div class="info-grid" style="margin-bottom:16px">
        <div><div class="k">Orders To Place</div><div class="v" style="color:${ordersToPlace ? 'var(--red)' : 'var(--green)'}">${ordersToPlace} of ${groups.length}</div></div>
        <div><div class="k">Items Still To Order</div><div class="v">${toOrder.length} of ${mats.length}</div></div>
        <div><div class="k">Cost Still To Order</div><div class="v" style="color:var(--red)">${money(totOrder)}</div></div>
        <div><div class="k">Total Material Cost</div><div class="v">${money(totAll)}</div></div>
      </div>
      <table>
        <thead><tr><th style="width:40px">Ordered</th><th>Material</th><th>Purchase Link</th><th class="right">Qty</th><th>Unit</th><th class="right">Unit Cost</th><th class="right">Total</th></tr></thead>
        <tbody>
          ${groups.map((g) => `
          <tr class="totals-row"><td colspan="6">📦 ${esc(g.name)} — ${g.open ? g.open + ' item' + (g.open === 1 ? '' : 's') + ' to order' : '✓ fully ordered'}</td><td class="right">${money(g.total)}</td></tr>
          ${g.items.map((m) => `
          <tr class="${m.ordered ? 'ordered' : ''}">
            <td><input type="checkbox" data-mid="${m.id}" ${m.ordered ? 'checked' : ''} style="width:17px;height:17px;accent-color:var(--gold)" /></td>
            <td><span class="mat-name">${esc(m.name)}</span></td>
            <td>${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">Buy ↗</a>` : '<span class="muted">—</span>'}</td>
            <td class="right">${m.qty || 1}</td>
            <td>${esc(m.unit || '')}</td>
            <td class="right">${money(m.price)}</td>
            <td class="right">${money(m.price * (m.qty || 1))}</td>
          </tr>`).join('')}`).join('')}
          <tr class="totals-row"><td colspan="6">Still to order (${ordersToPlace} order${ordersToPlace === 1 ? '' : 's'}, ${toOrder.length} items)</td><td class="right" style="color:var(--red)">${money(totOrder)}</td></tr>
          <tr class="totals-row"><td colspan="6">Grand total material cost (${mats.length} items)</td><td class="right">${money(totAll)}</td></tr>
        </tbody>
      </table>` : '<div class="muted">No material list uploaded yet.</div>'}
    </div>

    <div class="panel">
      <h3>Notes / To-Do</h3>
      <div id="noteList">
        ${(p.notes || []).map((n) => `
        <div class="note-row ${n.done ? 'done' : ''}">
          <input type="checkbox" data-nid="${n.id}" ${n.done ? 'checked' : ''} />
          <span class="note-text">${esc(n.text)}</span>
          <button class="del" data-delnote="${n.id}" title="Delete note">✕</button>
        </div>`).join('') || '<div class="muted">No notes yet.</div>'}
      </div>
      <div class="note-add">
        <input class="f" id="noteInput" placeholder="Add a note / to-do item…" />
        <button class="btn gold" id="noteAddBtn">Add</button>
      </div>
    </div>` : ''}`;

  // job location map (all users)
  if (p.lat && p.lng) drawMap('jobmap', [p], true);

  // tap the lockbox code to copy it (all users)
  wireLockboxCopy();

  // photo viewer (all users)
  document.querySelectorAll('[data-view]').forEach((d) =>
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-delphoto]')) return;
      openLightbox(p.photos || [], Number(d.dataset.view));
    })
  );

  // cap the photo grid at 2 rows; the "View all" link opens the job's photo page
  const jpg = document.getElementById('jobPhotoGrid');
  const jpMore = document.getElementById('jobPhotosMore');
  if (jpg && jpMore) {
    const capRows = () => {
      if (!document.body.contains(jpg)) { window.removeEventListener('resize', capRows); return; }
      const cols = getComputedStyle(jpg).gridTemplateColumns.split(' ').length;
      const max = cols * 2;
      [...jpg.children].forEach((el, i) => (el.style.display = i < max ? '' : 'none'));
      jpMore.style.display = jpg.children.length > max ? 'block' : 'none';
    };
    capRows();
    window.addEventListener('resize', capRows);
  }

  // photos are crew work — the delivery guy adds and removes them too
  if (IS_CREW) {
    wirePhotoUploader(id, () => renderJob(id));
    document.querySelectorAll('[data-delphoto]').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await askConfirm('Delete this photo?')) return;
        await api(`/api/projects/${id}/photos/${b.dataset.delphoto}`, { method: 'DELETE' });
        renderJob(id);
      })
    );
  }

  if (!isAdmin) return;

  $('#editProjBtn').addEventListener('click', () => projectModal(p));
  if ($('#delProjBtn')) $('#delProjBtn').addEventListener('click', async () => {
    if (!await askConfirm('Delete this project? This cannot be undone.')) return;
    await api('/api/projects/' + id, { method: 'DELETE' });
    location.hash = '#/jobs';
  });

  // scheduled payments (what's due)
  $('#dueAddBtn').addEventListener('click', async () => {
    const amount = parseFloat($('#dueAmount').value);
    if (!amount || amount <= 0) { $('#dueErr').textContent = 'Enter a valid amount.'; return; }
    try {
      await api(`/api/projects/${id}/dues`, {
        method: 'POST',
        json: { label: $('#dueLabel').value.trim(), amount, dueDate: $('#dueDate').value || null },
      });
      renderJob(id);
    } catch (err) { $('#dueErr').textContent = err.message; }
  });
  document.querySelectorAll('[data-duepaid]').forEach((b) =>
    b.addEventListener('click', async () => {
      const nowPaid = b.dataset.now === '1';
      if (nowPaid && !await askConfirm('Mark this back as unpaid? Its entry in Payments Received will be removed.', { ok: 'Mark Unpaid' })) return;
      await api(`/api/projects/${id}/dues/${b.dataset.duepaid}`, { method: 'PUT', json: { paid: !nowPaid } });
      renderJob(id);
    })
  );
  document.querySelectorAll('[data-deldue]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this scheduled payment?')) return;
      await api(`/api/projects/${id}/dues/${b.dataset.deldue}`, { method: 'DELETE' });
      renderJob(id);
    })
  );

  // payments
  $('#payAddBtn').addEventListener('click', async () => {
    const amount = parseFloat($('#payAmount').value);
    if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }
    try {
      await api(`/api/projects/${id}/payments`, { method: 'POST', json: { amount, date: $('#payDate').value, note: $('#payNote').value.trim() } });
      renderJob(id);
    } catch (err) { alert(err.message); }
  });
  document.querySelectorAll('[data-delpay]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this payment?')) return;
      await api(`/api/projects/${id}/payments/${b.dataset.delpay}`, { method: 'DELETE' });
      renderJob(id);
    })
  );

  /* Pick a receipt → try to read the vendor, total and date off it and pre-fill the form.
   * Only empty fields get filled, so anything already typed is never clobbered. The
   * suggestions are editable and the user is told to check them. If scanning isn't
   * configured or the read fails, the form just stays manual. */
  $('#invFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    const status = $('#invScan');
    status.className = 'scan-status';
    if (!f) { status.textContent = ''; return; }
    status.textContent = '🔎 Reading the receipt…';
    try {
      const up = await prepReceipt(f);      // shrink / convert HEIC so the scanner can read it
      const fd = new FormData();
      fd.append('receipt', up, up.name);
      const r = await fetch('/api/scan-receipt', { method: 'POST', body: fd });
      if (r.status === 503) { status.textContent = ''; return; }   // not configured — stay quiet
      const g = await r.json().catch(() => ({}));
      if (!r.ok) { status.textContent = g.error || 'Could not read the receipt.'; return; }
      const filled = [];
      if (g.desc && !$('#invDesc').value.trim()) { $('#invDesc').value = g.desc; filled.push('description'); }
      if (g.amount && !parseFloat($('#invAmount').value)) { $('#invAmount').value = g.amount.toFixed(2); filled.push('cost'); }
      if (g.vendor && !$('#invPaidTo').value.trim()) { $('#invPaidTo').value = g.vendor; filled.push('paid to'); }
      if (g.category) { $('#invCategory').value = g.category; filled.push('category'); }
      if (g.date) { $('#invDate').value = g.date; filled.push('date'); }
      if (filled.length) {
        status.className = 'scan-status ok';
        status.textContent = `✓ Filled in ${filled.join(', ')} — check against the receipt before saving.`;
      } else {
        status.textContent = 'Could not make out the details. Enter them by hand.';
      }
    } catch { status.textContent = 'Could not read the receipt. Enter the details by hand.'; }
  });

  // invoices (money out)
  $('#invAddBtn').addEventListener('click', async () => {
    const desc = $('#invDesc').value.trim();
    const amount = parseFloat($('#invAmount').value);
    if (!desc) { $('#invErr').textContent = 'Enter a description.'; return; }
    if (!amount || amount <= 0) { $('#invErr').textContent = 'Enter a valid cost.'; return; }
    const btn = $('#invAddBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const fd = new FormData();
      fd.append('desc', desc);
      fd.append('amount', amount);
      fd.append('paidTo', $('#invPaidTo').value.trim());
      fd.append('category', $('#invCategory').value);
      fd.append('date', $('#invDate').value || '');
      const f = $('#invFile').files[0];
      if (f) fd.append('invoice', f, f.name);
      await api(`/api/projects/${id}/invoices`, { method: 'POST', body: fd });
      renderJob(id);
    } catch (err) {
      $('#invErr').textContent = err.message;
      btn.disabled = false; btn.textContent = '+ Add Invoice';
    }
  });
  document.querySelectorAll('[data-delinv]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this invoice? The attached file is removed too.')) return;
      await api(`/api/projects/${id}/invoices/${b.dataset.delinv}`, { method: 'DELETE' });
      renderJob(id);
    })
  );

  // materials
  $('#matUploadBtn').addEventListener('click', () => $('#matFile').click());
  $('#matFile').addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    const fd = new FormData();
    fd.append('excel', e.target.files[0]);
    try { await api(`/api/projects/${id}/materials`, { method: 'POST', body: fd }); renderJob(id); }
    catch (err) { alert(err.message); }
  });
  document.querySelectorAll('input[data-mid]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      await api(`/api/projects/${id}/materials/${cb.dataset.mid}`, { method: 'PUT', json: { ordered: cb.checked } });
      renderJob(id);
    })
  );

  // notes
  const addNote = async () => {
    const t = $('#noteInput').value.trim();
    if (!t) return;
    await api(`/api/projects/${id}/notes`, { method: 'POST', json: { text: t } });
    renderJob(id);
  };
  $('#noteAddBtn').addEventListener('click', addNote);
  $('#noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });
  document.querySelectorAll('input[data-nid]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      await api(`/api/projects/${id}/notes/${cb.dataset.nid}`, { method: 'PUT', json: { done: cb.checked } });
      renderJob(id);
    })
  );
  document.querySelectorAll('[data-delnote]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/projects/${id}/notes/${b.dataset.delnote}`, { method: 'DELETE' });
      renderJob(id);
    })
  );
}

/* ---------- RECEIPTS INBOX (staff) ----------
 * Snap receipts on site without picking a job. Each upload is scanned, then sits here
 * with editable fields until it gets filed to a job as that job's invoice. */
async function renderReceipts() {
  const [receipts, projects] = await Promise.all([api('/api/receipts'), api('/api/projects')]);
  // general bucket first, then the jobs A–Z
  const jobs = [...(overheadOf(projects) ? [overheadOf(projects)] : []),
    ...realJobs(projects).sort((a, b) => a.name.localeCompare(b.name))];
  const total = receipts.reduce((s, r) => s + (r.amount || 0), 0);
  const needsAttention = receipts.filter((r) => !r.amount).length;
  /* Receipts already filed onto a job. They live as that job's costs now, so gather
   * them back up: anything filed from the inbox, plus any cost with a receipt image
   * attached that didn't come from a check. Newest first. */
  const filed = projects
    .flatMap((p) => (p.invoices || [])
      .filter((x) => x.receiptId || (x.file && !x.checkId))
      .map((x) => ({ ...x, projectName: p.name, projectId: p.id })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id));
  const filedTotal = filed.reduce((s, x) => s + (x.amount || 0), 0);

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Receipts</h1>
      <a class="btn" href="#/jobs">Jobs →</a>
    </div>
    <div class="panel">
      <h3>Add Receipts</h3>
      ${photoUploaderHtml({
        accept: '.pdf,image/*',
        labels: { camera: '📷 Snap Receipt', pick: '🧾 Choose Files', send: '⬆ Upload & Read All' },
        hint: 'Keep tapping <b>Snap Receipt</b> to add more — nothing uploads until you tap Upload.',
      })}
      <div class="muted" style="margin-top:12px">
        Snap them now and file them to a job later. Each one is read automatically — cost, vendor and date come back filled in for you to check.
      </div>
    </div>

    <div class="page-head" style="margin-bottom:12px">
      <h1 style="font-size:17px">Waiting to be filed${receipts.length ? ` — ${receipts.length}` : ''}</h1>
      ${receipts.length ? `<span class="muted">${money(total)} unfiled${needsAttention ? ` · ${needsAttention} need a cost` : ''}</span>` : ''}
    </div>

    ${receipts.length ? `<div class="receipt-grid">${receipts.map((r) => `
      <div class="panel receipt-card" data-rc="${r.id}">
        <div class="receipt-head">
          <a class="mini-chip" href="#" data-file-view="${r.file}" data-file-name="${esc(r.fileName || '')}">📄 View receipt</a>
          <span>
            <button class="del" data-rescan="${r.id}" title="Try reading it again">🔎</button>
            <button class="del" data-delrec="${r.id}" title="Delete receipt">✕</button>
          </span>
        </div>
        ${r.scanned ? '' : `<div class="scan-status">⚠️ ${esc(r.scanError || "Couldn't read this one automatically")} — fill it in below.</div>`}
        <div class="form-grid" style="margin-top:12px">
          <div class="full"><label class="f">Description</label><input class="f" data-f="desc" value="${esc(r.desc)}" placeholder="What was bought" /></div>
          <div><label class="f">Cost ($)</label><input class="f" data-f="amount" type="number" step="0.01" min="0" value="${r.amount ?? ''}" placeholder="0.00" /></div>
          <div><label class="f">Paid To</label><input class="f" data-f="paidTo" value="${esc(r.paidTo)}" placeholder="Sub or supplier" /></div>
          <div><label class="f">Category</label><select class="f" data-f="category">${categoryOptions(r.category)}</select></div>
          <div><label class="f">Date</label><input class="f" data-f="date" type="date" value="${r.date || ''}" /></div>
          <div><label class="f">File To Job</label>
            <select class="f" data-f="job">
              <option value="">— Choose a job —</option>
              ${jobs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="full receipt-actions">
            <span class="muted" data-save="${r.id}"></span>
            <button class="btn gold" data-file="${r.id}">File to Job</button>
          </div>
        </div>
        <div class="muted receipt-meta">Added ${fmtDate(String(r.uploaded).slice(0, 10))}${r.by ? ' by ' + esc(r.by) : ''}</div>
      </div>`).join('')}</div>`
    : '<div class="panel muted">Nothing waiting. Upload a receipt above and it will show up here ready to file.</div>'}

    ${filed.length ? `
    <div class="panel">
      <h3>Recent Receipts <span class="muted" style="font-size:13px;text-transform:none;letter-spacing:0">— ${filed.length} filed${filedTotal ? ', ' + money(filedTotal) : ''}</span></h3>
      <table class="filed-table">
        <thead><tr><th>Date</th><th>What</th><th>Category</th><th>Paid To</th><th>Job</th><th>Receipt</th><th class="right">Cost</th></tr></thead>
        <tbody>
          ${filed.slice(0, 60).map((x) => `
          <tr>
            <td>${fmtDate(x.date)}</td>
            <td>${esc(x.desc)}</td>
            <td><span class="cat-chip">${esc(x.category || 'Other')}</span></td>
            <td>${x.paidTo ? esc(x.paidTo) : '<span class="muted">—</span>'}</td>
            <td><a href="#/job/${x.projectId}">${esc(x.projectName)}</a></td>
            <td>${x.file ? `<a class="mini-chip" href="#" data-file-view="${x.file}" data-file-name="${esc(x.fileName || '')}">📄 View</a>` : '<span class="muted">—</span>'}</td>
            <td class="right"><b>${money(x.amount)}</b></td>
          </tr>`).join('')}
          ${filed.length > 60 ? `<tr><td colspan="7" class="muted">Showing the 60 most recent of ${filed.length}.</td></tr>` : ''}
        </tbody>
      </table>
    </div>` : ''}`;

  wirePhotoUploader(null, () => renderReceipts(), {
    endpoint: '/api/receipts', field: 'receipt', thumbs: false, prepare: prepReceipt,
  });

  // edits save on blur, so a half-typed cost is never pushed
  document.querySelectorAll('.receipt-card').forEach((card) => {
    const id = card.dataset.rc;
    const val = (f) => card.querySelector(`[data-f="${f}"]`).value;
    const note = card.querySelector(`[data-save="${id}"]`);
    card.querySelectorAll('[data-f]:not([data-f="job"])').forEach((inp) =>
      inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'blur', async () => {
        try {
          await api('/api/receipts/' + id, {
            method: 'PUT',
            json: { desc: val('desc'), amount: val('amount'), paidTo: val('paidTo'), date: val('date'), category: val('category') },
          });
          note.textContent = 'Saved';
          setTimeout(() => { note.textContent = ''; }, 1200);
        } catch (err) { note.textContent = err.message; }
      })
    );
    card.querySelector(`[data-file="${id}"]`).addEventListener('click', async () => {
      const projectId = val('job');
      if (!projectId) { note.textContent = 'Pick a job first.'; return; }
      if (!parseFloat(val('amount'))) { note.textContent = 'Enter the cost first.'; return; }
      try {
        // flush any unsaved edits, then file it
        await api('/api/receipts/' + id, {
          method: 'PUT',
          json: { desc: val('desc'), amount: val('amount'), paidTo: val('paidTo'), date: val('date'), category: val('category') },
        });
        await api(`/api/receipts/${id}/assign`, { method: 'POST', json: { projectId } });
        renderReceipts();
      } catch (err) { note.textContent = err.message; }
    });
  });

}

/* ---------- REPORTS (admin) ----------
 * Cash basis throughout: money counts on the day it moved. Useful for seeing where
 * you stand and for handing figures to an accountant — not a substitute for books. */
let reportTab = 'pl';
let reportFrom = '', reportTo = '', reportYear = String(new Date().getFullYear());

function downloadCsv(name, rows) {
  const esc2 = (v) => {
    const s2 = String(v ?? '');
    return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2;
  };
  const csv = rows.map((r) => r.map(esc2).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function renderReports() {
  if (!reportFrom) {                               // default to the year so far
    const y = new Date().getFullYear();
    reportFrom = `${y}-01-01`; reportTo = todayISO();
  }
  const tab = (k, label) => `<button class="todo-tab ${reportTab === k ? 'active' : ''}" data-rtab="${k}">${label}</button>`;
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Reports</h1>
      <div class="todo-tabs">${tab('pl', 'Profit & Loss')}${tab('jobs', 'Job Profitability')}${tab('1099', '1099s')}</div>
    </div>
    <div id="reportBody"><div class="panel muted">Loading…</div></div>`;
  document.querySelectorAll('[data-rtab]').forEach((b) =>
    b.addEventListener('click', () => { reportTab = b.dataset.rtab; renderReports(); }));
  if (reportTab === 'pl') return reportPL();
  if (reportTab === 'jobs') return reportJobs();
  return report1099();
}

async function reportPL() {
  const d = await api(`/api/reports/pl?from=${reportFrom}&to=${reportTo}`);
  const pct = (v) => (d.income ? Math.round((v / d.income) * 1000) / 10 : 0);
  $('#reportBody').innerHTML = `
    <div class="panel">
      <div class="report-range">
        <div><label class="f">From</label><input class="f" type="date" id="plFrom" value="${reportFrom}" /></div>
        <div><label class="f">To</label><input class="f" type="date" id="plTo" value="${reportTo}" /></div>
        <div class="report-presets">
          <button class="btn small" data-preset="ytd">This year</button>
          <button class="btn small" data-preset="last">Last year</button>
          <button class="btn small" data-preset="q">This quarter</button>
        </div>
        <button class="btn" id="plCsv">⤓ CSV</button>
      </div>
    </div>
    <div class="cards">
      <div class="stat"><div class="num" style="color:var(--green)">${money(d.income)}</div><div class="lbl">Money In</div></div>
      <div class="stat"><div class="num" style="color:var(--red)">${money(d.expenses)}</div><div class="lbl">Money Out</div></div>
      <div class="stat"><div class="num" style="color:${d.net >= 0 ? 'var(--green)' : 'var(--red)'}">${money(d.net)}</div><div class="lbl">Net</div></div>
    </div>
    <div class="panel">
      <h3>Where the money went</h3>
      ${d.byCategory.length ? `
      <table>
        <thead><tr><th>Category</th><th class="right">Amount</th><th class="right">% of income</th><th style="width:38%"></th></tr></thead>
        <tbody>
          ${d.byCategory.map((c) => `
          <tr>
            <td><b>${esc(c.category)}</b></td>
            <td class="right">${money(c.amount)}</td>
            <td class="right muted">${pct(c.amount)}%</td>
            <td><div class="bar"><span style="width:${Math.min(100, d.expenses ? (c.amount / d.expenses) * 100 : 0)}%"></span></div></td>
          </tr>`).join('')}
          <tr class="totals-row"><td>Total</td><td class="right" style="color:var(--red)">${money(d.expenses)}</td><td colspan="2"></td></tr>
        </tbody>
      </table>` : '<div class="muted">No costs recorded in this period.</div>'}
    </div>
    <div class="panel">
      <h3>By job</h3>
      ${d.byJob.length ? `
      <table>
        <thead><tr><th>Job</th><th class="right">Received</th><th class="right">Spent</th><th class="right">Net</th></tr></thead>
        <tbody>
          ${d.byJob.map((j) => `
          <tr>
            <td><a href="#/job/${j.id}">${esc(j.name)}</a>${j.overhead ? ' <span class="badge badge-amber">general</span>' : ''}</td>
            <td class="right" style="color:var(--green)">${money(j.received)}</td>
            <td class="right" style="color:var(--red)">${money(j.spent)}</td>
            <td class="right"><b style="color:${j.net >= 0 ? 'var(--green)' : 'var(--red)'}">${money(j.net)}</b></td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="muted">Nothing moved in this period.</div>'}
    </div>
    <div class="muted">Cash basis — money counts on the day it moved. This is a management report, not bookkeeping.</div>`;

  const reload = () => { reportFrom = $('#plFrom').value; reportTo = $('#plTo').value; renderReports(); };
  $('#plFrom').addEventListener('change', reload);
  $('#plTo').addEventListener('change', reload);
  document.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const now = new Date(), y = now.getFullYear();
      if (b.dataset.preset === 'ytd') { reportFrom = `${y}-01-01`; reportTo = todayISO(); }
      if (b.dataset.preset === 'last') { reportFrom = `${y - 1}-01-01`; reportTo = `${y - 1}-12-31`; }
      if (b.dataset.preset === 'q') {
        const q = Math.floor(now.getMonth() / 3);
        reportFrom = `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`; reportTo = todayISO();
      }
      renderReports();
    }));
  $('#plCsv').addEventListener('click', () => downloadCsv(`profit-and-loss_${reportFrom}_to_${reportTo}.csv`, [
    ['Profit & Loss (cash basis)', reportFrom + ' to ' + reportTo], [],
    ['Money In', d.income], ['Money Out', d.expenses], ['Net', d.net], [],
    ['Category', 'Amount'], ...d.byCategory.map((c) => [c.category, c.amount]), [],
    ['Job', 'Received', 'Spent', 'Net'], ...d.byJob.map((j) => [j.name, j.received, j.spent, j.net]),
  ]));
}

async function reportJobs() {
  const rows = await api('/api/reports/jobs');
  const t = (k) => cents(rows.reduce((s, r) => s + (r[k] || 0), 0));
  $('#reportBody').innerHTML = `
    <div class="panel">
      <div class="report-range"><h3 style="margin:0">Lifetime, every job</h3><button class="btn" id="jobCsv">⤓ CSV</button></div>
    </div>
    <div class="panel">
      ${rows.length ? `
      <table>
        <thead><tr><th>Job</th><th>Customer</th><th class="right">Contract</th><th class="right">Costs</th><th class="right">Profit</th><th class="right">Margin</th><th class="right">Unbilled</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
          <tr>
            <td><a href="#/job/${r.id}">${esc(r.name)}</a></td>
            <td>${r.customerName ? esc(r.customerName) : '<span class="muted">—</span>'}</td>
            <td class="right">${money(r.price)}</td>
            <td class="right" style="color:var(--red)">${money(r.spent)}</td>
            <td class="right"><b style="color:${r.profit >= 0 ? 'var(--green)' : 'var(--red)'}">${money(r.profit)}</b></td>
            <td class="right">${r.margin === null ? '<span class="muted">—</span>' : `<span class="badge ${r.margin < 10 ? 'badge-red' : r.margin < 25 ? 'badge-amber' : ''}">${r.margin}%</span>`}</td>
            <td class="right muted">${money(r.unbilled)}</td>
          </tr>`).join('')}
          <tr class="totals-row">
            <td colspan="2">All jobs</td>
            <td class="right">${money(t('price'))}</td>
            <td class="right" style="color:var(--red)">${money(t('spent'))}</td>
            <td class="right" style="color:var(--green)">${money(t('profit'))}</td>
            <td colspan="2"></td>
          </tr>
        </tbody>
      </table>` : '<div class="muted">No jobs yet.</div>'}
    </div>
    <div class="muted">Margin is contract price less costs. Labour you pay outside the portal is not in these numbers.</div>`;
  $('#jobCsv').addEventListener('click', () => downloadCsv('job-profitability.csv', [
    ['Job', 'Customer', 'Contract', 'Costs', 'Profit', 'Margin %', 'Unbilled'],
    ...rows.map((r) => [r.name, r.customerName || '', r.price, r.spent, r.profit, r.margin ?? '', r.unbilled]),
  ]));
}

async function report1099() {
  const d = await api(`/api/reports/1099?year=${reportYear}`);
  const years = [];
  for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 5; y--) years.push(String(y));
  $('#reportBody').innerHTML = `
    <div class="panel">
      <div class="report-range">
        <div><label class="f">Tax year</label>
          <select class="f" id="yr">${years.map((y) => `<option ${y === reportYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
        </div>
        <div class="muted">Reporting threshold for ${d.year}: <b>${money(d.threshold)}</b></div>
        <button class="btn" id="csv1099">⤓ CSV</button>
      </div>
    </div>
    ${d.missingTaxId ? `<div class="check-todo">⚠️ ${d.missingTaxId} contractor${d.missingTaxId === 1 ? '' : 's'} over the threshold ${d.missingTaxId === 1 ? 'has' : 'have'} no tax ID on file — you need a W-9 before you can file.</div>` : ''}
    <div class="cards">
      <div class="stat"><div class="num">${d.reportableCount}</div><div class="lbl">Need a 1099</div></div>
      <div class="stat"><div class="num">${money(d.totalPaid)}</div><div class="lbl">Paid to contractors</div></div>
    </div>
    <div class="panel">
      ${d.rows.length ? `
      <table>
        <thead><tr><th>Contractor</th><th>Tax ID</th><th class="right">Checks</th><th class="right">Paid in ${esc(d.year)}</th><th>1099?</th></tr></thead>
        <tbody>
          ${d.rows.map((r) => `
          <tr>
            <td><a href="#/contractor/${r.id}"><b>${esc(r.name)}</b></a></td>
            <td>${r.hasTaxId
              ? `${r.taxIdType === 'ssn' ? '•••-••-' : '••-•••'}${esc(r.taxIdLast4)}`
              : '<span class="badge badge-red">missing</span>'}</td>
            <td class="right">${r.checkCount}</td>
            <td class="right"><b>${money(r.paid)}</b></td>
            <td>${r.reportable ? '<span class="badge badge-amber">Yes</span>' : '<span class="muted">Under threshold</span>'}</td>
          </tr>`).join('')}
          <tr class="totals-row"><td colspan="3">Total</td><td class="right">${money(d.totalPaid)}</td><td></td></tr>
        </tbody>
      </table>` : `<div class="muted">No contractor payments recorded in ${esc(d.year)}.</div>`}
    </div>
    <div class="muted">
      Totals come from checks logged here, so anything paid outside the portal is missing. This is a
      worksheet — it does not file anything with the IRS. Check the figures against your bank before filing.
    </div>`;
  $('#yr').addEventListener('change', (e) => { reportYear = e.target.value; renderReports(); });
  $('#csv1099').addEventListener('click', () => downloadCsv(`1099-summary-${d.year}.csv`, [
    [`1099-NEC worksheet ${d.year}`, `threshold ${d.threshold}`], [],
    ['Contractor', 'ID type', 'Last 4', 'Checks', 'Paid', 'Reportable'],
    ...d.rows.map((r) => [r.name, r.taxIdType || '', r.taxIdLast4 || '', r.checkCount, r.paid, r.reportable ? 'YES' : 'no']),
  ]));
}

/* ---------- CHECK DETAIL (admin) ----------
 * One check, its photo, and the line-by-line breakdown. Each line points at a job;
 * doing so files that amount as the job's cost. The total sits under the check number. */
async function renderCheck(id) {
  let k;
  try { k = await api('/api/checks/' + id); }
  catch { $('#main').innerHTML = '<div class="panel">Check not found.</div>'; return; }
  const [projects, contractors] = await Promise.all([api('/api/projects'), api('/api/contractors')]);
  // general bucket first, then the jobs A–Z
  const jobs = [...(overheadOf(projects) ? [overheadOf(projects)] : []),
    ...realJobs(projects).sort((a, b) => a.name.localeCompare(b.name))];
  const lines = k.lines || [];
  const unassigned = lines.filter((l) => !l.projectId).length;

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Check ${k.number ? '#' + esc(k.number) : ''}</h1>
      <div>
        ${k.contractorId ? `<a class="btn" href="#/contractor/${k.contractorId}">← ${esc(k.contractorName)}</a>` : '<a class="btn" href="#/contractors">← Contractors</a>'}
        <button class="btn danger" id="delCheckBtn">Delete</button>
      </div>
    </div>

    <div class="check-summary">
      <div>
        <div class="k">Check Number</div>
        <div class="check-num">${k.number ? '#' + esc(k.number) : '<span class="muted">Not read</span>'}</div>
        <div class="k" style="margin-top:12px">Total</div>
        <div class="check-total">${money(k.total)}</div>
      </div>
      <div class="check-meta">
        <div><div class="k">Paid To</div><div class="v">${k.contractorName ? `<a href="#/contractor/${k.contractorId}">${esc(k.contractorName)}</a>` : `<span class="muted">${esc(k.payee || 'Unknown')} — not linked</span>`}</div></div>
        <div><div class="k">Date</div><div class="v">${fmtDate(k.date)}</div></div>
        <div><div class="k">Lines</div><div class="v">${lines.length}${unassigned ? ` <span class="badge badge-amber">${unassigned} unassigned</span>` : ''}</div></div>
      </div>
    </div>

    ${k.scanned ? '' : `<div class="panel scan-status">⚠️ ${esc(k.scanError || 'Could not read this check automatically')} — fill the details in below.</div>`}

    ${(() => {
      const todo = [];
      if (!k.number) todo.push('check number');
      if (!k.contractorId) todo.push('who it was paid to');
      if (!lines.length) todo.push('at least one job line');
      else if (unassigned) todo.push(`a job for ${unassigned} line${unassigned === 1 ? '' : 's'}`);
      return todo.length
        ? `<div class="check-todo">Still needed: ${todo.map((t) => `<b>${t}</b>`).join(' · ')}</div>`
        : '<div class="check-todo done">✓ This check is complete — every line is costed to a job.</div>';
    })()}

    <div class="panel">
      <h3><span class="step-n">1</span> Check Details</h3>
      <div class="form-grid">
        <div><label class="f">Check Number</label><input class="f" id="ckNum" value="${esc(k.number)}" /></div>
        <div><label class="f">Date</label><input class="f" id="ckDate" type="date" value="${k.date || ''}" /></div>
        <div class="full"><label class="f">Paid To</label>
          <select class="f" id="ckCon">
            <option value="">— Not linked to a contractor —</option>
            ${contractors.map((c) => `<option value="${c.id}" ${k.contractorId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          ${!k.contractorId && k.payee ? `<div class="scan-status">Read as “${esc(k.payee)}” — no contractor by that name. <button class="btn small gold" id="ckMakeCon">Create “${esc(k.payee)}”</button></div>` : ''}
        </div>
      </div>
    </div>

    <div class="panel">
      <h3><span class="step-n">2</span> Breakdown — one line per job</h3>
      ${lines.length ? `
      <table class="check-lines">
        <thead><tr><th>Job</th><th class="right">Amount</th><th style="width:36px"></th></tr></thead>
        <tbody>
          ${lines.map((l) => `
          <tr data-line="${l.id}">
            <td>
              <select class="f" data-lf="projectId">
                <option value="">— Not assigned —</option>
                ${jobs.map((p) => `<option value="${p.id}" ${l.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
              </select>
              ${l.readAs ? `<div class="line-readas">${l.auto ? '✓ auto-matched from' : 'written on check as'} “${esc(l.readAs)}”</div>` : ''}
            </td>
            <td class="right"><input class="f right" data-lf="amount" type="number" step="0.01" min="0" value="${l.amount ?? ''}" /></td>
            <td class="right"><button class="del" data-delline="${l.id}" title="Remove line">✕</button></td>
          </tr>`).join('')}
          <tr class="totals-row">
            <td>Total</td><td class="right" style="color:var(--red)">${money(k.total)}</td><td></td>
          </tr>
        </tbody>
      </table>` : '<div class="muted">No lines on this check yet. Add one below.</div>'}
      <div class="form-grid" style="margin-top:16px">
        <div><label class="f">Job</label>
          <select class="f" id="ckLineJob">
            <option value="">— Choose a job —</option>
            ${jobs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div><label class="f">Amount ($)</label><input class="f" id="ckLineAmt" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div style="display:flex;align-items:flex-end"><button class="btn gold" id="ckAddLine">+ Add Job Cost</button></div>
        <div class="error full" id="ckLineErr"></div>
      </div>
      <div class="muted" style="margin-top:10px">Add one line per job. Each files that amount as a cost on the job, so its profit stays right.</div>
    </div>

    <div class="check-submit">
      <div>
        <div class="k">Check total</div>
        <div class="check-submit-amt">${money(k.total)}</div>
        <div class="muted" id="ckNote"></div>
      </div>
      <div class="check-submit-act">
        <button class="btn" id="ckSave">Save</button>
        <button class="btn gold" id="ckDone">✓ Save &amp; Finish</button>
      </div>
    </div>

    <div class="panel">
      <h3>Check Image</h3>
      <input type="file" id="ckPhotoFile" accept=".pdf,image/*" style="display:none" />
      ${k.file
        ? `<img class="check-img" src="/api/file/${k.file}" alt="Check ${esc(k.number)}" data-file-view="${k.file}" data-file-name="Check ${esc(k.number)}" />
           <div style="margin-top:12px"><button class="btn" id="ckPhotoBtn">Replace Image</button></div>`
        : `<div class="muted" style="margin-bottom:12px">No image on this check — it was entered by hand.</div>
           <button class="btn gold" id="ckPhotoBtn">📷 Attach Photo</button>`}
      <div class="scan-status" id="ckPhotoStatus"></div>
    </div>`;

  const note = $('#ckNote');
  const saveHeader = () => api('/api/checks/' + id, {
    method: 'PUT',
    json: { number: $('#ckNum').value.trim(), date: $('#ckDate').value, contractorId: $('#ckCon').value || null },
  });
  $('#ckSave').addEventListener('click', async () => {
    note.textContent = 'Saving…';
    try { await saveHeader(); renderCheck(id); }
    catch (err) { note.textContent = err.message; }
  });
  /* Save & Finish: commit the header, then say plainly if anything is still
   * outstanding rather than leaving a half-filled check lying around. */
  $('#ckDone').addEventListener('click', async () => {
    const btn = $('#ckDone');
    btn.disabled = true;
    note.textContent = 'Saving…';
    try {
      await saveHeader();
      const fresh = await api('/api/checks/' + id);
      const open = (fresh.lines || []).filter((l) => !l.projectId).length;
      const missing = [];
      if (!fresh.number) missing.push('a check number');
      if (!fresh.contractorId) missing.push('who it was paid to');
      if (!(fresh.lines || []).length) missing.push('at least one job line');
      else if (open) missing.push(`a job for ${open} line${open === 1 ? '' : 's'}`);
      if (missing.length) {
        btn.disabled = false;
        note.textContent = '';
        const leave = await askConfirm(
          `Saved. This check still needs ${missing.join(' and ')}. Leave it unfinished for now?`,
          { ok: 'Leave for now', danger: false });
        if (!leave) { renderCheck(id); return; }
      }
      location.hash = fresh.contractorId ? '#/contractor/' + fresh.contractorId : '#/contractors';
    } catch (err) { note.textContent = err.message; btn.disabled = false; }
  });
  if ($('#ckMakeCon')) $('#ckMakeCon').addEventListener('click', () => {
    contractorModal({ name: k.payee }, async (saved) => {
      await api('/api/checks/' + id, { method: 'PUT', json: { contractorId: saved.id } });
      renderCheck(id);
    });
  });
  $('#ckAddLine').addEventListener('click', async () => {
    const amount = parseFloat($('#ckLineAmt').value);
    if (!amount) { $('#ckLineErr').textContent = 'Enter an amount.'; return; }
    try {
      await api(`/api/checks/${id}/lines`, {
        method: 'POST',
        json: { amount, projectId: $('#ckLineJob').value || null },
      });
      renderCheck(id);
    } catch (err) { $('#ckLineErr').textContent = err.message; }
  });
  $('#ckPhotoBtn').addEventListener('click', () => $('#ckPhotoFile').click());
  $('#ckPhotoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('#ckPhotoStatus').textContent = 'Uploading…';
    try {
      const up = await prepReceipt(f);
      const fd = new FormData();
      fd.append('check', up, up.name);
      await api(`/api/checks/${id}/photo`, { method: 'POST', body: fd });
      renderCheck(id);
    } catch (err) { $('#ckPhotoStatus').textContent = err.message; }
  });
  document.querySelectorAll('tr[data-line]').forEach((row) => {
    const lid = row.dataset.line;
    const val = (f) => row.querySelector(`[data-lf="${f}"]`).value;
    const save = async () => {
      try {
        await api(`/api/checks/${id}/lines/${lid}`, {
          method: 'PUT',
          json: { amount: val('amount'), projectId: val('projectId') || null },
        });
        renderCheck(id);
      } catch (err) { alert(err.message); renderCheck(id); }
    };
    row.querySelector('[data-lf="amount"]').addEventListener('blur', save);
    row.querySelector('[data-lf="projectId"]').addEventListener('change', save);
  });
  document.querySelectorAll('[data-delline]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Remove this line? Any job cost it created is removed too.')) return;
      await api(`/api/checks/${id}/lines/${b.dataset.delline}`, { method: 'DELETE' });
      renderCheck(id);
    })
  );
  $('#delCheckBtn').addEventListener('click', async () => {
    if (!await askConfirm('Delete this check? Every job cost it created is removed too.')) return;
    await api('/api/checks/' + id, { method: 'DELETE' });
    location.hash = k.contractorId ? '#/contractor/' + k.contractorId : '#/contractors';
  });
}

/* ---------- CONTRACTORS (admin) ----------
 * Subs and vendors you write checks to. Tax IDs are encrypted server-side; the list
 * only ever holds the last 4, and the full number arrives only when you tap Reveal. */
const taxMask = (c) => (c.taxIdLast4
  ? (c.taxIdType === 'ssn' ? '•••-••-' : '••-•••') + c.taxIdLast4
  : '<span class="muted">—</span>');

function contractorFormHtml(c) {
  const e = c || {};
  return `
    <div class="full"><label class="f">Full Name *</label><input class="f" name="name" required value="${esc(e.name || '')}" placeholder="Business or person the check is written to" /></div>
    <div class="full muted" style="margin-top:-4px">Everything below is optional — you can fill it in later.</div>
    <div><label class="f">ID Type</label>
      <select class="f" name="taxIdType">
        <option value="ein" ${e.taxIdType !== 'ssn' ? 'selected' : ''}>EIN</option>
        <option value="ssn" ${e.taxIdType === 'ssn' ? 'selected' : ''}>SSN</option>
      </select>
    </div>
    <div><label class="f">EIN / SSN ${e.taxIdLast4 ? '(on file — leave blank to keep)' : '(optional)'}</label>
      <input class="f" name="taxId" inputmode="numeric" autocomplete="off" placeholder="9 digits" /></div>
    <div><label class="f">Phone</label><input class="f" name="phone" value="${esc(e.phone || '')}" /></div>
    <div><label class="f">Email</label><input class="f" name="email" type="email" value="${esc(e.email || '')}" /></div>
    <div class="full"><label class="f">Notes</label><input class="f" name="notes" value="${esc(e.notes || '')}" placeholder="Trade, crew size, anything worth remembering" /></div>`;
}

/* `c` may be a real contractor (edit) or just a pre-filled name coming off a scanned
 * check (create). Only an id means edit — going by truthiness alone sent a PUT to
 * /api/contractors/undefined, which matches no route and failed. */
function contractorModal(c, onSaved) {
  const isEdit = !!(c && c.id);
  openModal(`
    <h2>${isEdit ? 'Edit Contractor' : 'Add Contractor'}</h2>
    ${!isEdit && c && c.name ? `<div class="muted" style="margin:-8px 0 14px">Read off the check as “${esc(c.name)}” — correct it if the handwriting was off.</div>` : ''}
    <form id="conForm" class="form-grid">
      ${contractorFormHtml(c)}
      <div class="modal-actions full">
        <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn gold">${isEdit ? 'Save Changes' : 'Add Contractor'}</button>
      </div>
      <div class="error full" id="conErr"></div>
    </form>`);
  $('#conForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const f = Object.fromEntries(new FormData(e.target));
    if (isEdit && !f.taxId) delete f.taxId;      // blank on an edit means "keep what's on file"
    btn.disabled = true;
    try {
      const saved = isEdit
        ? await api('/api/contractors/' + c.id, { method: 'PUT', json: f })
        : await api('/api/contractors', { method: 'POST', json: f });
      closeModal();
      if (saved.warning) alert(saved.warning);   // saved either way — just say what didn't stick
      onSaved(saved);
    } catch (err) { $('#conErr').textContent = err.message; btn.disabled = false; }
  });
}

async function renderContractors() {
  const [list, checks] = await Promise.all([api('/api/contractors'), api('/api/checks')]);
  const paid = list.reduce((s, c) => s + (c.paidTotal || 0), 0);
  const loose = checks.filter((k) => !k.contractorId);
  const openLines = checks.reduce((s, k) => s + (k.lines || []).filter((l) => !l.projectId).length, 0);
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Contractors</h1>
      <button class="btn gold" id="newConBtn">+ Add Contractor</button>
    </div>

    <div class="panel">
      <h3>Log a Check</h3>
      <input type="file" id="ckFile" accept=".pdf,image/*" style="display:none" />
      <div class="photo-add-btns">
        <button class="btn gold" id="ckUpBtn">📷 Scan a Check</button>
        <button class="btn" id="ckManBtn">✍️ Enter by Hand</button>
      </div>
      <div class="scan-status" id="ckUpStatus"></div>
      <div class="muted" style="margin-top:8px">
        Scanning reads the check number, who it was written to and the handwritten lines. No photo? Enter it by hand and add a line per job — you can attach the photo later.
      </div>
    </div>

    ${loose.length || openLines ? `
    <div class="panel">
      <h3>Needs Attention</h3>
      ${loose.length ? `<div style="margin-bottom:10px">${loose.length} check${loose.length === 1 ? '' : 's'} not linked to a contractor:
        ${loose.map((k) => `<a class="mini-chip" href="#/check/${k.id}">${k.number ? '#' + esc(k.number) : 'No number'}${k.payee ? ' — ' + esc(k.payee) : ''}</a>`).join('')}</div>` : ''}
      ${openLines ? `<div class="muted">${openLines} check line${openLines === 1 ? '' : 's'} still need a job assigned — their cost isn't counted against any job yet.</div>` : ''}
    </div>` : ''}

    <div class="panel">
      ${list.length ? `
      <table>
        <thead><tr><th>Name</th><th>EIN / SSN</th><th>Contact</th><th class="right">Checks</th><th class="right">Paid</th><th class="right">Actions</th></tr></thead>
        <tbody>
          ${list.map((c) => `
          <tr>
            <td><a href="#/contractor/${c.id}"><b>${esc(c.name)}</b></a></td>
            <td class="taxid-cell">
              <span class="lockbox-code" data-taxid="${c.id}" title="${c.hasTaxId ? 'Tap to reveal' : ''}">${taxMask(c)}</span>
            </td>
            <td>${[c.phone, c.email].filter(Boolean).map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
            <td class="right">${c.checkCount}</td>
            <td class="right"><b>${money(c.paidTotal)}</b></td>
            <td class="right">
              <button class="btn small" data-edcon="${c.id}">Edit</button>
              <button class="btn small danger" data-delcon="${c.id}">Delete</button>
            </td>
          </tr>`).join('')}
          <tr class="totals-row"><td colspan="4">Total paid out</td><td class="right">${money(paid)}</td><td></td></tr>
        </tbody>
      </table>` : '<div class="muted">No contractors yet. Add one, or upload a check and the portal will offer to create them for you.</div>'}
    </div>
    <div class="muted" style="margin-top:-8px">
      🔒 Tax IDs are encrypted before they are saved and are only shown when you tap one. Every reveal is written to the server log.
    </div>`;

  $('#ckUpBtn').addEventListener('click', () => $('#ckFile').click());
  $('#ckManBtn').addEventListener('click', () => {
    openModal(`
      <h2>Log a Check</h2>
      <form id="ckManForm" class="form-grid">
        <div><label class="f">Check Number</label><input class="f" name="number" inputmode="numeric" placeholder="1009" /></div>
        <div><label class="f">Date</label><input class="f" name="date" type="date" value="${todayISO()}" /></div>
        <div class="full"><label class="f">Paid To</label>
          <select class="f" name="contractorId">
            <option value="">— Choose a contractor —</option>
            ${list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="full muted">You'll add a line per job on the next screen.</div>
        <div class="modal-actions full">
          <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn gold">Create Check</button>
        </div>
        <div class="error full" id="ckManErr"></div>
      </form>`);
    $('#ckManForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);          // multipart, just with no file attached
      try {
        const k = await api('/api/checks', { method: 'POST', body: fd });
        closeModal();
        location.hash = '#/check/' + k.id;
      } catch (err) { $('#ckManErr').textContent = err.message; }
    });
  });
  $('#ckFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const status = $('#ckUpStatus');
    const btn = $('#ckUpBtn');
    const step = (t) => { status.className = 'scan-status busy'; status.innerHTML = `<span class="spin"></span> ${t}`; };
    btn.disabled = true;
    step('Preparing the photo…');
    try {
      const up = await prepReceipt(f);
      const fd = new FormData();
      fd.append('check', up, up.name);
      step('Reading the check — number, payee and lines…');
      const k = await api('/api/checks', { method: 'POST', body: fd });
      // unknown payee — offer to create them rather than leaving the check unlinked
      if (!k.payeeMatched && k.payee) {
        status.className = 'scan-status';
        status.textContent = '';
        const make = await askConfirm(
          `This check is made out to "${k.payee}", who isn't in your contractors yet. Add them now?`,
          { ok: 'Add Contractor', danger: false });
        if (make) {
          contractorModal({ name: k.payee }, async (saved) => {
            await api('/api/checks/' + k.id, { method: 'PUT', json: { contractorId: saved.id } });
            location.hash = '#/check/' + k.id;
          });
          return;
        }
      }
      location.hash = '#/check/' + k.id;
    } catch (err) {
      status.className = 'scan-status';
      status.textContent = err.message;
    } finally { btn.disabled = false; }
  });

  $('#newConBtn').addEventListener('click', () => contractorModal(null, () => renderContractors()));
  document.querySelectorAll('[data-edcon]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = list.find((x) => x.id === Number(b.dataset.edcon));
      contractorModal(c, () => renderContractors());
    })
  );
  document.querySelectorAll('[data-delcon]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this contractor?')) return;
      try {
        await api('/api/contractors/' + b.dataset.delcon, { method: 'DELETE' });
        renderContractors();
      } catch (err) { alert(err.message); }
    })
  );
  wireTaxReveal(list);
}

/* Tap a masked tax ID to fetch the full number; it hides itself again shortly after. */
function wireTaxReveal(list) {
  document.querySelectorAll('[data-taxid]').forEach((el) =>
    el.addEventListener('click', async () => {
      const c = list.find((x) => x.id === Number(el.dataset.taxid));
      if (!c || !c.hasTaxId || el.dataset.busy) return;
      el.dataset.busy = '1';
      const masked = el.innerHTML;
      try {
        const r = await api('/api/contractors/' + c.id + '/reveal', { method: 'POST' });
        el.textContent = r.taxId;
        setTimeout(() => { el.innerHTML = masked; delete el.dataset.busy; }, 15000);
      } catch (err) { el.textContent = err.message; setTimeout(() => { el.innerHTML = masked; delete el.dataset.busy; }, 4000); }
    })
  );
}

async function renderContractor(id) {
  const [list, checks] = await Promise.all([api('/api/contractors'), api('/api/checks')]);
  const c = list.find((x) => x.id === id);
  if (!c) { $('#main').innerHTML = '<div class="panel">Contractor not found.</div>'; return; }
  const theirs = checks.filter((k) => k.contractorId === id);
  const total = theirs.reduce((s, k) => s + k.total, 0);
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${esc(c.name)}</h1>
      <div><button class="btn" id="edConBtn">Edit</button> <a class="btn" href="#/contractors">← All Contractors</a></div>
    </div>
    <div class="panel">
      <div class="info-grid">
        <div><div class="k">EIN / SSN</div><div class="v"><span class="lockbox-code" data-taxid="${c.id}" title="${c.hasTaxId ? 'Tap to reveal' : ''}">${taxMask(c)}</span></div></div>
        <div><div class="k">Phone</div><div class="v">${c.phone ? esc(c.phone) : '<span class="muted">—</span>'}</div></div>
        <div><div class="k">Email</div><div class="v">${c.email ? esc(c.email) : '<span class="muted">—</span>'}</div></div>
        <div><div class="k">Checks Written</div><div class="v">${theirs.length}</div></div>
        <div><div class="k">Total Paid</div><div class="v" style="color:var(--red)">${money(total)}</div></div>
      </div>
      ${c.notes ? `<div class="muted" style="margin-top:14px">${esc(c.notes)}</div>` : ''}
    </div>
    <div class="panel">
      <h3>Checks</h3>
      ${theirs.length ? `
      <table>
        <thead><tr><th>Check #</th><th>Date</th><th>For</th><th class="right">Amount</th></tr></thead>
        <tbody>
          ${theirs.map((k) => `
          <tr>
            <td><a href="#/check/${k.id}"><b>${k.number ? '#' + esc(k.number) : 'No number'}</b></a></td>
            <td>${fmtDate(k.date)}</td>
            <td>${(k.lines || []).length
              ? `${k.lines.length} job${k.lines.length === 1 ? '' : 's'}${k.lines.some((l) => !l.projectId) ? ' <span class="badge badge-amber">needs a job</span>' : ''}`
              : '<span class="muted">—</span>'}</td>
            <td class="right"><b>${money(k.total)}</b></td>
          </tr>`).join('')}
          <tr class="totals-row"><td colspan="3">Total paid (${theirs.length} check${theirs.length === 1 ? '' : 's'})</td><td class="right" style="color:var(--red)">${money(total)}</td></tr>
        </tbody>
      </table>` : '<div class="muted">No checks on file for this contractor yet.</div>'}
    </div>`;
  $('#edConBtn').addEventListener('click', () => contractorModal(c, () => renderContractor(id)));
  wireTaxReveal(list);
}

/* ---------- CUSTOMERS ---------- */
async function renderCustomers() {
  const customers = await api('/api/customers');
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Customers</h1>
      <button class="btn gold" id="newCustBtn">+ Add Customer</button>
    </div>
    <div class="panel">
      ${customers.length ? `
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Email (for notifications)</th><th>Jobs</th><th class="right">Actions</th></tr></thead>
        <tbody>${customers.map((c) => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${esc(c.username)}</td>
            <td>${c.email ? esc(c.email) : '<span class="muted">—</span>'}</td>
            <td>${c.projectCount}</td>
            <td class="right">
              <button class="btn small" data-em="${c.id}" data-emv="${esc(c.email || '')}">Email</button>
              <button class="btn small" data-pw="${c.id}">Reset Password</button>
              <button class="btn small danger" data-del="${c.id}">Delete</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="muted">No customers yet. Add one so you can assign jobs to them and they can log in to follow their project.</div>'}
    </div>`;
  $('#newCustBtn').addEventListener('click', () => {
    openModal(`
      <h2>Add Customer</h2>
      <form id="custForm" class="form-grid">
        <div class="full"><label class="f">Customer / Company Name *</label><input class="f" name="name" required /></div>
        <div><label class="f">Login Username *</label><input class="f" name="username" required /></div>
        <div><label class="f">Login Password *</label><input class="f" name="password" required /></div>
        <div class="full"><label class="f">Email (optional — gets notified when you add documents or photos)</label><input class="f" name="email" type="email" /></div>
        <div class="modal-actions full">
          <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn gold">Add Customer</button>
        </div>
        <div class="error full" id="custErr"></div>
      </form>`);
    $('#custForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/customers', { method: 'POST', json: Object.fromEntries(fd) });
        closeModal(); renderCustomers();
      } catch (err) { $('#custErr').textContent = err.message; }
    });
  });
  document.querySelectorAll('[data-pw]').forEach((b) =>
    b.addEventListener('click', async () => {
      const pw = prompt('New password for this customer:');
      if (!pw) return;
      await api('/api/customers/' + b.dataset.pw, { method: 'PUT', json: { password: pw } });
      alert('Password updated.');
    })
  );
  document.querySelectorAll('[data-em]').forEach((b) =>
    b.addEventListener('click', async () => {
      const em = prompt('Customer email (leave empty to remove):', b.dataset.emv || '');
      if (em === null) return;
      await api('/api/customers/' + b.dataset.em, { method: 'PUT', json: { email: em } });
      renderCustomers();
    })
  );
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this customer login? Their jobs stay but become unassigned.')) return;
      await api('/api/customers/' + b.dataset.del, { method: 'DELETE' });
      renderCustomers();
    })
  );
}

/* ---------- JOB PHOTO PAGE (all photos for one job, by date) ---------- */
async function renderJobPhotos(id) {
  let p;
  try { p = await api('/api/projects/' + id); }
  catch { $('#main').innerHTML = '<div class="panel">Job not found.</div>'; return; }
  const isStaff = IS_CREW;   // delivery adds photos too
  const photos = (p.photos || []).slice().sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
  /* group by upload date (newest first) */
  const groups = [];
  for (const ph of photos) {
    const d = String(ph.uploaded).slice(0, 10);
    if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] });
    groups[groups.length - 1].items.push(ph);
  }
  let idx = 0;
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${esc(p.name)} — Photos${photos.length ? ' (' + photos.length + ')' : ''}</h1>
      <a class="btn" href="#/job/${p.id}">← Back to Job</a>
    </div>
    ${isStaff ? `
    <div style="margin-bottom:18px">${photoUploaderHtml()}</div>` : ''}
    ${photos.length ? groups.map((g) => `
    <section class="cust-group">
      <div class="cust-head">
        <h3>📅 ${fmtDate(g.d)}</h3>
        <span class="muted">${g.items.length} photo${g.items.length === 1 ? '' : 's'}</span>
      </div>
      <div class="photo-grid">
        ${g.items.map((ph) => `
        <div class="photo-item" data-view="${idx++}">
          <img src="/api/file/${ph.thumb || ph.file}" alt="${esc(ph.name)}" loading="lazy" />
          ${isStaff ? `<button class="photo-del" data-delphoto="${ph.id}" title="Delete photo">✕</button>` : ''}
        </div>`).join('')}
      </div>
    </section>`).join('') : '<div class="panel muted">No photos yet.</div>'}`;
  document.querySelectorAll('[data-view]').forEach((d) =>
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-delphoto]')) return;
      openLightbox(photos, Number(d.dataset.view));
    })
  );
  if (!isStaff) return;
  wirePhotoUploader(id, () => renderJobPhotos(id));

  document.querySelectorAll('[data-delphoto]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await askConfirm('Delete this photo?')) return;
      await api(`/api/projects/${id}/photos/${b.dataset.delphoto}`, { method: 'DELETE' });
      renderJobPhotos(id);
    })
  );
}

/* ---------- PROJECT MANAGERS (admin) ---------- */
async function renderManagers() {
  const [pms, crew] = await Promise.all([api('/api/pms'), api('/api/delivery')]);
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>Project Managers</h1>
      <button class="btn gold" id="newPmBtn">+ Add Manager</button>
    </div>
    <div class="panel">
      ${pms.length ? `
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Jobs</th><th class="right">Actions</th></tr></thead>
        <tbody>${pms.map((c) => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${esc(c.username)}</td>
            <td>${c.email ? esc(c.email) : '<span class="muted">—</span>'}</td>
            <td>${c.projectCount}</td>
            <td class="right">
              <button class="btn small" data-pmem="${c.id}" data-pmemv="${esc(c.email || '')}">Email</button>
              <button class="btn small" data-pmpw="${c.id}">Reset Password</button>
              <button class="btn small danger" data-pmdel="${c.id}">Delete</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="muted">No project managers yet. Add one and assign them to jobs — they will only see the jobs assigned to them.</div>'}
    </div>

    <div class="page-head" style="margin-top:28px">
      <h1>Delivery Crew</h1>
      <button class="btn gold" id="newDelBtn">+ Add Delivery</button>
    </div>
    <div class="panel">
      ${crew.length ? `
      <table>
        <thead><tr><th>Name</th><th>Username</th><th class="right">Actions</th></tr></thead>
        <tbody>${crew.map((c) => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${esc(c.username)}</td>
            <td class="right">
              <button class="btn small" data-delpw="${c.id}">Reset Password</button>
              <button class="btn small danger" data-deldel="${c.id}">Delete</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="muted">No delivery logins yet.</div>'}
      <div class="muted" style="margin-top:14px">
        Delivery logins see the job map, every job's address and lockbox, what each job has cost, and the photos —
        and can add photos and receipts. They cannot see contract prices, payments, material orders or contractors.
      </div>
    </div>`;

  $('#newDelBtn').addEventListener('click', () => {
    openModal(`
      <h2>Add Delivery Login</h2>
      <form id="delForm" class="form-grid">
        <div class="full"><label class="f">Full Name *</label><input class="f" name="name" required /></div>
        <div><label class="f">Login Username *</label><input class="f" name="username" required /></div>
        <div><label class="f">Login Password *</label><input class="f" name="password" required /></div>
        <div class="modal-actions full">
          <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn gold">Add Delivery</button>
        </div>
        <div class="error full" id="delErr"></div>
      </form>`);
    $('#delForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/delivery', { method: 'POST', json: Object.fromEntries(new FormData(e.target)) });
        closeModal(); renderManagers();
      } catch (err) { $('#delErr').textContent = err.message; }
    });
  });
  document.querySelectorAll('[data-delpw]').forEach((b) =>
    b.addEventListener('click', async () => {
      const pw = prompt('New password for this delivery login:');
      if (!pw) return;
      await api('/api/delivery/' + b.dataset.delpw, { method: 'PUT', json: { password: pw } });
      alert('Password updated.');
    })
  );
  document.querySelectorAll('[data-deldel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this delivery login?')) return;
      await api('/api/delivery/' + b.dataset.deldel, { method: 'DELETE' });
      renderManagers();
    })
  );

  $('#newPmBtn').addEventListener('click', () => {
    openModal(`
      <h2>Add Project Manager</h2>
      <form id="pmForm" class="form-grid">
        <div class="full"><label class="f">Full Name *</label><input class="f" name="name" required /></div>
        <div><label class="f">Login Username *</label><input class="f" name="username" required /></div>
        <div><label class="f">Login Password *</label><input class="f" name="password" required /></div>
        <div class="full"><label class="f">Email (optional)</label><input class="f" name="email" type="email" /></div>
        <div class="modal-actions full">
          <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn gold">Add Manager</button>
        </div>
        <div class="error full" id="pmErr"></div>
      </form>`);
    $('#pmForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/pms', { method: 'POST', json: Object.fromEntries(fd) });
        closeModal(); renderManagers();
      } catch (err) { $('#pmErr').textContent = err.message; }
    });
  });
  document.querySelectorAll('[data-pmpw]').forEach((b) =>
    b.addEventListener('click', async () => {
      const pw = prompt('New password for this manager:');
      if (!pw) return;
      await api('/api/pms/' + b.dataset.pmpw, { method: 'PUT', json: { password: pw } });
      alert('Password updated.');
    })
  );
  document.querySelectorAll('[data-pmem]').forEach((b) =>
    b.addEventListener('click', async () => {
      const em = prompt('Manager email (leave empty to remove):', b.dataset.pmemv || '');
      if (em === null) return;
      await api('/api/pms/' + b.dataset.pmem, { method: 'PUT', json: { email: em } });
      renderManagers();
    })
  );
  document.querySelectorAll('[data-pmdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!await askConfirm('Delete this manager login? Their jobs stay but become unassigned.')) return;
      await api('/api/pms/' + b.dataset.pmdel, { method: 'DELETE' });
      renderManagers();
    })
  );
}

/* ---------- photo lightbox ---------- */
/* Convert iPhone HEIC/HEIF photos to JPEG in the browser where possible
 * (Safari can decode them; other browsers keep the original file). */
async function heicToJpeg(file) {
  if (!/\.(heic|heif)$/i.test(file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
  } catch { return file; }
}

/* Prepare a receipt photo for scanning: cap the long edge at 1568px (the most the
 * vision model resolves anyway), re-encode as JPEG. This does three jobs at once —
 * converts iPhone HEIC to a format the scanner accepts, keeps a 5 MB phone photo
 * under the upload limit, and speeds the upload up on a site connection.
 * Returns the file untouched if it can't be decoded, so nothing is ever lost. */
async function prepReceipt(file) {
  if (/\.pdf$/i.test(file.name)) return file;              // PDFs go up as-is
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

/* Make a small JPEG thumbnail in the browser before uploading (returns null if the
 * image can't be decoded, e.g. HEIC on some browsers — the full photo is used then). */
async function makeThumb(file, maxDim = 480) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.78));
  } catch { return null; }
}

/* ---------- photo uploader with a staging tray ----------
 * Shot or picked photos land in a local pending list first. The user keeps adding
 * (tap Take Photo over and over) and can drop bad shots; nothing reaches the server
 * until Upload All. Markup + wiring are split so both the job page and the job's
 * photo page can reuse them. */
function photoUploaderHtml(opts = {}) {
  const l = { camera: '📷 Take Photo', pick: '🖼️ Choose Photos', send: '⬆ Upload All', ...(opts.labels || {}) };
  const hint = opts.hint || 'Keep tapping <b>Take Photo</b> to add more — nothing uploads until you tap Upload All.';
  const accept = opts.accept || 'image/*';
  return `
    <div class="photo-uploader">
      <input type="file" id="photoCam" accept="image/*" capture="environment" style="display:none" />
      <input type="file" id="photoFile" accept="${accept}" multiple style="display:none" />
      <div class="photo-add-btns">
        <button class="btn gold" id="photoCamBtn">${l.camera}</button>
        <button class="btn" id="photoPickBtn">${l.pick}</button>
      </div>
      <div class="photo-queue hidden" id="photoQueue">
        <div class="photo-queue-head">
          <b id="photoQueueCount"></b>
          <div class="photo-queue-acts">
            <button class="btn ghost" id="photoQueueClear">Clear</button>
            <button class="btn gold" id="photoQueueSend" data-send="${esc(l.send)}">${l.send}</button>
          </div>
        </div>
        <div class="photo-queue-grid" id="photoQueueGrid"></div>
        <div class="muted photo-queue-hint">${hint}</div>
      </div>
    </div>`;
}

/* opts: { endpoint, field, thumbs } — defaults upload photos to a job. */
function wirePhotoUploader(jobId, onDone, opts = {}) {
  if (!$('#photoCamBtn')) return;
  const endpoint = opts.endpoint || `/api/projects/${jobId}/photos`;
  const field = opts.field || 'photo';
  const wantThumbs = opts.thumbs !== false;
  const queue = [];               // { file, url }
  const qWrap = $('#photoQueue'), qGrid = $('#photoQueueGrid');
  const qCount = $('#photoQueueCount'), qSend = $('#photoQueueSend'), qClear = $('#photoQueueClear');

  const drawQueue = () => {
    qWrap.classList.toggle('hidden', !queue.length);
    if (!queue.length) return;
    const noun = wantThumbs ? 'photo' : 'file';
    qCount.textContent = `${queue.length} ${noun}${queue.length === 1 ? '' : 's'} ready to upload`;
    qGrid.innerHTML = queue.map((q, i) => `
      <div class="photo-item pending">
        ${q.url ? `<img src="${q.url}" alt="" />` : '<div class="pending-pdf">📄 PDF</div>'}
        <button class="photo-del" data-qrm="${i}" title="Remove">✕</button>
      </div>`).join('');
    qGrid.querySelectorAll('[data-qrm]').forEach((b) =>
      b.addEventListener('click', () => {
        const [gone] = queue.splice(Number(b.dataset.qrm), 1);
        if (gone.url) URL.revokeObjectURL(gone.url);
        drawQueue();
      }));
  };

  const addFiles = (files) => {
    for (const f of files) {
      const isPdf = /\.pdf$/i.test(f.name);
      const isImg = f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name);
      if (!isImg && !(isPdf && !wantThumbs)) continue;   // PDFs only where they're accepted
      queue.push({ file: f, url: isPdf ? null : URL.createObjectURL(f) });   // no preview for a PDF
    }
    drawQueue();
  };

  $('#photoCamBtn').addEventListener('click', () => $('#photoCam').click());
  $('#photoPickBtn').addEventListener('click', () => $('#photoFile').click());
  // clear .value after each pick so shooting another photo still fires change
  ['#photoCam', '#photoFile'].forEach((sel) =>
    $(sel).addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; }));

  qClear.addEventListener('click', () => {
    queue.splice(0).forEach((q) => URL.revokeObjectURL(q.url));
    drawQueue();
  });

  qSend.addEventListener('click', async () => {
    if (!queue.length) return;
    const jobs = queue.slice();
    const total = jobs.length;
    let done = 0;
    qSend.disabled = qClear.disabled = true;
    const tick = () => { qSend.textContent = `Uploading ${Math.min(done + 1, total)} of ${total}…`; };
    tick();
    const send = async ({ file }) => {
      // PDFs go up untouched; images get the HEIC fix and a thumbnail where wanted
      const isPdf = /\.pdf$/i.test(file.name);
      const up = isPdf ? file : await (opts.prepare || heicToJpeg)(file);
      const fd = new FormData();
      fd.append(field, up, up.name || 'upload.jpg');
      if (wantThumbs && !isPdf) {
        const th = await makeThumb(up);
        if (th) fd.append('thumb', th, 'thumb.jpg');
      }
      await api(endpoint, { method: 'POST', body: fd });
      done++; tick();
    };
    try {
      // receipts are scanned server-side, so send them one at a time; photos go 3 up
      const lanes = wantThumbs ? [0, 1, 2] : [0];
      let next = 0;
      await Promise.all(lanes.map(async () => {
        while (next < jobs.length) await send(jobs[next++]);
      }));
      queue.forEach((q) => { if (q.url) URL.revokeObjectURL(q.url); });
      onDone();
    } catch (err) {
      alert('Upload failed: ' + err.message + (done ? `\n\n${done} of ${total} did make it.` : ''));
      onDone();
    }
  });
}

function openLightbox(photos, startIdx) {
  if (!photos.length) return;
  let idx = startIdx;
  const single = photos.length === 1;
  const back = document.createElement('div');
  back.className = 'lightbox';
  back.innerHTML = `
    <button class="lb-btn lb-close" title="Close">✕</button>
    ${single ? '' : '<button class="lb-btn lb-prev" title="Previous">‹</button><button class="lb-btn lb-next" title="Next">›</button>'}
    <img class="lb-img" alt="" />
    <div class="lb-count"></div>`;
  document.body.appendChild(back);
  const img = back.querySelector('.lb-img');
  const count = back.querySelector('.lb-count');
  const show = (i) => {
    idx = (i + photos.length) % photos.length;
    img.src = '/api/file/' + photos[idx].file;
    count.textContent = single ? '' : (idx + 1) + ' / ' + photos.length;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
  };
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  back.querySelector('.lb-close').addEventListener('click', close);
  if (!single) {
    back.querySelector('.lb-prev').addEventListener('click', () => show(idx - 1));
    back.querySelector('.lb-next').addEventListener('click', () => show(idx + 1));
  }
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  // swipe to change photo (mobile)
  let sx = null;
  back.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  back.addEventListener('touchend', (e) => {
    if (sx === null || single) { sx = null; return; }
    const dx = e.changedTouches[0].clientX - sx;
    if (dx > 40) show(idx - 1);
    else if (dx < -40) show(idx + 1);
    sx = null;
  }, { passive: true });
  show(idx);
}

/* ---------- modal helpers ---------- */
function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

/* In-app replacement for window.confirm().
 * Native confirm() is unreliable on phones — several mobile browsers, and any page
 * running as a home-screen app, suppress it and return false, so a delete looked
 * like it simply did nothing. This dialog behaves the same everywhere. */
function askConfirm(message, { ok = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(message)}</h2>
      <div class="modal-actions" style="margin-top:20px">
        <button type="button" class="btn ghost" style="color:#555;border-color:#ccc" id="askNo">Cancel</button>
        <button type="button" class="btn ${danger ? 'danger' : 'gold'}" id="askYes">${esc(ok)}</button>
      </div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    $('#askYes').addEventListener('click', () => finish(true));
    $('#askNo').addEventListener('click', () => finish(false));
    // dismissing by tapping the backdrop counts as "no"
    const back = $('#modal');
    const onBack = (e) => { if (e.target === back) { back.removeEventListener('click', onBack); finish(false); } };
    back.addEventListener('click', onBack);
  });
}

/* ---------- in-page file viewer ----------
 * Opens a receipt, invoice or check in an overlay on the current page. No new tab,
 * no navigation, so nothing reloads and the page you were on is still underneath. */
function openFile(file, name = '') {
  if (!file) return;
  const isPdf = /\.pdf$/i.test(file) || /\.pdf$/i.test(name);
  const back = document.createElement('div');
  back.className = 'lightbox file-view';
  back.innerHTML = `
    <button class="lb-btn lb-close" title="Close">✕</button>
    <a class="lb-btn lb-open" href="/api/file/${file}" download title="Download">⤓</a>
    ${isPdf
      ? `<iframe class="fv-frame" src="/api/file/${file}" title="${esc(name)}"></iframe>`
      : `<img class="lb-img" src="/api/file/${file}" alt="${esc(name)}" />`}
    ${name ? `<div class="lb-count">${esc(name)}</div>` : ''}`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.querySelector('.lb-close').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
}
/* Receipt actions are delegated from the document once, not re-bound on every
 * render — re-binding stacked a new listener each time the page redrew, so one tap
 * fired the handler N times over. */
document.addEventListener('click', async (e) => {
  const rescan = e.target.closest('[data-rescan]');
  const del = e.target.closest('[data-delrec]');
  if (!rescan && !del) return;
  const id = rescan ? rescan.dataset.rescan : del.dataset.delrec;
  const note = document.querySelector(`[data-save="${id}"]`);
  if (rescan) {
    rescan.disabled = true;
    if (note) note.textContent = 'Reading again…';
    try { await api('/api/receipts/' + id + '/rescan', { method: 'POST' }); renderReceipts(); }
    catch (err) { if (note) note.textContent = err.message; rescan.disabled = false; }
    return;
  }
  if (!await askConfirm('Delete this receipt? The file is removed too.')) return;
  try { await api('/api/receipts/' + id, { method: 'DELETE' }); renderReceipts(); }
  catch (err) { alert(err.message); }
});

/* One global handler so every [data-file-view] link opens in place, on any page. */
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-file-view]');
  if (!link) return;
  e.preventDefault();
  e.stopPropagation();
  openFile(link.dataset.fileView, link.dataset.fileName || '');
});
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

boot();
