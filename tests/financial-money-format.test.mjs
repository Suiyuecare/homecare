import test from 'node:test';
import assert from 'node:assert/strict';

// Importing the shared UI module does not mount a document or create a session.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { formatMoney } = await import('../public/ui.js');

const legacy = value => new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 2 }).format(Number(value || 0) / 100);

// Independent oracle: split the exact base-10 safe-integer string, then group
// the dollar characters. Do not reuse the implementation's BigInt arithmetic,
// cents/100 floating-point conversion, or Intl.formatToParts algorithm.
const exact = cents => {
  assert.equal(typeof cents, 'number'); assert.ok(Number.isSafeInteger(cents));
  const digits = String(Math.abs(cents)).padStart(3, '0');
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (cents < 0 ? '-$' : '$') + dollars + '.' + digits.slice(-2);
};
const agrees = cents => assert.equal(formatMoney(cents), exact(cents), 'Exact primitive safe-integer cents: ' + String(cents));
const sameFallback = value => assert.equal(formatMoney(value), legacy(value));

test('financial money preserves the existing common TWD currency grouping and two decimal bytes', () => {
  for (const [cents, expected] of [[0, '$0.00'], [1, '$0.01'], [47, '$0.47'], [99, '$0.99'], [100, '$1.00'], [101, '$1.01'], [12345, '$123.45'], [100000, '$1,000.00'], [18800, '$188.00'], [20000, '$200.00'], [1000000000, '$10,000,000.00'], [-12345, '-$123.45']]) {
    assert.equal(legacy(cents), expected); assert.equal(formatMoney(cents), expected); agrees(cents);
  }
  for (const cents of [0, -0]) { assert.equal(formatMoney(cents), '$0.00'); assert.equal(formatMoney(cents), legacy(cents)); }
});

test('negative sub-dollar primitive safe integers keep the minus sign while primitive negative zero remains positive zero', () => {
  for (let cents = 1; cents <= 99; cents += 1) {
    agrees(cents); agrees(-cents);
    assert.equal(formatMoney(-cents), '-$0.' + String(cents).padStart(2, '0'));
  }
  assert.equal(formatMoney(-100), '-$1.00'); assert.equal(formatMoney(-101), '-$1.01');
  assert.equal(formatMoney(-0), '$0.00');
  assert.equal(formatMoney('-0'), legacy('-0'), 'A truthy string -0 still follows the existing coercing fallback and preserves its negative sign');
});

test('maximum and minimum primitive safe-integer cents retain their last cent without passing through rounded dollar Numbers', () => {
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER), '$90,071,992,547,409.91');
  assert.equal(formatMoney(Number.MIN_SAFE_INTEGER), '-$90,071,992,547,409.91');
  for (let offset = 0; offset < 200; offset += 1) {
    const cents = Number.MAX_SAFE_INTEGER - offset; agrees(cents); agrees(-cents);
  }
  assert.notEqual(formatMoney(Number.MAX_SAFE_INTEGER), legacy(Number.MAX_SAFE_INTEGER), 'The old floating dollar conversion loses one cent at this boundary');
  assert.notEqual(formatMoney(Number.MIN_SAFE_INTEGER), legacy(Number.MIN_SAFE_INTEGER));
});

test('cent rollovers large whole-dollar groups and trailing 00 or 99 remain exact on both sides of every boundary', () => {
  const anchors = [100, 100000, 100000000, 100000000000, 100000000000000, 9007199254740900];
  for (const anchor of anchors) for (const offset of [-101, -100, -99, -1, 0, 1, 2, 90, 91, 99]) {
    const cents = anchor + offset;
    if (Number.isSafeInteger(cents)) { agrees(cents); agrees(-cents); }
  }
  for (const cents of [9007199254740899, 9007199254740900, 9007199254740901, 8999999999999999, 8999999999999900]) { agrees(cents); agrees(-cents); }
});

test('deterministic primitive safe-integer samples across the full signed range match the decimal-string oracle', () => {
  let seed = 0x5a17b9d3;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const seen = new Set();
  let oldPrecisionDifferences = 0;
  for (let index = 0; index < 2048; index += 1) {
    const cents = (next() & 0x1fffff) * 2 ** 32 + next();
    assert.ok(Number.isSafeInteger(cents)); seen.add(cents);
    agrees(cents); agrees(-cents);
    if (legacy(cents) !== exact(cents)) oldPrecisionDifferences += 1;
  }
  assert.equal(seen.size, 2048); assert.ok(oldPrecisionDifferences > 10, 'The sample must exercise real old float-precision failures rather than only small values');
});

