import { insertChunked, dedupeBy } from '../bulk.js';
import {
  blankToNone,
  parseFilenamePeriod,
  parseIdr,
  parseIntValue,
  parsePct,
  parseTs,
  readSheetAsStrings,
  toDateString,
} from '../parsers.js';
import { readShopeeWorkbook as readWorkbook } from '../shopeeLocale.js';
import { deriveReportPeriod } from './performanceOverview.js';

export function detectProductPerformancePeriod(filepath, filename = '') {
  // The filename range is the most reliable signal for this export: the
  // "parentskudetail" variant has no parseable date in its sheets at all
  // ("Tanggal Dibuat" is YYYYMMDD text and lists newly-added products, not
  // the reporting month).
  const fromName = parseFilenamePeriod(filename);
  if (fromName) return { start: fromName.start, end: fromName.end };

  const wb = readWorkbook(filepath);

  // Try "Produk yang Baru Ditambahkan" dates
  try {
    const rows = readSheetAsStrings(wb, 'Produk yang Baru Ditambahkan');
    const dates = rows
      .map((r) => parseTs(r['Tanggal Dibuat'], '%d-%m-%Y') || parseTs(r['Tanggal Dibuat']))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (dates.length > 0) {
      const start = new Date(dates[0].getFullYear(), dates[0].getMonth(), 1);
      const end = new Date(dates[dates.length - 1].getFullYear(), dates[dates.length - 1].getMonth() + 1, 0);
      return { start: toDateString(start), end: toDateString(end) };
    }
  } catch {
    // sheet may be empty
  }

  return { start: null, end: null };
}

async function upsertProduct(client, resolver, brandId, productId, productName, statusName) {
  const statusId = await resolver.getOrCreateOne(
    'product_statuses', 'status_id', 'status_name', blankToNone(statusName),
  );
  await client.query(
    `INSERT INTO products (product_id, product_name, product_status_id, brand_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id) DO UPDATE
       SET product_name = EXCLUDED.product_name,
           product_status_id = EXCLUDED.product_status_id,
           brand_id = COALESCE(products.brand_id, EXCLUDED.brand_id)`,
    [productId, productName, statusId, brandId],
  );
}

const SUMMARY_COLUMNS = [
  'period_id', 'product_id', 'product_status_id',
  'product_views', 'product_clicks', 'click_percentage',
  'orders_created', 'orders_ready_to_ship',
  'sales_created_idr', 'sales_ready_to_ship_idr',
  'unique_viewers', 'unique_clickers', 'product_page_visitors', 'product_page_views',
  'visitors_no_purchase', 'no_purchase_rate', 'search_clicks', 'likes',
  'cart_visitors', 'cart_adds', 'cart_conversion_rate',
  'products_ordered_created', 'products_ordered_ready_to_ship',
  'buyers_created', 'buyers_ready_to_ship',
  'created_order_conversion_rate', 'ready_to_ship_conversion_rate',
  'sales_per_order_created', 'sales_per_order_ready_to_ship',
  'repeat_order_rate_created', 'repeat_purchase_pct_ready_to_ship',
  'avg_days_repeat_order_created', 'avg_days_repeat_purchase_ready_to_ship',
  'brand_id', 'upload_id',
];

const VARIANT_COLUMNS = [
  'period_id', 'variant_id', 'variant_status_id',
  'orders_created', 'orders_ready_to_ship',
  'buyers_created', 'buyers_ready_to_ship',
  'sales_created_idr', 'sales_ready_to_ship_idr',
  'products_ordered_ready_to_ship',
  'brand_id', 'upload_id',
];

