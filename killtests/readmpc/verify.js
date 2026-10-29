// Lifeguard kill test 2: call NEAR Read MPC (verify_foreign_transaction) on a real Base Sepolia
// USDC Transfer log from a throwaway testnet account, and time the yield/resume.
const { connect, keyStores, transactions, utils } = require('near-api-js');
const os = require('os'), path = require('path'), fs = require('fs');

const ACCOUNT = process.argv[2];
const MPC = 'v1.signer-prod.testnet';
const BASE_RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Circle USDC on Base Sepolia
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const rpc = async (method, params) => {
  const r = await fetch(BASE_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};
const num = (h) => parseInt(h, 16);

(async () => {
  // Base Sepolia finality lag
  const [latest, safe, fin] = await Promise.all(['latest', 'safe', 'finalized'].map((t) => rpc('eth_getBlockByNumber', [t, false])));
  const lag = { safeBlocks: num(latest.number) - num(safe.number), safeSec: num(latest.timestamp) - num(safe.timestamp),
    finalizedBlocks: num(latest.number) - num(fin.number), finalizedSec: num(latest.timestamp) - num(fin.timestamp) };
  console.log('Base Sepolia lag', lag);

  // A USDC Transfer already at Safe
  const to = num(safe.number), from = to - 199;
  const logs = await rpc('eth_getLogs', [{ address: USDC, topics: [TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  if (!logs.length) throw new Error('no USDC transfer in range');
  const log = logs[logs.length - 1];
  console.log('log', { tx: log.transactionHash, block: num(log.blockNumber), logIndex: num(log.logIndex) });

  const args = { request: {
    request: { Base: { tx_id: log.transactionHash.slice(2), extractors: [{ Log: { log_index: num(log.logIndex) } }], finality: 'Safe' } },
    domain_id: 3, payload_version: 1 } };

  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
  const near = await connect({ networkId: 'testnet', keyStore, nodeUrl: 'https://rpc.testnet.near.org' });
  const account = await near.account(ACCOUNT);
  const action = transactions.functionCall('verify_foreign_transaction', args, 300_000_000_000_000n, 1n);
  const [hash, signed] = await account.signTransaction(MPC, [action]);
  const txHash = utils.serialize.base_encode(hash);
  const t0 = Date.now();
  await near.connection.provider.sendTransactionAsync(signed);
  console.log('sent', txHash);

  let out;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { out = await near.connection.provider.txStatus(txHash, ACCOUNT, 'FINAL'); } catch { continue; }
    if (out.status && (out.status.SuccessValue !== undefined || out.status.Failure)) break;
  }
  const secs = (Date.now() - t0) / 1000;
  const result = { seconds: secs, lag, log: { tx: log.transactionHash, logIndex: num(log.logIndex), block: num(log.blockNumber) },
    nearTx: txHash, status: out && out.status };
  if (out && out.status.SuccessValue) result.response = JSON.parse(Buffer.from(out.status.SuccessValue, 'base64').toString());
  console.log(JSON.stringify(result, null, 1));
  fs.writeFileSync('result.json', JSON.stringify({ ...result, rawLog: log, args }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
