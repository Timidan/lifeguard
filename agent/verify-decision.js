#!/usr/bin/env node
// Checks a saved model decision: the enclave's signature covers these exact bytes, and NEAR AI's attestation report names its signer.
const crypto = require('node:crypto'), fs = require('node:fs');
const { ethers } = require('ethers');

const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

(async () => {
  const { text, signature, signing_address: signer, signature_kind: kind } = d.signature;
  const nonce = crypto.randomBytes(32).toString('hex');
  const report = await (await fetch(`https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(d.model)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`)).json();
  const checks = {
    'signed by the model enclave': kind === 'provider_tee',
    'signature covers these bytes': text === `${d.model}:${sha256(d.request)}:${sha256(d.response)}`,
    'signature recovers the signer': ethers.verifyMessage(text, signature).toLowerCase() === signer.toLowerCase(),
    "signer is in today's attestation report": report.model_attestations.some((m) => m.signing_address.toLowerCase() === signer.toLowerCase()),
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
  console.log(`The model saw: ${JSON.parse(d.request).messages.at(-1).content}`);
  console.log(`The model said: ${JSON.parse(d.response).choices[0].message.content.replace(/\s+/g, ' ')}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
})();
