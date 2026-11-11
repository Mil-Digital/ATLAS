import * as XLSX from 'xlsx';
// xlsx is CommonJS: under Node ESM the namespace import above exposes read/
// utils but NOT SSF — that only exists on the default export.
import XLSXDefault from 'xlsx';
import pool from '../config/db.js';
import * as fileStore from './fileStore.js';

// Pengaturan Brand's data layer: the brand's narrative profile, and the
// file library every other module reads instead of asking for its own
// upload.
//
// The channel vocabulary below is NOT invented here — it is the exact set
// Report Generator already saves into ads_reports.raw_uploads
// ('meta','cpas','produk','produk_otomatis','toko','toko_keyword','live',
// 'overview','tiktok'), plus the three Dashboard file_type values
// ('order','performance_overview','product_performance') and the product
// master reference. Keeping one vocabulary is what lets a library file be
// handed to the report pipeline later with no translation step.

export const LIBRARY_CHANNELS = {
  // Split per campaign type (migration-free: `channel` is TEXT, not an enum).
  // 'meta' stays valid for the combined Boost+Non-Boost exports already in the
  // library — the Report Generator still reads that channel — while new
  // uploads are filed as the three the report vocabulary already names
  // ('boost', 'nonboost', 'cpas_overall' in ads_reports.meta_ad_rows).
  meta: ['meta', 'boost', 'nonboost', 'cpas'],
  shopee: [
    'order',
    'performance_overview',
    'product_performance',
    'produk',
    'produk_otomatis',
    'toko',
    'toko_keyword',
    'live',
    'overview',
    'product_master',
  ],
  tiktok: ['tiktok', 'tiktok_order'],
  // Google Ads (migration 036). Search terms and change history are also
  // filed automatically from what the Google Ads Script pushes; auction
  // insights only ever arrive as an upload (see googleAdsFiles.js).
  // The rest are monthly archive copies of the datasets the script syncs
  // (migrations 040/041): filed automatically, never uploaded.
  google: [
    'auction_insights', 'search_terms', 'change_history',
    'ads', 'conversions', 'impression_share', 'campaign_settings', 'keyword_quality', 'devices', 'hourly', 'landing_pages',
  ],
};

// Slots ATLAS fills itself and that accept no upload: the report reads the
// synced tables, so an uploaded file there would replace the archive copy
// while changing nothing the report shows.
export const AUTO_ONLY_CHANNELS = {
  google: new Set(['ads', 'conversions', 'impression_share', 'campaign_settings', 'keyword_quality', 'devices', 'hourly', 'landing_pages']),
};

export function isAutoOnly(platform, channel) {
  return Boolean(AUTO_ONLY_CHANNELS[platform]?.has(channel));
}

// Files that describe a mapping rather than a period. They are stored with
// period_month = NULL and are never asked "which month is this?".
export const REFERENCE_CHANNELS = new Set(['product_master']);

export function isValidScope(platform, channel) {
  return Boolean(LIBRARY_CHANNELS[platform]?.includes(channel));
}

// Shopee names its Iklan Produk Otomatis export "Rincian Data Iklan Produk
// Otomatis …"; the Iklan Produk slot takes "Data Keseluruhan Iklan Shopee …".
// The Report Generator folds Otomatis rows into Iklan Produk itself, so an
// Otomatis file filed under 'produk' is counted twice. The name is the only
// reliable tell — both exports share the same columns.
export function isShopeeOtomatisFilename(filename = '') {
  return /otomatis/i.test(String(filename));
}

export function shopeeChannelMismatch(platform, channel, filename) {
  if (platform !== 'shopee') return null;
  if (channel === 'produk' && isShopeeOtomatisFilename(filename)) {
    return `${filename} adalah ekspor Iklan Produk Otomatis — unggah ke slot Iklan Produk Otomatis, bukan Iklan Produk`;
  }
  if (channel === 'produk_otomatis' && /keseluruhan/i.test(String(filename))) {
    return `${filename} adalah ekspor Data Keseluruhan Iklan — unggah ke slot Iklan Produk, bukan Iklan Produk Otomatis`;
  }
  return null;
}

