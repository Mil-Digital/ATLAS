import pool from '../../config/db.js';
import { parseIdr, parsePct, readSheetRaw } from '../import/parsers.js';
import { readShopeeWorkbook as readWorkbook } from '../import/shopeeLocale.js';
import * as fileStore from '../fileStore.js';

// Shopee's own monthly figures, read from the shop-stats export the brand
// uploaded (Pengaturan Brand > Data > Performance Overview).
//
// The importer only keeps that file's DAILY rows (daily_order_performance,
// daily_channel_performance). Two things the dashboard needs are not
// recoverable from them:
//
//  - unique counts. "Total Pengunjung" and "Pembeli" are unique per day, so
//    summing 31 days counts a returning visitor 31 times. Shopee's header row
//    for the month is the only true monthly unique figure.
//  - the per-channel monthly subtotals. The daily importer reads every
//    section with the Halaman Produk column order, which is wrong for Iklan
//    Shopee (its columns are Ads Impression / Total Pesanan / Konversi /
//    Pengeluaran Iklan / ROAS) and it doesn't recognise the "Live & Video
//    Affiliate" section, filing it under Video Penjual.
//
// Rather than migrate the production schema, this reads the stored raw file
// (public.uploads.raw_file, or the brand library copy) and caches the parsed
// result per upload. Everything here is read-only.

const STAGES = ['Pesanan Dibuat', 'Pesanan Siap Dikirim', 'Pesanan Dibayar'];

// Section title in the "Asal Penjualan" part of the sheet -> stable key.
const CHANNELS = {
  'Halaman Produk': 'productPage',
  'Live Penjual': 'live',
  'Video Penjual': 'video',
  'Live & Video Affiliate': 'affiliate',
  Affiliate: 'affiliate',
  'Iklan Shopee': 'ads',
};

export const CHANNEL_LABELS = {
  productPage: 'Halaman Produk',
  live: 'Live Penjual',
  video: 'Video Penjual',
  affiliate: 'Live & Video Affiliate',
  ads: 'Iklan Shopee',
};

const cache = new Map();
const CACHE_LIMIT = 64;

const num = (v) => {
  const n = parseIdr(v);
  return n == null ? null : n;
};

// Column lookup by header text, so a section keeps working when Shopee
// reorders or relabels a column ("Live Ditonton" vs "Jumlah Produk Dilihat").
function pick(header, row, ...names) {
  for (const name of names) {
    const i = header.findIndex((h) => String(h || '').trim().toLowerCase() === name.toLowerCase());
    if (i >= 0) return row[i];
  }
  return null;
}

function parseStageTotals(raw) {
  const header = raw[0] || [];
  const row = raw[1] || [];
  if (!/^\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{4}$/.test(String(row[0] || '').trim())) return null;
  const g = (...n) => pick(header, row, ...n);
  return {
    period: String(row[0]).trim(),
    sales: num(g('Total Penjualan (IDR)')),
    orders: num(g('Total Pesanan')),
    salesPerOrder: num(g('Penjualan per Pesanan')),
    clicks: num(g('Produk Diklik')),
    visitors: num(g('Total Pengunjung')),
    cvr: parsePct(g('Tingkat Konversi Pesanan')),
    cancelledOrders: num(g('Pesanan Dibatalkan')),
    cancelledSales: num(g('Penjualan Dibatalkan')),
    returnedOrders: num(g('Pesanan Dikembalikan')),
    returnedSales: num(g('Penjualan Dikembalikan')),
    buyers: num(g('Pembeli')),
    newBuyers: num(g('Total Pembeli Baru')),
    existingBuyers: num(g('Total Pembeli Saat Ini')),
    potentialBuyers: num(g('Total Potensi Pembeli')),
    repeatRate: parsePct(g('Tingkat Pembelian Berulang')),
  };
}

function parseSubRow(channel, header, row) {
  const g = (...n) => pick(header, row, ...n);
  if (channel === 'ads') {
    return {
      name: String(row[0]).trim(),
      sales: num(g('Penjualan (IDR)')),
      impressions: num(g('Ads Impression')),
      orders: num(g('Total Pesanan')),
      spend: num(g('Pengeluaran Iklan')),
      roas: num(g('ROAS Iklan')),
    };
  }
  return {
    name: String(row[0]).trim(),
    sales: num(g('Penjualan (IDR)')),
    views: num(g('Jumlah Produk Dilihat', 'Live Ditonton', 'Video Ditonton', 'Konten Ditonton')),
    clicks: num(g('Produk Diklik')),
    orders: num(g('Total Pesanan')),
    buyers: num(g('Total Pembeli')),
    uniqueViewers: num(g('Produk Unik Dilihat', 'Penonton Live', 'Penonton Video', 'Penonton Konten')),
    uniqueClickers: num(g('Produk Unik Diklik')),
  };
}

