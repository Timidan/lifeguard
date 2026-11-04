#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const INTERVAL_MS = 30000, COOLDOWN_MS = 300000;
const NEAR_AI = 'https://cloud-api.near.ai/v1', MODEL = process.env.KEEPER_MODEL ?? 'z-ai/glm-5.3-flash';
const REPAY_SCHEMA = { type: 'object', additionalProperties: false, required: ['buffer_percent', 'reason'],
  properties: { buffer_percent: { type: 'number' }, reason: { type: 'string' } } };
// The model judges the trend; the keeper does the arithmetic, which small models get wrong.
const SIZING_PROMPT = `You decide the safety buffer for one repayment on an Aave loan. Its health factor has fallen below the rescue trigger, so a repayment of toReachTarget USDC goes out now, which lifts the health factor to targetHealthFactor (or all of usdcAvailable, if that is less).
You get healthFactor now, targetHealthFactor, toReachTarget, usdcAvailable and recentHealthFactors, readings 30 seconds apart, oldest first.
Choose buffer_percent, from 0 to 25, to repay on top of toReachTarget: 0 when the readings are flat or rising, more the faster they are falling.
Reply with JSON only: buffer_percent, and reason, one plain sentence that names the current health factor and the trend in the readings and says why that buffer.`;

function decide(state) {
  const { healthFactor, debtUsd, usdc, pending = [], now = 0, lastActionAt = null,
    trigger = 1.25, target = 1.9, cooldownMs = COOLDOWN_MS } = state;
  const skip = (reason) => ({ action: 'skip', reason, amount: 0 });
  if (Array.isArray(pending) ? pending.length > 0 : pending) return skip('pending_transaction');
  if (lastActionAt !== null && now - lastActionAt < cooldownMs) return skip('cooldown');
  if (!Number.isFinite(trigger) || trigger <= 0 || !Number.isFinite(target) || target <= trigger) return skip('invalid_thresholds');
  if (!(healthFactor >= 0) || !Number.isFinite(debtUsd) || debtUsd < 0 || !Number.isFinite(usdc) || usdc < 0) return skip('invalid_state');
  if (healthFactor >= trigger || debtUsd === 0) return skip('healthy');
  // This position borrows USDC; use its USD debt at $1 per USDC.
  const needed = Math.ceil(debtUsd * (1 - healthFactor / target) * 1e6);
  const available = Math.floor(usdc * 1e6);
  if (!Number.isSafeInteger(needed) || !Number.isSafeInteger(available)) return skip('invalid_state');
  if (available === 0) return skip('no_usdc');
  return { action: 'repay', reason: available < needed ? 'balance_limited' : 'below_trigger', amount: Math.min(needed, available) / 1e6 };
}

// The model only picks a buffer of 0-25% on top of the rule's amount, capped by the USDC available, so a bad reply can
// neither stop a rescue nor overpay. Anything else and the rule's amount stands.
function sizeRepay(rule, loan, reply) {
  const buffer = Number(reply?.buffer_percent), reason = String(reply?.reason ?? '').trim();
  const why = !(buffer >= 0 && buffer <= 25) ? 'buffer_out_of_range' : reason.length < 20 ? 'no_reason' : null;
  if (why) return { ...rule, decidedBy: 'rule', modelRejected: why };
  const amount = Math.floor(Math.min(loan.usdc, rule.amount * (1 + buffer / 100)) * 1e6) / 1e6;
  const expectedHealthFactor = Number(((loan.healthFactor * loan.debtUsd) / (loan.debtUsd - amount)).toFixed(3));
  return { action: 'repay', reason: reason.slice(0, 300), amount, bufferPercent: buffer, expectedHealthFactor, decidedBy: 'model' };
}

