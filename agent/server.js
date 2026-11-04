#!/usr/bin/env node
// Lifeguard web server: serves web/dist, reads loans live, relays the setup steps owners sign in their wallets,
// and lets a visitor fire the red-team attacks with the agent's real key. The key stays in agent/.keys; the browser only ever gets results.
//
//   node server.js            PORT (default 8740), HOST (default 127.0.0.1)
const http = require('http'), fs = require('fs'), path = require('path');
const L = require('./lib');
const { ethers } = require('ethers');

const S = L.state(); // the demo deployment: its contract hosts every position, and its owner relays Read MPC confirmations
const TGAS = 1_000_000_000_000n;
const iface = new ethers.Interface(['function mint(address,address,uint256)', 'function borrow(address,uint256,uint256,uint16,address)']);

const DIST = path.join(__dirname, '..', 'web', 'dist');
const PORT = Number(process.env.PORT || 8740);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

// One attack costs the agent key about 0.00015 NEAR of its 1 NEAR allowance (measured).
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

// Every attack any visitor sends, so the page can show live totals. Kept on disk across restarts.
const FEED_FILE = path.join(__dirname, 'data', 'feed.json');
let feed = fs.existsSync(FEED_FILE) ? JSON.parse(fs.readFileSync(FEED_FILE)) : { sent: 0, refused: 0, recent: [] };
function record(r) {
  feed.sent++;
  if (r.refused) feed.refused++;
  feed.recent = [{ name: r.name, refused: r.refused, layer: r.layer, tx: r.tx, at: r.at }, ...feed.recent].slice(0, 20);
  fs.mkdirSync(path.dirname(FEED_FILE), { recursive: true });
  fs.writeFileSync(FEED_FILE, JSON.stringify(feed));
}

// Attacks share one access key, so they run one at a time to keep its nonce in order.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function runAttack(i) {
  const list = L.attacks(L.state(), await L.fees());
  const attack = list[i];
  const r = await attack.run(await L.agentAccount());
  const layer = r.error ? L.refusedBy(r.error) : null;
  const result = {
    i, name: attack.name, refused: !!r.error, layer,
    error: r.error ? r.error.replace(/\s+/g, ' ').trim() : null,
    tx: layer === 'Lifeguard contract' ? r.txHash : null, // access-key refusals never reach the chain
    value: r.error ? null : r.value,
    at: new Date().toISOString(),
  };
  record(result);
  return result;
}

const cache = new Map();
async function position(id = S.position) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 8000) return { ...hit.body, relay: relays.get(id) || null, setup: setups.get(id) || null };
  const p = await L.view('get_position', { id });
  if (!p) return null;
  const provider = (await L.ownerAccount()).connection.provider;
  const [config, keys, loan] = await Promise.all([
    L.view('get_config'),
    provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: p.owner }),
    p.address ? L.account(p.address) : null,
  ]);
  // Function-call keys the owner has given agents for this contract.
  const agents = keys.keys.filter((k) => k.access_key.permission.FunctionCall?.receiver_id === S.contract).map((k) => ({
    publicKey: k.public_key, methods: k.access_key.permission.FunctionCall.method_names,
    allowance: k.access_key.permission.FunctionCall.allowance, keeper: k.public_key === S.agentPublicKey,
  }));
  const keeper = keys.keys.find((k) => k.public_key === S.agentPublicKey);
  const body = {
    contract: S.contract, owner: p.owner, position: id, address: p.address, agentPublicKey: S.agentPublicKey,
    nonce: p.nonce, pending: p.pending.map((x) => x.tx_hash), history: p.history, config, agents,
    key: keeper?.access_key.permission.FunctionCall || 'FullAccess',
    loan: loan && { ...loan, healthFactor: Number.isFinite(loan.healthFactor) ? loan.healthFactor : null },
    attacks: L.attacks(S, {}).map(({ name, short, detail }) => ({ name, short, detail })),
    feed,
    readAt: new Date().toISOString(),
  };
  cache.set(id, { at: Date.now(), body });
  return { ...body, relay: relays.get(id) || null, setup: setups.get(id) || null };
}

// Owners never change, so the list of positions only grows: each call reads only the ids past the last one known.
const owners = [];
async function positionsOf(owner) {
  for (let id = owners.length; ; id++) { const p = await L.view('get_position', { id }); if (!p) break; owners[id] = p.owner; } // by index: overlapping calls write the same values
  const provider = (await L.ownerAccount()).connection.provider;
  const keeperKey = await provider.query({ request_type: 'view_access_key', finality: 'final', account_id: owner, public_key: S.agentPublicKey }).then(() => true, () => false);
  return { positions: owners.flatMap((o, id) => (o === owner ? [id] : [])), keeperKey, keeperPublicKey: S.agentPublicKey, contract: S.contract };
}

