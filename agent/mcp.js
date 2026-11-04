#!/usr/bin/env node
// Lifeguard MCP server: lets any MCP client (Claude Code, Cursor, a NEAR AI agent) act on one loan with the agent's
// NEAR function-call key. The tools are a convenience; NEAR's access key and the Lifeguard contract decide what runs.
//
//   node mcp.js init <position> <contract>   make an agent key for a position; prints the public key to grant
//   node mcp.js                              serve MCP over stdio (LIFEGUARD_STATE picks the loan, as in cli.js)
console.log = (...a) => console.error(...a); // stdout carries only MCP messages
const fs = require('fs'), os = require('os'), path = require('path');
const { KeyPair } = require('near-api-js');
const { ethers } = require('ethers');
const L = require('./lib');

const ASSETS = { USDC: { address: L.BASE.usdc, decimals: 6 }, cbETH: { address: L.BASE.cbeth, decimals: 18 } };
const asset = { type: 'string', enum: Object.keys(ASSETS) };
const amount = { type: 'string', description: 'Amount in whole tokens, e.g. "250" or "0.5"' };

/** Sign one loan-safe action with the agent's key, then broadcast it on Base and wait until it is mined. */
async function act(kind, { asset: sym, amount: n }) {
  const s = L.state(), a = ASSETS[sym];
  if (!a) throw new Error(`asset must be one of ${Object.keys(ASSETS).join(', ')}`);
  const p = await L.view('get_position', { id: s.position });
  if (p.pending.length) return { refused: false, error: `Confirm ${p.pending[0].tx_hash} first; the loan's nonce advances only after Read MPC confirms it.` };
  const action = { [kind]: { asset: a.address, amount: ethers.parseUnits(n, a.decimals).toString() } };
  const signed = await L.call(await L.agentAccount(), s.contract, 'request_action', { id: s.position, action, fees: await L.fees() });
  if (signed.error) return { refused: true, by: L.refusedBy(signed.error), error: signed.error, nearTx: signed.txHash && L.NEAR_EXPLORER + signed.txHash };
  const tx = await L.base.broadcastTransaction(signed.value.raw).catch(() => null);
  const receipt = await L.base.waitForTransaction(signed.value.tx_hash, 1, 120000).catch(() => null);
  return {
    signedOnNear: L.NEAR_EXPLORER + signed.txHash,
    baseTx: L.BASE.explorer + signed.value.tx_hash,
    mined: receipt ? (receipt.status === 1 ? 'success' : 'reverted') : 'not yet',
    next: receipt?.status === 1 ? `Call confirm with ${signed.value.tx_hash} so Read MPC verifies it and the nonce advances.`
      : tx || receipt ? 'A reverted transaction is never confirmed; the owner resets the nonce.' : 'Broadcast failed; try confirm later.',
  };
}