export async function loadProductPerformance(client, resolver, filepath, brandId, uploadId, periodId) {
  const wb = readWorkbook(filepath);
  const rows = readSheetAsStrings(wb, 'Produk dengan Performa Terbaik').filter((row) => {
    const variant = blankToNone(row['Kode Variasi']);
    return variant == null;
  });

  // Semua status di-resolve sekali di depan, jadi getOrCreateOne di bawah
  // tidak lagi menembak database per baris.
  await resolver.warmSingle('product_statuses', 'status_id', 'status_name',
    rows.map((r) => blankToNone(r['Status Produk Saat Ini'])));

  const productRows = [];
  const summaryRows = [];

  for (const row of rows) {
    const productId = parseIntValue(row['Kode Produk']);
    if (!productId) continue;

    const statusId = await resolver.getOrCreateOne(
      'product_statuses', 'status_id', 'status_name', blankToNone(row['Status Produk Saat Ini']),
    );

    productRows.push([productId, row['Produk'], statusId, brandId]);
    summaryRows.push([
      periodId, productId, statusId,
        parseIntValue(row['Jumlah Produk Dilihat']) ?? 0,
        parseIntValue(row['Produk Diklik']) ?? 0,
        parsePct(row['Persentase Klik']),
        parseIntValue(row['Pesanan Dibuat']) ?? 0,
        parseIntValue(row['Pesanan Siap Dikirim']) ?? 0,
        parseIdr(row['Total Penjualan (Pesanan Dibuat) (IDR)']) ?? 0,
        parseIdr(row['Penjualan (Pesanan Siap Dikirim) (IDR)']) ?? 0,
        parseIntValue(row['Produk Unik Dilihat']) ?? 0,
        parseIntValue(row['Produk Unik Diklik']) ?? 0,
        parseIntValue(row['Pengunjung Produk (Kunjungan)']) ?? 0,
        parseIntValue(row['Halaman Produk Dilihat']) ?? 0,
        parseIntValue(row['Pengunjung Melihat Tanpa Membeli']) ?? 0,
        parsePct(row['Tingkat Pengunjung Melihat Tanpa Membeli']),
        parseIntValue(row['Klik Pencarian']) ?? 0,
        parseIntValue(row['Suka']) ?? 0,
        parseIntValue(row['Pengunjung Produk (Menambahkan Produk ke Keranjang)']) ?? 0,
        parseIntValue(row['Dimasukkan ke Keranjang (Produk)']) ?? 0,
        parsePct(row['Tingkat Konversi Produk Dimasukkan ke Keranjang']),
        parseIntValue(row['Produk (Pesanan Dibuat)']) ?? 0,
        parseIntValue(row['Produk (Pesanan Siap Dikirim)']) ?? 0,
        parseIntValue(row['Total Pembeli (Pesanan Dibuat)']) ?? 0,
        parseIntValue(row['Total Pembeli (Pesanan Siap Dikirim)']) ?? 0,
        parsePct(row['Tingkat Konversi (Pesanan yang Dibuat)']),
        parsePct(row['Tingkat Konversi (Pesanan Siap Dikirim)']),
        parseIdr(row['Penjualan per Pesanan (Pesanan Dibuat) (IDR)']),
        parseIdr(row['Penjualan per Pesanan (Pesanan Siap Dikirim) (IDR)']),
        parsePct(row['Tingkat Pesanan Berulang (Pesanan Dibuat)']),
        parsePct(row['% Pembelian Ulang (Pesanan Siap Dikirim)']),
        parseIdr(row['Rata-rata hari Pesanan Berulang (Pesanan Dibuat)']),
        parseIdr(row['Rata-rata Hari Pembelian Terulang (Pesanan Siap Dikirim)']),
        brandId, uploadId,
    ]);
  }

  // Tidak ada produk yang terbaca berarti kolomnya tidak dikenali, bukan
  // bulan yang kosong — gagalkan impornya supaya tidak tercatat "terbaca
  // Dashboard" dengan 0 baris.
  if (summaryRows.length === 0) {
    throw new Error('Tidak ada produk yang terbaca dari sheet "Produk dengan Performa Terbaik". Pastikan file adalah ekspor Performa Toko › Produk › Performa Produk dari Shopee Seller Centre.');
  }

  // brand_id: COALESCE mempertahankan pemilik pertama, sama seperti
  // upsertProduct versi per-baris sebelumnya.
  await insertChunked(
    client, 'products', ['product_id', 'product_name', 'product_status_id', 'brand_id'],
    dedupeBy(productRows, 0),
    `ON CONFLICT (product_id) DO UPDATE
       SET product_name = EXCLUDED.product_name,
           product_status_id = EXCLUDED.product_status_id,
           brand_id = COALESCE(products.brand_id, EXCLUDED.brand_id)`,
    500,
  );

  return insertChunked(
    client, 'product_performance_summary', SUMMARY_COLUMNS, summaryRows,
    'ON CONFLICT (brand_id, period_id, product_id) DO NOTHING RETURNING id', 150,
  );
}