/** The NEAR transaction an owner signs in their wallet for each setup step. */
async function step(id, name, query) {
  if (name === 'open') return { receiverId: S.contract, method: 'create_position', args: {}, gas: String(100n * TGAS), deposit: String(5n * 10n ** 22n) };
  const p = await L.view('get_position', { id });
  if (!p?.address) throw Object.assign(new Error('No such position'), { status: 404 });
  const usdc = Math.round(Number(query.get('usdc') || 1000));
  if (!(usdc >= 1 && usdc <= 100000)) throw Object.assign(new Error('usdc must be 1 to 100,000'), { status: 400 });
  const owner = async (to, data, gas) => ['owner_action', { id, to, value: '0', data, fees: await L.fees(gas) }];
  const agent = async (kind, asset, amount, gas) => ['request_action', { id, action: { [kind]: { asset, amount: String(amount) } }, fees: await L.fees(gas) }];
  const steps = {
    mint: () => owner(L.BASE.faucet, iface.encodeFunctionData('mint', [L.BASE.cbeth, p.address, 10n ** 18n]), 200000),
    approveCollateral: () => agent('Approve', L.BASE.cbeth, 10n ** 18n, 100000),
    supply: () => agent('Supply', L.BASE.cbeth, 10n ** 18n, 400000),
    borrow: () => owner(L.BASE.pool, iface.encodeFunctionData('borrow', [L.BASE.usdc, BigInt(usdc) * 10n ** 6n, 2, 0, p.address]), 500000),
    approveRepay: () => agent('Approve', L.BASE.usdc, 10000n * 10n ** 6n, 100000),
    // Borrows just enough to take the health factor to 1.2, under the agent's 1.25 trigger, so an owner can watch a rescue.
    risk: async () => {
      const a = await L.account(p.address);
      const more = Math.floor(a.debtUsd * (a.healthFactor / 1.2 - 1));
      if (!(more >= 1) || more > a.availableBorrowsUsd) throw Object.assign(new Error('This loan is already at or below 1.2'), { status: 409 });
      return owner(L.BASE.pool, iface.encodeFunctionData('borrow', [L.BASE.usdc, BigInt(more) * 10n ** 6n, 2, 0, p.address]), 500000);
    },
  };
  if (!steps[name]) throw Object.assign(new Error('No such step'), { status: 404 });
  const [method, args] = await steps[name]();
  return { receiverId: S.contract, method, args, gas: String(300n * TGAS), deposit: '0' };
}

// After the owner signs, anyone may broadcast the Base transaction and ask Read MPC to confirm it. The server does both.
// ponytail: jobs live in memory; a restart drops them, and the page simply asks again.
const relays = new Map();
let confirms = Promise.resolve(); // confirmations go one at a time
function relay(id) {
  const running = relays.get(id);
  if (running && !['done', 'reverted', 'failed'].includes(running.state)) return running;
  const job = { state: 'starting', tx: null, error: null };
  relays.set(id, job);
  const done = (async () => {
    const pos = await L.view('get_position', { id }), t = pos.pending[0];
    if (!t) return (job.state = 'done');
    Object.assign(job, { state: 'mining', tx: t.tx_hash });
    await L.base.broadcastTransaction(t.raw).catch(() => {}); // already sent or mined is fine
    const receipt = await L.base.waitForTransaction(t.tx_hash, 1, 240000);
    if (receipt.status !== 1) return (job.state = 'reverted');
    job.state = 'safe';
    for (;;) { const safe = await L.base.getBlock('safe'); if (safe && safe.number >= receipt.blockNumber) break; await L.sleep(4000); }
    job.state = 'confirming';
    await L.sleep(30000); // Read MPC's view of `safe` lags the public RPC
    for (let i = 0; i < 5; i++) {
      // Lifeguard's key on the owner's account may call confirm, so the server never holds a full-access key.
      const confirm = () => L.agentAccount(pos.owner).then((a) => L.call(a, S.contract, 'confirm', { id, tx_hash: t.tx_hash }));
      const r = await (confirms = confirms.then(confirm, confirm));
      const still = (await L.view('get_position', { id })).pending.some((x) => x.tx_hash === t.tx_hash);
      if (r.value === true || !still) { cache.delete(id); return Object.assign(job, { state: 'done', nearProof: r.txHash }); }
      await L.sleep(20000);
    }
    throw new Error('Read MPC has not verified it yet');
  })().catch((e) => Object.assign(job, { state: 'failed', error: e.message })).then(() => job);
  return Object.defineProperty(job, 'done', { value: done }); // awaitable, and left out of the JSON
}

