import { dedupeByKeys, insertChunked, upsertSql } from '../bulk.js';
import {
  parseIdr,
  parseIntValue,
  parsePct,
  parsePeriodSummary,
  parseTs,
  readSheetAsStrings,
  readSheetRaw,
  toDateString,
} from '../parsers.js';
import { readShopeeWorkbook as readWorkbook } from '../shopeeLocale.js';

const STAGE_SHEETS = ['Pesanan Dibuat', 'Pesanan Siap Dikirim', 'Pesanan Dibayar'];

export function detectPerformanceOverviewPeriod(filepath) {
  const wb = readWorkbook(filepath);
  const raw = readSheetRaw(wb, 'Pesanan Dibuat');
  if (raw.length > 1 && raw[1]?.[0]) {
    const summary = parsePeriodSummary(raw[1][0]);
    if (summary) return summary;
  }

  const rows = readSheetAsStrings(wb, 'Pesanan Dibuat');
  const dates = rows
    .map((r) => parseTs(r['Tanggal'], '%d-%m-%Y'))
    .filter(Boolean);
  if (dates.length === 0) return { start: null, end: null };
  dates.sort((a, b) => a - b);
  return { start: toDateString(dates[0]), end: toDateString(dates[dates.length - 1]) };
}

const DAILY_ORDER_COLUMNS = [
  'report_date', 'stage_id', 'total_sales_idr', 'total_orders', 'sales_per_order',
  'products_clicked', 'total_visitors', 'order_conversion_rate',
  'cancelled_orders', 'cancelled_sales_idr', 'returned_orders', 'returned_sales_idr',
  'total_buyers', 'new_buyers', 'existing_buyers', 'potential_buyers',
  'repeat_purchase_rate', 'brand_id', 'upload_id',
];

const DAILY_CHANNEL_COLUMNS = [
  'report_date', 'stage_id', 'channel_id', 'sub_source_id',
  'sales_idr', 'sales_ratio', 'products_viewed', 'products_clicked',
  'total_orders', 'products_ordered', 'click_percentage', 'conversion_rate',
  'sales_per_order', 'total_buyers', 'unique_products_viewed', 'unique_products_clicked',
  'ad_spend_idr', 'roas',
  'brand_id', 'upload_id',
];

export async function loadDailyOrderPerformance(client, resolver, filepath, brandId, uploadId) {
  const wb = readWorkbook(filepath);
  const batch = [];

  for (const sheetName of STAGE_SHEETS) {
    const rows = readSheetAsStrings(wb, sheetName).filter((row) => parseTs(row['Tanggal'], '%d-%m-%Y') != null);
    const stageId = await resolver.getOrCreateOne(
      'order_pipeline_stages', 'stage_id', 'stage_name', sheetName,
    );

    for (const row of rows) {
      batch.push([
        parseTs(row['Tanggal'], '%d-%m-%Y'), stageId,
        parseIdr(row['Total Penjualan (IDR)']) ?? 0, parseIntValue(row['Total Pesanan']) ?? 0,
        parseIdr(row['Penjualan per Pesanan']), parseIntValue(row['Produk Diklik']) ?? 0,
        parseIntValue(row['Total Pengunjung']) ?? 0, parsePct(row['Tingkat Konversi Pesanan']),
        parseIntValue(row['Pesanan Dibatalkan']) ?? 0, parseIdr(row['Penjualan Dibatalkan']) ?? 0,
        parseIntValue(row['Pesanan Dikembalikan']) ?? 0, parseIdr(row['Penjualan Dikembalikan']) ?? 0,
        parseIntValue(row['Pembeli']) ?? 0, parseIntValue(row['Total Pembeli Baru']) ?? 0,
        parseIntValue(row['Total Pembeli Saat Ini']) ?? 0, parseIntValue(row['Total Potensi Pembeli']) ?? 0,
        parsePct(row['Tingkat Pembelian Berulang']),
        brandId, uploadId,
      ]);
    }
  }

  // Nothing parsed means the columns were not recognised, not an empty
  // month. Failing here keeps the library from marking the file "terbaca
  // Dashboard" while GMV reads Rp0, and offers "Impor ulang" instead.
  if (batch.length === 0) {
    throw new Error('Tidak ada baris harian yang terbaca dari sheet Pesanan Dibuat / Siap Dikirim / Dibayar. Pastikan file adalah ekspor Performa Toko › Tinjauan dari Shopee Seller Centre.');
  }

  const keys = ['brand_id', 'report_date', 'stage_id'];
  return insertChunked(
    client, 'daily_order_performance', DAILY_ORDER_COLUMNS,
    dedupeByKeys(batch, keys.map((k) => DAILY_ORDER_COLUMNS.indexOf(k))),
    upsertSql(DAILY_ORDER_COLUMNS, keys), 300,
  );
}

// Section title in the "Asal Penjualan" sheet -> channel name stored in
// shopee.traffic_channels. Shopee titles the affiliate section "Live & Video
// Affiliate"; it is stored as the existing 'Affiliate' channel.
const CHANNEL_SECTIONS = {
  'Halaman Produk': 'Halaman Produk',
  'Live Penjual': 'Live Penjual',
  'Video Penjual': 'Video Penjual',
  'Live & Video Affiliate': 'Affiliate',
  Affiliate: 'Affiliate',
  'Iklan Shopee': 'Iklan Shopee',
};

const isBlank = (v) => v == null || String(v).trim() === '';