// The exact request and response bytes are kept because the enclave's signature covers their hashes.
async function askModel(loan) {
  const key = fs.readFileSync(path.join(__dirname, '.keys/near-ai-key'), 'utf8').trim();
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-no-aliasing': 'true', 'accept-encoding': 'identity' };
  const request = JSON.stringify({ model: MODEL, stream: false, max_tokens: 400, reasoning_effort: 'none',
    messages: [{ role: 'system', content: SIZING_PROMPT }, { role: 'user', content: JSON.stringify(loan) }],
    response_format: { type: 'json_schema', json_schema: { name: 'repay', strict: true, schema: REPAY_SCHEMA } } });
  const res = await fetch(`${NEAR_AI}/chat/completions`, { method: 'POST', headers, body: request, signal: AbortSignal.timeout(20000) });
  const response = await res.text();
  if (!res.ok) throw new Error(`NEAR AI answered ${res.status}`);
  const body = JSON.parse(response);
  const signature = await fetch(`${NEAR_AI}/signature/${body.id}?signing_algo=ecdsa`, { headers, signal: AbortSignal.timeout(10000) })
    .then((r) => r.json()).catch(() => null);
  const dir = path.join(__dirname, 'data/decisions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${body.id}.json`), JSON.stringify({ model: MODEL, request, response, signature }, null, 2));
  return { reply: JSON.parse(body.choices[0].message.content), modelChat: body.id, signed: !!signature?.signature };
}

// Positions whose owner has given this keeper's key to the contract. Positions only grow and owners never change.
const owners = [];
async function granted(L) {
  const s = L.state();
  for (let id = owners.length; ; id++) { const p = await L.view('get_position', { id }); if (!p) break; owners.push(p.owner); }
  const provider = (await L.ownerAccount()).connection.provider;
  const ids = [];
  for (const owner of new Set(owners)) {
    const { keys } = await provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: owner });
    if (keys.some((k) => k.public_key === s.agentPublicKey && k.access_key.permission.FunctionCall?.receiver_id === s.contract)) {
      owners.forEach((o, id) => o === owner && ids.push({ id, owner }));
    }
  }
  return ids;
}

// ponytail: positions are served one after another, so a rescue in flight delays the others by a few minutes.
async function main() {
  const L = require('./lib');
  const trigger = Number(process.env.KEEPER_TRIGGER ?? 1.25);
  const target = Number(process.env.KEEPER_TARGET ?? 1.9);
  const dryRun = process.env.KEEPER_DRY_RUN === '1';
  if (!Number.isFinite(trigger) || trigger <= 0 || !Number.isFinite(target) || target <= trigger) throw new Error('KEEPER_TARGET must exceed a positive KEEPER_TRIGGER');
  const loans = new Map(); // position id -> { lastActionAt, work, readings }
  for (;;) {
    let ids = [];
    try { ids = await granted(L); } catch (e) { console.log(JSON.stringify({ time: new Date().toISOString(), event: 'error', reason: 'rpc_error', error: e.message })); }
    for (const { id, owner } of ids) {
      if (!loans.has(id)) loans.set(id, { lastActionAt: null, work: null, readings: [] });
      await tick(L, id, owner, loans.get(id), { trigger, target, dryRun });
    }
    await L.sleep(INTERVAL_MS);
  }
}

