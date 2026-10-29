// Recomputes Read MPC's payload_hash for a Base log: sha256(borsh(ForeignTxSignPayload::V1 { request, values })).
// Layout from near/mpc crates/near-mpc-contract-interface/src/types/foreign_chain.rs (enum indices = declaration order).
// If this matches the MPC's hash, a NEAR contract can compute `expected_payload_hash` from a relayer-supplied log.
const crypto = require('crypto'), fs = require('fs');

const r = JSON.parse(fs.readFileSync(process.argv[2] || 'result.json'));
const L = r.rawLog, ext = r.args.request.request.Base;
const out = [];
const u8 = (n) => out.push(Buffer.from([n]));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); out.push(b); };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); out.push(b); };
const hex = (h) => out.push(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const str = (s) => { const b = Buffer.from(s, 'utf8'); u32(b.length); out.push(b); };

u8(0);                     // ForeignTxSignPayload::V1
u8(6);                     // ForeignChainRpcRequest::Base
hex(ext.tx_id);            // EvmTxId [u8; 32]
u32(ext.extractors.length);
for (const e of ext.extractors) { u8(1); u64(e.Log.log_index); } // EvmExtractor::Log { log_index }
u8({ Latest: 0, Safe: 1, Finalized: 2 }[ext.finality]);
u32(1);                    // values: Vec<ExtractedValue>
u8(1); u8(1);              // ExtractedValue::EvmExtractedValue, EvmExtractedValue::Log
u8(L.removed ? 1 : 0);
u64(parseInt(L.logIndex, 16)); u64(parseInt(L.transactionIndex, 16));
hex(L.transactionHash); hex(L.blockHash); u64(parseInt(L.blockNumber, 16));
hex(L.address); str(L.data);
u32(L.topics.length); L.topics.forEach(hex);

const got = crypto.createHash('sha256').update(Buffer.concat(out)).digest('hex');
console.log('recomputed', got, '\nmpc       ', r.response.payload_hash, '\nmatch', got === r.response.payload_hash);
process.exit(got === r.response.payload_hash ? 0 : 1);
