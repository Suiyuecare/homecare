import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmployeeRegions, isNormalizedEmployeeRegions, formatEmployeeRegions, serializeEmployeeRegions,
} from '../public/data/employee-regions.js';

test('saved region types, ordering, repeated and empty items remain distinct without changing the source', () => {
  const source = Object.freeze(['北區', '', '北區', '空字串', '  中區\n第二行  ']);
  const normalized = normalizeEmployeeRegions(source);
  assert.notEqual(normalized, source);
  assert.deepEqual(normalized, source);
  assert.equal(normalizeEmployeeRegions('  北區  '), '  北區  ');
  for (const value of [undefined, null, '']) assert.equal(normalizeEmployeeRegions(value), null);
  assert.deepEqual(normalizeEmployeeRegions([]), []);
  assert.notEqual(formatEmployeeRegions([]), formatEmployeeRegions(null));
  assert.notEqual(formatEmployeeRegions(['']), formatEmployeeRegions(['空字串']));
  assert.notEqual(formatEmployeeRegions('北區'), formatEmployeeRegions(['北區']));
  assert.equal(formatEmployeeRegions(source), '保存清單（5 項）\n1. 「北區」\n2. 空字串\n3. 「北區」\n4. 「空字串」\n5. 「  中區\n第二行  」');
  assert.deepEqual(source, ['北區', '', '北區', '空字串', '  中區\n第二行  ']);
});

test('malformed regions expose only the frozen safe tag and cannot collide with saved marker text', () => {
  const malformed = Object.freeze({ secret: Object.freeze({ token: 'MUST-NOT-LEAK' }) });
  const invalid = normalizeEmployeeRegions(malformed);
  assert.deepEqual(invalid, { invalid: true });
  assert.equal(Object.isFrozen(invalid), true);
  for (const value of [null, '字串', '', [], [''], invalid]) assert.equal(isNormalizedEmployeeRegions(value), true);
  for (const value of [undefined, 0, false, ['北區', 1], { invalid: true, secret: 'MUST-NOT-LEAK' }, { invalid: false }]) {
    assert.equal(isNormalizedEmployeeRegions(value), false);
    assert.equal(formatEmployeeRegions(value).includes('MUST-NOT-LEAK'), false);
    assert.equal(serializeEmployeeRegions(value).includes('MUST-NOT-LEAK'), false);
  }
  const literal = '[欄位格式無法判讀]';
  assert.notEqual(formatEmployeeRegions(malformed), formatEmployeeRegions(literal));
  assert.equal(formatEmployeeRegions(literal), `保存文字：${literal}`);
  assert.equal(serializeEmployeeRegions(malformed), literal);
  assert.deepEqual(malformed, { secret: { token: 'MUST-NOT-LEAK' } });
});

test('CSV region projection is reversible for strings and lists including quotes, newlines and formula text', () => {
  const cases = ['=1+1', '文字「引號」\n第二行,"', ['北區', '', '北區', '\n換行', '"引號"', '=1+1'], []];
  for (const source of cases) {
    const serialized = serializeEmployeeRegions(source);
    const prefix = typeof source === 'string' ? '保存文字：'
      : source.length ? `保存清單（${source.length} 項）：` : '空清單（0 項）：';
    assert.equal(serialized.startsWith(prefix), true);
    assert.deepEqual(JSON.parse(serialized.slice(prefix.length)), source);
    assert.equal(isNormalizedEmployeeRegions(normalizeEmployeeRegions(source)), true);
  }
  assert.equal(serializeEmployeeRegions(null), '未提供');
  assert.notEqual(serializeEmployeeRegions(''), serializeEmployeeRegions([]));
  assert.notEqual(serializeEmployeeRegions(['']), serializeEmployeeRegions(['空字串']));
});