// A new loan address has no ETH for Base gas. Each position gets a little once, from a testnet-only wallet.
const DRIP_FILE = path.join(__dirname, '.keys', 'base-drip');
if (!fs.existsSync(DRIP_FILE)) fs.writeFileSync(DRIP_FILE, ethers.Wallet.createRandom().privateKey, { mode: 0o600 });
const drip = new ethers.Wallet(fs.readFileSync(DRIP_FILE, 'utf8').trim(), L.base);
const GAS_FILE = path.join(__dirname, 'data', 'gas.json');
let drips = Promise.resolve();
async function gas(id) {
  const p = await L.view('get_position', { id });
  if (!p?.address) throw Object.assign(new Error('No such position'), { status: 404 });
  if ((await L.base.getBalance(p.address)) >= ethers.parseEther('0.0001')) return { tx: null };
  const given = fs.existsSync(GAS_FILE) ? JSON.parse(fs.readFileSync(GAS_FILE)) : [];
  if (given.includes(id)) throw Object.assign(new Error('This loan already got gas once.'), { status: 409 });
  const send = async () => (await drip.sendTransaction({ to: p.address, value: ethers.parseEther('0.0003') })).wait();
  const receipt = await (drips = drips.then(send, send));
  fs.mkdirSync(path.dirname(GAS_FILE), { recursive: true });
  fs.writeFileSync(GAS_FILE, JSON.stringify([...given, id]));
  cache.delete(id);
  return { tx: receipt.hash };
}

// Aave's test faucet mints to anyone, so test collateral needs no signature from the owner.
const faucet = new ethers.Contract(L.BASE.faucet, ['function mint(address,address,uint256) returns (uint256)'], drip);
const mintTest = (to) => { const send = async () => (await faucet.mint(L.BASE.cbeth, to, 10n ** 18n)).wait(); return (drips = drips.then(send, send)); };

// Every setup step that isn't the owner's: Base gas and test cbETH from the testnet wallet, then the collateral through
// Lifeguard's agent key, which may only supply, repay and approve. Borrowing stays the owner's. Each call works out the
// next step from the chain, so it is safe to call again at any time; it stops when the owner has to borrow.
const setups = new Map();
function setup(id) {
  const running = setups.get(id);
  if (running?.state === 'working') return running;
  const job = { state: 'working', step: null, error: null };
  setups.set(id, job);
  (async () => {
    for (let i = 0; i < 12; i++) {
      const p = await L.view('get_position', { id });
      if (!p?.address) throw new Error('This position has no Base address yet.');
      if (p.pending.length) {
        job.step = 'confirm';
        const r = await relay(id).done;
        if (r.state !== 'done') throw new Error(r.error || `The Base transaction ${r.state}.`);
        continue;
      }
      const a = await L.account(p.address);
      const agent = (step, kind, asset, amount, gasLimit) => async () => {
        job.step = step;
        const r = await L.call(await L.agentAccount(p.owner), S.contract, 'request_action', { id, action: { [kind]: { asset, amount: String(amount) } }, fees: await L.fees(gasLimit) });
        if (r.error) throw new Error(/KeyNotFound/.test(r.error) ? "Lifeguard's agent has no key for this account yet." : r.error);
      };
      const next = a.eth < 0.0001 ? async () => { job.step = 'gas'; await gas(id); }
        : a.cbeth < 1 && a.collateralUsd === 0 ? async () => { job.step = 'mint'; await mintTest(p.address); }
        : a.collateralUsd === 0 && a.cbethAllowance < 1 ? agent('approveCollateral', 'Approve', L.BASE.cbeth, 10n ** 18n, 100000)
        : a.collateralUsd === 0 ? agent('supply', 'Supply', L.BASE.cbeth, 10n ** 18n, 400000)
        : a.debtUsd === 0 ? null
        : a.usdcAllowance === 0 ? agent('approveRepay', 'Approve', L.BASE.usdc, 10000n * 10n ** 6n, 100000)
        : null;
      if (!next) return Object.assign(job, { state: a.debtUsd === 0 ? 'waiting' : 'done', step: a.debtUsd === 0 ? 'borrow' : null });
      await next();
      cache.delete(id);
    }
    throw new Error('Setup did not finish.');
  })().catch((e) => Object.assign(job, { state: 'failed', error: e.message }));
  return job;
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
    const u = new URL(req.url, 'http://x');
    const id = (v) => (/^\d+$/.test(v ?? '') ? Number(v) : null);
    if (req.method === 'GET' && u.pathname === '/api/position') {
      const body = await position(u.searchParams.has('id') ? id(u.searchParams.get('id')) ?? -1 : S.position);
      return body ? send(res, 200, body) : send(res, 404, { error: 'No such position' });
    }
    if (req.method === 'GET' && u.pathname === '/api/positions') return send(res, 200, { owner: u.searchParams.get('owner'), ...(await positionsOf(u.searchParams.get('owner'))) });
    let r = u.pathname.match(/^\/api\/step\/(new|\d+)\/(\w+)$/);
    if (r && req.method === 'GET') return send(res, 200, await step(id(r[1]), r[2], u.searchParams));
    r = u.pathname.match(/^\/api\/(relay|gas|setup)\/(\d+)$/);
    if (r && req.method === 'POST') return send(res, 200, r[1] === 'relay' ? relay(Number(r[2])) : r[1] === 'setup' ? setup(Number(r[2])) : await gas(Number(r[2])));
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
    send(res, e.status || 502, { error: e.status ? e.message : `Testnet RPC error: ${e.message}` });
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`Lifeguard on port ${PORT}; Base gas wallet ${drip.address}`));