async function tick(L, id, owner, st, { trigger, target, dryRun }) {
  const { ethers } = require('ethers');
  const contract = L.state().contract;
  let row = { position: id, healthFactor: null, reason: 'rpc_error', amount: 0, nearSign: null, baseTx: null, nearProof: null, dryRun, ...st.work?.row };
  const log = (event, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...row, ...extra }));
  try {
    const p = await L.view('get_position', { id });
    if (!p.address) return;
    const a = await L.account(p.address);
    row.healthFactor = Number.isFinite(a.healthFactor) ? a.healthFactor : 'no debt';
    if (Number.isFinite(a.healthFactor)) st.readings.push(Number(a.healthFactor.toFixed(4)));
    st.readings.splice(0, st.readings.length - 10);
    const recent = p.history.filter((e) => e.kind.startsWith('repay ')).reduce((at, e) => Math.max(at, Number(e.at_ms)), 0);
    if (recent) st.lastActionAt = Math.max(st.lastActionAt ?? 0, recent);
    if (st.work && p.nonce !== st.work.signed.nonce) {
      const proven = p.history.some((e) => e.tx_hash === st.work.signed.tx_hash && e.proven);
      st.lastActionAt = Date.now();
      st.work = null;
      log(proven ? 'confirmed' : 'superseded');
    }

    if (!st.work) {
      // A repay above the Pool allowance reverts on Base and holds the nonce, so size against what the Pool can pull.
      const usdc = Math.min(a.usdc, a.usdcAllowance);
      let decision = decide({ ...a, usdc, pending: p.pending, trigger, target, now: Date.now(), lastActionAt: st.lastActionAt });
      if (decision.action === 'repay') {
        const rule = decision;
        const toReachTarget = Number((a.debtUsd * (1 - a.healthFactor / target)).toFixed(2));
        decision = await askModel({ healthFactor: a.healthFactor, debtUsd: a.debtUsd, usdcAvailable: usdc, targetHealthFactor: target, toReachTarget, recentHealthFactors: st.readings })
          .then(({ reply, ...evidence }) => ({ ...sizeRepay(rule, { healthFactor: a.healthFactor, debtUsd: a.debtUsd, usdc }, reply), ...evidence }))
          .catch((e) => ({ ...rule, decidedBy: 'rule', modelError: e.message }));
      }
      Object.assign(row, decision, { pendingTxs: p.pending.map((tx) => tx.tx_hash) });
      if (decision.action === 'repay' && !dryRun) {
        const acct = await L.agentAccount(owner);
        const fees = await L.fees(400000);
        const current = await L.view('get_position', { id });
        if (current.pending.length || current.nonce !== p.nonce) {
          Object.assign(row, { action: 'skip', reason: current.pending.length ? 'pending_transaction' : 'position_changed', amount: 0,
            pendingTxs: current.pending.map((tx) => tx.tx_hash) });
        } else {
          st.lastActionAt = Date.now();
          log('decision');
          const signed = await L.call(acct, contract, 'request_action', {
            id, action: { Repay: { asset: L.BASE.usdc, amount: ethers.parseUnits(decision.amount.toFixed(6), 6).toString() } }, fees,
          });
          row.nearSign = signed.txHash;
          if (signed.error) throw new Error(signed.error);
          row.baseTx = signed.value.tx_hash;
          st.work = { acct, signed: signed.value, row: { ...row }, safe: false };
          log('signed');
        }
      }
      if (!st.work) log(dryRun && decision.action === 'repay' ? 'dry_run' : 'decision');
    }

    if (st.work) {
      row = { ...st.work.row, healthFactor: row.healthFactor };
      // Retry only this signed transaction; never request another while it is unresolved.
      if (!st.work.safe) {
        const receipt = await L.broadcastAndWaitSafe(st.work.signed.raw);
        if (receipt.status !== 1) {
          st.work = null;
          throw new Error('Base transaction reverted; pending nonce requires owner recovery');
        }
        st.work.safe = true;
        log('safe');
        await L.sleep(45000);
      }
      const proof = await L.call(st.work.acct, contract, 'confirm', { id, tx_hash: st.work.signed.tx_hash });
      row.nearProof = proof.txHash;
      st.work.row.nearProof = proof.txHash;
      if (proof.value !== true) throw new Error(proof.error || 'Read MPC proof not accepted yet');
      st.lastActionAt = Date.now();
      st.work = null;
      log('confirmed');
    }
  } catch (e) {
    log('error', { error: e.message });
  }
}

module.exports = { decide, sizeRepay, askModel };
if (require.main === module) main().catch((e) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event: 'error', healthFactor: null, reason: 'startup_error', amount: 0,
    nearSign: null, baseTx: null, nearProof: null, error: e.message }));
  process.exitCode = 1;
});
