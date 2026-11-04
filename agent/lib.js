// Shared plumbing for the Lifeguard CLI: NEAR calls, Base Sepolia broadcast and finality, Aave reads.
const { connect, keyStores, transactions, utils, KeyPair } = require('near-api-js');
const { ethers } = require('ethers');
const os = require('os'), path = require('path'), fs = require('fs');

const STATE_FILE = path.resolve(process.env.LIFEGUARD_STATE || path.join(__dirname, '.keys', 'deployment.json'));
const NEAR_RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com'; // the public near.org endpoint takes 3–6 s per call
const base = new ethers.JsonRpcProvider(process.env.BASE_RPC || 'https://sepolia.base.org');
const credentials = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));

const BASE = {
  chainId: 84532,
  explorer: 'https://sepolia.basescan.org/tx/',
  pool: '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
  faucet: '0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc',
  usdc: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f',
  cbeth: '0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B',
};
const NEAR_EXPLORER = 'https://testnet.nearblocks.io/txns/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE)) : {});
function save(patch) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...patch }, null, 1), { mode: 0o600 });
}

const nearConnection = (keyStore = credentials) => connect({ networkId: 'testnet', nodeUrl: NEAR_RPC, keyStore });
const ownerAccount = async () => (await nearConnection()).account(state().owner);

/** The agent signs as the owner's account, but only with its function-call key. */
async function agentAccount(owner = state().owner) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', owner, KeyPair.fromString(state().agentKey));
  return (await nearConnection(keyStore)).account(owner);
}

function failureText(failure) {
  const kind = failure.ActionError?.kind;
  return kind?.FunctionCallError?.ExecutionError || JSON.stringify(kind || failure);
}

/** Sends one function call and waits for its final outcome (MPC yield/resume takes seconds). */
async function call(account, contractId, method, args, { deposit = 0n, gas = 300_000_000_000_000n } = {}) {
  const provider = account.connection.provider;
  let txHash;
  account.accessKeyByPublicKeyCache = {}; // near-api-js caches the key nonce; a cached one goes stale after a failure
  try {
    const [hash, signed] = await account.signTransaction(contractId, [transactions.functionCall(method, args, gas, deposit)]);
    txHash = utils.serialize.base_encode(hash);
    await provider.sendTransactionUntil(signed, 'INCLUDED'); // an invalid tx (e.g. access-key mismatch) fails here
  } catch (e) {
    return { txHash, error: e.type ? `${e.type}: ${e.message}` : e.message }; // rejected before execution
  }
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    let out;
    try { out = await provider.txStatus(txHash, account.accountId, 'FINAL'); } catch { continue; }
    if (out.status.SuccessValue !== undefined) {
      const v = out.status.SuccessValue;
      return { txHash, value: v ? JSON.parse(Buffer.from(v, 'base64').toString()) : null };
    }
    if (out.status.Failure) return { txHash, error: failureText(out.status.Failure) };
  }
  return { txHash, error: 'timed out waiting for the NEAR transaction' };
}

const view = async (method, args = {}) => (await ownerAccount()).viewFunction({ contractId: state().contract, methodName: method, args });

/** Fee caps the contract will accept, from current Base Sepolia fees. */
async function fees(gasLimit = 300000) {
  const f = await base.getFeeData();
  return {
    max_fee_per_gas: (f.maxFeePerGas * 2n).toString(),
    max_priority_fee_per_gas: (f.maxPriorityFeePerGas || 1000000n).toString(),
    gas_limit: String(gasLimit),
  };
}

/** Broadcasts a signed transaction and waits until Base marks its block `safe`. */
async function broadcastAndWaitSafe(raw) {
  let hash;
  try {
    hash = (await base.broadcastTransaction(raw)).hash;
  } catch (e) {
    hash = ethers.keccak256(raw);
    if (!/already known|nonce too low/i.test(e.message)) throw e;
    if (/nonce too low/i.test(e.message) && !(await base.getTransactionReceipt(hash))) {
      throw new Error('This nonce was used by another transaction; prove that one first (node cli.js confirm) or reset the nonce');
    }
  }
  const receipt = await base.waitForTransaction(hash, 1, 240000);
  for (;;) {
    const safe = await base.getBlock('safe');
    if (safe && safe.number >= receipt.blockNumber) break;
    await sleep(4000);
  }
  return receipt;
}

const aave = new ethers.Contract(BASE.pool, [
  'function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
], base);
const erc20 = (a) => new ethers.Contract(a, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], base);

