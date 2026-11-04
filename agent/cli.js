#!/usr/bin/env node
// Lifeguard CLI: deploy the contract, open a position, and run the agent's request → sign → broadcast → prove loop.
//
//   node cli.js deploy <owner.testnet>         create a contract account, deploy, initialise
//   node cli.js position                       open position 0 and fetch its MPC-derived Base address
//   node cli.js agent-key                      give the agent a function-call key (request_action, confirm only)
//   node cli.js owner <to> <calldata> [wei] [gas]    owner-signed call (setup: mint, borrow)
//   node cli.js agent <supply|repay|approve> <usdc|cbeth> <amount> [gas]   the agent's loan-safe actions
//   node cli.js confirm [tx_hash]              ask Read MPC to prove a signed transaction (default: first pending)
//   node cli.js redteam                        try to hurt the position with the agent's key
//   node cli.js status
//   node cli.js loop                           the whole demo on a new owner, contract and position; run it again to resume
//   node cli.js evidence                       rewrite the README's evidence and the site's recorded rescue from the chain
//
// LIFEGUARD_STATE names the deployment file (default .keys/deployment.json), so two deployments can sit side by side.
const { KeyPair, transactions } = require('near-api-js');
const { ethers } = require('ethers');
const fs = require('fs'), path = require('path');
const L = require('./lib');

const ASSETS = { usdc: { address: L.BASE.usdc, decimals: 6 }, cbeth: { address: L.BASE.cbeth, decimals: 18 } };
const WASM = path.join(__dirname, '..', 'contract', 'target', 'near', 'lifeguard.wasm');
const README = path.join(__dirname, '..', 'README.md');
const SITE_EVIDENCE = path.join(__dirname, '..', 'web', 'src', 'evidence.json');
const TARGET_HF = 1.08; // close enough to liquidation that the rescue matters

