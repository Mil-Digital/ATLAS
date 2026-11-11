import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import pool from '../src/config/db.js';
import * as library from '../src/services/brandLibraryService.js';
import * as uploadService from '../src/services/uploadService.js';
import { processUpload } from '../src/services/import/importService.js';

dotenv.config();

// Backfill: run the Dashboard importer over files that are already in the
// brand library but were uploaded before Pengaturan Brand started importing
// them (or whose import failed and needs a retry).
//
//   node scripts/importLibraryToDashboard.js            # every brand
//   node scripts/importLibraryToDashboard.js 95         # one brand
//   node scripts/importLibraryToDashboard.js 95 --force # re-import even if
//                                                       # already imported
//
// Safe to re-run: a file that already has a dashboard_upload_id is skipped
// unless --force, and --force deletes the previous import first so the fact
// tables never double-count a month.

// Performance Overview first on purpose: Product Performance resolves its
// period from the periods that file establishes, and fails without one.
const ORDER = ['performance_overview', 'order', 'product_performance'];

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const brandArg = args.find((a) => /^\d+$/.test(a));
  const brandId = brandArg ? Number(brandArg) : null;

  const { rows } = await pool.query(
    `SELECT f.id, f.brand_id, b.brand_name, f.channel, f.period_month::text AS period_month,
            f.original_filename, f.raw_file, f.dashboard_upload_id, f.uploaded_by
     FROM ads_reports.brand_library_files f
     JOIN public.brands b ON b.brand_id = f.brand_id
     WHERE f.channel = ANY($1) ${brandId ? 'AND f.brand_id = $2' : ''}
     ORDER BY f.brand_id, f.period_month`,
    brandId ? [Object.keys(library.DASHBOARD_FILE_TYPES), brandId] : [Object.keys(library.DASHBOARD_FILE_TYPES)],
  );

  // uploads.user_id is NOT NULL, and a library row uploaded by an older
  // build may not record who did it — attribute those to an admin rather
  // than failing the whole backfill on a bookkeeping column.
  const fallback = await pool.query("SELECT user_id FROM public.users WHERE role = 'admin' ORDER BY user_id LIMIT 1");
  const fallbackUserId = fallback.rows[0]?.user_id ?? null;

  const queue = rows
    .filter((r) => force || !r.dashboard_upload_id)
    .sort((a, b) => ORDER.indexOf(a.channel) - ORDER.indexOf(b.channel));

  if (!queue.length) {
    console.log('Tidak ada file yang perlu diimpor.');
    return;
  }
  console.log(`Mengimpor ${queue.length} file ke tabel Dashboard...\n`);

  for (const row of queue) {
    const label = `${row.brand_name} · ${row.channel} · ${row.period_month ?? '-'}`;
    if (force && row.dashboard_upload_id) {
      await uploadService.deleteUpload(row.dashboard_upload_id).catch(() => {});
    }
    const uploadId = uuidv4();
    try {
      await uploadService.createUploadRecord({
        uploadId,
        userId: row.uploaded_by ?? fallbackUserId,
        brandId: row.brand_id,
        fileType: library.DASHBOARD_FILE_TYPES[row.channel],
        filename: row.original_filename,
        rawFile: row.raw_file,
      });
      const result = await processUpload({
        uploadId,
        fileType: library.DASHBOARD_FILE_TYPES[row.channel],
        filepath: row.raw_file,
        brandId: row.brand_id,
        filename: row.original_filename,
        month: row.period_month?.slice(0, 7) ?? null,
      });
      await library.setDashboardUpload(row.id, uploadId);
      const synced = await library.syncCoverageFromImport(row.id, result.period, row.period_month?.slice(0, 7));
      const coverage = synced ? ` · coverage disesuaikan ke ${synced.coveredDays} hari` : '';
      console.log(`  OK    ${label} — ${result.rowsInserted} baris (${result.period.start} → ${result.period.end})${coverage}`);
    } catch (err) {
      console.log(`  GAGAL ${label} — ${err.message}`);
    }
  }
}

main()
  .catch((err) => { console.error('Backfill gagal:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