/* ── Brand profile ──────────────────────────────────────────────────── */

const PROFILE_FIELDS = [
  'sector',
  'brand_products_customer',
  'positioning_driver',
  'key_products_channels',
  'business_characteristics',
  'historical_learning',
  'objective_target',
  'strategic_priorities',
  'constraints_concerns',
];

export const INDUSTRY_OPTIONS = [
  'Retail Fashion',
  'Retail Non-Fashion',
  'Food & Beverage',
  'B2B Services',
];

export async function getProfile(brandId, db = pool) {
  const result = await db.query(
    `SELECT b.brand_id, b.brand_name, b.industry,
            ${PROFILE_FIELDS.map((f) => `p.${f}`).join(', ')},
            p.updated_at, u.full_name AS updated_by_name
     FROM public.brands b
     LEFT JOIN public.brand_profiles p ON p.brand_id = b.brand_id
     LEFT JOIN public.users u ON u.user_id = p.updated_by
     WHERE b.brand_id = $1`,
    [brandId],
  );
  return result.rows[0] ?? null;
}

export async function saveProfile(brandId, patch, userId) {
  const values = PROFILE_FIELDS.map((field) => (patch[field] === undefined ? null : patch[field]));
  const industry = patch.industry || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE public.brands SET industry = $2 WHERE brand_id = $1', [brandId, industry]);
    await client.query(
      `INSERT INTO public.brand_profiles (brand_id, ${PROFILE_FIELDS.join(', ')}, updated_by, updated_at)
       VALUES ($1, ${PROFILE_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, $${PROFILE_FIELDS.length + 2}, now())
       ON CONFLICT (brand_id) DO UPDATE SET
         ${PROFILE_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ')},
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [brandId, ...values, userId ?? null],
    );
    const profile = await getProfile(brandId, client);
    await client.query('COMMIT');
    return profile;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ── Minutes of Meeting ───────────────────────────────────────────── */

// updated_by_name is a correlated subquery rather than a JOIN so the same list
// works in RETURNING: a freshly saved record comes back already carrying the
// editor's name, instead of rendering nameless until the next full reload.
const MOM_FIELDS = `m.id, m.brand_id, m.meeting_date::text AS meeting_date, m.meeting_type, m.meeting_recap,
  m.todo_client, m.todo_mil, m.completed_task_keys, m.created_at, m.updated_at,
  (SELECT u.full_name FROM public.users u WHERE u.user_id = m.updated_by) AS updated_by_name`;

export async function listMinutes(brandId, { startDate, endDate } = {}) {
  const values = [brandId];
  const clauses = ['m.brand_id = $1'];
  if (startDate) { values.push(startDate); clauses.push(`m.meeting_date >= $${values.length}`); }
  if (endDate) { values.push(endDate); clauses.push(`m.meeting_date <= $${values.length}`); }
  const result = await pool.query(
    `SELECT ${MOM_FIELDS}
     FROM public.brand_minutes m
     WHERE ${clauses.join(' AND ')}
     ORDER BY m.meeting_date DESC, m.id DESC`,
    values,
  );
  return result.rows;
}

export async function createMinute(brandId, input, userId) {
  const result = await pool.query(
    `INSERT INTO public.brand_minutes AS m
       (brand_id, meeting_date, meeting_type, meeting_recap, todo_client, todo_mil, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING ${MOM_FIELDS}`,
    [brandId, input.meeting_date, input.meeting_type, input.meeting_recap || null, input.todo_client || null, input.todo_mil || null, userId ?? null],
  );
  return result.rows[0];
}

export async function updateMinute(brandId, minuteId, input, userId) {
  const result = await pool.query(
    `UPDATE public.brand_minutes m SET
       meeting_date = $3, meeting_type = $4, meeting_recap = $5,
       todo_client = $6, todo_mil = $7, updated_by = $8, updated_at = now()
     WHERE m.brand_id = $1 AND m.id = $2
     RETURNING ${MOM_FIELDS}`,
    [brandId, minuteId, input.meeting_date, input.meeting_type, input.meeting_recap || null, input.todo_client || null, input.todo_mil || null, userId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function deleteMinute(brandId, minuteId) {
  const result = await pool.query('DELETE FROM public.brand_minutes WHERE brand_id = $1 AND id = $2', [brandId, minuteId]);
  return result.rowCount > 0;
}

export async function saveMinuteTaskState(brandId, minuteId, completedTaskKeys, userId) {
  const result = await pool.query(
    `UPDATE public.brand_minutes m
     SET completed_task_keys = $3::jsonb, updated_by = $4, updated_at = now()
     WHERE m.brand_id = $1 AND m.id = $2
     RETURNING ${MOM_FIELDS}`,
    [brandId, minuteId, JSON.stringify(completedTaskKeys), userId ?? null],
  );
  return result.rows[0] ?? null;
}

/* ── Library ────────────────────────────────────────────────────────── */

// Everything except the bytes — the list endpoint is polled on every brand
// switch and must never drag BYTEA columns across the wire.
const LIBRARY_COLUMNS = `
  f.id, f.brand_id, f.platform, f.channel,
  f.period_month::text AS period_month,
  f.period_start::text AS period_start,
  f.period_end::text AS period_end,
  f.covered_days, f.day_bitmap, f.row_count, f.period_source, f.dashboard_upload_id, f.part_index,
  f.import_status, f.import_error, f.import_rows,
  f.original_filename, f.byte_size, f.uploaded_at, f.updated_at,
  u.full_name AS uploaded_by_name
`;

export async function listLibrary(brandId) {
  const result = await pool.query(
    `SELECT ${LIBRARY_COLUMNS}
     FROM ads_reports.brand_library_files f
     LEFT JOIN public.users u ON u.user_id = f.uploaded_by
     WHERE f.brand_id = $1
     ORDER BY f.platform, f.channel, f.period_month NULLS FIRST, f.part_index`,
    [brandId],
  );
  return result.rows;
}

export async function upsertLibraryFile({
  brandId, platform, channel, periodMonth, periodStart, periodEnd,
  coveredDays, dayBitmap, rowCount, periodSource, partIndex = 1, filename, buffer, userId,
}) {
  // Two upsert targets because the uniqueness of a reference file (no
  // month) is expressed by a different partial index than a monthly one.
  const conflict = periodMonth
    ? '(brand_id, platform, channel, period_month, part_index) WHERE period_month IS NOT NULL'
    : '(brand_id, platform, channel) WHERE period_month IS NULL';

  // The bytes go to R2 when it is configured (fileStore), else into the row.
  const stored = await fileStore.storeBytes(fileStore.keys.library(brandId, filename), buffer ?? null);
  let result;
  try {
    result = await pool.query(
    `INSERT INTO ads_reports.brand_library_files
       (brand_id, platform, channel, period_month, period_start, period_end,
        covered_days, day_bitmap, row_count, period_source, part_index, original_filename, byte_size, raw_file, uploaded_by, storage_key)
     VALUES ($1, $2::ads_reports.platform_enum, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT ${conflict} DO UPDATE SET
       period_start = EXCLUDED.period_start,
       period_end = EXCLUDED.period_end,
       covered_days = EXCLUDED.covered_days,
       day_bitmap = EXCLUDED.day_bitmap,
       row_count = EXCLUDED.row_count,
       period_source = EXCLUDED.period_source,
       part_index = EXCLUDED.part_index,
       original_filename = EXCLUDED.original_filename,
       byte_size = EXCLUDED.byte_size,
       raw_file = EXCLUDED.raw_file,
       storage_key = EXCLUDED.storage_key,
       uploaded_by = EXCLUDED.uploaded_by,
       updated_at = now()
     -- The subquery reads the statement's starting snapshot: the replaced
     -- file's object key, removed below once the new row is in.
     RETURNING id, (SELECT prev.storage_key FROM ads_reports.brand_library_files prev WHERE prev.id = brand_library_files.id) AS previous_key`,
    [
      brandId, platform, channel, periodMonth, periodStart, periodEnd,
      coveredDays, dayBitmap, rowCount, periodSource ?? null, partIndex, filename, buffer?.length ?? null, stored.rawFile, userId ?? null, stored.storageKey,
    ],
  );
  } catch (err) {
    await fileStore.deleteBytes(stored.storageKey).catch(() => {});
    throw err;
  }
  const previousKey = result.rows[0].previous_key;
  if (previousKey && previousKey !== stored.storageKey) await fileStore.deleteBytes(previousKey).catch(() => {});

  const saved = await pool.query(
    `SELECT ${LIBRARY_COLUMNS}
     FROM ads_reports.brand_library_files f
     LEFT JOIN public.users u ON u.user_id = f.uploaded_by
     WHERE f.id = $1`,
    [result.rows[0].id],
  );
  return saved.rows[0];
}

// The three exports Dashboard Brand Overview is built on. Everything else
// in the library is read by the Report Generator straight from its bytes;
// these three have to be parsed into shopee.* fact tables as well, because
// that is what the dashboard queries.
export const DASHBOARD_FILE_TYPES = {
  order: 'order',
  performance_overview: 'performance_overview',
  product_performance: 'product_performance',
};

// Once a Dashboard file has actually been parsed, the rows that landed in
// the fact tables are the truth about what it covers — more reliable than
// the filename, which is a request parameter Shopee echoes back, not a
// description of the contents. "Order.all.20260801_20260831_part_1_of_2"
// names the whole month and holds three weeks of it; without this the
// library would report a complete August that the dashboard cannot back up.
export async function syncCoverageFromImport(fileId, range, monthKey) {
  if (!range?.start || !range?.end) return null;
  const summary = summariseRange(range, monthKey);
  // Nol hari setelah dipotong ke bulan slotnya berarti rentang file memang di
  // luar bulan itu — bukan "snapshot tanpa tanggal". Menandainya 'import'
  // akan menghapus satu-satunya petunjuk bahwa filenya salah slot.
  // range.source = 'overview' when the range was matched from Performance
  // Overview sales (Product Performance carries no dates of its own).
  const source = summary.coveredDays === 0 ? 'mismatch' : (range.source ?? 'import');
  const result = await pool.query(
    `UPDATE ads_reports.brand_library_files
     SET period_start = $2, period_end = $3, covered_days = $4, day_bitmap = $5, period_source = $6, updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [fileId, summary.periodStart, summary.periodEnd, summary.coveredDays, summary.dayBitmap, source],
  );
  return result.rowCount ? { ...summary, source } : null;
}

export async function setDashboardUpload(fileId, uploadId) {
  await pool.query(
    'UPDATE ads_reports.brand_library_files SET dashboard_upload_id = $1 WHERE id = $2',
    [uploadId, fileId],
  );
}

// Hasil impor disimpan eksplisit, bukan disimpulkan dari ada-tidaknya
// dashboard_upload_id: "gagal" dan "bukan dataset Dashboard" sama-sama
// membuat kolom itu NULL, dan membedakan keduanya justru yang dibutuhkan UI.
export async function setImportResult(fileId, { status, error = null, rows = null, uploadId = null }) {
  await pool.query(
    `UPDATE ads_reports.brand_library_files
     SET import_status = $2, import_error = $3, import_rows = $4,
         dashboard_upload_id = COALESCE($5, CASE WHEN $2 = 'failed' THEN NULL ELSE dashboard_upload_id END),
         updated_at = now()
     WHERE id = $1`,
    [fileId, status, error, rows, uploadId],
  );
}

// Byte file untuk impor ulang — supaya percobaan kedua tidak menuntut
// pengguna mengunggah file yang sama sekali lagi.
export async function getFileForImport(brandId, fileId) {
  const result = await pool.query(
    `SELECT id, brand_id, platform, channel, period_month::text AS period_month,
            original_filename, raw_file, storage_key, dashboard_upload_id, uploaded_by
     FROM ads_reports.brand_library_files
     WHERE brand_id = $1 AND id = $2`,
    [brandId, fileId],
  );
  return withBytes(result.rows[0]);
}

// A row as callers have always had it: raw_file holds the bytes, wherever
// they are kept (the row itself, or R2 under storage_key).
async function withBytes(row) {
  if (!row) return null;
  const rawFile = await fileStore.readBytes({ rawFile: row.raw_file, storageKey: row.storage_key });
  return { ...row, raw_file: rawFile };
}

// Every part already filed under one month slot, oldest part first.
export async function listSlotParts(brandId, platform, channel, periodMonth) {
  const result = await pool.query(
    `SELECT id, part_index, original_filename, dashboard_upload_id, day_bitmap
     FROM ads_reports.brand_library_files
     WHERE brand_id = $1 AND platform = $2::ads_reports.platform_enum AND channel = $3
       AND period_month IS NOT DISTINCT FROM $4
     ORDER BY part_index`,
    [brandId, platform, channel, periodMonth],
  );
  return result.rows;
}

export function hasCoverageOverlap(existingParts, dayBitmap) {
  if (!dayBitmap) return false;
  return existingParts.some((part) => part.day_bitmap && [...dayBitmap].some((day, index) => day === '1' && part.day_bitmap[index] === '1'));
}

// Where a newly uploaded file belongs in the slot. Re-uploading a file with
// the same name replaces that part rather than adding a duplicate of it —
// picking the same export twice is a slip, not a request for two copies.
export function placePart(existingParts, filename, replaceFileId = null) {
  if (replaceFileId != null) {
    const target = existingParts.find((part) => part.id === replaceFileId);
    if (!target) return null;
    return { partIndex: target.part_index, previousUploadId: target.dashboard_upload_id, replaced: true };
  }
  const sameName = existingParts.find((part) => part.original_filename === filename);
  if (sameName) return { partIndex: sameName.part_index, previousUploadId: sameName.dashboard_upload_id, replaced: true };
  const next = existingParts.reduce((max, part) => Math.max(max, part.part_index), 0) + 1;
  return { partIndex: next, previousUploadId: null, replaced: false };
}

export async function deleteLibraryFile(brandId, fileId) {
  const result = await pool.query(
    'DELETE FROM ads_reports.brand_library_files WHERE brand_id = $1 AND id = $2 RETURNING id, dashboard_upload_id, storage_key',
    [brandId, fileId],
  );
  const row = result.rows[0];
  if (row?.storage_key) await fileStore.deleteBytes(row.storage_key).catch(() => {});
  return row ?? null;
}

// A file's identity without its bytes: enough to answer a revalidation.
export async function getLibraryFileHead(brandId, fileId) {
  const result = await pool.query(
    `SELECT original_filename, storage_key, updated_at, (raw_file IS NOT NULL OR storage_key IS NOT NULL) AS has_bytes
     FROM ads_reports.brand_library_files WHERE brand_id = $1 AND id = $2`,
    [brandId, fileId],
  );
  return result.rows[0] ?? null;
}

export async function getLibraryFileBytes(brandId, fileId) {
  const result = await pool.query(
    'SELECT original_filename, raw_file, storage_key FROM ads_reports.brand_library_files WHERE brand_id = $1 AND id = $2',
    [brandId, fileId],
  );
  return withBytes(result.rows[0]);
}

/* ── Period detection ───────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// Excel serials only count as dates inside a sane window (roughly 2009 to
// 2064). Without that guard every quantity/price column in the sheet would
// register as a date and the detected period would be nonsense.
const SERIAL_MIN = 40000;
const SERIAL_MAX = 60000;

function cellToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return iso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number' && value >= SERIAL_MIN && value <= SERIAL_MAX) {
    const parsed = XLSXDefault.SSF.parse_date_code(value);
    return parsed ? iso(parsed.y, parsed.m, parsed.d) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  // Indonesian exports write DD-MM-YYYY / DD/MM/YYYY; day-first is the
  // right reading for both Shopee and TikTok Seller Center.
  m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

// Marketplace exports are not always the .xlsx their extension claims:
// Shopee and TikTok Seller Centre both hand out "Excel" files that are
// really CSV or an HTML table, and those throw on a plain buffer read. Try
// the honest reading first, then the text readings, before giving up.
function readWorkbook(buffer) {
  // raw:true is load-bearing, not tidiness. Without it SheetJS parses a
  // text date like "01-06-2026" month-first and hands back 6 January —
  // silently moving every Indonesian date whose day is <= 12 into the wrong
  // month. Keeping text as text lets cellToIso() below apply the day-first
  // reading these exports actually use. Real date-typed cells still arrive
  // as Date objects, which are unambiguous.
  const options = { cellDates: true, raw: true };
  try {
    return XLSX.read(buffer, { type: 'buffer', ...options });
  } catch (bufferError) {
    try {
      return XLSX.read(buffer.toString('utf8'), { type: 'string', ...options });
    } catch {
      throw bufferError;
    }
  }
}

// Scans every sheet for date-shaped cells. Deliberately header-agnostic:
// the eleven supported exports name their date column at least six
// different ways ("Tanggal", "Waktu Pesanan Dibuat", "Day", "Tanggal
// Mulai"...), and a whitelist would silently detect nothing the first time
// a platform renames one.
export function detectDates(buffer, { maxRows = 20000 } = {}) {
  const workbook = typeof buffer?.SheetNames === 'undefined' ? readWorkbook(buffer) : buffer;
  const dates = new Set();
  let rowCount = 0;

  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, blankrows: false });
    rowCount = Math.max(rowCount, Math.max(rows.length - 1, 0));
    for (const row of rows.slice(0, maxRows)) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const found = cellToIso(cell);
        if (found) dates.add(found);
      }
    }
  }
  return { dates: [...dates].sort(), rowCount, workbook };
}

// ── Where a period actually comes from ──────────────────────────────
//
// Row dates are the LAST resort, not the first. The two most common Shopee
// exports prove why:
//
//   - "Data Keseluruhan Iklan Shopee" carries one row per campaign, and its
//     Tanggal Mulai is the day that campaign was created — dates spanning
//     2024 to 2026 in a report about July 2026. Reading the rows gives a
//     confidently wrong answer. The file states its real period on a
//     "Periode,01/07/2026 - 31/07/2026" line above the table.
//   - "parentskudetail" (performa toko) has no date column at all; its
//     period lives only in the filename, 20260701_20260731.
//
// So: a declared period beats a filename, a filename beats row dates, and
// row dates are trusted only when nothing better exists.

const RANGE_PATTERNS = [
  // 01/07/2026 - 31/07/2026 · 01-07-2026 s/d 31-07-2026 (day-first)
  { re: /(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s*(?:-|–|s\/d|sampai|to|until)\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i, order: 'dmy' },
  // 2026-07-01 to 2026-07-31
  { re: /(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:-|–|s\/d|to|until)\s*(\d{4})-(\d{1,2})-(\d{1,2})/i, order: 'ymd' },
];

// Google Ads exports put the range on its own line under the report title,
// with month names: "September 1, 2026 - September 30, 2026" (English UI),
// "1 September 2026 - 30 September 2026" (Indonesian), "Sep 1, 2026 – …".
const MONTH_NUMBER = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8, agt: 8,
  sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12,
};
const MONTH_WORD = '([A-Za-z]{3,9})\\.?';
const NAMED_RANGE_PATTERNS = [
  { re: new RegExp(`${MONTH_WORD}\\s+(\\d{1,2}),?\\s+(\\d{4})\\s*(?:-|–|to|s/d|sampai)\\s*${MONTH_WORD}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'), order: 'mdy' },
  { re: new RegExp(`(\\d{1,2})\\s+${MONTH_WORD}\\s+(\\d{4})\\s*(?:-|–|to|s/d|sampai)\\s*(\\d{1,2})\\s+${MONTH_WORD}\\s+(\\d{4})`, 'i'), order: 'dmy' },
];
const monthOf = (word) => MONTH_NUMBER[String(word).slice(0, 3).toLowerCase()] ?? null;

function namedRangeFromText(text) {
  for (const { re, order } of NAMED_RANGE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const [a, b, c, d, e, f] = m.slice(1);
    const [m1, d1, y1, m2, d2, y2] = order === 'mdy' ? [monthOf(a), b, c, monthOf(d), e, f] : [monthOf(b), a, c, monthOf(e), d, f];
    if (!m1 || !m2) continue;
    return { start: iso(Number(y1), m1, Number(d1)), end: iso(Number(y2), m2, Number(d2)) };
  }
  return null;
}

function rangeFromText(text) {
  for (const { re, order } of RANGE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const [a, b, c, d, e, f] = m.slice(1).map(Number);
    return order === 'dmy'
      ? { start: iso(c, b, a), end: iso(f, e, d) }
      : { start: iso(a, b, c), end: iso(d, e, f) };
  }
  return null;
}

// A "Periode" / "Reporting period" line in the rows above the table. Only
// the first handful of rows are considered: further down, a cell reading
// "Periode" is a data value, not a header.
export function detectDeclaredPeriod(workbook, { scanRows = 12 } = {}) {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, blankrows: false }).slice(0, scanRows);
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const text = row.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? ''))).join(' ');
      // A row that is nothing but a named-month range is a declared period
      // even without a "Period" label — that is how Google Ads writes it.
      const named = namedRangeFromText(text);
      if (named && text.replace(/[\s,]/g, '').length <= 60) return named;
      if (!/periode|period|rentang|date range/i.test(text)) continue;
      const range = rangeFromText(text);
      if (range) return range;
    }
  }
  return null;
}

// Shopee and TikTok both stamp the range into the download name:
// "...-01_07_2026-31_07_2026.csv", "parentskudetail.20260701_20260731.xlsx".
export function detectFilenamePeriod(filename = '') {
  const name = String(filename);
  let m = name.match(/(\d{2})[_-](\d{2})[_-](\d{4})\D{1,3}(\d{2})[_-](\d{2})[_-](\d{4})/);
  if (m) {
    const [d1, m1, y1, d2, m2, y2] = m.slice(1).map(Number);
    return { start: iso(y1, m1, d1), end: iso(y2, m2, d2) };
  }
  m = name.match(/(\d{4})(\d{2})(\d{2})\D{1,3}(\d{4})(\d{2})(\d{2})/);
  if (m) {
    const [y1, m1, d1, y2, m2, d2] = m.slice(1).map(Number);
    return { start: iso(y1, m1, d1), end: iso(y2, m2, d2) };
  }
  return rangeFromText(name);
}

// Turns the detected dates into the coverage the UI draws.
export function summarisePeriod(dates, forcedMonth = null) {
  if (!dates.length) {
    if (!forcedMonth) return { periodMonth: null, periodStart: null, periodEnd: null, coveredDays: 0, dayBitmap: null };
    const [y, m] = forcedMonth.split('-').map(Number);
    return { periodMonth: iso(y, m, 1), periodStart: null, periodEnd: null, coveredDays: 0, dayBitmap: '0'.repeat(daysInMonth(y, m)) };
  }

  let year;
  let month;
  if (forcedMonth) {
    [year, month] = forcedMonth.split('-').map(Number);
  } else {
    // The month that owns the most dates — a campaign export whose rows sit
    // in July but whose "Tanggal Selesai" spills into August belongs to July.
    const tally = new Map();
    for (const date of dates) {
      const key = date.slice(0, 7);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    [year, month] = best[0].split('-').map(Number);
  }

  const total = daysInMonth(year, month);
  const prefix = `${year}-${pad(month)}-`;
  const inMonth = dates.filter((d) => d.startsWith(prefix));
  const days = new Set(inMonth.map((d) => Number(d.slice(8, 10))));

  // A campaign-level export carries "Tanggal Mulai"/"Tanggal Selesai", not
  // one row per day: every row repeats the same one or two ranges. Four
  // distinct days spanning a fortnight means the file covers the fortnight,
  // not four days — fill the span so coverage isn't understated. The bound
  // is deliberately low: a daily export has far more distinct days than
  // this, so its exact (and possibly gappy) coverage is left untouched.
  if (days.size > 0 && days.size <= 4) {
    const min = Math.min(...days);
    const max = Math.max(...days);
    if (max - min >= 2) for (let d = min; d <= max; d += 1) days.add(d);
  }

  const bitmap = Array.from({ length: total }, (_, i) => (days.has(i + 1) ? '1' : '0')).join('');
  const sorted = [...days].sort((a, b) => a - b);
  return {
    periodMonth: iso(year, month, 1),
    periodStart: sorted.length ? iso(year, month, sorted[0]) : null,
    periodEnd: sorted.length ? iso(year, month, sorted[sorted.length - 1]) : null,
    coveredDays: sorted.length,
    dayBitmap: bitmap,
  };
}

// The single entry point the controller uses: read the file once, then let
// the best available signal decide the period. `source` travels back to the
// UI so the user can see WHY a month was filled in the way it was.
export function analyseFile({ buffer, filename, month }) {
  const workbook = readWorkbook(buffer);
  const { dates, rowCount } = detectDates(workbook);

  const declared = detectDeclaredPeriod(workbook);
  const fromName = detectFilenamePeriod(filename);
  const range = declared ?? fromName;

  if (range) {
    return {
      ...summariseRange(range, month),
      rowCount,
      source: declared ? 'declared' : 'filename',
      declaredRange: range,
    };
  }
  return { ...summarisePeriod(dates, month), rowCount, source: dates.length ? 'rows' : 'none', declaredRange: null };
}

// Coverage from an explicit start/end range, clipped to the month the file
// was filed under. A range that misses the month entirely yields no days —
// the caller turns that into a "wrong slot?" warning rather than a silent 0.
export function summariseRange(range, forcedMonth) {
  const monthKey = forcedMonth ?? range.start.slice(0, 7);
  const [year, month] = monthKey.split('-').map(Number);
  const total = daysInMonth(year, month);
  const monthStart = iso(year, month, 1);
  const monthEnd = iso(year, month, total);

  const start = range.start > monthStart ? range.start : monthStart;
  const end = range.end < monthEnd ? range.end : monthEnd;

  if (start > end) {
    return { periodMonth: iso(year, month, 1), periodStart: null, periodEnd: null, coveredDays: 0, dayBitmap: '0'.repeat(total) };
  }

  const from = Number(start.slice(8, 10));
  const to = Number(end.slice(8, 10));
  const bitmap = Array.from({ length: total }, (_, i) => (i + 1 >= from && i + 1 <= to ? '1' : '0')).join('');
  return { periodMonth: iso(year, month, 1), periodStart: start, periodEnd: end, coveredDays: to - from + 1, dayBitmap: bitmap };
}
