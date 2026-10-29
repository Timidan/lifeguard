# Lifeguard

**Lifeguard: an AI agent that can rescue your loan on any chain but can never put it at risk, enforced by NEAR.**

An Aave loan on Base Sepolia, held at an address that NEAR chain signatures control. An agent holding only a NEAR function-call key repaid 1,000 USDC on it:

| | Health factor | Debt |
|---|---|---|
| Before | 1.079 | $2,088 |
| After the agent's repay | **2.064** | $1,089 |

The same key tried eight ways to hurt the position. All eight were refused.

Built for NEAR HACKATHON (tracks: AI Security & Defense, Agent Economy, Unstoppable DeFi). Every line of code was written during the hackathon window.

## The problem

To let an agent protect a loan today, you give a bot your keys or a vendor's smart wallet. Its policy lives off-chain, in a dashboard or a prompt. A prompt-injected or buggy agent can then borrow, withdraw or approve an attacker as easily as it can repay.

## What Lifeguard does

The loan stays on Aave (Base Sepolia) at an EVM address derived by the NEAR MPC network for the Lifeguard contract. The agent never holds that address's key; the contract does, through chain signatures.

The agent can ask the contract for exactly three things: **supply**, **repay**, or **approve the Aave Pool up to a cap**. None of them can lower an Aave health factor (shown on a fork in `killtests/hf-claim`). The contract builds every byte of the Base transaction itself, and only then asks NEAR's MPC network to sign it:
- `onBehalfOf` is fixed to the position;
- the chain id and the `to` address are fixed;
- fees are capped;
- actions are capped per day.

It counts the transaction only after **NEAR Read MPC** proves it succeeded on Base.

```
agent (NEAR function-call key)
  └─ request_action(Repay 1000 USDC) ──► Lifeguard contract on NEAR
                                          builds the EIP-1559 tx itself
                                          └─ v1.signer-prod.testnet.sign ──► signature (chain signatures)
relayer broadcasts the signed tx ──► Base Sepolia: Aave repay executes
relayer waits for Base `safe` ──► confirm(tx_hash)
                                    └─ v1.signer-prod.testnet.verify_foreign_transaction (Read MPC)
                                       proves the tx succeeded ──► nonce advances, action recorded
```

### Two layers stop the agent, and both are visible

The contract cannot tell a function-call key from a full-access key: both arrive as the owner's account. So enforcement has two layers:

1. **NEAR's protocol.** The agent's access key allows only `request_action` and `confirm` on the Lifeguard contract. NEAR itself rejects anything else: `owner_action`, `reset_nonce`, transfers.
2. **The contract.** `request_action` accepts only `Supply`, `Repay` and `Approve`. Borrow and withdraw cannot even be expressed. Every byte of calldata is built in the contract, so no raw transaction from the agent ever reaches the signer.

## NEAR features used

| Feature | Where | What it does here |
|---|---|---|
| Chain signatures, `sign` (domain 0, secp256k1) | `contract/src/lib.rs` `sign` / `on_signed` | Signs the EIP-1559 transaction the contract built |
| Chain signatures, `derived_public_key` | `create_position` / `on_derived` | The contract fetches its own Base address for `pos/<id>` |
| Read MPC, `verify_foreign_transaction` (domain 3, `Base`, `BlockHash`, `Safe`) | `confirm` / `on_confirmed` | Proves the signed transaction succeeded on Base; reverts are never proven |
| Yield/resume (inside MPC `sign` and `verify_foreign_transaction`) | promise callbacks | The NEAR call resumes when the MPC network answers (10–22 s measured) |
| Function-call access keys | `agent/cli.js agent-key` | The agent's key is limited to `request_action` and `confirm` on this contract |
| Named accounts and cross-contract calls | contract and MPC | `lifeguard-mvtx9n46.testnet` calls `v1.signer-prod.testnet` |

## Evidence (testnet, 29 Oct 2026)

