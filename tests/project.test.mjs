import {test} from 'node:test';import assert from 'node:assert/strict';
import {illustrativeQuote} from '../src/quote.mjs';
test('fee and network cost reconcile, including rounding',()=>{
  const q=illustrativeQuote(2000001n,5000n);assert.equal(q.fee,360000n);
  assert.equal(q.net+q.fee+q.networkCost,q.gross);assert.throws(()=>illustrativeQuote(-1n));
});