async function upsertProductVariant(client, resolver, brandId, variantId, productId, variantName, statusName) {
  const statusId = await resolver.getOrCreateOne(
    'product_statuses', 'status_id', 'status_name', blankToNone(statusName),
  );
  // variant_sku deliberately left NULL here: the sheet's "SKU Induk" column
  // is the PARENT product's SKU (shared across all its variants), not a
  // per-variant SKU, so writing it here would collide with the partial
  // unique index on variant_sku across sibling variants.
  // brand_id follows the same first-write-wins convention as upsertProduct
  // above (variant_id is a global catalog key, not brand-scoped -- the same
  // sample file can legitimately get uploaded under more than one brand).
  await client.query(
    `INSERT INTO product_variants (variant_id, product_id, variant_name, variant_status_id, brand_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (variant_id) DO UPDATE
       SET product_id = EXCLUDED.product_id,
           variant_name = EXCLUDED.variant_name,
           variant_status_id = EXCLUDED.variant_status_id,
           brand_id = COALESCE(product_variants.brand_id, EXCLUDED.brand_id)`,
    [variantId, productId, variantName, statusId, brandId],
  );
}

// Variant-level rows (Kode Variasi populated, not blank/"-") from the same
// "Produk dengan Performa Terbaik" sheet loadProductPerformance reads —
// these were previously skipped entirely (no loader ever wrote to
// product_variants/product_variant_performance), so the Product Performance
// tab's variant-level view had to be reconstructed from raw orders instead
// of Shopee's own "Pesanan Siap Dikirim" figures. Traffic metrics
// (views/clicks/visitors) are blank ("-") for variant rows in the source
// file, so only sales/order metrics are modeled here.
export async function loadProductVariantPerformance(client, resolver, filepath, brandId, uploadId, periodId) {
  const wb = readWorkbook(filepath);
  const rows = readSheetAsStrings(wb, 'Produk dengan Performa Terbaik').filter((row) => {
    const variant = blankToNone(row['Kode Variasi']);
    return variant != null;
  });

  await resolver.warmSingle('product_statuses', 'status_id', 'status_name',
    rows.map((r) => blankToNone(r['Status Variasi Saat Ini'])));

  const variantRows = [];
  const perfRows = [];

  for (const row of rows) {
    const productId = parseIntValue(row['Kode Produk']);
    const variantId = parseIntValue(row['Kode Variasi']);
    if (!productId || !variantId) continue;

    const statusId = await resolver.getOrCreateOne(
      'product_statuses', 'status_id', 'status_name', blankToNone(row['Status Variasi Saat Ini']),
    );

    // variant_sku sengaja dibiarkan NULL: kolom "SKU Induk" di sheet adalah
    // SKU produk induk (dipakai bersama semua variannya), bukan SKU per
    // varian, jadi menulisnya di sini akan bertabrakan dengan partial unique
    // index variant_sku antar varian bersaudara.
    variantRows.push([variantId, productId, row['Nama Variasi'] ?? '', statusId, brandId]);
    perfRows.push([
      periodId, variantId, statusId,
      parseIntValue(row['Pesanan Dibuat']) ?? 0,
      parseIntValue(row['Pesanan Siap Dikirim']) ?? 0,
      parseIntValue(row['Total Pembeli (Pesanan Dibuat)']) ?? 0,
      parseIntValue(row['Total Pembeli (Pesanan Siap Dikirim)']) ?? 0,
      parseIdr(row['Total Penjualan (Pesanan Dibuat) (IDR)']) ?? 0,
      parseIdr(row['Penjualan (Pesanan Siap Dikirim) (IDR)']) ?? 0,
      parseIntValue(row['Produk (Pesanan Siap Dikirim)']) ?? 0,
      brandId, uploadId,
    ]);
  }

  await insertChunked(
    client, 'product_variants', ['variant_id', 'product_id', 'variant_name', 'variant_status_id', 'brand_id'],
    dedupeBy(variantRows, 0),
    `ON CONFLICT (variant_id) DO UPDATE
       SET product_id = EXCLUDED.product_id,
           variant_name = EXCLUDED.variant_name,
           variant_status_id = EXCLUDED.variant_status_id,
           brand_id = COALESCE(product_variants.brand_id, EXCLUDED.brand_id)`,
    500,
  );

  return insertChunked(
    client, 'product_variant_performance', VARIANT_COLUMNS, perfRows,
    'ON CONFLICT (brand_id, period_id, variant_id) DO NOTHING RETURNING id', 400,
  );
}

