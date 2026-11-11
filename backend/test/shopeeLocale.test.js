import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { localizeShopeeWorkbook } from '../src/services/import/shopeeLocale.js';
import { readSheetAsStrings, readSheetRaw } from '../src/services/import/parsers.js';

// Shaped like an English Shopee Performance Overview export: Indonesian stage
// sheet names, English headers, and the daily traffic-source sheet under its
// truncated English name.
function englishOverview() {
  const wb = XLSX.utils.book_new();
  const stageHeader = ['Date', 'Sales (IDR)', 'Orders', 'Visitors', 'Order Conversion Rate', '# of buyers'];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    stageHeader,
    ['01-10-2026-31-10-2026', '867.705.748', '1819', '99625', '0,69%', '1669'],
    [],
    stageHeader,
    ['01-10-2026', '28.428.990', '62', '5096', '0,67%', '60'],
  ]), 'Pesanan Dibayar');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Date', 'Order Type', 'Sales (IDR)', 'Sales from Product Card'],
    ['01-10-2026-31-10-2026', 'Paid Order', '867.705.748', '718.468.235'],
  ]), 'Traffic Sources (paid order)');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    [],
    ['Product Card'],
    ['Traffic Source', 'Sales Ratio', 'Sales (IDR)', 'Product Impressions', 'Orders', 'Units'],
    ['Product Card', '100,00%', '718.468.235', '4.378.222', '1.486,00', '1.690,00'],
    ['Shop', '31,00%', '222.737.525', '1.184.011', '486,01', '581,00'],
    ['Shopee Ads'],
    ['Traffic Source', 'Sales Ratio', 'Sales (IDR)', 'Ads Impression', 'Orders', 'Conversion', 'Ads Expense', 'Ads ROAS'],
    ['Product Ads (GMV Max-Shop)', '34,05%', '216.001.720', '869.981', '506,00', '0,06%', '10.347.048', '20,88'],
  ]), 'Source Contribution (paid o...');
  return wb;
}

test('translates English stage headers to the Indonesian ones the importer reads', () => {
  const wb = localizeShopeeWorkbook(englishOverview());
  const rows = readSheetAsStrings(wb, 'Pesanan Dibayar');
  const day = rows.find((r) => r.Tanggal === '01-10-2026');
  assert.equal(day['Total Penjualan (IDR)'], '28.428.990');
  assert.equal(day['Total Pesanan'], '62');
  assert.equal(day['Total Pengunjung'], '5096');
  assert.equal(day.Pembeli, '60');
});

test('renames the daily traffic-source sheet and translates its blocks by context', () => {
  const wb = localizeShopeeWorkbook(englishOverview());
  assert.ok(wb.SheetNames.includes('(pesanan dibayar)Asal Penjualan'));
  const raw = readSheetRaw(wb, '(pesanan dibayar)Asal Penjualan').filter((r) => r.length);
  assert.deepEqual(raw[0].slice(0, 1), ['Halaman Produk']);
  // "Sales (IDR)" is "Penjualan (IDR)" here, not the stage sheet's "Total Penjualan (IDR)".
  assert.deepEqual(raw[1].slice(0, 6), ['Sumber Kunjungan', 'Rasio Penjualan', 'Penjualan (IDR)', 'Jumlah Produk Dilihat', 'Total Pesanan', 'Produk']);
  assert.equal(raw[2][0], 'Halaman Produk');
  assert.equal(raw[3][0], 'Toko');
  assert.equal(raw[4][0], 'Iklan Shopee');
  assert.deepEqual(raw[5].slice(5), ['Konversi', 'Pengeluaran Iklan', 'ROAS Iklan']);
  assert.equal(raw[6][0], 'Product Ads (GMV Max-Shop)');
});

test('translates the headline sheet so monthlyShopStats recognises it', () => {
  const wb = localizeShopeeWorkbook(englishOverview());
  const raw = readSheetRaw(wb, 'Traffic Sources (paid order)');
  assert.deepEqual(raw[0], ['Tanggal', 'Status Pesanan', 'Penjualan (IDR)', 'Penjualan dari halaman produk']);
  assert.equal(raw[1][1], 'Pesanan Dibayar');
});

test('translates English Product Performance headers and sheet names', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Item ID', 'Product', 'Current Item Status', 'Variation ID', 'SKU', 'Sales (Confirmed Order) (IDR)', 'Repeat Order Rate (Confirmed Order)'],
    ['28230935530', 'Medium Catto Workbag', 'Normal', '-', '-', '115.505.000', '4,60%'],
  ]), 'Produk dengan Performa Terbaik');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Item ID'], ['28230935530']]), 'Uncompetitive price');
  localizeShopeeWorkbook(wb);
  const [row] = readSheetAsStrings(wb, 'Produk dengan Performa Terbaik');
  assert.equal(row['Kode Produk'], '28230935530');
  assert.equal(row.Produk, 'Medium Catto Workbag');
  assert.equal(row['Kode Variasi'], '-');
  assert.equal(row['Penjualan (Pesanan Siap Dikirim) (IDR)'], '115.505.000');
  assert.equal(row['% Pembelian Ulang (Pesanan Siap Dikirim)'], '4,60%');
  assert.ok(wb.SheetNames.includes('Harga Belum Kompetitif'));
});

test('leaves an Indonesian workbook untouched and is idempotent', () => {
  const wb = XLSX.utils.book_new();
  const aoa = [['Tanggal', 'Total Penjualan (IDR)', 'Total Pesanan'], ['01-06-2026', '7.078.100', '45']];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Pesanan Dibayar');
  localizeShopeeWorkbook(wb);
  localizeShopeeWorkbook(wb);
  assert.deepEqual(wb.SheetNames, ['Pesanan Dibayar']);
  assert.deepEqual(readSheetRaw(wb, 'Pesanan Dibayar'), aoa);
});
