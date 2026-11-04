# Lifeguard

**Lifeguard: an AI agent that can rescue your Aave loan but can never put it at risk, enforced by NEAR.**

An Aave loan on Base Sepolia, held at an address that NEAR chain signatures control. An agent holding only a NEAR function-call key repaid 1,000 USDC on it:

<!-- evidence:rescue -->

| | Health factor | Debt |
|---|---|---|
| Before | 1.081 | $2,023 |
| After the agent's repay | **2.137** | $1,023 |

<!-- /evidence -->

<!-- evidence:autonomous -->

Then, with nobody touching it, on 2 Nov 2026: `agent/keeper.js` saw health factor 1.119, asked `z-ai/glm-5.3-flash` on NEAR AI how much to repay, and repaid 1,000 USDC through the same contract in 3 min 40 s.

| | Health factor | Debt |
|---|---|---|
| Before | 1.119 | $1,972 |
| After the keeper's repay | **2.269** | $973 |

[Signed by NEAR](https://testnet.nearblocks.io/txns/4HG5yznzx6QYQs72UGM1M738H1LaCMpNFXmfKeECaawQ) · [mined on Base](https://sepolia.basescan.org/tx/0xa215b56918dfe25bc939ef00820e7451dfd572b2322f3604c08e20244023510a) · [confirmed by Read MPC](https://testnet.nearblocks.io/txns/58LLyAtncWQvgjzeYNKok1Et8sYAGv9KwJb1Zc2HdUet)

The model's decision was signed inside its enclave. To check it: `cd agent && node verify-decision.js decisions/f4e83f302f824c848b4b960a4e394188.json`

<!-- /evidence -->

The same key tried eight ways to hurt the position. All eight were refused.

Built for NEAR HACKATHON (tracks: AI Security & Defense, Unstoppable DeFi, Agent Economy). Work started on 29 Oct 2026; the rules count code written from the 19 Oct announcement. All the evidence on this page was recorded inside the 1–14 Nov window.

## Use it

Open **https://lifeguard.timidan.xyz** (NEAR testnet and Base Sepolia; no real funds).

1. **Attack the agent.** On [the test loan](https://lifeguard.timidan.xyz/app?position=0), press *Send with the agent's key* on any of the eight attacks. You'll see which layer refused it, the exact error, and the failed transaction on NEAR. The server sends each attack with the agent's real key.
2. **Protect a loan of your own.** On [the app](https://lifeguard.timidan.xyz/app), connect a NEAR testnet wallet (Meteor or MyNEARWallet).
   - *Open loan*: one approval of 0.05 NEAR. It creates your position and gives Lifeguard's agent a key that can only call `request_action` and `confirm`.
   - The server then funds Base gas, gets 1 test cbETH and has the agent supply it. That takes about 10 minutes, mostly waiting for Base to mark blocks `safe` and for Read MPC to confirm each step.
   - *Borrow 1,000 USDC*: one more approval. The agent then approves USDC for repayments, and the card shows your health factor.
   - *Borrow until the health factor is 1.2*: you push the loan into danger yourself. Within a few minutes the keeper sees it below 1.25, asks a model on NEAR AI how much to repay, and repays; the health factor goes back up and the repay appears under Activity, verified by Read MPC.
3. **Use your own agent over MCP.** Once your loan is ready, the app shows these steps with your position filled in:
   ```sh
   git clone https://github.com/Timidan/lifeguard && cd lifeguard/agent && npm install && cd ..
   node agent/mcp.js init <position> lifeguard-mvxuworb.testnet   # prints a public key
   ```
   Paste that key into *Give it a key* in the app (one wallet approval), then add the server to your client, for example `claude mcp add lifeguard -e LIFEGUARD_STATE=$HOME/.lifeguard/lifeguard-mvxuworb.testnet-<position>.json -- node agent/mcp.js`. Ask it for `get_loan`, then to repay 100 USDC: it signs through the contract and you get the NEAR, Base and Read MPC links. Ask it to borrow or withdraw with `near_call`: NEAR's access key or the contract refuses it, and the tool returns which layer refused and the failed transaction.

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
| Named accounts and cross-contract calls | contract and MPC | The contract's account calls `v1.signer-prod.testnet` |

<!-- evidence:steps -->

## Evidence (testnet, 1 Nov 2026)

Contract: [`lifeguard-mvxuworb.testnet`](https://testnet.nearblocks.io/address/lifeguard-mvxuworb.testnet). Position 0's Base address: [`0xd6cab70b6781f8d79a2dbb7d94ef37b6128cb719`](https://sepolia.basescan.org/address/0xd6cab70b6781f8d79a2dbb7d94ef37b6128cb719).

| Step | Who | Signed by NEAR | Mined on Base | Proven by Read MPC |
|---|---|---|---|---|
| Mint 1 cbETH | owner | [4r9zN8fw…](https://testnet.nearblocks.io/txns/4r9zN8fwMMj7TWYJYT2QPXdAaxHQkh6S1cRPxZDkwJtM) | [0x795c…9990](https://sepolia.basescan.org/tx/0x795c1ded9b035ecace64e3f3699fc48b3a5ae4e7e1f0496e451d6fdcf8509990) | [Fs4PCt2M…](https://testnet.nearblocks.io/txns/Fs4PCt2M4ygZbxmYbfAe5UcLqn3drLAR1VawntRdBQtF) |
| Mint 1,000 USDC | owner | [ESUrZqtT…](https://testnet.nearblocks.io/txns/ESUrZqtTVqSQRpendHxKfD4N2kEfMDhvzbnJNCtar1VD) | [0x5a6d…551c](https://sepolia.basescan.org/tx/0x5a6d70c14aed02aff494c623583999576460cec98259dd5875ef5e5972c1551c) | [EHhadJZ4…](https://testnet.nearblocks.io/txns/EHhadJZ4QQPAdvnAYmi25qxLs1fAQWXWvKZ6XBRV1F4H) |
| Approve cbETH to the Pool | agent | [3idNyGw5…](https://testnet.nearblocks.io/txns/3idNyGw5KUB36mKafUQvTD3NqwXnorbHj8XCpyFBy4ui) | [0xc504…0061](https://sepolia.basescan.org/tx/0xc504b3d9d2410ce22b29bbca26769af5d75e2e7cf5162703481768dfb22d0061) | [6UV84mkY…](https://testnet.nearblocks.io/txns/6UV84mkYj96UATXHQvWV5d6fiVkoN7uvMoQRLwGr1FLp) |
| Supply 1 cbETH | agent | [5Urxad9K…](https://testnet.nearblocks.io/txns/5Urxad9KBdK9CYzLohhw23ssjZd9212wNYB8EGDoTQ9p) | [0xc5f7…0962](https://sepolia.basescan.org/tx/0xc5f7c300763f37ad5ad7efd220950456708b01b539e20634defb3d64c29a0962) | [FjbFAgG6…](https://testnet.nearblocks.io/txns/FjbFAgG6gQUfCTxDbYz2GuJEkZ9Uz6iiFtDrGGCrczvi) |
| Borrow 2,023 USDC (HF → 1.081) | owner | [BHdZk6wj…](https://testnet.nearblocks.io/txns/BHdZk6wjvyuAgm3itFghi4EgwcuCAhtAejenyMWasv3p) | [0xbf2b…ff7b](https://sepolia.basescan.org/tx/0xbf2b0b12578655e940475659b6aad2f4a9670ce959254816cecd513c93f0ff7b) | [CPM2kyBW…](https://testnet.nearblocks.io/txns/CPM2kyBWq5NyN7ny9WE3nVfu1dgpzeXjqARrHzgdG7Dj) |
| Approve USDC to the Pool | agent | [HYcqupxd…](https://testnet.nearblocks.io/txns/HYcqupxdca7qDRHtiFQSb5iZsG7TBJgR5kj7ASd73uMv) | [0x251f…e352](https://sepolia.basescan.org/tx/0x251f188b8fdfb78e45be3cdc5a4acf2be87d7a1577bbda7c911b88ce7d7ce352) | [93GDtzCq…](https://testnet.nearblocks.io/txns/93GDtzCqmzLTagqNsxGrorQokJHucVR1pp3i7HKSgftk) |
| **Repay 1,000 USDC (HF 1.081 → 2.137)** | **agent** | [7SLhiw7E…](https://testnet.nearblocks.io/txns/7SLhiw7EHzLyXAkEvkhucWau8A2mahbgpXUBsrT9tyEg) | [0xbe1c…9984](https://sepolia.basescan.org/tx/0xbe1c57d14f562fe77741a20d9c55c3fe4234f8b9f215cf41c3a95870529c9984) | [6tK8vGgy…](https://testnet.nearblocks.io/txns/6tK8vGgy6R7YPVjfoRRXgyMSHPzDeSV7jpDS8znuch96) |

<!-- /evidence -->

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

## Check it yourself

You need Rust, Node 22 and Foundry. None of these steps needs funds.

1. **Check the transaction builder against real transactions.** Run `cd contract && cargo test`. You'll see 11 tests pass. One rebuilds two transactions that NEAR chain signatures signed and Ethereum Sepolia mined, and matches the signing hash and the transaction hash byte for byte. The others check the calldata, the derived address, the proof path and that disallowed requests are refused.
2. **Check the core safety claim.** Run `cd killtests/hf-claim && forge test -vv`. You'll see 3 tests pass on a fork of Base Sepolia's Aave V3 Pool. Each allowed action, in a healthy state, a liquidatable state and a state below the liquidation threshold, either raises the health factor or reverts.
3. **Check the rescue on the explorers.** Open the repay row in the evidence table:
   - the NEAR transaction shows `request_action`, then a call to `v1.signer-prod.testnet` `sign`;
   - the Base transaction shows Aave `repay` from the position's address;
   - the proof transaction shows `confirm`, then `verify_foreign_transaction`, then `on_confirmed` returning `true`.
4. **Read the position's state on NEAR.** Run `cd agent && npm install && node cli.js status`. You'll see the position's `nonce`, its health factor from Aave, and the history with `proven: true` on every step. This needs `agent/.keys/deployment.json`; otherwise read `get_position {"id":0}` on the explorer.

## Run your own

- `cd contract && cargo near build non-reproducible-wasm`
- `cd agent && npm install && node cli.js loop`. It creates a new owner and contract from the testnet faucet, opens a position, gives the agent its key, and prints the position's Base address.
- Send that address a little Base Sepolia ETH and run `node cli.js loop` again. In about 25 minutes it mints test tokens, supplies cbETH, borrows to a health factor of 1.08, has the agent repay 1,000 USDC, and runs the red team. If it stops part-way, run it again: it picks up from the position's nonce.
- `node cli.js evidence` rewrites the evidence above and the site's recorded rescue from the chain. Rebuild the site to show it: `cd web && npm run build`.

## Limitations, by design

- **Testnet only.** NEAR testnet and Base Sepolia, with Aave test tokens. Read MPC and chain signatures work the same way on mainnet; this entry spends no real funds.
- **Base and Aave V3 only.** E-mode and isolation-mode positions are not covered by the fork test yet.
- **The owner's full-access key is trusted.** `owner_action` can sign anything. That is the point: the agent's key is not the owner's.
- **Proofs are slower than signing.** Read MPC is called after Base marks the block `safe`, which took between 30 s and 3.5 minutes when measured, and the MPC network's view of `safe` can lag. The relayer waits 45 s and retries.
- **A reverted transaction is never proven.** The owner can reset the nonce (`reset_nonce`).
- **The model sizes the repay; it does not decide what is allowed.** The keeper's rule triggers below health factor 1.25 and computes the amount to reach 1.9; the model on NEAR AI only adds a buffer of 0 to 25%, and a bad answer falls back to the rule. The contract still checks every action.
- **One relayer.** The hosted server broadcasts transactions and asks Read MPC to confirm them, and the keeper serves positions one after another. Anyone can relay, because signed transactions and proofs are public.
- **If you revoke Lifeguard's key**, the keeper stops serving your loan and the server can no longer confirm for it; your own agent or the CLI can still call `confirm`.

## Repository

- `contract/`: the NEAR contract in Rust (near-sdk 5.30). `src/evm.rs` holds the RLP encoder, the EIP-1559 hashing and the Aave calldata builders.
- `agent/`: Node, near-api-js 5.1.1, ethers 6.13.4.
  - `server.js`: the site's API. It prepares the transactions your wallet signs, runs the loan setup with Lifeguard's key, relays and confirms, and sends the eight attacks.
  - `keeper.js`: watches every position that gave Lifeguard its key and repays below health factor 1.25. `node keeper.check.js` tests its rule.
  - `mcp.js`: the MCP server for your own agent.
  - `verify-decision.js`: checks the enclave signature on a saved model decision.
  - `cli.js`: deploy, the full scripted loop, the red team and the evidence writer.
- `web/`: the landing page and the app (Vite + React, NEAR Wallet Selector). Build it with `cd web && npm install && npm run build`, then run `node agent/server.js` and open `http://127.0.0.1:8740`. The server holds Lifeguard's key; the browser never sees it.
- `killtests/`: the experiments that de-risked the idea before the build (Aave health-factor fork test, Read MPC timing and payload hash, chain-signature broadcast).

Libraries: near-sdk, bs58, near-api-js, ethers, NEAR Wallet Selector, React, Vite, Tailwind, forge-std. Code was written with AI coding assistance, from 29 Oct 2026.

License: MIT.
