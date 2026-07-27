/* DMV Design and Build — portal frontend */
let ME = null;
let homeMap = null, bigMap = null;
let todoTab = 'open'; // which tab of the home to-do panel is selected

const $ = (s) => document.querySelector(s);
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

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
  $('#whoami').textContent = ME.name + (ME.role === 'admin' ? ' (Admin)' : '');
  const links = [['#/home', 'Home'], ['#/jobs', ME.role === 'admin' ? 'Jobs' : 'My Jobs']];
  if (ME.role === 'admin') links.push(['#/orders', 'Orders']);
  links.push(['#/photos', 'Photos']);
  if (ME.role === 'admin') links.push(['#/customers', 'Customers']);
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
  const jobMatch = h.match(/^#\/job\/(\d+)/);
  if (jobMatch) return renderJob(Number(jobMatch[1]));
  if (h.startsWith('#/jobs')) return renderJobs();
  if (h.startsWith('#/orders') && ME.role === 'admin') return renderOrders();
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
  const projects = await api('/api/projects');
  const totalValue = projects.reduce((s, p) => s + (p.price || 0), 0);
  const isAdmin = ME.role === 'admin';
  const received = isAdmin ? projects.reduce((s, p) => s + (p.payments || []).reduce((a, x) => a + (x.amount || 0), 0), 0) : null;
  const toOrder = isAdmin ? projects.reduce((s, p) => s + (p.materials || []).filter((m) => !m.ordered).length, 0) : null;
  const toOrderCost = isAdmin ? projects.reduce((s, p) => s + (p.materials || []).filter((m) => !m.ordered).reduce((a, m) => a + (m.price || 0) * (m.qty || 1), 0), 0) : null;
  const recentPhotos = projects
    .flatMap((p) => (p.photos || []).map((ph) => ({ ...ph, projectName: p.name, projectId: p.id })))
    .sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
  $('#main').innerHTML = `
    ${isAdmin ? '' : `<div class="page-head"><h1>Welcome, ${esc(ME.name)}</h1></div>`}
    <div class="cards">
      <div class="stat"><div class="num">${projects.length}</div><div class="lbl">${isAdmin ? 'Active Jobs' : 'My Jobs'}</div></div>
      ${isAdmin ? `
      <div class="stat"><div class="num" style="color:var(--red)">${money(totalValue - received)}</div><div class="lbl">Outstanding</div></div>
      <div class="stat"><div class="num" style="color:var(--green)">${money(received)}</div><div class="lbl">Received</div></div>` : ''}
      <div class="stat"><div class="num">${money(totalValue)}</div><div class="lbl">Total Contract Value</div></div>
      ${toOrder !== null ? `<div class="stat"><div class="num">${toOrder}</div><div class="lbl">Materials To Order</div></div>
      <div class="stat"><div class="num">${money(toOrderCost)}</div><div class="lbl">Materials To Order Cost</div></div>` : ''}
    </div>
    ${isAdmin ? `
    <div class="home-duo">
    <div class="panel chart-panel">
      <h3>Cash Flow — Receivable vs. Spending vs. Received</h3>
      ${financeChartSVG(projects)}
    </div>
    <div class="panel todo-panel">
      ${(() => {
        const openCount = projects.reduce((s, p) => s + (p.notes || []).filter((n) => !n.done).length, 0);
        const doneCount = projects.reduce((s, p) => s + (p.notes || []).filter((n) => n.done).length, 0);
        const list = (done) => {
          const jobs = projects
            .map((p) => ({ ...p, shown: (p.notes || []).filter((n) => !!n.done === done) }))
            .filter((p) => p.shown.length);
          if (!jobs.length) return `<div class="muted">${done ? 'Nothing completed yet.' : 'No open to-do items. Add notes on a job page and they will show up here.'}</div>`;
          return jobs.map((p) => `
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
        <h3>To-Do — All Jobs</h3>
        <div class="todo-tabs">
          <button class="todo-tab ${todoTab === 'open' ? 'active' : ''}" data-ttab="open">Open${openCount ? ' (' + openCount + ')' : ''}</button>
          <button class="todo-tab ${todoTab === 'done' ? 'active' : ''}" data-ttab="done">Completed${doneCount ? ' (' + doneCount + ')' : ''}</button>
        </div>
      </div>
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
          <img src="/api/file/${ph.file}" alt="${esc(ph.name)}" loading="lazy" />
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
      const m = L.marker([p.lat, p.lng]).bindPopup(
        `<div class="map-popup"><a href="#/job/${p.id}">${esc(p.name)}</a><br>${esc(p.address)}<br>Starts: ${fmtDate(p.startDate)}</div>`
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
async function renderJobs() {
  const projects = await api('/api/projects');
  const isAdmin = ME.role === 'admin';
  const card = (p, showCustomer) => `
      <div class="job-card" onclick="location.hash='#/job/${p.id}'">
        <h4>${esc(p.name)}</h4>
        <div class="addr">📍 ${esc(p.address)}</div>
        <div class="job-meta">
          <span><b>${money(p.price)}</b></span>
          <span>Starts <b>${fmtDate(p.startDate)}</b></span>
          ${showCustomer && p.customerName ? `<span class="badge">${esc(p.customerName)}</span>` : ''}
        </div>
        ${isAdmin ? `<div class="job-meta" style="margin-top:8px">
          <span>${(p.materials || []).filter((m) => !m.ordered).length} materials to order</span>
          <span>${(p.notes || []).filter((n) => !n.done).length} open notes</span>
        </div>` : ''}
      </div>`;
  let body;
  if (!projects.length) {
    body = '<div class="panel muted">No jobs yet.' + (isAdmin ? ' Click “+ New Project” to create your first job.' : '') + '</div>';
  } else if (!isAdmin) {
    body = `<div class="job-grid">${projects.map((p) => card(p, false)).join('')}</div>`;
  } else {
    /* group jobs under their customer */
    const groups = new Map();
    for (const p of projects) {
      const key = p.customerName || 'Unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const names = [...groups.keys()].sort((a, b) =>
      (a === 'Unassigned') - (b === 'Unassigned') || a.localeCompare(b));
    body = names.map((n) => {
      const list = groups.get(n);
      const total = list.reduce((s, p) => s + (p.price || 0), 0);
      return `
      <section class="cust-group">
        <div class="cust-head">
          <h3>👤 ${esc(n)}</h3>
          <span class="muted">${list.length} job${list.length === 1 ? '' : 's'} — ${money(total)}</span>
        </div>
        <div class="job-grid">${list.map((p) => card(p, false)).join('')}</div>
      </section>`;
    }).join('');
  }
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${isAdmin ? 'Jobs' : 'My Jobs'}</h1>
      ${isAdmin ? '<button class="btn gold" id="newProjBtn">+ New Project</button>' : ''}
    </div>
    ${body}`;
  if (isAdmin) $('#newProjBtn').addEventListener('click', () => projectModal());
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
          <img src="/api/file/${ph.file}" alt="${esc(ph.name)}" loading="lazy" />
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
  const isEdit = !!p;
  openModal(`
    <h2>${isEdit ? 'Edit Project' : 'New Project'}</h2>
    <form id="projForm" class="form-grid">
      <div class="full"><label class="f">Project Name *</label><input class="f" name="name" required value="${isEdit ? esc(p.name) : ''}" /></div>
      <div class="full"><label class="f">Address * (used to pin the job on the map)</label><input class="f" name="address" required value="${isEdit ? esc(p.address) : ''}" /></div>
      <div><label class="f">Price ($)</label><input class="f" name="price" type="number" step="0.01" min="0" value="${isEdit ? p.price : ''}" /></div>
      <div><label class="f">Job Start Date</label><input class="f" name="startDate" type="date" value="${isEdit && p.startDate ? p.startDate : ''}" /></div>
      <div class="full"><label class="f">Customer</label>
        <select class="f" name="customerId">
          <option value="">— No customer assigned —</option>
          ${customers.map((c) => `<option value="${c.id}" ${isEdit && p.customerId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
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
  const isAdmin = ME.role === 'admin';
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

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${esc(p.name)}</h1>
      <div>
        ${isAdmin ? `<button class="btn" id="editProjBtn">Edit</button> <button class="btn danger" id="delProjBtn">Delete</button>` : ''}
      </div>
    </div>

    <div class="panel">
      <div class="info-grid">
        <div><div class="k">Address</div><div class="v">${esc(p.address)}</div></div>
        <div><div class="k">Price</div><div class="v">${money(p.price)}</div></div>
        <div><div class="k">Job Start Date</div><div class="v">${fmtDate(p.startDate)}</div></div>
        <div><div class="k">Customer</div><div class="v">${esc(p.customerName || '—')}</div></div>
      </div>
      <div style="margin-top:16px">
        ${p.contractFile ? `<a class="file-chip" href="/api/file/${p.contractFile}" target="_blank">📄 Contract — ${esc(p.contractName)}</a>` : '<span class="muted" style="margin-right:12px">No contract uploaded.</span>'}
        ${p.planFile ? `<a class="file-chip" href="/api/file/${p.planFile}" target="_blank">📐 Arch Plan — ${esc(p.planName)}</a>` : '<span class="muted">No arch plan uploaded.</span>'}
      </div>
      ${!p.lat && isAdmin ? '<div class="muted" style="margin-top:10px">⚠️ Address could not be located on the map. Edit the project and refine the address.</div>' : ''}
    </div>

    ${p.lat && p.lng ? `
    <div class="panel">
      <h3>Location</h3>
      <div id="jobmap"></div>
    </div>` : ''}

    <div class="panel">
      <h3>Photos${(p.photos || []).length ? ' (' + p.photos.length + ')' : ''}</h3>
      ${isAdmin ? `
      <div style="margin-bottom:14px">
        <input type="file" id="photoFile" accept="image/*" multiple style="display:none" />
        <button class="btn gold" id="photoUploadBtn">⬆ Upload Photos</button>
        <span class="muted"> You can select several at once.</span>
      </div>` : ''}
      ${(p.photos || []).length ? `
      <div class="photo-grid">
        ${p.photos.map((ph) => `
        <div class="photo-item" data-view="${p.photos.indexOf(ph)}">
          <img src="/api/file/${ph.file}" alt="${esc(ph.name)}" loading="lazy" />
          ${isAdmin ? `<button class="photo-del" data-delphoto="${ph.id}" title="Delete photo">✕</button>` : ''}
        </div>`).join('')}
      </div>` : '<div class="muted">No photos yet.</div>'}
    </div>

    ${isAdmin ? `
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
    </div>

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

  // photo viewer (all users)
  document.querySelectorAll('[data-view]').forEach((d) =>
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-delphoto]')) return;
      openLightbox(p.photos || [], Number(d.dataset.view));
    })
  );

  if (!isAdmin) return;

  // photo upload / delete
  $('#photoUploadBtn').addEventListener('click', () => $('#photoFile').click());
  $('#photoFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const btn = $('#photoUploadBtn');
    btn.disabled = true;
    try {
      for (let i = 0; i < files.length; i++) {
        btn.textContent = `Uploading ${i + 1} of ${files.length}…`;
        const fd = new FormData();
        fd.append('photo', files[i]);
        await api(`/api/projects/${id}/photos`, { method: 'POST', body: fd });
      }
      renderJob(id);
    } catch (err) { alert(err.message); renderJob(id); }
  });
  document.querySelectorAll('[data-delphoto]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this photo?')) return;
      await api(`/api/projects/${id}/photos/${b.dataset.delphoto}`, { method: 'DELETE' });
      renderJob(id);
    })
  );

  $('#editProjBtn').addEventListener('click', () => projectModal(p));
  $('#delProjBtn').addEventListener('click', async () => {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    await api('/api/projects/' + id, { method: 'DELETE' });
    location.hash = '#/jobs';
  });

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
      if (!confirm('Delete this payment?')) return;
      await api(`/api/projects/${id}/payments/${b.dataset.delpay}`, { method: 'DELETE' });
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
        <thead><tr><th>Name</th><th>Username</th><th>Jobs</th><th class="right">Actions</th></tr></thead>
        <tbody>${customers.map((c) => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${esc(c.username)}</td>
            <td>${c.projectCount}</td>
            <td class="right">
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
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Delete this customer login? Their jobs stay but become unassigned.')) return;
      await api('/api/customers/' + b.dataset.del, { method: 'DELETE' });
      renderCustomers();
    })
  );
}

/* ---------- photo lightbox ---------- */
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
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

boot();
