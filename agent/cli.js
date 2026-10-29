#!/usr/bin/env node
// Lifeguard CLI: deploy the contract, open a position, and run the agent's request → sign → broadcast → prove loop.
//
//   node cli.js deploy [owner.testnet]        create a contract account, deploy, initialise
//   node cli.js position                       open position 0 and fetch its MPC-derived Base address
//   node cli.js agent-key                      give the agent a function-call key (request_action, confirm only)
//   node cli.js owner <to> <calldata> [wei] [gas]    owner-signed call (setup: mint, borrow)
//   node cli.js agent <supply|repay|approve> <usdc|cbeth> <amount> [gas]   the agent's loan-safe actions
//   node cli.js redteam                        try to hurt the position with the agent's key
//   node cli.js status
const { KeyPair, transactions, connect } = require('near-api-js');
const { ethers } = require('ethers');
const fs = require('fs'), path = require('path');
const L = require('./lib');

const ASSETS = { usdc: { address: L.BASE.usdc, decimals: 6 }, cbeth: { address: L.BASE.cbeth, decimals: 18 } };
const WASM = path.join(__dirname, '..', 'contract', 'target', 'near', 'lifeguard.wasm');
const ATTACKER = '0x000000000000000000000000000000000000dEaD';

async function deploy(owner = L.state().owner || 'lifeguard-kt-mvtu6ag4.testnet') {
  const contract = `lifeguard-${Date.now().toString(36)}.testnet`;
  const key = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: contract, newAccountPublicKey: key.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet helper: ${res.status} ${await res.text()}`);
  await L.credentials.setKey('testnet', contract, key);
  const config = {
    mpc: 'v1.signer-prod.testnet', foreign_chain: 'Base', foreign_tx_domain: 3, chain_id: String(L.BASE.chainId),
    pool: L.BASE.pool,
    assets: [
      { address: L.BASE.usdc, approve_cap: (100_000n * 10n ** 6n).toString() },
      { address: L.BASE.cbeth, approve_cap: (100n * 10n ** 18n).toString() },
    ],
    max_fee_per_gas: '5000000000', max_priority_fee_per_gas: '2000000000', max_gas_limit: '1000000', max_actions_per_day: 30,
  };
  const acct = await (await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org', keyStore: L.credentials })).account(contract);
  const out = await acct.signAndSendTransaction({ receiverId: contract, actions: [
    transactions.deployContract(fs.readFileSync(WASM)),
    transactions.functionCall('new', { config }, 100_000_000_000_000n, 0n),
  ] });
  L.save({ contract, owner, position: undefined, address: undefined, agentKey: undefined });
  console.log(`deployed ${contract} (owner ${owner})\n  ${L.NEAR_EXPLORER}${out.transaction.hash}`);
}

async function position() {
  const s = L.state();
  const r = await L.call(await L.ownerAccount(), s.contract, 'create_position', {}, { deposit: 50n * 10n ** 21n });
  if (r.error) throw new Error(r.error);
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

/** Has NEAR sign, broadcasts on Base, waits for `safe`, then asks Read MPC to prove it. */
async function signBroadcastProve(accountPromise, method, args, label) {
  const s = L.state();
  const acct = await accountPromise;
  console.log(`→ ${label}`);
  const signed = await L.call(acct, s.contract, method, args);
  if (signed.error) throw new Error(`NEAR refused: ${signed.error}`);
  console.log(`  signed by NEAR MPC   ${L.NEAR_EXPLORER}${signed.txHash}`);
  const receipt = await L.broadcastAndWaitSafe(signed.value.raw);
  console.log(`  mined on Base (${receipt.status === 1 ? 'success' : 'REVERTED'})  ${L.BASE.explorer}${receipt.hash}`);
  if (receipt.status !== 1) {
    console.log(`  Read MPC never proves a revert; the owner resets the nonce: node cli.js reset ${Number(signed.value.nonce) + 1}`);
    return;
  }
  const proof = await L.call(acct, s.contract, 'confirm', { id: s.position, tx_hash: signed.value.tx_hash });
  console.log(`  Read MPC proof ${proof.value === true ? 'accepted, nonce advanced' : `not accepted (${proof.error || proof.value})`}  ${L.NEAR_EXPLORER}${proof.txHash}`);
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

async function reset(nonce) {
  const r = await L.call(await L.ownerAccount(), L.state().contract, 'reset_nonce', { id: L.state().position, nonce: String(nonce) });
  console.log(r.error || `nonce reset to ${nonce}`);
}

/** Every attempt uses the agent's key. Each must fail, and the output says which layer stopped it. */
async function redteam() {
  const s = L.state();
  const f = await L.fees();
  const borrow = new ethers.Interface(['function borrow(address,uint256,uint256,uint16,address)'])
    .encodeFunctionData('borrow', [L.BASE.usdc, 10n ** 9n, 2, 0, s.address]);
  let agentAcct;
  const attempts = [
    ['borrow through owner_action', () => L.call(agentAcct, s.contract, 'owner_action', { id: s.position, to: L.BASE.pool, value: '0', data: borrow, fees: f })],
    ['borrow as an agent action', () => L.call(agentAcct, s.contract, 'request_action', { id: s.position, action: { Borrow: { asset: L.BASE.usdc, amount: '1000000000' } }, fees: f })],
    ['withdraw as an agent action', () => L.call(agentAcct, s.contract, 'request_action', { id: s.position, action: { Withdraw: { asset: L.BASE.cbeth, amount: '1' } }, fees: f })],
    ['approve far above the cap', () => L.call(agentAcct, s.contract, 'request_action', { id: s.position, action: { Approve: { asset: L.BASE.usdc, amount: (10n ** 30n).toString() } }, fees: f })],
    ['supply an unlisted token', () => L.call(agentAcct, s.contract, 'request_action', { id: s.position, action: { Supply: { asset: ATTACKER, amount: '1' } }, fees: f })],
    ['drain gas with a huge fee', () => L.call(agentAcct, s.contract, 'request_action', { id: s.position, action: { Repay: { asset: L.BASE.usdc, amount: '1' } }, fees: { ...f, max_fee_per_gas: (10n ** 15n).toString() } })],
    ['rewind the nonce', () => L.call(agentAcct, s.contract, 'reset_nonce', { id: s.position, nonce: '0' })],
    ['send the owner\'s NEAR away', async () => {
      try { await agentAcct.sendMoney('lifeguard-attacker.testnet', 10n ** 22n); return { value: 'sent' }; } catch (e) { return { error: `${e.type || ''} ${e.message}` }; }
    }],
  ];
  let held = 0;
  for (const [name, attempt] of attempts) {
    agentAcct = await L.agentAccount(); // fresh access-key nonce for every attempt
    const r = await attempt();
    const layer = /MethodNameMismatch|NotEnoughAllowance|RequiresFullAccess|ReceiverMismatch|access key/i.test(r.error || '') ? 'NEAR access key' : 'Lifeguard contract';
    const blocked = !!r.error;
    held += blocked;
    console.log(`${blocked ? 'BLOCKED' : 'ALLOWED'}  ${name.padEnd(30)} ${blocked ? layer.padEnd(18) + ' ' + r.error.replace(/\s+/g, ' ').slice(0, 110) : JSON.stringify(r.value)}`);
  }
  console.log(`\n${held}/${attempts.length} attacks blocked`);
  process.exitCode = held === attempts.length ? 0 : 1;
}

async function status() {
  const s = L.state();
  const p = await L.view('get_position', { id: s.position });
  const a = await L.account(p.address);
  console.log(JSON.stringify({ contract: s.contract, owner: s.owner, position: s.position, address: p.address, nonce: p.nonce, pending: p.pending.length, health_factor: a.healthFactor, ...a, last: p.history.slice(-3) }, null, 1));
}

const [cmd, ...args] = process.argv.slice(2);
const commands = { deploy, position, 'agent-key': agentKey, owner, agent, reset, redteam, status };
if (!commands[cmd]) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 11).join('\n'));
  process.exit(1);
}
commands[cmd](...args).catch((e) => { console.error(e.message || e); process.exit(1); });
