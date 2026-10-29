// Same Read MPC request as result.json, but with a wrong expected_payload_hash. Lifeguard needs this to fail.
const { connect, keyStores, transactions, utils } = require('near-api-js');
const os = require('os'), path = require('path'), fs = require('fs');
const ACCOUNT = process.argv[2], r = JSON.parse(fs.readFileSync('result.json'));
(async () => {
  const wrong = r.response.payload_hash.slice(0, 63) + (r.response.payload_hash.endsWith('0') ? '1' : '0');
  const args = { request: { ...r.args.request, expected_payload_hash: wrong } };
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org',
    keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials')) });
  const account = await near.account(ACCOUNT);
  const [hash, signed] = await account.signTransaction('v1.signer-prod.testnet',
    [transactions.functionCall('verify_foreign_transaction', args, 300_000_000_000_000n, 1n)]);
  const txHash = utils.serialize.base_encode(hash), t0 = Date.now();
  await near.connection.provider.sendTransactionAsync(signed);
  let out;
  for (let i = 0; i < 150; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    try { out = await near.connection.provider.txStatus(txHash, ACCOUNT, 'FINAL'); } catch { continue; }
    if (out.status && (out.status.SuccessValue !== undefined || out.status.Failure)) break;
  }
  const res = { nearTx: txHash, seconds: (Date.now() - t0) / 1000, status: out && out.status };
  console.log(JSON.stringify(res, null, 1).slice(0, 1500));
  fs.writeFileSync('negative-result.json', JSON.stringify(res, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
