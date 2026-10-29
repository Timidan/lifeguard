// Lifeguard kill test 3: NEAR chain signatures sign an EIP-1559 transaction for Base Sepolia.
// Derives the Base address for (account, path), builds an Aave supply transaction, asks the MPC
// network to sign its hash, and checks the signature recovers to the derived address.
const { connect, keyStores, transactions, utils } = require('near-api-js');
const { ethers } = require('ethers');
const os = require('os'), path = require('path'), fs = require('fs');

const ACCOUNT = process.argv[2], PATH = 'lifeguard/position-1', MPC = 'v1.signer-prod.testnet';
const base = new ethers.JsonRpcProvider('https://sepolia.base.org');
const POOL = '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27', USDC = '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f';

(async () => {
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org',
    keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials')) });
  const account = await near.account(ACCOUNT);

  // 1. Derived Base address
  const pk = await account.viewFunction({ contractId: MPC, methodName: 'derived_public_key',
    args: { path: PATH, predecessor: ACCOUNT, domain_id: 0 } });
  const raw = utils.serialize.base_decode(pk.split(':')[1]); // 64-byte uncompressed point, no 0x04 prefix
  const address = ethers.getAddress('0x' + ethers.keccak256(raw).slice(-40));
  console.log('derived', pk.slice(0, 24) + '…', '->', address);

  // 2. EIP-1559 tx: Aave supply(USDC, 1, address, 0)
  const data = new ethers.Interface(['function supply(address,uint256,address,uint16)'])
    .encodeFunctionData('supply', [USDC, 1n, address, 0]);
  const fee = await base.getFeeData();
  const tx = ethers.Transaction.from({ type: 2, chainId: 84532, nonce: await base.getTransactionCount(address),
    to: POOL, data, value: 0n, gasLimit: 300000n, maxFeePerGas: fee.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 1000000n });
  const digest = tx.unsignedHash;

  // 3. MPC sign
  const args = { request: { path: PATH, payload_v2: { Ecdsa: digest.slice(2) }, domain_id: 0 } };
  const [hash, signed] = await account.signTransaction(MPC, [transactions.functionCall('sign', args, 300_000_000_000_000n, 1n)]);
  const txHash = utils.serialize.base_encode(hash), t0 = Date.now();
  await near.connection.provider.sendTransactionAsync(signed);
  let out;
  for (let i = 0; i < 120; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    try { out = await near.connection.provider.txStatus(txHash, ACCOUNT, 'FINAL'); } catch { continue; }
    if (out.status && (out.status.SuccessValue !== undefined || out.status.Failure)) break;
  }
  const seconds = (Date.now() - t0) / 1000;
  if (!out || !out.status.SuccessValue) { console.log(JSON.stringify(out && out.status)); process.exit(1); }
  const sig = JSON.parse(Buffer.from(out.status.SuccessValue, 'base64').toString());

  // 4. Recover
  tx.signature = { r: '0x' + sig.big_r.affine_point.slice(2), s: '0x' + sig.s.scalar, yParity: sig.recovery_id };
  const ok = tx.from === address;
  const res = { seconds, nearTx: txHash, derivedAddress: address, recovered: tx.from, match: ok, baseTxHash: tx.hash, rawSigned: tx.serialized };
  console.log(JSON.stringify({ ...res, rawSigned: tx.serialized.slice(0, 40) + '…' }, null, 1));
  fs.writeFileSync('sign-result.json', JSON.stringify(res, null, 1));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
