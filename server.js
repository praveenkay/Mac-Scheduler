#!/usr/bin/env node
/**
 * Mac Scheduler — local-only control center for macOS scheduled tasks.
 * Zero npm dependencies. Reads/writes launchd plists, cron, and daemons.
 *
 * Storage locations covered:
 *   ~/Library/LaunchAgents/                per-user launchd agents
 *   /Library/LaunchAgents/                 system-wide launch agents
 *   /Library/LaunchDaemons/                system launch daemons
 *   crontab  (user + system)               traditional cron scheduler
 *   /etc/periodic/{daily,weekly,monthly}   BSD periodic scripts
 *
 * Run:  node server.js   (or ./server.js)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const PORT = Number(process.env.MAC_SCHEDULER_PORT || 8742);
const HOST = '127.0.0.1';
const ROOT = __dirname;

// ---------------------------------------------------------------------------
// Source configuration
// ---------------------------------------------------------------------------
const SOURCES = [
  {
    id: 'user-agents',
    name: 'User Launch Agents',
    desc: '~/Library/LaunchAgents — run in your login session',
    dir: () => path.join(os.homedir(), 'Library', 'LaunchAgents'),
    editable: true,
    kind: 'launchd',
  },
  {
    id: 'system-agents',
    name: 'System Launch Agents',
    desc: '/Library/LaunchAgents — run in every user login session',
    dir: () => '/Library/LaunchAgents',
    editable: true,
    needsSudo: true,
    kind: 'launchd',
  },
  {
    id: 'system-daemons',
    name: 'System Launch Daemons',
    desc: '/Library/LaunchDaemons — run at boot, as root',
    dir: () => '/Library/LaunchDaemons',
    editable: true,
    needsSudo: true,
    kind: 'launchd',
  },
  {
    id: 'user-cron',
    name: 'User Crontab',
    desc: 'Traditional cron table for the current user',
    editable: true,
    kind: 'cron',
  },
  {
    id: 'system-cron',
    name: 'System Crontab',
    desc: '/etc/crontab — system-wide cron jobs (requires sudo)',
    editable: true,
    needsSudo: true,
    kind: 'cron',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 20000, ...opts }, (err, out) => {
      resolve({ ok: !err, out: out || '', err: err ? String(err.message) : '' });
    });
  });
}

async function readIfFile(p) {
  try { return await fs.promises.readFile(p, 'utf8'); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Plist decode via python3 stdlib (handles all plist types safely)
// ---------------------------------------------------------------------------
const PY_PLIST_DECODE = `
import plistlib, sys, json, datetime
with open(sys.argv[1], 'rb') as f:
    o = plistlib.load(f)
def conv(v):
    if isinstance(v, datetime.datetime): return {"__date__": v.isoformat()}
    if isinstance(v, bytes): return v.decode('utf-8', 'replace')
    if isinstance(v, (list, tuple)): return [conv(i) for i in v]
    if isinstance(v, dict): return {k: conv(i) for k, i in v.items()}
    return v
print(json.dumps(conv(o)))
`;

async function plistDecode(filePath) {
  const raw = await readIfFile(filePath);
  if (raw === null) return { ok: false, err: 'File not readable', raw: null, obj: null };
  const y = await run('/usr/bin/python3', ['-c', PY_PLIST_DECODE, filePath]);
  let obj = null;
  if (y.ok && y.out) {
    try { obj = JSON.parse(y.out); } catch { obj = null; }
  }
  return { ok: y.ok, err: y.err, raw, obj };
}

// ---------------------------------------------------------------------------
// launchctl state map: label -> {pid, status}
// ---------------------------------------------------------------------------
async function launchctlState() {
  const state = {};
  const gui = await run('/bin/launchctl', ['list']);
  if (gui.ok) {
    gui.out.split('\n').slice(1).forEach((l) => {
      const m = l.trim().split(/\s+/);
      if (m.length >= 3) {
        const [pid, status, label] = m;
        state[label] = { pid: pid === '-' ? null : pid, status };
      }
    });
  }
  // system domain (daemons) needs sudo; query via bsd list best-effort
  const sys = await run('/bin/launchctl', ['print', 'system'], { timeout: 5000 });
  if (sys.ok) {
    const re = /\{\s*(\S+)\s*=\s*\{([^}]*)\}\s*\}/g;
    let m;
    while ((m = re.exec(sys.out))) {
      const label = m[1].replace(/"/g, '');
      const body = m[2];
      const pidMatch = body.match(/pid = (\d+)/);
      const stateMatch = body.match(/state = (\w+)/);
      if (label && !state[label]) {
        state[label] = { pid: pidMatch ? pidMatch[1] : null, status: stateMatch ? stateMatch[1] : 'loaded' };
      }
    }
  }
  return state;
}

function domainFor(task) {
  return task.needsSudo ? 'system' : 'gui/' + process.getuid();
}

// ---------------------------------------------------------------------------
// Collect all tasks
// ---------------------------------------------------------------------------
async function collectTasks() {
  const tasks = [];
  const state = await launchctlState();

  for (const src of SOURCES) {
    if (src.kind === 'cron') {
      const cronTask = await collectCron(src, state);
      if (cronTask) tasks.push(cronTask);
      continue;
    }
    const dir = src.dir();
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch { entries = []; }

    for (const name of entries) {
      if (!name.endsWith('.plist')) continue;
      const file = path.join(dir, name);
      const dec = await plistDecode(file);
      const label = (dec.obj && dec.obj.Label) || name.replace(/\.plist$/, '');
      const st = state[label] || null;
      let meta = null;
      try {
        const f = await fs.promises.stat(file);
        meta = { size: f.size, mtime: f.mtime.toISOString(), ctime: f.ctime.toISOString() };
      } catch {}
      tasks.push({
        id: src.id + '::' + name,
        source: src.id,
        name,
        label,
        type: 'launchd',
        loaded: !!(st && st.pid),
        pid: st ? st.pid : null,
        status: st ? st.status : 'unknown',
        file,
        editable: src.editable,
        needsSudo: !!src.needsSudo,
        parsed: dec.obj,
        raw: dec.raw,
        meta,
      });
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Cron collection
// ---------------------------------------------------------------------------
async function collectCron(src) {
  const x = await run('/usr/bin/crontab', ['-l']);
  const content = x.ok ? x.out : (src.id === 'system-cron' ? await readIfFile('/etc/crontab') || '' : '');
  const jobs = parseCrontab(content);
  return {
    id: src.id + '::__file__',
    source: src.id,
    name: src.id === 'system-cron' ? 'System crontab' : 'User crontab',
    label: src.name,
    type: 'cronfile',
    loaded: null,
    pid: null,
    status: null,
    file: src.id === 'system-cron' ? '/etc/crontab' : 'crontab',
    editable: src.editable,
    needsSudo: !!src.needsSudo,
    jobs,
    raw: content,
    meta: null,
  };
}

function parseCrontab(content) {
  const jobs = [];
  content.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/\s+/);
    if (parts.length <= 5) return;
    const re = /^([*0-9-,/A-Za-z]+)$/;
    let i = 0;
    const fields = [];
    while (i < 5 && re.test(parts[i])) { fields.push(parts[i]); i++; }
    if (fields.length < 5) return;
    const command = parts.slice(i).join(' ');
    if (!command) return;
    jobs.push({ lineNo: idx + 1, minute: fields[0], hour: fields[1], dom: fields[2], mon: fields[3], dow: fields[4], command });
  });
  return jobs;
}

function renderCrontab(jobs, existingComments = '') {
  // Preserve original header/comments if provided, then append jobs
  const lines = [];
  if (existingComments) {
    for (const l of existingComments.split('\n')) {
      const t = l.trim();
      if (!t) continue;
      lines.push(l);
    }
  }
  for (const j of jobs) {
    lines.push([j.minute, j.hour, j.dom, j.mon, j.dow, j.command].join(' '));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function jsonError(res, code, msg) {
  sendJson(res, code, { ok: false, error: String(msg) });
}
function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 20e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// --- API routes ---
async function handleApi(route, method, req, res) {
  if (route === '/api' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true, name: 'Mac Scheduler', version: '1.0.0',
      user: os.userInfo().username, host: os.hostname(),
      sourceCount: SOURCES.length,
    });
  }
  if (route === '/api/sources' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      sources: SOURCES.map(({ id, name, desc, editable, needsSudo }) => ({ id, name, desc, editable, needsSudo })),
    });
  }
  if (route === '/api/tasks' && method === 'GET') {
    const tasks = await collectTasks();
    return sendJson(res, 200, { ok: true, tasks });
  }

  // /api/tasks POST  -> create a new launchd plist in a source
  if (route === '/api/tasks' && method === 'POST') {
    const b = await body(req);
    const src = SOURCES.find((s) => s.id === b.source);
    if (!src || src.kind !== 'launchd') return jsonError(res, 400, 'Invalid source for launchd creation');
    const name = (b.name || '').trim();
    const xml = b.xml || b.content || '';
    if (!name.endsWith('.plist')) return jsonError(res, 400, 'Name must end with .plist');
    const dir = src.dir();
    const file = path.join(dir, name);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file, xml, 'utf8');
      return sendJson(res, 200, { ok: true, id: src.id + '::' + name, file });
    } catch (e) { return jsonError(res, 500, e.message); }
  }

  // /api/cron PUT -> replace crontab content
  if (route === '/api/cron' && method === 'PUT') {
    const b = await body(req);
    if (!['user-cron', 'system-cron'].includes(b.source)) return jsonError(res, 400, 'Bad source');
    const tmp = `/tmp/.macsched_cron_${process.getuid()}.txt`;
    try {
      await fs.promises.writeFile(tmp, b.content || '', 'utf8');
      const x = await run('/usr/bin/crontab', [tmp]);
      if (x.ok) return sendJson(res, 200, { ok: true });
      return jsonError(res, 500, x.err);
    } catch (e) { return jsonError(res, 500, e.message); }
  }

  // /api/job/:id  operations
  const jobMatch = route.match(/^\/api\/job\/(.+)$/);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    return handleJob(id, method, req, res);
  }

  // /api/keepalive  — toggle the background keep-alive agent
  if (route === '/api/keepalive' && method === 'GET') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', KEEPALIVE_LABEL + '.plist');
    const on = fs.existsSync(plist);
    return sendJson(res, 200, { ok: true, enabled: on, plist });
  }
  if (route === '/api/keepalive' && method === 'POST') {
    const b = await body(req);
    const enabled = !!b.enabled;
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', KEEPALIVE_LABEL + '.plist');
    try {
      if (!enabled) {
        await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${KEEPALIVE_LABEL}`]);
        if (fs.existsSync(plist)) await fs.promises.unlink(plist);
      } else {
        const node = await findNode();
        const appResources = process.env.MAC_SCHEDULER_NATIVE
          ? path.join(path.dirname(process.execPath || ''), '..', 'Resources')
          : path.join(__dirname);
        const serverFile = path.join(appResources, 'server.js');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${KEEPALIVE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${serverFile}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/tmp/macscheduler-keepalive.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/macscheduler-keepalive.log</string>
</dict>
</plist>
`;
        await fs.promises.mkdir(path.dirname(plist), { recursive: true });
        await fs.promises.writeFile(plist, xml, 'utf8');
        await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${KEEPALIVE_LABEL}`]);
        await run('/bin/launchctl', ['load', plist]);
      }
      return sendJson(res, 200, { ok: true, enabled });
    } catch (e) { return jsonError(res, 500, e.message); }
  }

  // /api/permissions — open System Settings > Full Disk Access for this app
  if (route === '/api/permissions' && method === 'POST') {
    await run('/usr/bin/open', ['-b', 'com.apple.systempreferences',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles']);
    return sendJson(res, 200, { ok: true });
  }

  return jsonError(res, 404, 'Unknown API route');
}

const KEEPALIVE_LABEL = 'com.praveenkay.macscheduler.keepalive';

async function findNode() {
  const candidates = [
    '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
    path.join(os.homedir(), '.local', 'bin', 'node'),
    path.join(os.homedir(), '.hermes', 'node', 'bin', 'node'),
  ];
  for (const c of candidates) {
    try { await fs.promises.access(c, fs.constants.X_OK); return c; } catch {}
  }
  return '/opt/homebrew/bin/node';
}

async function handleJob(id, method, req, res) {
  const all = await collectTasks();
  const task = all.find((t) => t.id === id);
  if (!task) return jsonError(res, 404, 'Job not found');

  if (method === 'GET') {
    return sendJson(res, 200, { ok: true, task });
  }
  if (method === 'PUT') {
    const b = await body(req);
    if (task.type === 'cronfile') {
      const tmp = `/tmp/.macsched_cron_${process.getuid()}.txt`;
      try {
        await fs.promises.writeFile(tmp, b.content || '', 'utf8');
        const x = await run('/usr/bin/crontab', [tmp]);
        if (x.ok) return sendJson(res, 200, { ok: true });
        return jsonError(res, 500, x.err);
      } catch (e) { return jsonError(res, 500, e.message); }
    }
    // launchd
    const xml = b.xml ?? b.content;
    if (!xml) return jsonError(res, 400, 'Missing plist content');
    try {
      await fs.promises.writeFile(task.file, xml, 'utf8');
      const reload = await reloadJob(task);
      return sendJson(res, 200, { ok: true, reload });
    } catch (e) { return jsonError(res, 500, e.message); }
  }
  // best-effort bootout: try domain/label (canonical), then by file path
  async function bootout(task) {
    const domain = domainFor(task);
    await run('/bin/launchctl', ['bootout', `${domain}/${task.label}`]);
    await run('/bin/launchctl', ['bootout', domain, task.file]);
    return true;
  }

  if (method === 'DELETE') {
    try {
      await fs.promises.unlink(task.file);
      await bootout(task);
      return sendJson(res, 200, { ok: true });
    } catch (e) { return jsonError(res, 500, e.message); }
  }
  if (method === 'POST') {
    const b = await body(req);
    const action = b.action;
    if (action === 'load') {
      await bootout(task);
      const x = await run('/bin/launchctl', ['load', task.file]);
      return x.ok ? sendJson(res, 200, { ok: true, detail: x.err }) : jsonError(res, 500, x.err);
    }
    if (action === 'unload') {
      await bootout(task);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'run') {
      // ensure it is loaded first, then kickstart
      await run('/bin/launchctl', ['load', task.file]);
      const x = await run('/bin/launchctl', ['kickstart', '-k', domainFor(task) + '/' + task.label]);
      return x.ok ? sendJson(res, 200, { ok: true }) : jsonError(res, 500, x.err);
    }
    return jsonError(res, 400, 'Unknown action');
  }
  return jsonError(res, 405, 'Method not allowed');
}

async function reloadJob(task) {
  const domain = domainFor(task);
  const out = { bootout: false, loaded: false };
  await run('/bin/launchctl', ['bootout', `${domain}/${task.label}`]);
  await run('/bin/launchctl', ['bootout', domain, task.file]);
  out.bootout = true;
  const ld = await run('/bin/launchctl', ['load', task.file]);
  out.loaded = ld.ok;
  return out;
}

// --- Static ---
function serveStatic(urlPath, res) {
  let p = path.join(ROOT, 'public', urlPath === '/' ? 'index.html' : urlPath);
  if (!p.startsWith(ROOT)) { return jsonError(res, 403, 'forbidden'); }
  fs.readFile(p, (err, data) => {
    if (err) {
      p = path.join(ROOT, 'public', 'index.html');
      return fs.readFile(p, (err2, data2) => {
        if (err2) return jsonError(res, 404, 'Not found');
        sendRaw(res, 200, data2, MIME['.html']);
      });
    }
    sendRaw(res, 200, data, MIME[path.extname(p)] || MIME['.html']);
  });
}

function sendRaw(res, code, data, ctype) {
  res.writeHead(code, { 'Content-Type': ctype });
  res.end(data);
}

// --- Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;
  if (route === '/api' || route.startsWith('/api/')) {
    handleApi(route, req.method, req, res).catch((e) => jsonError(res, 500, String(e)));
    return;
  }
  serveStatic(route, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │            Mac Scheduler                      │');
  console.log(`  │  http://${HOST}:${PORT}                        │`);
  console.log('  │  Press Ctrl-C to stop.                        │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
});
