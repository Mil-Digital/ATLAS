import pool from '../../config/db.js';
import { refreshInternalDashboard } from '../internalDashboardSync/dailyTrackingSync.js';
import { LookupResolver } from './lookupResolver.js';
import { parseFilenamePeriod } from './parsers.js';
import { detectOrderPeriod, loadOrders } from './loaders/orders.js';
import {
  detectPerformanceOverviewPeriod,
  deriveReportPeriod,
  loadDailyOrderPerformance,
  loadDailyChannelPerformance,
} from './loaders/performanceOverview.js';
import {
  applyAdsRecommendation,
  applyPriceCompetitiveness,
  detectProductPerformancePeriod,
  loadProductPerformance,
  loadProductVariantPerformance,
  resolvePeriodId,
} from './loaders/productPerformance.js';

const FILE_TYPE_HANDLERS = {
  order: {
    detectPeriod: detectOrderPeriod,
    import: async (client, resolver, filepath, brandId, uploadId) => {
      return loadOrders(client, resolver, filepath, brandId, uploadId);
    },
  },
  performance_overview: {
    detectPeriod: detectPerformanceOverviewPeriod,
    import: async (client, resolver, filepath, brandId, uploadId) => {
      const ordersInserted = await loadDailyOrderPerformance(client, resolver, filepath, brandId, uploadId);
      const channelsInserted = await loadDailyChannelPerformance(client, resolver, filepath, brandId, uploadId);
      return ordersInserted + channelsInserted;
    },
  },
  product_performance: {
    detectPeriod: detectProductPerformancePeriod,
    import: async (client, resolver, filepath, brandId, uploadId, detectedPeriod) => {
      let periodId = await resolvePeriodId(client, resolver, filepath, brandId, detectedPeriod);
      if (!periodId) {
        throw new Error(
          'Periode data tidak dapat ditentukan. Unggah Performance Overview terlebih dahulu atau pastikan file Product Performance memiliki tanggal.',
        );
      }

      let inserted = await loadProductPerformance(
        client, resolver, filepath, brandId, uploadId, periodId,
      );
      inserted += await loadProductVariantPerformance(
        client, resolver, filepath, brandId, uploadId, periodId,
      );
      inserted += await applyPriceCompetitiveness(
        client, resolver, filepath, brandId, periodId, 'Harga Belum Kompetitif',
      );
      inserted += await applyPriceCompetitiveness(
        client, resolver, filepath, brandId, periodId, 'Harga Sudah Kompetitif',
      );
      for (const sheet of ['Tingkatkan dengan Iklan', 'Iklankan', 'Cek Performa Iklan']) {
        inserted += await applyAdsRecommendation(
          client, resolver, filepath, brandId, periodId, sheet,
        );
      }
      return inserted;
    },
  },
};

export function detectPeriod(fileType, filepath, filename) {
  const handler = FILE_TYPE_HANDLERS[fileType];
  if (!handler) throw new Error(`Tipe file tidak dikenal: ${fileType}`);
  return handler.detectPeriod(filepath, filename);
}

// "YYYY-MM" -> that calendar month's first and last day.
function monthBounds(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

// `month` is the library slot ("YYYY-MM") the file was filed under, when
// there is one. Product Performance is a monthly aggregate with no dates in
// it, and a renamed file carries no range in its name either; without the
// slot it fell back to the brand's latest Performance Overview month, which
// pinned every backfilled month onto the same period. The slot month is used
// only to file the rows — the returned `period` stays what the file itself
// says, so the library keeps showing such a file as a monthly snapshot.
export async function processUpload({ uploadId, fileType, filepath, brandId, filename, month = null }) {
  const handler = FILE_TYPE_HANDLERS[fileType];
  if (!handler) throw new Error(`Tipe file tidak dikenal: ${fileType}`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO shopee, public');

    await client.query(
      `UPDATE uploads SET status = 'processing' WHERE upload_id = $1`,
      [uploadId],
    );

    const period = handler.detectPeriod(filepath, filename);
    // A Shopee filename's own range still wins; the slot beats the weaker
    // "newly added products" guess inside detectPeriod.
    const slotPeriod = fileType === 'product_performance' && !parseFilenamePeriod(filename ?? '')
      ? monthBounds(month)
      : null;
    const importPeriod = slotPeriod ?? period;
    await client.query(
      `UPDATE uploads SET period_start = $1, period_end = $2 WHERE upload_id = $3`,
      [importPeriod.start, importPeriod.end, uploadId],
    );

    const resolver = new LookupResolver(client);
    // Dua perubahan yang bertemu di sini: `period` diteruskan supaya
    // Product Performance bisa menentukan periodenya dari nama file, dan
    // loader boleh mengembalikan {inserted, note} saat ada baris yang
    // sengaja dilewati. Catatannya disimpan di uploads.error_message supaya
    // terlihat di History Upload — status tetap 'success', karena filenya
    // memang berhasil diimpor, hanya tidak seluruhnya.
    const outcome = await handler.import(client, resolver, filepath, brandId, uploadId, importPeriod);
    const rowsInserted = typeof outcome === 'number' ? outcome : outcome.inserted;
    const note = typeof outcome === 'number' ? null : outcome.note;

    await client.query(
      `UPDATE uploads SET status = 'success', rows_inserted = $1, completed_at = now(), error_message = $3
       WHERE upload_id = $2`,
      [rowsInserted, uploadId, note],
    );

    await client.query('COMMIT');
    // Performance Overview feeds the Business Insight's Shopee Ads funnel.
    if (fileType === 'performance_overview' && brandId) await refreshInternalDashboard(brandId);
    return { rowsInserted, period, note };
  } catch (err) {
    await client.query('ROLLBACK');
    await pool.query(
      `UPDATE uploads SET status = 'failed', error_message = $1, completed_at = now() WHERE upload_id = $2`,
      [err.message, uploadId],
    );
    throw err;
  } finally {
    client.release();
  }
}
