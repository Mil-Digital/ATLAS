import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSalesRange } from '../src/services/import/loaders/productPerformance.js';

const month = (n, salesOf) => Array.from({ length: n }, (_, i) => ({
  date: `2026-11-${String(i + 1).padStart(2, '0')}`,
  sales: salesOf(i + 1),
}));

test('finds a partial month: days 1-9 whose sales sum to the file total', () => {
  const days = month(9, (d) => 1_000_000 + d * 10_000); // Performance Overview has only 1-9 Nov
  const total = days.reduce((s, d) => s + d.sales, 0);
  assert.deepEqual(matchSalesRange(days, total), { start: '2026-11-01', end: '2026-11-09' });
});

test('picks the run inside a full month that matches, not the whole month', () => {
  const days = month(30, (d) => 500_000 + d * 1_000);
  const total = days.slice(0, 9).reduce((s, d) => s + d.sales, 0);
  assert.deepEqual(matchSalesRange(days, total), { start: '2026-11-01', end: '2026-11-09' });
});

test('tolerates a rounding difference of up to 0.1%', () => {
  const days = month(30, () => 25_000_000);
  assert.deepEqual(matchSalesRange(days, 750_000_000 + 300_000), { start: '2026-11-01', end: '2026-11-30' });
});

test('returns null when no run matches, or nothing is known', () => {
  const days = month(30, () => 25_000_000);
  assert.equal(matchSalesRange(days, 12_345), null);
  assert.equal(matchSalesRange([], 1_000), null);
  assert.equal(matchSalesRange(days, 0), null);
});

test('a missing day breaks the run instead of being skipped over', () => {
  const days = month(10, () => 100).filter((d) => d.date !== '2026-11-05');
  assert.equal(matchSalesRange(days, 900), null);
  assert.deepEqual(matchSalesRange(days, 400), { start: '2026-11-01', end: '2026-11-04' });
});

test('on a tie, zero-sales days at the edges are included (longer run)', () => {
  const days = month(5, (d) => (d === 1 || d === 5 ? 0 : 100));
  assert.deepEqual(matchSalesRange(days, 300), { start: '2026-11-01', end: '2026-11-05' });
});
