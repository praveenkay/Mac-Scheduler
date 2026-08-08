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
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const PORT = Number(process.env.MAC_SCHEDULER_PORT || 8742);
const HOST = '127.0.0.1';
const ROOT = __dirname;

const APP_VERSION = '0.4.0';
const GITHUB_REPO = 'praveenkay/Mac-Scheduler';
const GITHUB_RELEASES_URL = 'https://github.com/' + GITHUB_REPO + '/releases';
const GITHUB_LATEST_API = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';

// ---------------------------------------------------------------------------
// App data dirs (created on first run / install)
// ---------------------------------------------------------------------------
const APP_CONFIG_DIR = path.join(os.homedir(), '.config', 'macscheduler');
const APP_SOURCES_FILE = path.join(APP_CONFIG_DIR, 'sources.json');
const APP_SETTINGS_FILE = path.join(APP_CONFIG_DIR, 'settings.json');
const APPLYOPPS_CONFIG = path.join(os.homedir(), '.applyopps', 'config.json');
const APPLYOPPS_PORT = 5290;
const KEEPALIVE_LABEL = 'com.praveenkay.macscheduler.keepalive';

function ensureAppDirs() {
  try { fs.mkdirSync(APP_CONFIG_DIR, { recursive: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Source configuration
// ---------------------------------------------------------------------------
const BUILTIN_SOURCES = [
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

// Custom sources are persisted to ~/.config/macscheduler/sources.json so users
// can add their own scheduled-task locations.
function loadCustomSources() {
  ensureAppDirs();
  try {
    return JSON.parse(fs.readFileSync(APP_SOURCES_FILE, 'utf8')) || [];
  } catch { return []; }
}
function saveCustomSources(list) {
  ensureAppDirs();
  fs.mkdirSync(path.dirname(APP_SOURCES_FILE), { recursive: true });
  fs.writeFileSync(APP_SOURCES_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function buildSOURCES() {
  const custom = loadCustomSources().map((s) => ({
    id: s.id,
    name: s.name,
    desc: s.desc || '',
    dir: () => s.dir || s.path || '',
    editable: true,
    needsSudo: !!s.needsSudo,
    kind: s.kind || 'launchd',
    custom: true,
  }));
  return [...BUILTIN_SOURCES, ...custom];
}
let SOURCES = buildSOURCES();
function refreshSources() { SOURCES = buildSOURCES(); }

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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Minimal HTTP JSON client (works for both http and https URLs).
function postJSON(url, payload, { apiKey, model, timeout = 60000, system, user } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Bad URL: ' + url)); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? require('https') : require('http');
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const data = JSON.stringify({ model: model || 'auto', messages, max_tokens: 2000 });
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    if (apiKey) reqOpts.headers.Authorization = 'Bearer ' + apiKey;
    const req = mod.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (text) return resolve({ text: String(text).trim() });
          reject(new Error('AI empty response from ' + url + ' — ' + (j && j.error ? JSON.stringify(j.error) : body.slice(0, 200))));
        } catch { reject(new Error('Invalid AI response from ' + url + ': ' + body.slice(0, 200))); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('AI request timed out')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Load ApplyOpps config (our source of truth for AI providers). Returns null if absent.
function loadApplyOppsConfig() {
  try { return JSON.parse(fs.readFileSync(APPLYOPPS_CONFIG, 'utf8')); }
  catch { return null; }
}
function sanitizeProviders(cfg) {
  if (!cfg) return { active_provider: null, providers: {} };
  const out = {};
  for (const [k, v] of Object.entries(cfg.providers || {})) {
    out[k] = {
      enabled: !!v.enabled,
      free: !!v.free,
      base_url: v.base_url || '',
      models: v.models || [],
      default_model: v.default_model || '',
      notes: v.notes || '',
      has_key: !!(v.api_key || k === 'ollama' || k === 'zen'),
      api_key_masked: v.api_key ? String(v.api_key).slice(0, 6) + '…' + String(v.api_key).slice(-4) : '',
    };
  }
  return { active_provider: cfg.active_provider, providers: out };
}

// Find the active provider config (only used server-side; keys never leave).
function activeProvider(cfg) {
  if (!cfg) return null;
  const name = cfg.active_provider || Object.keys(cfg.providers || {}).find((k) => cfg.providers[k].enabled);
  const p = cfg.providers && cfg.providers[name];
  return p && p.enabled ? { name, ...p } : null;
}

// Send a prompt: prefer the ApplyOpps local router so users get the same
// provider/model they configured there; else route by that same config directly.
async function aiChat(user, system) {
  const cfg = loadApplyOppsConfig();
  // 1) Try the ApplyOpps router on its port (it already handles failover).
  if (await loadUp(APPLYOPPS_PORT, '/v1/health')) {
    try {
      return await postJSON('http://127.0.0.1:' + APPLYOPPS_PORT + '/v1/chat/completions', {}, { model: 'auto', user, system, timeout: 90000 });
    } catch (e) { /* fall through to direct */ }
  }
  // 2) Direct call to the configured active provider, trying its models in order.
  const p = activeProvider(cfg);
  if (!p) throw new Error('No AI provider enabled. Configure one in Settings → AI.');
  const base = (p.base_url || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const models = (p.models && p.models.length ? p.models : [p.default_model].filter(Boolean));
  const ordered = [p.default_model, ...models].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (const m of ordered) {
    try {
      return await postJSON(url, {}, { apiKey: p.api_key, model: m, user, system, timeout: 90000 });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No usable model for provider ' + p.name);
}

function loadUp(port, path) {
  return new Promise((resolve) => {
    const mod = require('http');
    const req = mod.get('http://127.0.0.1:' + port + (path || '/'), (res) => {
      res.resume(); resolve(true); req.destroy();
    });
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
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

function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

function getJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'Accept': 'application/vnd.github+json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad response from ' + url)); }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(8000, () => { req.destroy(new Error('Request timed out')); });
  });
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
      ok: true, name: 'Mac Scheduler', version: APP_VERSION,
      user: os.userInfo().username, host: os.hostname(),
      sourceCount: SOURCES.length,
      updateUrl: GITHUB_RELEASES_URL,
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

  // /api/settings — read/write app settings (stored in ~/.config/macscheduler/settings.json)
  if (route === '/api/settings' && method === 'GET') {
    ensureAppDirs();
    let s = {};
    try { s = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')) || {}; } catch {}
    return sendJson(res, 200, { ok: true, settings: s });
  }
  if (route === '/api/settings' && method === 'POST') {
    const b = await body(req);
    ensureAppDirs();
    const cur = (() => { try { return JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')) || {}; } catch { return {}; } })();
    Object.assign(cur, b.settings || {});
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(cur, null, 2), 'utf8');
    return sendJson(res, 200, { ok: true, settings: cur });
  }

  // /api/ai — ApplyOpps-powered AI provider config (read + write)
  if (route === '/api/ai' && method === 'GET') {
    const cfg = loadApplyOppsConfig();
    const applyOppsUp = await loadUp(APPLYOPPS_PORT, '/v1/health');
    return sendJson(res, 200, {
      ok: true,
      applyopps: { path: APPLYOPPS_CONFIG, running: applyOppsUp },
      ...sanitizeProviders(cfg),
    });
  }
  if (route === '/api/ai' && method === 'POST') {
    const b = await body(req);
    const cfg = loadApplyOppsConfig();
    if (!cfg) return jsonError(res, 404, 'ApplyOpps config not found at ' + APPLYOPPS_CONFIG);
    const update = b.update || {};
    if (update.active_provider && cfg.providers[update.active_provider]) {
      cfg.active_provider = update.active_provider;
    }
    if (update.providers) {
      for (const [k, patch] of Object.entries(update.providers)) {
        if (!cfg.providers[k]) continue;
        if (typeof patch.enabled === 'boolean') cfg.providers[k].enabled = patch.enabled;
        if (typeof patch.default_model === 'string') cfg.providers[k].default_model = patch.default_model;
        if (typeof patch.api_key === 'string' && patch.api_key !== '') cfg.providers[k].api_key = patch.api_key;
      }
    }
    try {
      fs.writeFileSync(APPLYOPPS_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, ...sanitizeProviders(cfg) });
    } catch (e) { return jsonError(res, 500, e.message); }
  }

  // /api/ai/generate — plain-English → launchd plist (uses ApplyOpps router or its config)
  if (route === '/api/ai/generate' && method === 'POST') {
    const b = await body(req);
    const prompt = (b.prompt || '').trim();
    if (!prompt) return jsonError(res, 400, 'Describe the task you want to schedule');
    const system = `You are a macOS scheduling expert. Convert the user's plain-English request into a single valid launchd plist.
Return ONLY a JSON object with these keys:
- "label": a reverse-dns label like "com.praveenkay.example"
- "filename": the label + ".plist"
- "description": one short sentence (plain text, no quotes needed) describing what the task does
- "xml": the full plist XML (with <?xml ...?> declaration, <plist version="1.0">, <dict>...</dict>)

Rules:
- Always use ProgramArguments (never Program).
- If a schedule/time is described use StartCalendarInterval or StartInterval.
- If "always running"/"daemon"/"keep alive" is described set KeepAlive true.
- Use /bin/bash or the exact path the user names for commands.
- Keep it minimal and valid. No markdown fences.`;
    try {
      const { text } = await aiChat(prompt, system);
      let obj = null;
      try { obj = JSON.parse(text.replace(/```(json)?|```/g, '').trim()); } catch { obj = null; }
      if (!obj || !obj.xml) return jsonError(res, 502, 'AI did not return a valid task. Try a more specific description.');
      return sendJson(res, 200, { ok: true, label: obj.label, filename: obj.filename, description: obj.description, xml: obj.xml });
    } catch (e) { return jsonError(res, 502, e.message); }
  }

  // /api/sources POST/PUT/DELETE — add/edit/remove custom sources
  if (route === '/api/sources' && method === 'POST') {
    const b = await body(req);
    const name = (b.name || '').trim();
    const dir = (b.dir || '').trim();
    if (!name || !dir) return jsonError(res, 400, 'Name and folder path are required');
    const list = loadCustomSources();
    const id = (b.id || 'custom-' + Date.now().toString(36)).trim();
    list.push({ id, name, dir, kind: b.kind === 'cron' ? 'cron' : 'launchd', needsSudo: !!b.needsSudo, desc: b.desc || '' });
    saveCustomSources(list);
    refreshSources();
    return sendJson(res, 200, { ok: true, id });
  }
  if (route === '/api/sources' && method === 'PUT') {
    const b = await body(req);
    const list = loadCustomSources();
    const item = list.find((s) => s.id === b.id);
    if (!item) return jsonError(res, 404, 'Source not found');
    if (b.name !== undefined) item.name = String(b.name).trim();
    if (b.dir !== undefined) item.dir = String(b.dir).trim();
    if (b.desc !== undefined) item.desc = String(b.desc).trim();
    if (b.needsSudo !== undefined) item.needsSudo = !!b.needsSudo;
    saveCustomSources(list);
    refreshSources();
    return sendJson(res, 200, { ok: true });
  }
  if (route === '/api/sources' && method === 'DELETE') {
    const b = await body(req);
    const list = loadCustomSources().filter((s) => s.id !== b.id);
    saveCustomSources(list);
    refreshSources();
    return sendJson(res, 200, { ok: true });
  }

  // /api/export — bundle all tasks (plists + crontabs) into one portable JSON file
  if (route === '/api/export' && method === 'GET') {
    const tasks = await collectTasks();
    const bundle = {
      app: 'Mac Scheduler',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      tasks: tasks.map((t) => ({
        source: t.source,
        name: t.name,
        label: t.label,
        type: t.type,
        file: t.file,
        raw: t.raw || '',
      })),
    };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="mac-scheduler-tasks.json"',
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }

  // /api/import — restore tasks from an export file (creates files, loads them)
  if (route === '/api/import' && method === 'POST') {
    const b = await body(req);
    const tasks = Array.isArray(b.tasks) ? b.tasks : [];
    if (!tasks.length) return jsonError(res, 400, 'No tasks in import file');
    const results = [];
    for (const t of tasks) {
      const src = SOURCES.find((s) => s.id === t.source);
      if (!src) { results.push({ name: t.name, ok: false, err: 'Unknown source ' + t.source }); continue; }
      try {
        if (t.type === 'cronfile') {
          if (t.source === 'user-cron') {
            const tmp = `/tmp/.macsched_cron_${process.getuid()}.txt`;
            const existing = await readIfFile(tmp);
            const content = t.raw || '';
            fs.writeFileSync(tmp, content, 'utf8');
            const x = await run('/usr/bin/crontab', [tmp]);
            results.push({ name: t.name, ok: x.ok, err: x.ok ? '' : x.err });
          } else {
            results.push({ name: t.name, ok: false, err: 'System crontab import requires sudo (not automated)' });
          }
          continue;
        }
        const dir = src.dir();
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, t.name);
        fs.writeFileSync(file, t.raw, 'utf8');
        await run('/bin/launchctl', ['load', file]);
        results.push({ name: t.name, ok: true });
      } catch (e) { results.push({ name: t.name, ok: false, err: e.message }); }
    }
    return sendJson(res, 200, { ok: true, results });
  }

  // /api/uninstall — delete the app + created files/folders, but keep user tasks
  if (route === '/api/uninstall' && method === 'POST') {
    const b = await body(req);
    const full = !!b.full;
    // Never delete scheduled tasks themselves — only app artifacts.
    const targets = [
      APP_CONFIG_DIR,
      path.join(os.homedir(), 'Library', 'LaunchAgents', KEEPALIVE_LABEL + '.plist'),
      '/tmp/macsched.log',
      '/tmp/macscheduler-keepalive.log',
    ];
    await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${KEEPALIVE_LABEL}`]);
    for (const t of targets) {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
    // Remove the .app bundle if a path is given (e.g. /Applications/Mac Scheduler.app).
    if (full && b.appPath) {
      try { fs.rmSync(b.appPath, { recursive: true, force: true }); } catch {}
    }
    return sendJson(res, 200, { ok: true, message: 'Mac Scheduler data removed. Your scheduled tasks were left untouched.' });
  }

  // --- Update check: query the GitHub latest release and compare versions ---
  if (route === '/api/update' && method === 'GET') {
    try {
      const release = await getJSON(GITHUB_LATEST_API, { 'User-Agent': 'Mac-Scheduler/' + APP_VERSION });
      const latest = String(release.tag_name || '').replace(/^v/, '');
      const current = APP_VERSION.replace(/^v/, '');
      const hasUpdate = latest && semverGt(latest, current);
      return sendJson(res, 200, {
        ok: true,
        current: APP_VERSION,
        latest: latest || null,
        hasUpdate: !!hasUpdate,
        releaseUrl: release.html_url || GITHUB_RELEASES_URL,
        releaseName: release.name || null,
        publishedAt: release.published_at || null,
        updateUrl: GITHUB_RELEASES_URL,
      });
    } catch (e) {
      // No published release yet (404) or network failure → nothing newer known.
      return sendJson(res, 200, { ok: true, current: APP_VERSION, latest: null, hasUpdate: false, releaseUrl: GITHUB_RELEASES_URL, updateUrl: GITHUB_RELEASES_URL, note: e.message });
    }
  }

  // --- Open a URL in the default browser (used to jump to the release page) ---
  if (route === '/api/open' && method === 'POST') {
    const b = await body(req);
    const url = String(b.url || '');
    if (!/^https?:\/\//.test(url)) return jsonError(res, 400, 'Invalid URL');
    try {
      await run('/usr/bin/open', [url]);
      return sendJson(res, 200, { ok: true });
    } catch (e) { return jsonError(res, 500, e.message); }
  }

  return jsonError(res, 404, 'Unknown API route');
}

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