// Kedua fungsi di bawah dulu menembakkan satu UPDATE per produk. Kolom yang
// ditulis sama untuk seluruh sheet, jadi seluruh sheet muat dalam satu
// statement lewat = ANY(array).
async function tagProducts(client, filepath, sheetName, brandId, periodId, column, valueId) {
  const wb = readWorkbook(filepath);
  // Optional sheet: Shopee's "parentskudetail" export variant omits the
  // price-competitiveness / ads-recommendation sheets entirely. A missing
  // sheet just means there is nothing to tag -- it must not abort the whole
  // import (readSheetAsStrings throws on an unknown sheet name).
  if (!wb.SheetNames.includes(sheetName)) return 0;
  const ids = readSheetAsStrings(wb, sheetName)
    .map((row) => parseIntValue(row['Kode Produk']))
    .filter(Boolean);
  if (!ids.length) return 0;

  const result = await client.query(
    `UPDATE product_performance_summary
     SET ${column} = $1
     WHERE brand_id = $2 AND period_id = $3 AND product_id = ANY($4::bigint[])`,
    [valueId, brandId, periodId, ids],
  );
  return result.rowCount;
}

export async function applyPriceCompetitiveness(client, resolver, filepath, brandId, periodId, sheetName) {
  const statusId = await resolver.getOrCreateOne(
    'price_competitiveness_statuses', 'status_id', 'status_name', sheetName,
  );
  return tagProducts(client, filepath, sheetName, brandId, periodId, 'price_competitiveness_status_id', statusId);
}

export async function applyAdsRecommendation(client, resolver, filepath, brandId, periodId, sheetName) {
  const stageId = await resolver.getOrCreateOne(
    'ads_recommendation_stages', 'stage_id', 'stage_name', sheetName,
  );
  return tagProducts(client, filepath, sheetName, brandId, periodId, 'ads_recommendation_stage_id', stageId);
}

export async function resolvePeriodId(client, resolver, filepath, brandId, detectedPeriod = null) {
  // The file's own reporting range (from its filename) wins: it is specific
  // to THIS month, whereas the performance-overview fallback below always
  // points at the brand's most recent overview upload -- which pins every
  // Product Performance file to the same month when several are backfilled.
  if (detectedPeriod?.start && detectedPeriod?.end) {
    return resolver.getOrCreate(
      'report_periods', 'period_id', ['period_start', 'period_end'],
      [detectedPeriod.start, detectedPeriod.end],
    );
  }

  // Otherwise, derive from linked performance overview upload for same brand
  const recent = await client.query(
    `SELECT period_start, period_end FROM uploads
     WHERE brand_id = $1 AND file_type = 'performance_overview'
       AND status = 'success' AND period_start IS NOT NULL
     ORDER BY uploaded_at DESC LIMIT 1`,
    [brandId],
  );

  if (recent.rows.length > 0) {
    const { period_start, period_end } = recent.rows[0];
    return resolver.getOrCreate(
      'report_periods', 'period_id', ['period_start', 'period_end'],
      [period_start, period_end],
    );
  }

  const detected = detectProductPerformancePeriod(filepath);
  if (detected.start && detected.end) {
    return resolver.getOrCreate(
      'report_periods', 'period_id', ['period_start', 'period_end'],
      [detected.start, detected.end],
    );
  }

  return null;
}

export { deriveReportPeriod };
