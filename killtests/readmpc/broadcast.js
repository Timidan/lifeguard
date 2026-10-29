// Lifeguard kill test 3b: broadcast a NEAR-chain-signed transaction on an EVM chain.
// Signs a transaction from the derived address (default: 0-value self-transfer) and waits for the receipt.
// Optional args: to, value in wei, calldata, gas limit.
const { connect, keyStores, transactions, utils } = require('near-api-js');
const { ethers } = require('ethers');
const os = require('os'), path = require('path'), fs = require('fs');

const [ACCOUNT, RPC, TO, VALUE_WEI = '0', DATA = '0x', GAS = '21000'] = process.argv.slice(2);
const PATH = 'lifeguard/position-1', MPC = 'v1.signer-prod.testnet';

(async () => {
  const evm = new ethers.JsonRpcProvider(RPC);
  const { chainId } = await evm.getNetwork();
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org',
    keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials')) });
  const account = await near.account(ACCOUNT);
  const pk = await account.viewFunction({ contractId: MPC, methodName: 'derived_public_key', args: { path: PATH, predecessor: ACCOUNT, domain_id: 0 } });
  const address = ethers.getAddress('0x' + ethers.keccak256(utils.serialize.base_decode(pk.split(':')[1])).slice(-40));

  const fee = await evm.getFeeData();
  const tx = ethers.Transaction.from({ type: 2, chainId, nonce: await evm.getTransactionCount(address), to: TO || address, value: BigInt(VALUE_WEI), data: DATA,
    gasLimit: BigInt(GAS), maxFeePerGas: fee.maxFeePerGas * 2n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 1000000n });

  const args = { request: { path: PATH, payload_v2: { Ecdsa: tx.unsignedHash.slice(2) }, domain_id: 0 } };
  const [hash, signed] = await account.signTransaction(MPC, [transactions.functionCall('sign', args, 300_000_000_000_000n, 1n)]);
  const nearTx = utils.serialize.base_encode(hash);
  await near.connection.provider.sendTransactionAsync(signed);
  let out;
  for (let i = 0; i < 120; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    try { out = await near.connection.provider.txStatus(nearTx, ACCOUNT, 'FINAL'); } catch { continue; }
    if (out.status && (out.status.SuccessValue !== undefined || out.status.Failure)) break;
  }
  const sig = JSON.parse(Buffer.from(out.status.SuccessValue, 'base64').toString());
  tx.signature = { r: '0x' + sig.big_r.affine_point.slice(2), s: '0x' + sig.s.scalar, yParity: sig.recovery_id };
  if (tx.from !== address) throw new Error('recovered ' + tx.from);

  const sent = await evm.broadcastTransaction(tx.serialized);
  const receipt = await sent.wait(1, 180000);
  const res = { chainId: Number(chainId), from: address, nearTx, evmTx: receipt.hash, block: receipt.blockNumber, status: receipt.status };
  console.log(JSON.stringify(res, null, 1));
  fs.writeFileSync(`broadcast-${chainId}-${receipt.hash.slice(2, 10)}.json`, JSON.stringify(res, null, 1));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
