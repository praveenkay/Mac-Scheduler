/* ============================================================
   Mac Scheduler — frontend app
   ============================================================ */
'use strict';

const state = {
  tasks: [],
  sources: [],
  activeSource: 'all',
  filter: 'all',
  search: '',
  theme: localStorage.getItem('macsched-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  autoRefresh: localStorage.getItem('macsched-autorefresh') === '1',
  currentId: null,
  isCron: false,
};

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

document.documentElement.setAttribute('data-theme', state.theme);

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- Toasts ----------
function toast(msg, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = { success: '✓', error: '✕', info: 'ℹ' }[type] || 'ℹ';
  el.innerHTML = `<span>${ic}</span><span>${esc(msg)}</span>`;
  $('#toastRoot').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---------- Loading / data ----------
async function refresh() {
  showLoading();
  try {
    const [t, s] = await Promise.all([api('/tasks'), api('/sources')]);
    state.tasks = t.tasks;
    state.sources = s.sources;
    buildSourceNav();
    render();
  } catch (e) {
    toast('Failed to load tasks: ' + e.message, 'error', 6000);
  }
}

function showLoading() {
  $('#taskList').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
}

// ---------- Source nav ----------
function buildSourceNav() {
  const nav = $('#sourceNav');
  const existing = $$('#sourceNav .nav-item[data-source]');
  existing.forEach((el) => { if (el.dataset.source !== 'all') el.remove(); });
  const label = document.createElement('div');
  label.className = 'nav-section-label';
  label.textContent = 'Scheduled Task Sources';
  nav.appendChild(label);

  for (const s of state.sources) {
    const count = state.tasks.filter((t) => t.source === s.id).length;
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (state.activeSource === s.id ? ' active' : '');
    btn.dataset.source = s.id;
    const colors = { 'user-agents': 'linear-gradient(135deg,#22c55e,#16a34a)', 'system-agents': 'linear-gradient(135deg,#3b82f6,#2563eb)', 'system-daemons': 'linear-gradient(135deg,#8b5cf6,#6d28d9)', 'user-cron': 'linear-gradient(135deg,#f59e0b,#d97706)', 'system-cron': 'linear-gradient(135deg,#ef4444,#b91c1c)' };
    btn.innerHTML = `<span class="nav-dot" style="background:${colors[s.id] || 'var(--accent)'}"></span><span class="nav-label">${esc(s.name)}</span><span class="nav-count">${count}</span>`;
    btn.addEventListener('click', () => { setActiveSource(s.id); });
    nav.appendChild(btn);
  }
}

function setActiveSource(id) {
  state.activeSource = id;
  $$('#sourceNav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.source === id));
  render();
}

// ---------- Classification ----------
function taskStatus(t) {
  if (t.type === 'cronfile') return t.jobs && t.jobs.length ? 'scheduled' : 'stopped';
  if (t.loaded) return 'running';
  if (isScheduled(t.parsed)) return 'scheduled';
  return 'stopped';
}
function isScheduled(p) {
  if (!p) return false;
  return !!(p.StartCalendarInterval || p.StartInterval || p.WeeklySchedule);
}
function scheduleLabel(t) {
  if (t.type === 'cronfile') {
    const n = (t.jobs || []).length;
    return n ? `${n} cron job${n > 1 ? 's' : ''} configured` : 'No cron jobs';
  }
  const p = t.parsed || {};
  if (p.StartCalendarInterval) {
    if (Array.isArray(p.StartCalendarInterval)) return `${p.StartCalendarInterval.length} scheduled times`;
    const sci = p.StartCalendarInterval;
    const parts = [];
    if (sci.Weekday !== undefined) parts.push(weekdayName(sci.Weekday));
    if (sci.Hour !== undefined) parts.push(`${pad(sci.Hour)}:${pad(sci.Minute ?? 0)}`);
    if (sci.Minute !== undefined && sci.Hour === undefined) parts.push(`minute ${sci.Minute}`);
    if (sci.Day !== undefined) parts.push(`day ${sci.Day}`);
    if (sci.Month !== undefined) parts.push(monthName(sci.Month));
    return parts.length ? parts.join(' · ') : 'On schedule';
  }
  if (p.StartInterval) {
    const s = p.StartInterval;
    return s >= 3600 ? `Every ${fmtDur(s)}` : `Every ${fmtDur(s)}`;
  }
  if (p.RunAtLoad) return 'Runs at load';
  if (p.KeepAlive && p.KeepAlive !== 'false') return 'Always active';
  if (p.WatchPaths) return `Watches ${p.WatchPaths.length} path${p.WatchPaths.length > 1 ? 's' : ''}`;
  if (p.QueueDirectories) return `Monitors ${p.QueueDirectories.length} queue dir${p.QueueDirectories.length > 1 ? 's' : ''}`;
  if (p.SocketListeners) return 'Listens on socket';
  return 'No schedule';
}
function weekdayName(n) {
  const d = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
  return d[n] ?? n;
}
function monthName(n) { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][n - 1] ?? n; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDur(sec) {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
function programPreview(t) {
  if (t.type === 'cronfile') return 'cron(8) scheduler';
  const p = t.parsed || {};
  const args = p.ProgramArguments;
  if (Array.isArray(args)) return args.join(' ');
  if (p.Program) return p.Program;
  return '—';
}
function sourceMeta(id) {
  const s = state.sources.find((x) => x.id === id);
  return s || { name: id, desc: id };
}

// ---------- Filtering ----------
function visibleTasks() {
  let list = state.tasks;
  if (state.activeSource !== 'all') list = list.filter((t) => t.source === state.activeSource);
  if (state.filter === 'running') list = list.filter((t) => taskStatus(t) === 'running');
  if (state.filter === 'scheduled') list = list.filter((t) => taskStatus(t) === 'scheduled');
  if (state.filter === 'stopped') list = list.filter((t) => taskStatus(t) === 'stopped' || taskStatus(t) === 'unknown');
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter((t) =>
      (t.label || '').toLowerCase().includes(q) ||
      (t.name || '').toLowerCase().includes(q) ||
      (t.raw || '').toLowerCase().includes(q) ||
      programPreview(t).toLowerCase().includes(q)
    );
  }
  return list.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
}

// ---------- Render main ----------
function render() {
  const list = visibleTasks();
  const total = state.tasks.length;
  const running = state.tasks.filter((t) => taskStatus(t) === 'running').length;
  const sched = state.tasks.filter((t) => ['scheduled', 'running'].includes(taskStatus(t))).length;

  $('#stat-total').textContent = total;
  $('#stat-loaded').textContent = running;
  $('#stat-sched').textContent = sched;

  const meta = state.activeSource === 'all' ? null : sourceMeta(state.activeSource);
  $('#viewTitle').textContent = meta ? meta.name : 'All Tasks';
  $('#viewDesc').textContent = meta ? meta.desc : `${total} scheduled jobs on this Mac`;
  $('#count-all').textContent = total;

  const grid = $('#taskList');
  $('#emptyState').hidden = list.length > 0;
  grid.innerHTML = '';

  for (const t of list) grid.appendChild(taskCard(t));
}

function taskCard(t) {
  const st = taskStatus(t);
  const el = document.createElement('div');
  el.className = 'task-card';
  el.dataset.status = st;
  el.dataset.id = t.id;

  const isCron = t.type === 'cronfile';
  const iconBg = {
    'user-agents': 'var(--green-bg)', 'system-agents': 'var(--blue-bg)',
    'system-daemons': 'var(--purple-bg)', 'user-cron': 'var(--amber-bg)', 'system-cron': 'var(--red-bg)',
  }[t.source] || 'var(--bg-soft)';
  const icon = isCron ? '🗓' : '⚙';

  const statusBadge = st === 'running' ? '<span class="card-status status-running">● Running</span>'
    : st === 'scheduled' ? '<span class="card-status status-scheduled">● Scheduled</span>'
    : st === 'stopped' ? '<span class="card-status status-stopped">■ Stopped</span>'
    : '<span class="card-status status-unknown">Unknown</span>';

  el.innerHTML = `
    <div class="card-top">
      <div class="card-icon" style="background:${iconBg}">${icon}</div>
      <div class="card-title">
        <div class="card-name">${esc(t.label || t.name)}</div>
        <div class="card-label">${esc(t.name)}</div>
      </div>
      ${statusBadge}
    </div>
    <div class="card-schedule">
      <svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3.586l2.207 2.207a1 1 0 0 1-1.414 1.414l-2.5-2.5A1 1 0 0 1 7 8V4a1 1 0 0 1 1-1zM8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0z"/></svg>
      <span>${esc(scheduleLabel(t))}</span>
    </div>
    <div class="card-prog" title="${esc(programPreview(t))}">${esc(programPreview(t))}</div>
    <div class="card-foot">
      <span class="card-src"><span class="mini-dot" style="background:var(--accent)"></span>${esc(sourceMeta(t.source).name)}</span>
      ${t.meta ? '<span>' + fmtTime(t.meta.mtime) + '</span>' : ''}
    </div>`;

  el.addEventListener('click', () => openDrawer(t.id));
  return el;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- Drawer ----------
async function openDrawer(id) {
  state.currentId = id;
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  state.isCron = t.type === 'cronfile';

  $('#dType').textContent = t.type === 'cronfile' ? 'CRON' : 'LAUNCHD';
  $('#dType').className = 'drawer-type-badge' + (t.type === 'cronfile' ? ' cron' : '');
  $('#dLabel').textContent = t.label || t.name;
  $('#dFile').textContent = t.file || '';
  $('#drawer').hidden = false;

  const body = $('#drawerBody');
  body.innerHTML = '<div class="skeleton" style="height:80px;margin-bottom:14px"></div><div class="skeleton" style="height:200px"></div>';

  if (t.type === 'cronfile') {
    renderCronDrawer(body, t);
  } else {
    renderLaunchdDrawer(body, t);
  }
}

function whatItDoes(t) {
  const p = t.parsed || {};
  const parts = [];
  if (t.type === 'cronfile') {
    const n = (t.jobs || []).length;
    parts.push(`Stores ${n} cron job${n === 1 ? '' : 's'} in this user's crontab.`);
    const cmds = (t.jobs || []).slice(0, 3).map((j) => j.command).filter(Boolean);
    if (cmds.length) parts.push(`Commands: ${cmds.join('; ')}${(t.jobs || []).length > 3 ? ' …' : ''}`);
    return parts.join(' ');
  }
  const prog = p.ProgramArguments ? p.ProgramArguments.join(' ') : (p.Program || '');
  if (prog) parts.push(`Runs: ${prog}`);
  parts.push(`Schedule: ${scheduleLabel(t)}.`);
  if (p.KeepAlive) parts.push('Launchd keeps it running (restarts after exit).');
  if (p.RunAtLoad) parts.push('Starts when loaded.');
  if (p.WorkingDirectory) parts.push(`Working directory: ${p.WorkingDirectory}.`);
  if (p.StandardOutPath || p.StandardErrorPath) {
    parts.push(`Logs: ${[p.StandardOutPath, p.StandardErrorPath].filter(Boolean).join(', ')}`);
  }
  return parts.join(' ');
}

function drawerInfoBlocks(t) {
  const st = taskStatus(t);
  const statusEl = st === 'running' ? '<span class="val" style="color:var(--green)">Running' + (t.pid ? ` (PID ${t.pid})` : '') + '</span>'
    : st === 'scheduled' ? '<span class="val" style="color:var(--amber)">Scheduled (not running)</span>'
    : st === 'stopped' ? '<span class="val" style="color:var(--red)">Stopped / not loaded</span>'
    : '<span class="val">Unknown</span>';
  return `
    <div class="section">
      <div class="section-title">What this task does</div>
      <div class="info-item full" style="grid-column:1/-1;background:var(--bg-soft)">
        <div class="val" style="font-weight:400;font-size:13px;line-height:1.5">${esc(whatItDoes(t))}</div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Overview</div>
      <div class="info-grid">
        <div class="info-item"><label>Status</label>${statusEl}</div>
        <div class="info-item"><label>Source</label><div class="val">${esc(sourceMeta(t.source).name)}</div></div>
        <div class="info-item full"><label>Label</label><div class="val mono">${esc(t.label || '—')}</div></div>
        <div class="info-item full"><label>File</label><div class="val mono">${esc(t.file)}</div></div>
        <div class="info-item"><label>Type</label><div class="val">${t.type === 'cronfile' ? 'Cron table' : 'Launchd plist'}</div></div>
        ${t.meta ? `<div class="info-item"><label>Modified</label><div class="val">${fmtTime(t.meta.mtime)}</div></div>` : ''}
        ${t.meta ? `<div class="info-item"><label>Size</label><div class="val">${t.meta.size} bytes</div></div>` : ''}
      </div>
    </div>`;
}

// ---------- Launchd drawer (full CRUD form) ----------
function renderLaunchdDrawer(body, t) {
  const p = t.parsed || {};
  const args = Array.isArray(p.ProgramArguments) ? p.ProgramArguments.slice() : [];

  const schedSection = buildScheduleForm(p);

  body.innerHTML = `
    ${drawerInfoBlocks(t)}

    <div class="section">
      <div class="section-title">Operations</div>
      <div class="op-btns">
        <button class="btn btn-success btn-sm" data-op="load">▶ Load</button>
        <button class="btn btn-sm" data-op="unload">⏹ Unload</button>
        <button class="btn btn-sm" data-op="run">⚡ Run Now</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Edit Task</div>
      <div class="field"><label>Label (unique identifier)</label>
        <input id="fLabel" value="${esc(p.Label || '')}" placeholder="com.example.task" /></div>

      <div class="field"><label>Program (executable path)</label>
        <input id="fProgram" value="${esc(p.Program || (args[0] || ''))}" placeholder="/usr/bin/say" />
        <div class="hint">Path to the binary or script launchd runs.</div></div>

      <div class="field">
        <label>Arguments (beyond program)</label>
        <div class="args-list" id="argsList"></div>
        <button class="btn btn-sm" id="addArgBtn" style="margin-top:7px">+ Add argument</button>
      </div>

      <div class="field"><label>Working Directory</label>
        <input id="fCwd" value="${esc(p.WorkingDirectory || '')}" placeholder="/Users/me" /></div>

      <div class="field-row">
        <div class="field"><label>Standard Output Path</label><input id="fOut" value="${esc(p.StandardOutPath || '')}" placeholder="/tmp/task.log" /></div>
        <div class="field"><label>Standard Error Path</label><input id="fErr" value="${esc(p.StandardErrorPath || '')}" placeholder="/tmp/task.err.log" /></div>
      </div>

      ${schedSection}

      <div class="toggle-row"><div><label>Run at load</label><div class="desc">Starts immediately when loaded</div></div>
        <label class="switch"><input type="checkbox" id="fRunAtLoad" ${p.RunAtLoad ? 'checked' : ''}><span class="slider"></span></label></div>
      <div class="toggle-row"><div><label>Keep alive</label><div class="desc">Restart if it exits</div></div>
        <label class="switch"><input type="checkbox" id="fKeepAlive" ${p.KeepAlive ? 'checked' : ''}><span class="slider"></span></label></div>
    </div>

    <div class="section">
      <div class="raw-toggle-row">
        <label class="switch"><input type="checkbox" id="rawToggle"><span class="slider"></span></label>
        <span>Show raw XML plist</span>
      </div>
      <textarea id="rawEditor" spellcheck="false" hidden>${esc(t.raw || '')}</textarea>
      <div class="drawer-actions-sticky">
        <button class="btn btn-danger" id="delBtn">Delete</button>
        <button class="btn btn-primary" id="saveBtn">Save Changes</button>
      </div>
    </div>`;

  // populate args
  const argsList = $('#argsList');
  if (args.length) {
    args.forEach((a) => addArgInput(a));
  } else {
    addArgInput('');
  }

  $('#addArgBtn').addEventListener('click', () => addArgInput(''));
  $('#drawerClose').addEventListener('click', closeDrawer);
  document.getElementById('delBtn').addEventListener('click', () => confirmDelete(t));
  document.getElementById('saveBtn').addEventListener('click', async () => { await saveLaunchd(t); });

  // raw toggle
  document.getElementById('rawToggle').addEventListener('change', (e) => {
    const ed = document.getElementById('rawEditor');
    ed.hidden = !e.target.checked;
    if (e.target.checked && !ed.value.trim() && t.raw) ed.value = t.raw;
  });

  // op buttons
  $$('#drawerBody .op-btns .btn[data-op]').forEach((b) => {
    b.addEventListener('click', async () => {
      const op = b.dataset.op;
      b.disabled = true;
      try {
        await api('/job/' + encodeURIComponent(t.id), { method: 'POST', body: JSON.stringify({ action: op }) });
        toast(op === 'load' ? 'Task loaded' : op === 'unload' ? 'Task unloaded' : 'Task launched now', 'success');
        await refresh();
        await openDrawer(t.id);
      } catch (e) { toast(e.message, 'error', 6000); }
      b.disabled = false;
    });
  });
}

function addArgInput(val) {
  const list = $('#argsList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'arg-item';
  row.innerHTML = `<input value="${esc(val)}" placeholder="argument…" />` +
    `<button class="del-arg" title="Remove">×</button>`;
  row.querySelector('.del-arg').addEventListener('click', () => row.remove());
  list.appendChild(row);
  row.querySelector('input').focus();
}

function buildScheduleForm(p) {
  let html = `<div class="section-title">Schedule</div>`;
  const sci = p.StartCalendarInterval;
  const si = p.StartInterval;

  const checked = (cond) => cond ? 'checked' : '';

  html += `<div class="toggle-row"><div><label>Interval (recurring seconds)</label><div class="desc">Runs every N seconds</div></div>
    <label class="switch"><input type="checkbox" id="useInterval" ${checked(!!si && !sci)}><span class="slider"></span></label></div>
    <div class="field"><label>Every (seconds)</label><input id="intervalSec" type="number" min="1" value="${si || 3600}" ${!si || sci ? 'disabled' : ''} /></div>

    <div class="toggle-row"><div><label>Calendar schedule</label><div class="desc">Specific time(s) e.g. daily 9:30</div></div>
      <label class="switch"><input type="checkbox" id="useCalendar" ${checked(!!sci)}><span class="slider"></span></label></div>`;

  const c = Array.isArray(sci) ? sci[0] : (sci || {});
  const wd = c.Weekday !== undefined ? String(c.Weekday) : '';
  const hr = c.Hour !== undefined ? String(c.Hour) : '';
  const mn = c.Minute !== undefined ? String(c.Minute) : '';
  const dy = c.Day !== undefined ? String(c.Day) : '';
  const mo = c.Month !== undefined ? String(c.Month) : '';

  html += `<div class="field-row-3">
      <div class="field"><label>Weekday</label>
        <select id="cWeekday" ${!sci ? 'disabled' : ''}>
          <option value="">Any</option><option value="0" ${wd === '0' ? 'selected' : ''}>Sun</option><option value="1" ${wd === '1' ? 'selected' : ''}>Mon</option><option value="2" ${wd === '2' ? 'selected' : ''}>Tue</option><option value="3" ${wd === '3' ? 'selected' : ''}>Wed</option><option value="4" ${wd === '4' ? 'selected' : ''}>Thu</option><option value="5" ${wd === '5' ? 'selected' : ''}>Fri</option><option value="6" ${wd === '6' ? 'selected' : ''}>Sat</option>
        </select></div>
      <div class="field"><label>Hour</label><input id="cHour" type="number" min="0" max="23" placeholder="9" value="${hr}" ${!sci ? 'disabled' : ''} /></div>
      <div class="field"><label>Minute</label><input id="cMin" type="number" min="0" max="59" placeholder="30" value="${mn}" ${!sci ? 'disabled' : ''} /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Day of month</label><input id="cDay" type="number" min="1" max="31" placeholder="1-31 (blank=any)" value="${dy}" ${!sci ? 'disabled' : ''} /></div>
      <div class="field"><label>Month</label><input id="cMonth" type="number" min="1" max="12" placeholder="1-12 (blank=any)" value="${mo}" ${!sci ? 'disabled' : ''} /></div>
    </div>`;

  return `<div class="section">${html}</div>`;
}

function buildPlistFromForm(t) {
  const label = $('#fLabel').value.trim();
  const program = $('#fProgram').value.trim();
  const args = $$('#argsList input').map((i) => i.value.trim()).filter(Boolean);
  const cwd = $('#fCwd').value.trim();
  const out = $('#fOut').value.trim();
  const err = $('#fErr').value.trim();
  const runAtLoad = $('#fRunAtLoad').checked;
  const keepAlive = $('#fKeepAlive').checked;

  const useInterval = $('#useInterval').checked;
  const intervalSec = Number($('#intervalSec').value);
  const useCalendar = $('#useCalendar').checked;

  // Build XML plist
  let body = '';
  const add = (s) => { body += s; };

  add(`  <key>Label</key>\n  <string>${escXML(label)}</string>\n`);
  const allArgs = [program, ...args].filter(Boolean);
  if (allArgs.length) {
    add(`  <key>ProgramArguments</key>\n  <array>\n`);
    allArgs.forEach((a) => add(`    <string>${escXML(a)}</string>\n`));
    add(`  </array>\n`);
  }
  if (cwd) add(`  <key>WorkingDirectory</key>\n  <string>${escXML(cwd)}</string>\n`);
  if (out) add(`  <key>StandardOutPath</key>\n  <string>${escXML(out)}</string>\n`);
  if (err) add(`  <key>StandardErrorPath</key>\n  <string>${escXML(err)}</string>\n`);
  if (runAtLoad) add(`  <key>RunAtLoad</key>\n  <true/>\n`);
  if (keepAlive) add(`  <key>KeepAlive</key>\n  <true/>\n`);

  if (useInterval && intervalSec > 0) {
    add(`  <key>StartInterval</key>\n  <integer>${intervalSec}</integer>\n`);
  }
  if (useCalendar) {
    const wd = $('#cWeekday').value;
    const hr = $('#cHour').value.trim();
    const mn = $('#cMin').value.trim();
    const dy = $('#cDay').value.trim();
    const mo = $('#cMonth').value.trim();
    add(`  <key>StartCalendarInterval</key>\n  <dict>\n`);
    if (wd !== '') add(`    <key>Weekday</key>\n    <integer>${wd}</integer>\n`);
    if (hr !== '') add(`    <key>Hour</key>\n    <integer>${hr}</integer>\n`);
    if (mn !== '') add(`    <key>Minute</key>\n    <integer>${mn}</integer>\n`);
    if (dy !== '') add(`    <key>Day</key>\n    <integer>${dy}</integer>\n`);
    if (mo !== '') add(`    <key>Month</key>\n    <integer>${mo}</integer>\n`);
    add(`  </dict>\n`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
}

function escXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function saveLaunchd(t) {
  const rawToggle = document.getElementById('rawToggle');
  let xml;
  if (rawToggle && rawToggle.checked) {
    xml = document.getElementById('rawEditor').value;
  } else {
    xml = buildPlistFromForm(t);
  }
  if (!xml.trim()) return toast('Nothing to save', 'error');
  try {
    await api('/job/' + encodeURIComponent(t.id), { method: 'PUT', body: JSON.stringify({ xml }) });
    toast('Task saved and reloaded', 'success');
    await refresh();
    await openDrawer(t.id);
  } catch (e) {
    toast('Save failed: ' + e.message, 'error', 6000);
  }
}

function confirmDelete(t) {
  showModal({
    title: 'Delete this task?',
    desc: `“${t.label || t.name}” will be removed from ${sourceMeta(t.source).name} and unloaded from launchd. This cannot be undone.`,
    danger: true,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      try {
        await api('/job/' + encodeURIComponent(t.id), { method: 'DELETE' });
        toast('Task deleted', 'success');
        closeDrawer();
        await refresh();
      } catch (e) { toast('Delete failed: ' + e.message, 'error', 6000); }
    },
  });
}

// ---------- Cron drawer ----------
function renderCronDrawer(body, t) {
  body.innerHTML = `
    ${drawerInfoBlocks(t)}
    <div class="section">
      <div class="section-title">Cron Jobs (${(t.jobs || []).length})</div>
      <div class="cron-list" id="cronList"></div>
      <div class="cron-add-row">
        <input id="cMin" title="minute" placeholder="*" value="*" />
        <input id="cHour" title="hour" placeholder="*" value="*" />
        <input id="cDom" title="day of month" placeholder="*" value="*" />
        <input id="cMon" title="month" placeholder="*" value="*" />
        <input id="cDow" title="day of week" placeholder="*" value="*" />
        <input id="cCmd" class="cron-cmd" placeholder="command to run…" />
        <button class="btn btn-primary btn-sm" id="addCronBtn">Add</button>
      </div>
      <div class="hint" style="margin-top:6px">Min · Hour · Day · Month · Weekday · Command</div>
    </div>
    <div class="section">
      <div class="section-title">Raw Crontab</div>
      <textarea id="cronEditor" spellcheck="false">${esc(t.raw || '')}</textarea>
      <div class="drawer-actions-sticky">
        <button class="btn btn-danger" id="delCronAllBtn">Clear All</button>
        <button class="btn btn-primary" id="saveCronBtn">Save Crontab</button>
      </div>
    </div>`;

  // list jobs
  const list = $('#cronList');
  (t.jobs || []).forEach((j) => {
    const el = document.createElement('div');
    el.className = 'cron-item';
    el.innerHTML = `
      <div class="cron-line">${esc([j.minute, j.hour, j.dom, j.mon, j.dow].join(' '))} ${esc(j.command)}</div>
      <div class="cron-meta">Line ${j.lineNo} · <button class="btn btn-sm" data-rm-line="${j.lineNo}" style="color:var(--red);background:var(--red-bg);padding:1px 8px;border:none">remove</button></div>`;
    el.querySelector('[data-rm-line]').addEventListener('click', () => removeCronLine(j.lineNo));
    list.appendChild(el);
  });

  $('#addCronBtn').addEventListener('click', addCronFromForm);
  $('#saveCronBtn').addEventListener('click', () => saveCrontab());
  $('#delCronAllBtn').addEventListener('click', () => {
    showModal({
      title: 'Clear all cron jobs?',
      desc: 'This empties the entire crontab for this source.',
      danger: true, confirmLabel: 'Clear',
      onConfirm: async () => {
        try {
          await api('/job/' + encodeURIComponent(t.id), { method: 'PUT', body: JSON.stringify({ content: '' }) });
          toast('Crontab cleared', 'success'); await refresh(); await openDrawer(t.id);
        } catch (e) { toast(e.message, 'error', 6000); }
      },
    });
  });
}

function addCronFromForm() {
  const g = (id) => document.getElementById(id)?.value.trim();
  const line = [g('cMin') || '*', g('cHour') || '*', g('cDom') || '*', g('cMon') || '*', g('cDow') || '*', g('cCmd')].join(' ');
  if (!g('cCmd')) return toast('Enter a command', 'error');
  const ed = document.getElementById('cronEditor');
  ed.value = (ed.value.trim() ? ed.value.trim() + '\n' : '') + line + '\n';
  document.getElementById('cCmd').value = '';
  saveCrontab();
}

function removeCronLine(lineNo) {
  const t = state.tasks.find((x) => x.id === state.currentId);
  if (!t) return;
  const ed = document.getElementById('cronEditor');
  const lines = ed.value.split('\n').map((l) => ({ l, n: null }));
  // rebuild: remove the job by lineNo among job lines
  let idx = 0;
  const keep = [];
  for (const line of ed.value.split('\n')) {
    const trimmed = line.trim();
    const isJob = trimmed && !trimmed.startsWith('#');
    if (isJob) idx++;
    if (isJob && idx === lineNo) continue;
    keep.push(line);
  }
  ed.value = keep.join('\n');
  saveCrontab();
}

async function saveCrontab() {
  const t = state.tasks.find((x) => x.id === state.currentId);
  if (!t) return;
  const ed = document.getElementById('cronEditor');
  try {
    await api('/job/' + encodeURIComponent(t.id), { method: 'PUT', body: JSON.stringify({ content: ed.value }) });
    toast('Crontab saved', 'success');
    await refresh();
    await openDrawer(t.id);
  } catch (e) { toast('Save failed: ' + e.message, 'error', 6000); }
}

// ---------- Modal ----------
function showModal({ title, desc, danger = false, confirmLabel = 'Confirm', onConfirm, fields = [] }) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal${danger ? ' danger' : ''}">
        <h3>${esc(title)}</h3>
        <p class="modal-desc">${esc(desc)}</p>
        ${fields.map((f) => `<div class="field"><label>${esc(f.label)}</label>${f.type === 'select' ?
          `<select id="m_${f.id}">${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>` :
          `<input id="m_${f.id}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}" />`}</div>`).join('')}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="modalCancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modalOk">${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>`;
  const overlay = root.querySelector('.modal-overlay');
  const close = () => { root.innerHTML = ''; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('#modalCancel').addEventListener('click', close);
  $('#modalOk').addEventListener('click', () => {
    const vals = {};
    fields.forEach((f) => { vals[f.id] = document.getElementById('m_' + f.id)?.value; });
    close();
    onConfirm(vals);
  });
}

// ---------- Create new task ----------
function openCreateModal() {
  const t = state.tasks[0] || null;
  showModal({
    title: 'Create a New Scheduled Task',
    desc: 'Choose where to store the new launchd agent and give it a name. You can configure it after creation.',
    confirmLabel: 'Create',
    fields: [
      {
        id: 'src', label: 'Source',
        type: 'select',
        options: ['User Launch Agents', 'System Launch Agents', 'System Launch Daemons'],
        value: 'User Launch Agents',
      },
      { id: 'label', label: 'Label', placeholder: 'com.example.mytask', value: 'com.local.' + new Date().getTime().toString(36) },
      { id: 'name', label: 'Filename', placeholder: 'com.example.mytask.plist', value: '' },
    ],
    onConfirm: async (vals) => {
      const srcMap = {
        'User Launch Agents': 'user-agents',
        'System Launch Agents': 'system-agents',
        'System Launch Daemons': 'system-daemons',
      };
      const label = vals.label.trim();
      const name = vals.name.trim() || (label.endsWith('.plist') ? label : label + '.plist');
      const srcId = srcMap[vals.src] || 'user-agents';
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${escXML(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/say</string>\n    <string>Hello from Mac Scheduler</string>\n  </array>\n  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>9</integer>\n    <key>Minute</key>\n    <integer>0</integer>\n  </dict>\n</dict>\n</plist>\n`;
      try {
        await api('/tasks', { method: 'POST', body: JSON.stringify({ source: srcId, name, xml }) });
        toast('Task created', 'success');
        await refresh();
        setActiveSource(srcId);
        openDrawer(srcId + '::' + name);
      } catch (e) { toast('Create failed: ' + e.message, 'error', 6000); }
    },
  });
}

// ---------- Drawer close ----------
function closeDrawer() {
  $('#drawer').hidden = true;
  state.currentId = null;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modalRoot').innerHTML) closeDrawer();
  }
});

// ---------- Wire up ----------
$('#refreshBtn').addEventListener('click', refresh);
$('#themeBtn').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('macsched-theme', state.theme);
  document.documentElement.setAttribute('data-theme', state.theme);
});
$('#newTaskBtn').addEventListener('click', openCreateModal);
$('#drawerClose').addEventListener('click', closeDrawer);

