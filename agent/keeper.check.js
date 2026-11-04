const assert = require('node:assert/strict');
const { decide, sizeRepay } = require('./keeper');

const state = { healthFactor: 1.14, debtUsd: 1000, usdc: 1000, pending: [], now: 600000 };
assert.deepEqual(decide({ ...state, healthFactor: 1.3 }), { action: 'skip', reason: 'healthy', amount: 0 });
assert.deepEqual(decide(state), { action: 'repay', reason: 'below_trigger', amount: 400 });
assert.deepEqual(decide({ ...state, usdc: 25 }), { action: 'repay', reason: 'balance_limited', amount: 25 });
assert.deepEqual(decide({ ...state, pending: [{ tx_hash: 'pending' }] }), { action: 'skip', reason: 'pending_transaction', amount: 0 });
assert.deepEqual(decide({ ...state, lastActionAt: 599000 }), { action: 'skip', reason: 'cooldown', amount: 0 });
const rule = { action: 'repay', reason: 'below_trigger', amount: 400 };
const loan = { healthFactor: 1.14, debtUsd: 1000, usdc: 1000 };
const reason = 'Health factor 1.14 and falling for two minutes, so a 10% buffer.';
assert.deepEqual(sizeRepay(rule, loan, { buffer_percent: 10, reason }),
  { action: 'repay', reason, amount: 440, bufferPercent: 10, expectedHealthFactor: 2.036, decidedBy: 'model' });
assert.equal(sizeRepay(rule, loan, { buffer_percent: 90, reason }).modelRejected, 'buffer_out_of_range');
assert.equal(sizeRepay(rule, { ...loan, usdc: 420 }, { buffer_percent: 25, reason }).amount, 420);
console.log('keeper checks passed');