// Every section carries its own header row ("Sumber Kunjungan", ...), and the
// columns differ between sections: Live says "Live Ditonton" where Halaman
// Produk says "Jumlah Produk Dilihat", and Iklan Shopee has a different set
// altogether. Columns are therefore read by header name, never by position.
function channelRowValues(channel, header, row) {
  const g = (...names) => {
    for (const name of names) {
      const i = header.findIndex((h) => String(h ?? '').trim().toLowerCase() === name.toLowerCase());
      if (i >= 0) return row[i];
    }
    return null;
  };

  if (channel === 'Iklan Shopee') {
    return [
      parseIdr(g('Penjualan (IDR)')) ?? 0, parsePct(g('Rasio Penjualan')),
      parseIntValue(g('Ads Impression')) ?? 0, 0,
      parseIdr(g('Total Pesanan')) ?? 0, 0,
      null, parsePct(g('Konversi')),
      null, 0, 0, 0,
      parseIdr(g('Pengeluaran Iklan')), parseIdr(g('ROAS Iklan')),
    ];
  }

  return [
    parseIdr(g('Penjualan (IDR)')) ?? 0, parsePct(g('Rasio Penjualan')),
    parseIntValue(g('Jumlah Produk Dilihat', 'Live Ditonton', 'Video Ditonton', 'Konten Ditonton')) ?? 0,
    parseIntValue(g('Produk Diklik')) ?? 0,
    parseIdr(g('Total Pesanan')) ?? 0, parseIdr(g('Produk')) ?? 0,
    parsePct(g('Persentase Klik')), parsePct(g('Tingkat Konversi Pesanan')),
    parseIdr(g('Penjualan per Pesanan')), parseIntValue(g('Total Pembeli')) ?? 0,
    parseIntValue(g('Produk Unik Dilihat', 'Penonton Live', 'Penonton Video', 'Penonton Konten')) ?? 0,
    parseIntValue(g('Produk Unik Diklik')) ?? 0,
    null, null,
  ];
}

// Parses the three "(pesanan …)Asal Penjualan" sheets into daily rows. Pure
// (no DB access), so the backfill script can compare its output with what is
// stored before touching anything.
//
// Layout per section: a title row (only the first cell filled), a header row
// starting "Sumber Kunjungan", then blocks of [subtotal row, one row per day].
// A subtotal row named after the section itself introduces the channel's own
// daily total, stored under sub-source 'Semua'.
export function parseDailyChannelRows(src) {
  const wb = readWorkbook(src);
  const stageAsalSheets = {
    'Pesanan Dibuat': '(pesanan dibuat)Asal',
    'Pesanan Siap Dikirim': '(pesanan siap dikirim)Asal',
    'Pesanan Dibayar': '(pesanan dibayar)Asal',
  };
  const out = [];

  for (const [stageName, sheetPrefix] of Object.entries(stageAsalSheets)) {
    const matchedSheet = wb.SheetNames.find((n) => n.startsWith(sheetPrefix));
    if (!matchedSheet) continue;

    let title = null;
    let channel = null;
    let header = null;
    let subSource = null;

    for (const row of readSheetRaw(wb, matchedSheet)) {
      if (!row || row.length === 0) continue;
      const col0 = String(row[0] ?? '').trim();
      if (!col0) continue;

      if (CHANNEL_SECTIONS[col0] && row.slice(1).every(isBlank)) {
        title = col0;
        channel = CHANNEL_SECTIONS[col0];
        header = null;
        subSource = null;
        continue;
      }
      if (col0 === 'Sumber Kunjungan') { header = row; continue; }
      if (!channel || !header) continue;

      if (/^\d{2}-\d{2}-\d{4}$/.test(col0)) {
        out.push({
          reportDate: parseTs(col0, '%d-%m-%Y'),
          stageName,
          channel,
          subSource: subSource || 'Semua',
          values: channelRowValues(channel, header, row),
        });
      } else {
        subSource = col0 === title ? null : col0;
      }
    }
  }
  return out;
}

export async function loadDailyChannelPerformance(client, resolver, filepath, brandId, uploadId) {
  const batch = [];
  for (const r of parseDailyChannelRows(filepath)) {
    const stageId = await resolver.getOrCreateOne('order_pipeline_stages', 'stage_id', 'stage_name', r.stageName);
    const channelId = await resolver.getOrCreateOne('traffic_channels', 'channel_id', 'channel_name', r.channel);
    const subSourceId = await resolver.getOrCreateOne('traffic_sub_sources', 'sub_source_id', 'sub_source_name', r.subSource);
    batch.push([r.reportDate, stageId, channelId, subSourceId, ...r.values, brandId, uploadId]);
  }

  const keys = ['brand_id', 'report_date', 'stage_id', 'channel_id', 'sub_source_id'];
  return insertChunked(
    client, 'daily_channel_performance', DAILY_CHANNEL_COLUMNS,
    dedupeByKeys(batch, keys.map((k) => DAILY_CHANNEL_COLUMNS.indexOf(k))),
    upsertSql(DAILY_CHANNEL_COLUMNS, keys), 300,
  );
}

export async function deriveReportPeriod(client, resolver, filepath, stageSheet = 'Pesanan Dibuat') {
  const wb = readWorkbook(filepath);
  const rows = readSheetAsStrings(wb, stageSheet);
  const dates = rows
    .map((r) => parseTs(r['Tanggal'], '%d-%m-%Y'))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (dates.length === 0) return null;

  const periodStart = toDateString(dates[0]);
  const periodEnd = toDateString(dates[dates.length - 1]);

  return resolver.getOrCreate(
    'report_periods', 'period_id', ['period_start', 'period_end'],
    [periodStart, periodEnd],
  );
}