Contract: [`lifeguard-mvtx9n46.testnet`](https://testnet.nearblocks.io/address/lifeguard-mvtx9n46.testnet). Position 0's Base address: [`0x1a373d9b5676d82b5dd743cae2a4759bcd92cfa0`](https://sepolia.basescan.org/address/0x1a373d9b5676d82b5dd743cae2a4759bcd92cfa0).

| Step | Who | Signed by NEAR | Mined on Base | Proven by Read MPC |
|---|---|---|---|---|
| Approve cbETH to the Pool | agent | [264d9e4h…](https://testnet.nearblocks.io/txns/264d9e4ha6hYu9Vb9jWiaEkxcznGUz3BDHbgELYr5pmX) | [0xe476…6559](https://sepolia.basescan.org/tx/0xe4762abaef1f04783353d7e45ece1637cbc93a3c0a22d578ee1039cf67066559) | [9bWHenL5…](https://testnet.nearblocks.io/txns/9bWHenL5tXAr3xvNDZBnfrJr5BFso1cuW5PBybfAjVnA) |
| Supply 1 cbETH | agent | [7sP1NVq3…](https://testnet.nearblocks.io/txns/7sP1NVq3vHF8DzUS6oVRbnt6hi5kYsYZbrxxW2R7pESC) | [0xfde0…f443](https://sepolia.basescan.org/tx/0xfde05646c65ebe4ac24a58d74e6598f61726d80a50b8823ce92ae2f431fbf443) | [9BiV8qXD…](https://testnet.nearblocks.io/txns/9BiV8qXDCqCWzzfMRoo5CMmeHiLvomM9Z3aRS1JSSQcP) |
| Borrow 2,089 USDC (HF → 1.079) | owner | [BHcH4iJp…](https://testnet.nearblocks.io/txns/BHcH4iJphgwa4CL4e1f1rXA9WwbbmqUwancGwQFzbWfJ) | [0xb5de…2929](https://sepolia.basescan.org/tx/0xb5deadd5e2817c84edce9fe7a13dc664062132ef55f9efb3bfe0051c4b1a2929) | [4UpdrHqR…](https://testnet.nearblocks.io/txns/4UpdrHqRxBvPus9EgHW4fYqHjKu7hye1XCUbYVrJBNa8) |
| Approve USDC to the Pool | agent | [CdEmmAsA…](https://testnet.nearblocks.io/txns/CdEmmAsA3y6sMtnjTkZk8XcGXJCFKmHXjCTXzjBQVzZP) | [0x8ec2…a3ec](https://sepolia.basescan.org/tx/0x8ec2dedade8068eb6c08ebf461e937090e217b7f91763d437593468b5275a3ec) | [39Fk9xK9…](https://testnet.nearblocks.io/txns/39Fk9xK9uzaWB4LU3vyq8e6RweBAWbjwAqSv5QTkSrRe) |
| **Repay 1,000 USDC (HF 1.079 → 2.064)** | **agent** | [9vFSDqMV…](https://testnet.nearblocks.io/txns/9vFSDqMVYyLnERM7JEgGQqH3GaLxpXLVxTEkeAAWACgt) | [0xa5b2…63fd](https://sepolia.basescan.org/tx/0xa5b21591aa7a0e683b995726dbce9e87e66ee7ea8c65ca7fb075c4c2057a63fd) | [9kkjiWgJ…](https://testnet.nearblocks.io/txns/9kkjiWgJDc5Z9h7fhAnG8mTTi4S6gKz6mH9uQ3s3bHJV) |

Red team, with the agent's real key (`node agent/cli.js redteam`):

| Attempt | Stopped by | Error |
|---|---|---|
| Borrow through `owner_action` | NEAR access key | `MethodNameMismatch: … owner_action isn't allowed by the access key` |
| Borrow as an agent action | Lifeguard contract | `unknown variant 'Borrow'` |
| Withdraw as an agent action | Lifeguard contract | `unknown variant 'Withdraw'` |
| Approve far above the cap | Lifeguard contract | `Approve amount above the cap` |
| Supply an unlisted token | Lifeguard contract | `Asset not allowed` |
| Drain gas with a huge fee | Lifeguard contract | `Max fee above the cap` |
| Rewind the nonce | NEAR access key | `MethodNameMismatch: … reset_nonce isn't allowed` |
| Send the owner's NEAR away | NEAR access key | `RequiresFullAccess` |

## Try it

You need Rust, Node 22 and Foundry. None of these steps needs funds.

1. **Check the transaction builder against real transactions.** Run `cd contract && cargo test`. You'll see 11 tests pass. Two of them rebuild transactions that NEAR chain signatures signed and Ethereum Sepolia mined, and they match the signing hash and the transaction hash byte for byte. The others check that every disallowed request is refused.
2. **Check the core safety claim.** Run `cd killtests/hf-claim && forge test -vv`. You'll see 3 tests pass on a fork of Base Sepolia's Aave V3 Pool. Each allowed action, in a healthy state, a liquidatable state and a state below the liquidation threshold, either raises the health factor or reverts.
3. **Check the rescue on the explorers.** Open the repay row in the evidence table:
   - the NEAR transaction shows `request_action`, then a call to `v1.signer-prod.testnet` `sign`;
   - the Base transaction shows Aave `repay` from `0x1a37…cfa0`;
   - the proof transaction shows `confirm`, then `verify_foreign_transaction`, then `on_confirmed` returning `true`.
4. **Read the position's state on NEAR.** Run `cd agent && npm install && node cli.js status`. You'll see `nonce` 7, the health factor read live from Aave, and the history with `proven: true` on every step. This needs `agent/.keys/deployment.json`; otherwise read `get_position {"id":0}` on the explorer.

## Run your own

- `cd contract && cargo near build non-reproducible-wasm`
- `cd agent && npm install && node cli.js deploy <owner.testnet>`. The owner account's key must be in `~/.near-credentials/testnet/`.
- `node cli.js position`, then `node cli.js agent-key`.
- Fund the printed Base Sepolia address with a little ETH, then run `node cli.js owner <faucet> <mint calldata>` and `node cli.js agent supply|repay|approve …`.
- `node cli.js redteam`

## Limitations, by design

- **Testnet only.** NEAR testnet and Base Sepolia, with Aave test tokens. Read MPC and chain signatures work the same way on mainnet; this entry spends no real funds.
- **Base and Aave V3 only.** E-mode and isolation-mode positions are not covered by the fork test yet.
- **The owner's full-access key is trusted.** `owner_action` can sign anything. That is the point: the agent's key is not the owner's.
- **Proofs are slower than signing.** Read MPC is called after Base marks the block `safe` (about 40 s), and the MPC network's view of `safe` can lag. The relayer waits 45 s and retries.
- **A reverted transaction is never proven.** The owner can reset the nonce (`reset_nonce`).
- **The relayer is a CLI**, not a hosted service. Anyone can relay, because signed transactions and proofs are public.

## Repository

- `contract/`: the NEAR contract in Rust (near-sdk 5.30). `src/evm.rs` holds the RLP encoder, the EIP-1559 hashing and the Aave calldata builders.
- `agent/`: the relayer and red-team CLI (Node, near-api-js 5.1.1, ethers 6.13.4).
- `killtests/`: the experiments that de-risked the idea before the build (Aave health-factor fork test, Read MPC timing and payload hash, chain-signature broadcast).

Libraries: near-sdk, bs58, near-api-js, ethers, forge-std. Code was written with AI coding assistance during the hackathon window.

License: MIT.
