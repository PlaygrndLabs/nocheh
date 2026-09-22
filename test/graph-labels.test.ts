import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceNodeLabel} from '../src/graph-labels.js';

test('textless evidence labels expose kind and a stable identity',()=>{
  const first='2a36c7ad35b8cffcc4225dcdb1ffd50011d978478e0037da147a14f35e3f5c3f';
  const second='57d1ffd76c4626ba1a278fedfbe58069fc077f4ea011cce2dd63e725481fdef3';
  assert.equal(evidenceNodeLabel(null,'outbound_result',first),'Outbound result · 2a36c7ad');
  assert.equal(evidenceNodeLabel('', 'outbound_result',second),'Outbound result · 57d1ffd7');
  assert.notEqual(evidenceNodeLabel(null,'outbound_result',first),evidenceNodeLabel(null,'outbound_result',second));
  assert.equal(evidenceNodeLabel('Original text','telegram_update',first),'Original text');
});
