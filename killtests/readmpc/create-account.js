// Creates a throwaway NEAR testnet account through the public testnet faucet helper.
// The key is saved to ~/.near-credentials/testnet/<account>.json, never inside the repo.
const { KeyPair, keyStores } = require('near-api-js');
const os = require('os'), path = require('path');

(async () => {
  const accountId = `lifeguard-kt-${Date.now().toString(36)}.testnet`;
  const keyPair = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  console.log('helper status', res.status, (await res.text()).slice(0, 200));
  if (!res.ok) process.exit(1);
  const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
  await store.setKey('testnet', accountId, keyPair);
  console.log('account', accountId);
})();