/** A new testnet account from NEAR's faucet helper. Its key goes to ~/.near-credentials. */
async function newAccount(prefix) {
  const id = `${prefix}-${Date.now().toString(36)}.testnet`;
  const key = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet helper: ${res.status} ${await res.text()}`);
  await L.credentials.setKey('testnet', id, key);
  return id;
}

async function deploy(owner = L.state().owner) {
  if (!owner) throw new Error('Usage: node cli.js deploy <owner.testnet>');
  const contract = await newAccount('lifeguard');
  const config = {
    mpc: 'v1.signer-prod.testnet', foreign_chain: 'Base', foreign_tx_domain: 3, chain_id: String(L.BASE.chainId),
    pool: L.BASE.pool,
    assets: [
      { address: L.BASE.usdc, approve_cap: (100_000n * 10n ** 6n).toString() },
      { address: L.BASE.cbeth, approve_cap: (100n * 10n ** 18n).toString() },
    ],
    max_fee_per_gas: '5000000000', max_priority_fee_per_gas: '2000000000', max_gas_limit: '1000000', max_actions_per_day: 30,
  };
  const acct = await (await L.nearConnection()).account(contract);
  const out =await acct.signAndSendTransaction({ receiverId: contract, actions: [
    transactions.deployContract(fs.readFileSync(WASM)),
    transactions.functionCall('new', { config }, 100_000_000_000_000n, 0n),
  ] });
  L.save({ contract, owner, position: undefined, address: undefined, agentKey: undefined, borrowed: undefined, before: undefined, after: undefined, txs: undefined });
  console.log(`deployed ${contract} (owner ${owner})\n  ${L.NEAR_EXPLORER}${out.transaction.hash}`);
}

async function position() {
  const s = L.state();
  const r = await L.call(await L.ownerAccount(), s.contract, 'create_position', {}, { deposit: 50n * 10n ** 21n });
  if (r.error) {
    L.save({ contract: undefined }); // it may still have landed as position 0, so the next run starts on a new contract
    throw new Error(r.error);
  }
  L.save({ position: 0, address: r.value }); // first position of a fresh deployment
  console.log(`position 0: Base address ${r.value} (derived by NEAR MPC for ${s.contract}, path pos/0)\n  ${L.NEAR_EXPLORER}${r.txHash}`);
}

async function agentKey() {
  const s = L.state();
  const key = KeyPair.fromRandom('ed25519');
  const owner = await L.ownerAccount();
  await owner.addKey(key.getPublicKey().toString(), s.contract, ['request_action', 'confirm'], 10n ** 24n);
  L.save({ agentKey: key.toString(), agentPublicKey: key.getPublicKey().toString() });
  console.log(`agent key ${key.getPublicKey()} on ${s.owner}: receiver ${s.contract}, methods request_action + confirm, 1 NEAR gas allowance`);
}

/** Keeps each transaction's NEAR hashes, because the contract's history holds only the Base hash. */
function note(txHash, fields) {
  const txs = L.state().txs || {};
  L.save({ txs: { ...txs, [txHash]: { ...txs[txHash], ...fields } } });
}

/** Asks Read MPC to prove a mined transaction. Read MPC's view of `safe` can lag the public RPC, so wait and retry. */
async function prove(acct, txHash) {
  const s = L.state();
  await L.sleep(45000);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await L.call(acct, s.contract, 'confirm', { id: s.position, tx_hash: txHash });
    if (r.value === true) {
      note(txHash, { nearProof: r.txHash });
      return console.log(`  Read MPC proof accepted, nonce advanced  ${L.NEAR_EXPLORER}${r.txHash}`);
    }
    console.log(`  Read MPC proof attempt ${attempt}: not yet (${r.error || r.value})`);
  }
  throw new Error(`Not proven after 3 attempts; retry later with: node cli.js confirm ${txHash}`);
}

/** The nonce advances only on a proof, so a mined but unproven transaction must be proven before signing again. */
async function settlePending(acct) {
  for (const p of (await L.view('get_position', { id: L.state().position })).pending) {
    const receipt = await L.base.getTransactionReceipt(p.tx_hash);
    if (!receipt) continue;
    if (receipt.status !== 1) throw new Error(`${p.tx_hash} reverted; reset the nonce: node cli.js reset ${Number(p.nonce) + 1}`);
    console.log(`→ proving earlier transaction ${p.tx_hash} first`);
    return prove(acct, p.tx_hash);
  }
}

/** Has NEAR sign, broadcasts on Base, waits for `safe`, then asks Read MPC to prove it. */
async function signBroadcastProve(accountPromise, method, args, label) {
  const s = L.state();
  const acct = await accountPromise;
  console.log(`→ ${label}`);
  const signed = await L.call(acct, s.contract, method, args);
  if (signed.error) throw new Error(`NEAR refused: ${signed.error}`);
  console.log(`  signed by NEAR MPC   ${L.NEAR_EXPLORER}${signed.txHash}`);
  note(signed.value.tx_hash, { nearSign: signed.txHash });
  const receipt = await L.broadcastAndWaitSafe(signed.value.raw);
  console.log(`  mined on Base (${receipt.status === 1 ? 'success' : 'REVERTED'})  ${L.BASE.explorer}${receipt.hash}`);
  if (receipt.status !== 1) {
    console.log(`  Read MPC never proves a revert; the owner resets the nonce: node cli.js reset ${Number(signed.value.nonce) + 1}`);
    return;
  }
  await prove(acct, signed.value.tx_hash);
}

async function owner(to, data, value = '0', gas = '300000') {
  const s = L.state();
  await signBroadcastProve(L.ownerAccount(), 'owner_action',
    { id: s.position, to, value, data, fees: await L.fees(Number(gas)) }, `owner call to ${to}`);
}

async function agent(kind, asset, amount, gas = '300000') {
  const a = ASSETS[asset] || { address: asset, decimals: 0 };
  const units = ethers.parseUnits(amount, a.decimals).toString();
  const action = { [kind[0].toUpperCase() + kind.slice(1)]: { asset: a.address, amount: units } };
  await signBroadcastProve(L.agentAccount(), 'request_action',
    { id: L.state().position, action, fees: await L.fees(Number(gas)) }, `agent ${kind} ${amount} ${asset}`);
}

async function confirm(txHash) {
  const s = L.state();
  txHash = txHash || (await L.view('get_position', { id: s.position })).pending[0]?.tx_hash;
  const r = await L.call(await L.ownerAccount(), s.contract, 'confirm', { id: s.position, tx_hash: txHash });
  if (r.value === true) note(txHash, { nearProof: r.txHash });
  console.log(`Read MPC proof for ${txHash}: ${r.value === true ? 'accepted, nonce advanced' : `not accepted (${r.error || r.value})`}  ${L.NEAR_EXPLORER}${r.txHash}`);
}

async function reset(nonce) {
  const r = await L.call(await L.ownerAccount(), L.state().contract, 'reset_nonce', { id: L.state().position, nonce: String(nonce) });
  console.log(r.error || `nonce reset to ${nonce}`);
}

/** Every attempt uses the agent's key. Each must fail, and the output says which layer stopped it. */
async function redteam() {
  const list = L.attacks(L.state(), await L.fees());
  let held = 0;
  for (const { name, run } of list) {
    const r = await run(await L.agentAccount()); // fresh access-key nonce for every attempt
    const blocked = !!r.error;
    held += blocked;
    console.log(`${blocked ? 'BLOCKED' : 'ALLOWED'}  ${name.padEnd(30)} ${blocked ? L.refusedBy(r.error).padEnd(18) + ' ' + r.error.replace(/\s+/g, ' ').slice(0, 110) : JSON.stringify(r.value)}`);
    if (blocked && L.refusedBy(r.error) === 'Lifeguard contract') console.log(`         failed on chain: ${L.NEAR_EXPLORER}${r.txHash}`); // access-key refusals never reach the chain
  }
  console.log(`\n${held}/${list.length} attacks blocked`);
  process.exitCode = held === list.length ? 0 : 1;
}

async function status() {
  const s = L.state();
  const p = await L.view('get_position', { id: s.position });
  const a = await L.account(p.address);
  console.log(JSON.stringify({ contract: s.contract, owner: s.owner, position: s.position, address: p.address, nonce: p.nonce, pending: p.pending.length, ...a, healthFactor: Number.isFinite(a.healthFactor) ? a.healthFactor : 'no debt', history: p.history }, null, 1));
}

const mint = (token, amount) => new ethers.Interface(['function mint(address,address,uint256)'])
  .encodeFunctionData('mint', [token, L.state().address, amount]);

/** Takes the loan close to liquidation, so the rescue has something to rescue. The test oracle's price moves, so the amount is worked out here. */
async function borrow() {
  const { address } = L.state();
  const { collateralUsd, liquidationThreshold } = await L.account(address);
  const usdc = L.state().borrowed ?? Math.floor(collateralUsd * liquidationThreshold / TARGET_HF);
  L.save({ borrowed: usdc });
  const data = new ethers.Interface(['function borrow(address,uint256,uint256,uint16,address)'])
    .encodeFunctionData('borrow', [L.BASE.usdc, BigInt(usdc) * 10n ** 6n, 2, 0, address]);
  await owner(L.BASE.pool, data, '0', '500000');
}

async function rescue() {
  if (!L.state().before) L.save({ before: await L.account(L.state().address) });
  await agent('repay', 'usdc', '1000', '400000');
}

const hf = (a) => a?.healthFactor.toFixed(3);

/** Every step of the demo, in nonce order. The owner's key sets the loan up and takes it close to liquidation; the agent's key does the rest. */
const steps = (s) => [
  { label: 'Mint 1 cbETH', by: 'owner', run: () => owner(L.BASE.faucet, mint(L.BASE.cbeth, 10n ** 18n), '0', '200000') },
  { label: 'Mint 1,000 USDC', by: 'owner', run: () => owner(L.BASE.faucet, mint(L.BASE.usdc, 1000n * 10n ** 6n), '0', '200000') },
  { label: 'Approve cbETH to the Pool', by: 'agent', run: () => agent('approve', 'cbeth', '1', '100000') },
  { label: 'Supply 1 cbETH', by: 'agent', run: () => agent('supply', 'cbeth', '1', '400000') },
  { label: `Borrow ${s.borrowed?.toLocaleString('en-US')} USDC (HF → ${hf(s.before)})`, by: 'owner', run: borrow },
  { label: 'Approve USDC to the Pool', by: 'agent', run: () => agent('approve', 'usdc', '3000', '100000') },
  { label: `**Repay 1,000 USDC (HF ${hf(s.before)} → ${hf(s.after)})**`, by: '**agent**', run: rescue },
];

/** The whole demo in one command. It stops once to ask for gas, and can be run again after any failure: the position's nonce is the cursor, so no step runs twice. */
async function loop() {
  if (!L.state().owner) L.save({ owner: await newAccount('lifeguard-owner') });
  if (!L.state().contract) await deploy();
  if (!L.state().address) await position();
  if (!L.state().agentKey) await agentKey();
  const s = L.state();
  if ((await L.base.getBalance(s.address)) === 0n) return console.log(`Send a little Base Sepolia ETH to ${s.address}, then run this again.`);
  for (let failures = 0, done = -1; ;) {
    try {
      await settlePending(await L.ownerAccount());
      const nonce = Number((await L.view('get_position', { id: s.position })).nonce);
      if (nonce <= done) { await L.sleep(3000); continue; } // a lagging RPC node must not run a step twice
      const step = steps(L.state())[nonce];
      if (!step) break;
      await step.run();
      done = nonce;
      failures = 0;
    } catch (e) {
      if (++failures > 3) throw e;
      console.log(`  ${e.message}; trying again in 30 s`);
      await L.sleep(30000);
    }
  }
  if (!L.state().after) L.save({ after: await L.account(s.address) });
  await redteam();
}

/** Rewrites the README's evidence and the site's recorded rescue from the chain, so neither can drift from what happened. */
async function evidence() {
  const s = L.state();
  const proven = (await L.view('get_position', { id: s.position })).history.filter((e) => e.proven);
  const rows = steps(s).map((step, i) => {
    const e = proven[i], t = s.txs[e?.tx_hash];
    if (!t?.nearSign || !t?.nearProof) throw new Error(`No proof on record for: ${step.label}`);
    const near = (hash) => `[${hash.slice(0, 8)}…](${L.NEAR_EXPLORER}${hash})`;
    return `| ${step.label} | ${step.by} | ${near(t.nearSign)} | [${e.tx_hash.slice(0, 6)}…${e.tx_hash.slice(-4)}](${L.BASE.explorer}${e.tx_hash}) | ${near(t.nearProof)} |`;
  });
  const repay = proven[rows.length - 1];
  const date = new Date(Number(repay.at_ms)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  const blocks = {
    rescue: [
      '| | Health factor | Debt |', '|---|---|---|',
      `| Before | ${hf(s.before)} | ${usd(s.before.debtUsd)} |`,
      `| After the agent's repay | **${hf(s.after)}** | ${usd(s.after.debtUsd)} |`,
    ],
    steps: [
      `## Evidence (testnet, ${date})`, '',
      `Contract: [\`${s.contract}\`](https://testnet.nearblocks.io/address/${s.contract}). Position 0's Base address: [\`${s.address}\`](https://sepolia.basescan.org/address/${s.address}).`, '',
      '| Step | Who | Signed by NEAR | Mined on Base | Proven by Read MPC |', '|---|---|---|---|---|',
      ...rows,
    ],
  };
  const a = s.autonomous;
  const day = new Date(a.confirmedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const span = (Date.parse(a.confirmedAt) - Date.parse(a.decidedAt)) / 1000;
  blocks.autonomous = [
    `Then, with nobody touching it, on ${day}: \`agent/keeper.js\` saw health factor ${hf(a.before)}, asked \`${a.model}\` on NEAR AI how much to repay, and repaid ${a.amount.toLocaleString('en-US')} USDC through the same contract in ${Math.floor(span / 60)} min ${Math.round(span % 60)} s.`, '',
    '| | Health factor | Debt |', '|---|---|---|',
    `| Before | ${hf(a.before)} | ${usd(a.before.debtUsd)} |`,
    `| After the keeper's repay | **${hf(a.after)}** | ${usd(a.after.debtUsd)} |`, '',
    `[Signed by NEAR](${L.NEAR_EXPLORER}${a.nearSign}) · [mined on Base](${L.BASE.explorer}${a.baseTx}) · [confirmed by Read MPC](${L.NEAR_EXPLORER}${a.nearProof})`, '',
    `The model's decision was signed inside its enclave. To check it: \`cd agent && node verify-decision.js decisions/${a.modelChat}.json\``,
  ];
  const readme = fs.readFileSync(README, 'utf8').replace(/(<!-- evidence:(\w+) -->\n\n)[\s\S]*?(\n\n<!-- \/evidence -->)/g, (_, open, name, close) => open + blocks[name].join('\n') + close);
  fs.writeFileSync(README, readme);
  const latest = (await L.view('get_position', { id: s.position })).history.find((e) => e.tx_hash === a.baseTx);
  fs.writeFileSync(SITE_EVIDENCE, `${JSON.stringify({ rescue: {
    date: day, action: `Repay ${a.amount.toLocaleString('en-US')} USDC`, nonce: Number(latest.nonce),
    before: Number(hf(a.before)), after: Number(hf(a.after)), debtBefore: Math.round(a.before.debtUsd), debtAfter: Math.round(a.after.debtUsd),
    nearSign: a.nearSign, baseTx: a.baseTx, nearProof: a.nearProof,
  } }, null, 2)}\n`);
  console.log(`README and ${path.basename(SITE_EVIDENCE)} now show ${s.contract}, ${day}: HF ${hf(a.before)} → ${hf(a.after)}`);
}

// By hand, a command first proves any earlier mined transaction, because the nonce advances only on a proof. `loop` does this itself between steps.
const settled = (fn) => async (...a) => { await settlePending(await L.ownerAccount()); return fn(...a); };

const [cmd, ...args] = process.argv.slice(2);
const commands = { deploy, position, 'agent-key': agentKey, owner: settled(owner), agent: settled(agent), confirm, reset, redteam, status, loop, evidence };
if (!commands[cmd]) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 15).join('\n'));
  process.exit(1);
}
commands[cmd](...args).catch((e) => { console.error(e.message || e); process.exit(1); });
