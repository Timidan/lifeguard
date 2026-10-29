#!/usr/bin/env node
// Lifeguard web server: serves web/dist, reads the loan live, and lets a visitor fire the red-team attacks with
// the agent's real key. The key stays in agent/.keys; the browser only ever gets results.
//
//   node server.js            PORT (default 8740)
const http = require('http'), fs = require('fs'), path = require('path');
const L = require('./lib');

const DIST = path.join(__dirname, '..', 'web', 'dist');
const PORT = Number(process.env.PORT || 8740);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

// One attack costs the agent key about 0.00015 NEAR of its 1 NEAR allowance (measured 30 Oct 2026).
// ponytail: in-memory limits for one process; they reset on restart.
const PER_IP_PER_MIN = 20, PER_HOUR = 400;
const byIp = new Map(); // ip -> timestamps in the last minute
let hour = 0, inHour = 0;
function limited(ip) {
  const now = Date.now();
  if (now - hour > 3600_000) { hour = now; inHour = 0; }
  const recent = (byIp.get(ip) || []).filter((t) => now - t < 60_000);
  if (inHour >= PER_HOUR || recent.length >= PER_IP_PER_MIN) return true;
  byIp.set(ip, [...recent, now]);
  inHour++;
  return false;
}

// Attacks share one access key, so they run one at a time to keep its nonce in order.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function runAttack(i) {
  const list = L.attacks(L.state(), await L.fees());
  const attack = list[i];
  const r = await attack.run(await L.agentAccount());
  const layer = r.error ? L.refusedBy(r.error) : null;
  return {
    i, name: attack.name, refused: !!r.error, layer,
    error: r.error ? r.error.replace(/\s+/g, ' ').trim() : null,
    tx: layer === 'Lifeguard contract' ? r.txHash : null, // access-key refusals never reach the chain
    value: r.error ? null : r.value,
    at: new Date().toISOString(),
  };
}

let cached = { at: 0, body: null };
async function position() {
  if (Date.now() - cached.at < 8000) return cached.body;
  const s = L.state();
  const provider = (await L.ownerAccount()).connection.provider;
  const [p, config, key] = await Promise.all([
    L.view('get_position', { id: s.position }),
    L.view('get_config'),
    provider.query({ request_type: 'view_access_key', finality: 'final', account_id: s.owner, public_key: s.agentPublicKey }),
  ]);
  const loan = await L.account(p.address);
  const body = {
    contract: s.contract, owner: s.owner, position: s.position, address: p.address, agentPublicKey: s.agentPublicKey,
    nonce: p.nonce, pending: p.pending.map((x) => x.tx_hash), history: p.history, config,
    key: key.permission.FunctionCall || 'FullAccess',
    loan: { ...loan, healthFactor: Number.isFinite(loan.healthFactor) ? loan.healthFactor : null },
    attacks: L.attacks(s, {}).map(({ name, detail }) => ({ name, detail })),
    readAt: new Date().toISOString(),
  };
  cached = { at: Date.now(), body };
  return body;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function serveStatic(req, res) {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(DIST, url));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'web/dist is missing: run npm run build in web/', 'text/plain');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/position') return send(res, 200, await position());
    const m = req.url.match(/^\/api\/attack\/(\d)$/);
    if (m && req.method === 'POST') {
      const i = Number(m[1]);
      if (i >= L.attacks(L.state(), {}).length) return send(res, 404, { error: 'No such attack' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (limited(ip)) return send(res, 429, { error: 'Too many attacks at once. Wait a few seconds and try again.' });
      return send(res, 200, await serial(() => runAttack(i)));
    }
    if (req.url.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    serveStatic(req, res);
  } catch (e) {
    send(res, 502, { error: `Testnet RPC error: ${e.message}` });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Lifeguard on http://127.0.0.1:${PORT}`));
