/* DMV Design and Build — portal frontend */
let ME = null;
let homeMap = null, bigMap = null;

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
  $('#themeBtn').textContent = document.documentElement.classList.contains('light') ? '🌙 Dark Mode' : '☀️ Light Mode';
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
  if (h.startsWith('#/customers') && ME.role === 'admin') return renderCustomers();
  renderHome();
}

/* ---------- HOME ---------- */
async function renderHome() {
  const projects = await api('/api/projects');
  const totalValue = projects.reduce((s, p) => s + (p.price || 0), 0);
  const toOrder = ME.role === 'admin' ? projects.reduce((s, p) => s + (p.materials || []).filter((m) => !m.ordered).length, 0) : null;
  $('#main').innerHTML = `
    <div class="page-head"><h1>Welcome, ${esc(ME.name)}</h1></div>
    <div class="cards">
      <div class="stat"><div class="num">${projects.length}</div><div class="lbl">${ME.role === 'admin' ? 'Active Jobs' : 'My Jobs'}</div></div>
      <div class="stat"><div class="num">${money(totalValue)}</div><div class="lbl">Total Contract Value</div></div>
      ${toOrder !== null ? `<div class="stat"><div class="num">${toOrder}</div><div class="lbl">Materials To Order</div></div>` : ''}
    </div>
    <div class="panel map-card" id="mapCard">
      <h3>Job Map</h3>
      <div class="map-hint">Click map to expand ⛶</div>
      <div id="homemap"></div>
    </div>`;
  homeMap = drawMap('homemap', projects, false);
  setTimeout(() => homeMap.invalidateSize(), 120);
  $('#mapCard').addEventListener('click', () => openFullMap(projects));
}

function drawMap(elId, projects, interactivePopups) {
  const located = projects.filter((p) => p.lat && p.lng);
  const map = L.map(elId, { scrollWheelZoom: interactivePopups });
  L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps'
  }).addTo(map);
  if (located.length) {
    const group = L.featureGroup(located.map((p) => {
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
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${isAdmin ? 'Jobs' : 'My Jobs'}</h1>
      ${isAdmin ? '<button class="btn gold" id="newProjBtn">+ New Project</button>' : ''}
    </div>
    ${projects.length ? `<div class="job-grid">${projects.map((p) => `
      <div class="job-card" onclick="location.hash='#/job/${p.id}'">
        <h4>${esc(p.name)}</h4>
        <div class="addr">📍 ${esc(p.address)}</div>
        <div class="job-meta">
          <span><b>${money(p.price)}</b></span>
          <span>Starts <b>${fmtDate(p.startDate)}</b></span>
          ${p.customerName ? `<span class="badge">${esc(p.customerName)}</span>` : ''}
        </div>
        ${isAdmin ? `<div class="job-meta" style="margin-top:8px">
          <span>${(p.materials || []).filter((m) => !m.ordered).length} materials to order</span>
          <span>${(p.notes || []).filter((n) => !n.done).length} open notes</span>
        </div>` : ''}
      </div>`).join('')}</div>`
      : '<div class="panel muted">No jobs yet.' + (isAdmin ? ' Click “+ New Project” to create your first job.' : '') + '</div>'}`;
  if (isAdmin) $('#newProjBtn').addEventListener('click', () => projectModal());
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

    ${isAdmin ? `
    <div class="panel">
      <h3>Material List ${p.materialFileName ? '— from ' + esc(p.materialFileName) : ''}</h3>
      <div style="margin-bottom:14px">
        <input type="file" id="matFile" accept=".xlsx,.xls,.csv" style="display:none" />
        <button class="btn gold" id="matUploadBtn">⬆ Upload Excel Material List</button>
        <span class="muted"> Columns: material name, purchase link, price (and optional quantity). Re-uploading replaces the list.</span>
      </div>
      ${mats.length ? `
      <table>
        <thead><tr><th style="width:40px">Ordered</th><th>Material</th><th>Purchase Link</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead>
        <tbody>
          ${mats.map((m) => `
          <tr class="${m.ordered ? 'ordered' : ''}">
            <td><input type="checkbox" data-mid="${m.id}" ${m.ordered ? 'checked' : ''} style="width:17px;height:17px;accent-color:var(--gold)" /></td>
            <td><span class="mat-name">${esc(m.name)}</span></td>
            <td>${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">Buy ↗</a>` : '<span class="muted">—</span>'}</td>
            <td class="right">${m.qty || 1}</td>
            <td class="right">${money(m.price)}</td>
            <td class="right">${money(m.price * (m.qty || 1))}</td>
          </tr>`).join('')}
          <tr class="totals-row"><td colspan="5">Still to order (${toOrder.length} items)</td><td class="right" style="color:var(--red)">${money(totOrder)}</td></tr>
          <tr class="totals-row"><td colspan="5">Total material cost (${mats.length} items)</td><td class="right">${money(totAll)}</td></tr>
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

  if (!isAdmin) return;

  $('#editProjBtn').addEventListener('click', () => projectModal(p));
  $('#delProjBtn').addEventListener('click', async () => {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    await api('/api/projects/' + id, { method: 'DELETE' });
    location.hash = '#/jobs';
  });

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

/* ---------- modal helpers ---------- */
function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

boot();