const TOOLS = [
  {
    name: 'get_loan', description: "Read the loan on Aave (Base Sepolia): health factor, debt, collateral, the USDC the agent can repay with, and the position's nonce on NEAR.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = L.state(), p = await L.view('get_position', { id: s.position }), a = await L.account(p.address);
      return {
        healthFactor: Number.isFinite(a.healthFactor) ? Number(a.healthFactor.toFixed(4)) : 'no debt', liquidationBelow: 1,
        debtUsd: a.debtUsd, collateralUsd: a.collateralUsd, usdcBalance: a.usdc, usdcApprovedForRepay: a.usdcAllowance, ethForGas: a.eth,
        nonce: p.nonce, pending: p.pending.map((t) => t.tx_hash), baseAddress: p.address, position: s.position, contract: s.contract, owner: p.owner,
      };
    },
  },
  {
    name: 'repay', description: 'Repay USDC debt on Aave. Raises the health factor. Signs on NEAR, broadcasts on Base, then needs confirm.',
    inputSchema: { type: 'object', properties: { amount }, required: ['amount'] },
    run: ({ amount: n }) => act('Repay', { asset: 'USDC', amount: n }),
  },
  {
    name: 'supply', description: 'Supply collateral to Aave. Raises the health factor. Signs on NEAR, broadcasts on Base, then needs confirm.',
    inputSchema: { type: 'object', properties: { asset, amount }, required: ['asset', 'amount'] },
    run: (args) => act('Supply', args),
  },
  {
    name: 'approve', description: "Let Aave's Pool pull a token, up to the contract's cap. Needed before supply or repay. Then needs confirm.",
    inputSchema: { type: 'object', properties: { asset, amount }, required: ['asset', 'amount'] },
    run: (args) => act('Approve', args),
  },
  {
    name: 'confirm', description: "Ask NEAR's Read MPC to verify a mined Base transaction. Only then does the loan's nonce advance. Waits for Base to mark the block safe; can take a few minutes.",
    inputSchema: { type: 'object', properties: { tx_hash: { type: 'string', description: 'Base transaction hash; defaults to the pending one' } } },
    run: async ({ tx_hash }) => {
      const s = L.state(), p = await L.view('get_position', { id: s.position });
      const hash = tx_hash || p.pending[0]?.tx_hash;
      if (!hash) return { confirmed: false, error: 'Nothing is pending.' };
      const receipt = await L.base.getTransactionReceipt(hash);
      if (!receipt) return { confirmed: false, error: 'Not mined on Base yet.' };
      for (;;) { const safe = await L.base.getBlock('safe'); if (safe && safe.number >= receipt.blockNumber) break; await L.sleep(4000); }
      await L.sleep(30000); // Read MPC's view of `safe` lags the public RPC
      let r;
      for (let i = 0; i < 4; i++) {
        r = await L.call(await L.agentAccount(), s.contract, 'confirm', { id: s.position, tx_hash: hash });
        if (r.value === true) return { confirmed: true, readMpc: L.NEAR_EXPLORER + r.txHash, nonce: Number(p.nonce) + 1 };
        await L.sleep(20000);
      }
      return { confirmed: false, error: r.error || 'Read MPC has not verified it yet; try again shortly.' };
    },
  },
  {
    name: 'near_call', description: "Sign any NEAR function call with the agent's key. Nothing here is filtered: NEAR's access key and the Lifeguard contract decide whether it runs. Try a withdraw, a borrow or another contract to see the refusal.",
    inputSchema: { type: 'object', properties: {
      method: { type: 'string' }, args: { type: 'object' },
      receiver: { type: 'string', description: 'Defaults to the Lifeguard contract' },
      deposit_yocto: { type: 'string', description: 'Attached NEAR in yoctoNEAR' },
    }, required: ['method', 'args'] },
    run: async ({ method, args, receiver, deposit_yocto = '0' }) => {
      const s = L.state();
      const r = await L.call(await L.agentAccount(), receiver || s.contract, method, args, { deposit: BigInt(deposit_yocto), gas: 100_000_000_000_000n });
      const nearTx = r.txHash && L.NEAR_EXPLORER + r.txHash;
      return r.error ? { refused: true, by: L.refusedBy(r.error), error: r.error, nearTx } : { refused: false, value: r.value, nearTx };
    },
  },
];

function init(position, contract = L.state().contract) {
  return (async () => {
    if (!/^\d+$/.test(position ?? '') || !contract) throw new Error('usage: node mcp.js init <position> <contract>');
    const near = await L.nearConnection();
    const p = await (await near.account(contract)).viewFunction({ contractId: contract, methodName: 'get_position', args: { id: Number(position) } });
    if (!p) throw new Error(`No position ${position} on ${contract}`);
    const file = path.join(os.homedir(), '.lifeguard', `${contract}-${position}.json`);
    const key = KeyPair.fromRandom('ed25519');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ contract, position: Number(position), owner: p.owner, agentKey: key.toString() }, null, 1), { mode: 0o600 });
    process.stdout.write(`Agent key for position ${position} (owner ${p.owner}), saved in ${file}\n\nGrant this public key in the Lifeguard app:\n  ${key.getPublicKey()}\n\nThen add the server to your MCP client, e.g.\n  claude mcp add lifeguard -e LIFEGUARD_STATE=${file} -- node ${__filename}\n`);
  })();
}

function serve() {
  const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const handle = async ({ id, method, params = {} }) => {
    if (method === 'initialize') return { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lifeguard', version: '0.1.0' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS.map(({ run, ...t }) => t) };
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 });
      try {
        const result = await tool.run(params.arguments || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: result?.refused === true || !!result?.error };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  };
  require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return out({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (msg.id === undefined) return; // notifications need no answer
    handle(msg).then((result) => out({ id: msg.id, result }), (e) => out({ id: msg.id, error: { code: e.code || -32603, message: e.message } }));
  });
}

if (process.argv[2] === 'init') init(process.argv[3], process.argv[4]).catch((e) => { console.error(e.message); process.exit(1); });
else serve();