async function account(address) {
  const d = await aave.getUserAccountData(address);
  return {
    healthFactor: d.healthFactor > 10n ** 30n ? Infinity : Number(ethers.formatUnits(d.healthFactor, 18)),
    collateralUsd: Number(ethers.formatUnits(d.totalCollateralBase, 8)),
    debtUsd: Number(ethers.formatUnits(d.totalDebtBase, 8)),
    availableBorrowsUsd: Number(ethers.formatUnits(d.availableBorrowsBase, 8)),
    liquidationThreshold: Number(d.currentLiquidationThreshold) / 10000,
    eth:Number(ethers.formatEther(await base.getBalance(address))),
    usdc: Number(ethers.formatUnits(await erc20(BASE.usdc).balanceOf(address), 6)),
    usdcAllowance: Number(ethers.formatUnits(await erc20(BASE.usdc).allowance(address, BASE.pool), 6)),
    cbeth: Number(ethers.formatUnits(await erc20(BASE.cbeth).balanceOf(address), 18)),
    cbethAllowance: Number(ethers.formatUnits(await erc20(BASE.cbeth).allowance(address, BASE.pool), 18)),
  };
}

const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const ATTACK_GAS = 10_000_000_000_000n; // every attack fails before the MPC call; the key's allowance is charged for prepaid gas

/** What a compromised agent would try with its key. Each must fail. The CLI red team and the web server both run this list. */
function attacks(s, f) {
  const borrow = new ethers.Interface(['function borrow(address,uint256,uint256,uint16,address)'])
    .encodeFunctionData('borrow', [BASE.usdc, 10n ** 9n, 2, 0, s.address]);
  const act = (acct, action, fs = f) => call(acct, s.contract, 'request_action', { id: s.position, action, fees: fs }, { gas: ATTACK_GAS });
  return [
    { name: 'Borrow through owner_action', short: 'Raw borrow call', detail: 'Borrow 1,000 USDC with a raw Aave call', run: (a) => call(a, s.contract, 'owner_action', { id: s.position, to: BASE.pool, value: '0', data: borrow, fees: f }, { gas: ATTACK_GAS }) },
    { name: 'Borrow as an agent action', short: 'Borrow 1,000 USDC', detail: 'Ask the contract for a Borrow action', run: (a) => act(a, { Borrow: { asset: BASE.usdc, amount: '1000000000' } }) },
    { name: 'Withdraw as an agent action', short: 'Withdraw collateral', detail: 'Pull the cbETH collateral out', run: (a) => act(a, { Withdraw: { asset: BASE.cbeth, amount: '1' } }) },
    { name: 'Approve far above the cap', short: 'Approve unlimited', detail: 'Approve 10^24 USDC to the Pool', run: (a) => act(a, { Approve: { asset: BASE.usdc, amount: (10n ** 30n).toString() } }) },
    { name: 'Supply an unlisted token', short: 'Unlisted token', detail: `Supply a token at ${ATTACKER.slice(0, 6)}…${ATTACKER.slice(-4)}`, run: (a) => act(a, { Supply: { asset: ATTACKER, amount: '1' } }) },
    { name: 'Drain gas with a huge fee', short: 'Huge gas fee', detail: 'Repay 1 unit at 1,000,000 gwei per gas', run: (a) => act(a, { Repay: { asset: BASE.usdc, amount: '1' } }, { ...f, max_fee_per_gas: (10n ** 15n).toString() }) },
    { name: 'Rewind the nonce', short: 'Rewind the nonce', detail: 'Reset the loan\'s nonce to 0', run: (a) => call(a, s.contract, 'reset_nonce', { id: s.position, nonce: '0' }, { gas: ATTACK_GAS }) },
    { name: 'Send the owner\'s NEAR away', short: 'Send NEAR away', detail: 'Transfer 0.01 NEAR to another account', run: async (a) => {
      try { await a.sendMoney('lifeguard-attacker.testnet', 10n ** 22n); return { value: 'sent' }; } catch (e) { return { error: `${e.type || ''} ${e.message}`.trim() }; }
    } },
  ];
}

/** Which layer refused a request: NEAR rejects a disallowed access-key use before execution; anything else failed inside the contract. */
const refusedBy = (error) => (/MethodNameMismatch|NotEnoughAllowance|RequiresFullAccess|ReceiverMismatch|KeyNotFound|access key/i.test(error) ? 'NEAR access key' : 'Lifeguard contract');

module.exports = { BASE, NEAR_EXPLORER, base, call, view, fees, broadcastAndWaitSafe, account, state, save, nearConnection, ownerAccount, agentAccount, credentials, sleep, attacks, refusedBy };