$('#searchInput').addEventListener('input', (e) => {
  state.search = e.target.value;
  $('#clearSearch').hidden = !e.target.value;
  render();
});
$('#clearSearch').addEventListener('click', () => {
  state.search = '';
  $('#searchInput').value = '';
  $('#clearSearch').hidden = true;
  render();
});
$$('#filterChips .chip').forEach((c) => {
  c.addEventListener('click', () => {
    state.filter = c.dataset.filter;
    $$('#filterChips .chip').forEach((x) => x.classList.toggle('active', x === c));
    render();
  });
});

// ---------- Init ----------
// ---------- Auto-refresh ----------
let autoRefreshTimer = null;
function setupAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (state.autoRefresh) {
    autoRefreshTimer = setInterval(() => {
      if (!$('#drawer').hidden) return; // avoid clobbering an open editor
      refresh();
    }, 15000);
  }
}

(async function init() {
  $('#brand-sub').textContent = navigator.platform || 'macOS';
  await refresh();
  setupAutoRefresh();
})();

// ---------- Settings (tabbed panel) ----------
async function openSettings() {
  let ka = { enabled: false };
  let info = { version: '—', user: '—', host: '—' };
  let srcs = [];
  try { ka = await api('/keepalive'); } catch {}
  try { info = await api('/'); } catch {}
  try { srcs = (await api('/sources')).sources; } catch {}

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal settings-modal">
      <div class="settings-head">
        <div class="settings-title">
          <div class="settings-icon">⚙</div>
          <div>
            <h3>Settings</h3>
            <p class="modal-desc" style="margin:0">Mac Scheduler for ${esc(info.user)}@${esc(info.host)}</p>
          </div>
        </div>
        <button class="btn btn-ghost icon-btn" id="settingsClose">✕</button>
      </div>

      <div class="settings-tabs">
        <button class="settings-tab active" data-tab="general">General</button>
        <button class="settings-tab" data-tab="access">Access</button>
        <button class="settings-tab" data-tab="about">About</button>
      </div>

      <div class="settings-body">

        <!-- GENERAL -->
        <div class="settings-pane active" data-pane="general">
          <div class="section-title">Background</div>
          <div class="toggle-row">
            <div>
              <label>Run in background</label>
              <div class="desc">Keeps the server alive when the window is closed, so tasks stay visible on next launch</div>
            </div>
            <label class="switch"><input type="checkbox" id="kaToggle" ${ka.enabled ? 'checked' : ''}><span class="slider"></span></label>
          </div>

          <div class="section-title" style="margin-top:18px">Appearance</div>
          <div class="toggle-row">
            <div>
              <label>Dark mode</label>
              <div class="desc">Toggles the color theme</div>
            </div>
            <label class="switch"><input type="checkbox" id="themeToggle" ${state.theme === 'dark' ? 'checked' : ''}><span class="slider"></span></label>
          </div>

          <div class="section-title" style="margin-top:18px">Behavior</div>
          <div class="toggle-row">
            <div>
              <label>Auto-refresh task list</label>
              <div class="desc">Re-fetches tasks every 15 seconds so status changes appear automatically</div>
            </div>
            <label class="switch"><input type="checkbox" id="autoRefreshToggle" ${state.autoRefresh ? 'checked' : ''}><span class="slider"></span></label>
          </div>
        </div>

        <!-- ACCESS -->
        <div class="settings-pane" data-pane="access">
          <div class="section-title">Why access is needed</div>
          <div class="info-item full" style="margin-bottom:12px">
            <div class="val" style="font-weight:400;font-size:12.5px;line-height:1.55">macOS protects scheduled-task files. Your own <b>~/Library/LaunchAgents</b> and crontab are always readable. System folders need <b>Full Disk Access</b> (and editing them needs administrator privileges).</div>
          </div>

          <div class="section-title">Scheduled task sources</div>
          <div class="src-status-list" id="srcStatusList">
            ${srcs.map((s) => `
              <div class="src-status">
                <span class="mini-dot" style="background:${s.needsSudo ? 'var(--amber)' : 'var(--green)'}"></span>
                <span class="src-status-name">${esc(s.name)}</span>
                <span class="src-status-flag">${s.needsSudo ? 'sudo' : 'user'}</span>
                <span class="src-status-desc">${esc(s.desc)}</span>
              </div>`).join('')}
          </div>

          <button class="btn btn-block" id="permBtn">🔓 Open Full Disk Access settings</button>
          <div class="hint" style="margin-top:6px">System Settings → Privacy & Security → Files and Folders → enable <b>Mac Scheduler</b>, then quit and reopen the app.</div>
        </div>

        <!-- ABOUT -->
        <div class="settings-pane" data-pane="about">
          <div class="info-grid">
            <div class="info-item"><label>Version</label><div class="val">v${esc(info.version)}</div></div>
            <div class="info-item"><label>Server</label><div class="val mono">127.0.0.1:8742</div></div>
            <div class="info-item"><label>User</label><div class="val mono">${esc(info.user)}</div></div>
            <div class="info-item"><label>Host</label><div class="val mono">${esc(info.host)}</div></div>
            <div class="info-item full"><label>Data sources</label><div class="val">${srcs.length} launchd + cron locations</div></div>
          </div>
          <div class="hint" style="margin-top:12px">Mac Scheduler runs entirely on this computer — nothing leaves it.</div>
        </div>

      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" id="settingsClose2">Close</button>
      </div>
    </div>`;
  $('#modalRoot').appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  const close = () => modal.remove();
  $('#settingsClose').addEventListener('click', close);
  $('#settingsClose2').addEventListener('click', close);

  // Tabs
  $$('.settings-tab', modal).forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.settings-tab', modal).forEach((t) => t.classList.toggle('active', t === tab));
      $$('.settings-pane', modal).forEach((p) => p.classList.toggle('active', p.dataset.pane === tab.dataset.tab));
    });
  });

  $('#kaToggle').addEventListener('change', async (e) => {
    try {
      await api('/keepalive', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
      toast(e.target.checked ? 'Background mode enabled' : 'Background mode disabled', 'success');
    } catch (err) { toast(err.message, 'error', 6000); e.target.checked = !e.target.checked; }
  });

  $('#themeToggle').addEventListener('change', (e) => {
    state.theme = e.target.checked ? 'dark' : 'light';
    localStorage.setItem('macsched-theme', state.theme);
    document.documentElement.setAttribute('data-theme', state.theme);
  });

  $('#autoRefreshToggle').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    localStorage.setItem('macsched-autorefresh', state.autoRefresh ? '1' : '0');
    setupAutoRefresh();
    toast(state.autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off', 'success');
  });

  $('#permBtn').addEventListener('click', async () => {
    try { await api('/permissions', { method: 'POST' }); toast('Opening System Settings…', 'info'); }
    catch (err) { toast(err.message, 'error', 6000); }
  });
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsBtn2').addEventListener('click', openSettings);

// Sidebar toggle for narrow windows
const sidebarToggleBtn = $('#sidebarToggle');
const sidebar = $('#sidebar');
function syncSidebar() {
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  if (narrow) {
    sidebarToggleBtn.style.display = 'inline-flex';
  } else {
    sidebarToggleBtn.style.display = 'none';
  }
  if (sidebar.style.display !== 'none') sidebar.style.display = 'flex';
}
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
  });
}
window.matchMedia('(max-width: 900px)').addEventListener('change', syncSidebar);
window.addEventListener('resize', syncSidebar);
syncSidebar();