// One "Sumber Kunjungan" headline sheet: row 1 is the month's sales split by
// source, then one block per channel with the month's subtotal rows.
function parseSourceSheet(raw) {
  const header0 = raw[0] || [];
  const row1 = raw[1] || [];
  const g = (...n) => pick(header0, row1, ...n);
  const stage = String(g('Status Pesanan') || '').trim();
  const salesBySource = {
    total: num(g('Penjualan (IDR)')),
    productPage: num(g('Penjualan dari halaman produk')),
    live: num(g('Penjualan dari Live Penjual')),
    video: num(g('Penjualan dari Video Penjual')),
    affiliate: num(g('Penjualan dari Affiliate')),
    ads: num(g('Penjualan dari Iklan Shopee')),
  };

  const channels = {};
  let channel = null;
  let header = null;
  for (let i = 2; i < raw.length; i += 1) {
    const row = raw[i] || [];
    const c0 = String(row[0] || '').trim();
    const rest = row.slice(1).some((v) => String(v ?? '').trim() !== '');
    if (!c0) continue;
    if (!rest && CHANNELS[c0]) {
      channel = CHANNELS[c0];
      header = null;
      channels[channel] = { total: null, subs: [] };
      continue;
    }
    if (!channel) continue;
    if (c0 === 'Sumber Kunjungan') { header = row; continue; }
    if (!header || !rest) continue;
    const parsed = parseSubRow(channel, header, row);
    // The channel's own name as a row is its monthly subtotal.
    if (CHANNELS[c0] === channel) channels[channel].total = parsed;
    else channels[channel].subs.push(parsed);
  }

  const ads = channels.ads;
  if (ads) {
    const sum = (k) => ads.subs.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    ads.total = {
      name: 'Iklan Shopee',
      sales: salesBySource.ads,
      impressions: sum('impressions'),
      orders: sum('orders'),
      spend: sum('spend'),
    };
    ads.total.roas = ads.total.spend > 0 && ads.total.sales != null
      ? Number((ads.total.sales / ads.total.spend).toFixed(2)) : null;
  }

  return { stage, salesBySource, channels };
}

export function parseShopStatsWorkbook(buffer) {
  const wb = readWorkbook(buffer);
  const stages = {};
  for (const name of STAGES) {
    if (!wb.SheetNames.includes(name)) continue;
    const totals = parseStageTotals(readSheetRaw(wb, name));
    if (totals) stages[name] = { totals, salesBySource: null, channels: {} };
  }
  for (const name of wb.SheetNames) {
    const raw = readSheetRaw(wb, name);
    const h = raw[0] || [];
    if (String(h[0] || '').trim() !== 'Tanggal' || String(h[1] || '').trim() !== 'Status Pesanan') continue;
    const parsed = parseSourceSheet(raw);
    if (!stages[parsed.stage]) continue;
    // Several sheets repeat the same headline row; keep the first one that
    // actually carries the channel blocks.
    const slot = stages[parsed.stage];
    if (!slot.salesBySource) slot.salesBySource = parsed.salesBySource;
    if (Object.keys(slot.channels).length === 0) slot.channels = parsed.channels;
  }
  return stages;
}

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(last).padStart(2, '0')}` };
}

// The upload whose daily rows cover this month — the same file the rest of
// the dashboard already reads, so the monthly and daily figures never come
// from two different exports.
async function findMonthUpload(brandId, month) {
  const { start, end } = monthBounds(month);
  const res = await pool.query(`
    SELECT d.upload_id, count(DISTINCT d.report_date)::int AS days,
           min(d.report_date)::text AS first_day, max(d.report_date)::text AS last_day
    FROM shopee.daily_order_performance d
    WHERE d.brand_id = $1 AND d.report_date BETWEEN $2 AND $3
    GROUP BY d.upload_id
    ORDER BY days DESC
  `, [brandId, start, end]);
  return { uploads: res.rows, start, end };
}

// The upload's own copy first, else the brand library file it was imported
// from — each either in its row or in R2 (fileStore).
async function loadRawFile(uploadId) {
  const res = await pool.query(`
    SELECT u.raw_file AS u_raw, u.storage_key AS u_key, l.raw_file AS l_raw, l.storage_key AS l_key
    FROM public.uploads u
    LEFT JOIN ads_reports.brand_library_files l ON l.dashboard_upload_id = u.upload_id
    WHERE u.upload_id = $1
    LIMIT 1
  `, [uploadId]);
  const row = res.rows[0];
  if (!row) return null;
  return (await fileStore.readBytes({ rawFile: row.u_raw, storageKey: row.u_key }))
    || (await fileStore.readBytes({ rawFile: row.l_raw, storageKey: row.l_key }));
}

// Returns null when there is no single stored file for the month (nothing
// uploaded, the month split across several uploads, or an old upload whose
// raw file was never kept). Callers treat null as "monthly figure not
// available", never as zero.
export async function getMonthlyShopStats(brandId, month) {
  const { uploads, start, end } = await findMonthUpload(brandId, month);
  if (uploads.length !== 1) {
    return { available: false, reason: uploads.length === 0 ? 'no-upload' : 'split-upload', month, start, end };
  }
  const { upload_id: uploadId, first_day: firstDay, last_day: lastDay, days } = uploads[0];

  const key = String(uploadId);
  if (!cache.has(key)) {
    const buffer = await loadRawFile(uploadId);
    const parsed = buffer ? parseShopStatsWorkbook(buffer) : null;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, parsed);
  }
  const stages = cache.get(key);
  if (!stages || !stages['Pesanan Dibayar']) {
    return { available: false, reason: 'no-raw-file', month, start, end };
  }
  return {
    available: true,
    month,
    start,
    end,
    coveredStart: firstDay,
    coveredEnd: lastDay,
    coveredDays: days,
    isPartialMonth: firstDay !== start || lastDay !== end,
    stages,
  };
}
