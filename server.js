'use strict';
// Presenter helper server: serves the pages, relays phone-remote commands (SSE + POST),
// keeps the connection PIN, the list of connected phones and the shared Workspace layout.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const BLOCK_MS = 24 * 3600 * 1000;

function start(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const wantedPort = Number(opts.port || process.env.PORT || 8787);
  fs.mkdirSync(dataDir, { recursive: true });

  // ---- settings (connection PIN) ----
  const cfgFile = path.join(dataDir, 'server-config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch (e) {}
  if (!cfg.pin) { cfg.pin = String(crypto.randomInt(100000, 1000000)); saveCfg(); }
  function saveCfg() { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg)); } catch (e) {} }
  function pinOk(p) {
    const a = Buffer.from(String(p || '')), b = Buffer.from(String(cfg.pin));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---- workspace layouts (shared by every Control window) ----
  const wsFile = path.join(dataDir, 'workspace.json');
  let ws = { rev: 0, current: null, custom: {}, names: [] };
  try { ws = Object.assign(ws, JSON.parse(fs.readFileSync(wsFile, 'utf8'))); } catch (e) {}

  // ---- state ----
  const clients = new Set();          // { res, device, isLocal }
  const devices = new Map();          // id -> { id, name, ip, lastSeen, blocked, blockedAt }
  let lastState = null;
  const fails = new Map();            // ip -> { n, t } failed PIN attempts

  const isLoopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
  const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  function limited(ip) { const f = fails.get(ip); return !!(f && f.n >= 10 && Date.now() - f.t < 60000); }
  function noteFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 60000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }

  function touchDevice(req, id, name) {
    if (!id) return null;
    id = String(id).slice(0, 40);
    let d = devices.get(id);
    if (!d) { d = { id, name: 'Phone', ip: clientIp(req), lastSeen: Date.now(), blocked: false, blockedAt: 0 }; devices.set(id, d); }
    if (name) d.name = String(name).slice(0, 40);
    d.ip = clientIp(req); d.lastSeen = Date.now();
    if (d.blocked && Date.now() - d.blockedAt > BLOCK_MS) d.blocked = false;
    return d;
  }
  const deviceConnected = (id) => { for (const c of clients) if (c.device === id) return true; return false; };

  function broadcast(obj) {
    const line = 'data: ' + JSON.stringify(obj) + '\n\n';
    for (const c of clients) { try { c.res.write(line); } catch (e) {} }
  }
  function dropClients(filter) { for (const c of Array.from(clients)) if (filter(c)) { try { c.res.end(); } catch (e) {} clients.delete(c); } }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
      req.on('error', reject);
    });
  }
  function addresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((k) => (ifs[k] || []).forEach((a) => { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }));
    return out;
  }

  let boundPort = wantedPort;
  function servePage(req, res, file, inject) {
    let html;
    try { html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'); } catch (e) { res.writeHead(404); return res.end('Not found'); }
    if (inject) {
      const tag = '<script>window.__SERVER_PIN__=' + JSON.stringify(cfg.pin) + ';window.__SERVER_INFO__=' +
        JSON.stringify({ addresses: addresses(), port: boundPort }) + ';</script>';
      html = html.replace(/<head[^>]*>/i, (m) => m + tag);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  const server = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    const p = u.pathname, local = isLoopback(req), ip = clientIp(req);
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    // pages: the PIN is only ever written into pages opened ON this computer
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return servePage(req, res, 'presenter.html', local);
    if (req.method === 'GET' && p === '/live') return servePage(req, res, 'presenter.html', local);
    if (req.method === 'GET' && p === '/remote') return servePage(req, res, 'remote.html', false);

    // live updates (Server-Sent Events)
    if (req.method === 'GET' && p === '/events') {
      cors(res);
      if (limited(ip)) { res.writeHead(429); return res.end(); }
      if (!pinOk(u.searchParams.get('pin'))) { noteFail(ip); res.writeHead(401); return res.end(); }
      const devId = u.searchParams.get('device');
      const d = devId ? touchDevice(req, devId, u.searchParams.get('name')) : null;
      if (d && d.blocked) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { res, device: d ? d.id : null, isLocal: local };
      clients.add(c);
      if (lastState) res.write('data: ' + JSON.stringify(lastState) + '\n\n');
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(c); if (d) d.lastSeen = Date.now(); });
      return;
    }

    // commands from phones / state from the Control window
    if (req.method === 'POST' && p === '/api/send') {
      cors(res);
      if (limited(ip)) return json(res, 429, { ok: false });
      let body; try { body = await readBody(req, 2 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false }); }
      if (!pinOk(body.pin)) { noteFail(ip); return json(res, 401, { ok: false, message: 'Wrong PIN' }); }
      if (body.from === 'remote') {
        const d = touchDevice(req, body.device, body.name);
        if (d && d.blocked) return json(res, 403, { ok: false });
      }
      const msg = Object.assign({}, body); delete msg.pin; delete msg.device; delete msg.name;
      if (msg.from === 'control' && msg.type === 'state') lastState = msg;
      if (msg.from === 'control' || msg.from === 'remote') broadcast(msg);
      return json(res, 200, { ok: true });
    }

    // ---- computer-only endpoints ----
    if (p.startsWith('/api/')) {
      if (!local) return json(res, 403, { ok: false, message: 'Only on the computer running Presenter.' });
      if (req.method === 'GET' && p === '/api/devices') {
        const list = Array.from(devices.values()).map((d) => ({ id: d.id, name: d.name, ip: d.ip, lastSeen: d.lastSeen, blocked: d.blocked, connected: deviceConnected(d.id) }));
        return json(res, 200, { ok: true, devices: list });
      }
      if (req.method === 'POST' && (p === '/api/devices/remove' || p === '/api/devices/allow')) {
        const b = await readBody(req, 4096); const d = devices.get(String(b.id || ''));
        if (d) {
          if (p.endsWith('remove')) { d.blocked = true; d.blockedAt = Date.now(); dropClients((c) => c.device === d.id); }
          else d.blocked = false;
        }
        const list = Array.from(devices.values()).map((x) => ({ id: x.id, name: x.name, ip: x.ip, lastSeen: x.lastSeen, blocked: x.blocked, connected: deviceConnected(x.id) }));
        return json(res, 200, { ok: true, devices: list });
      }
      if (req.method === 'GET' && p === '/api/workspace') return json(res, 200, Object.assign({ ok: true }, ws));
      if (req.method === 'POST' && p === '/api/workspace') {
        const b = await readBody(req, 1024 * 1024);
        ws = { rev: ws.rev + 1, current: b.current || null, custom: b.custom || {}, names: Array.isArray(b.names) ? b.names : [] };
        try { fs.writeFileSync(wsFile, JSON.stringify(ws)); } catch (e) {}
        broadcast({ from: 'server', type: 'workspace', rev: ws.rev });
        return json(res, 200, { ok: true, rev: ws.rev });
      }
      // The connection PIN is the only PIN: changing it needs no second password.
      if (req.method === 'POST' && p === '/api/set-password') {
        const b = await readBody(req, 4096); const np = String(b.password || '');
        if (np.length < 4 || np.length > 64) return json(res, 400, { ok: false, message: 'The PIN must be 4–64 characters.' });
        cfg.pin = np; saveCfg();
        dropClients((c) => !c.isLocal);              // sign every phone out
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false });
    }

    res.writeHead(404); res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries++ < 10) { boundPort++; server.listen(boundPort, '0.0.0.0'); } else reject(e);
    });
    server.listen(boundPort, '0.0.0.0', () => resolve({ port: boundPort, server, getPin: () => cfg.pin }));
  });
}

module.exports = { start };

if (require.main === module) {
  start({}).then((s) => {
    console.log('Presenter server running:  http://localhost:' + s.port + '/   (connection PIN: ' + s.getPin() + ')');
  }).catch((e) => { console.error(e); process.exit(1); });
}