test('noninteger unsafe NaN and infinite primitive Numbers retain every existing Intl fallback result', () => {
  for (const value of [0.1, -0.1, 1.5, -1.5, 99.9, -99.9, 12345.67, -12345.67, Number.MIN_VALUE, -Number.MIN_VALUE, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, Number.MAX_VALUE, -Number.MAX_VALUE, 1e21, -1e21]) sameFallback(value);
});

test('numeric strings BigInts booleans null and undefined continue the exact original truthiness and Number coercion fallback', () => {
  for (const value of ['', ' ', '\t\n', '0', '-0', '1', '-1', '99', '-99', '100', '00100', '12345', '9007199254740991', '-9007199254740991', '9007199254740992', '1.5', '1e2', '0x64', '0b1100100', 'NaN', 'Infinity', '-Infinity', 'synthetic-invalid', true, false, null, undefined, 0n, 1n, -1n, 100n, 9007199254740991n, -9007199254740991n, 10n ** 100n]) sameFallback(value);
  assert.notEqual(formatMoney('9007199254740991'), formatMoney(Number.MAX_SAFE_INTEGER), 'A numeric string is not a newly validated safe-integer primitive');
  assert.notEqual(formatMoney(9007199254740991n), formatMoney(Number.MAX_SAFE_INTEGER), 'Existing BigInt inputs remain on the original Number fallback');
});

test('boxed primitives arrays dates and plain objects retain their original coercing output rather than being newly validated or repaired', () => {
  for (const value of [new Number(12345), new Number(-0), new Number(Number.MAX_SAFE_INTEGER), new String('12345'), new String(''), new Boolean(true), Object(12345n), [], [12345], ['12345'], [null], [undefined], [1, 2], {}, { cents: 12345 }, new Date('2026-10-09T00:00:00Z'), new Date(NaN)]) sameFallback(value);
  assert.equal(formatMoney(new Number(-0)), legacy(new Number(-0)), 'Boxed negative zero must retain the original fallback sign');
});

test('fallback object conversion preserves exactly one coercion and the same toPrimitive valueOf toString ordering', () => {
  const factories = [
    trace => ({ [Symbol.toPrimitive](hint) { trace.push('primitive:' + hint); return '12345'; } }),
    trace => ({ valueOf() { trace.push('valueOf'); return -0; }, toString() { trace.push('toString'); return 'must-not-be-used'; } }),
    trace => ({ valueOf() { trace.push('valueOf'); return 12345n; }, toString() { trace.push('toString'); return 'must-not-be-used'; } }),
    trace => ({ get [Symbol.toPrimitive]() { trace.push('get:primitive'); return undefined; }, get valueOf() { trace.push('get:valueOf'); return () => { trace.push('call:valueOf'); return {}; }; }, get toString() { trace.push('get:toString'); return () => { trace.push('call:toString'); return '4567'; }; } }),
  ];
  for (const factory of factories) {
    const expectedTrace = [], actualTrace = [];
    const expected = legacy(factory(expectedTrace)), actual = formatMoney(factory(actualTrace));
    assert.equal(actual, expected); assert.deepEqual(actualTrace, expectedTrace);
  }
});

test('fallback Symbols and invalid object conversions keep the same exception class message order and original thrown error identity', () => {
  const outcome = (fn, value) => { try { return { value: fn(value) }; } catch (error) { return { name: error.name, message: error.message, constructor: error.constructor }; } };
  for (const value of [Symbol('synthetic-cents'), Object(Symbol('synthetic-boxed-cents')), { [Symbol.toPrimitive]() { return {}; } }, Object.create(null)]) {
    assert.deepEqual(outcome(formatMoney, value), outcome(legacy, value));
  }
  const marker = new RangeError('synthetic-original-coercion-error');
  const trace = [];
  const value = { valueOf() { trace.push('valueOf'); throw marker; }, toString() { trace.push('toString'); return 'must-not-be-used'; } };
  assert.throws(() => formatMoney(value), error => error === marker);
  assert.deepEqual(trace, ['valueOf']);
  const expectedTrace = [];
  assert.throws(() => legacy({ valueOf() { expectedTrace.push('valueOf'); throw marker; } }), error => error === marker);
  assert.deepEqual(trace, expectedTrace);
});
