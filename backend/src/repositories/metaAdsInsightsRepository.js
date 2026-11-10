import pool from '../config/db.js';

// Every query takes an optional `db` (a checked-out client) so a rows upsert
// and its log update can share one transaction. Dates are cast `::text` in
// SELECTs, same reasoning as dailyTrackingRepository.

// ---------------------------------------------------------------------
// meta_ads_insights_daily
// ---------------------------------------------------------------------
// Bulk upsert through jsonb_to_recordset: one bound parameter no matter how
// many rows, so a 500-row chunk never runs into the driver's parameter cap.
export async function upsertInsightRows({ brandId, accountType, adAccountId, runId, rows }, db = pool) {
  if (!rows.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO meta_ads_insights_daily
       (brand_id, account_type, ad_account_id, entry_date, campaign_id, campaign_name,
        adset_id, adset_name, ad_id, ad_name, age, gender,
        objective, amount_spent, impressions, reach, link_clicks, purchases, purchase_value, metrics, fetch_run_id)
     SELECT $1, $2, $3, r.entry_date, r.campaign_id, r.campaign_name,
            COALESCE(r.adset_id, ''), COALESCE(r.adset_name, ''), COALESCE(r.ad_id, ''), COALESCE(r.ad_name, ''), r.age, r.gender,
            r.objective, r.amount_spent, r.impressions, r.reach, r.link_clicks, r.purchases, r.purchase_value,
            COALESCE(r.metrics, '{}'::jsonb), $5
     FROM jsonb_to_recordset($4::jsonb) AS r(
       entry_date date, campaign_id text, campaign_name text,
       adset_id text, adset_name text, ad_id text, ad_name text, age text, gender text,
       objective text, amount_spent numeric, impressions numeric, reach numeric,
       link_clicks numeric, purchases numeric, purchase_value numeric, metrics jsonb)
     ON CONFLICT (brand_id, account_type, entry_date, campaign_id, adset_id, ad_id, age, gender) DO UPDATE SET
       ad_account_id  = EXCLUDED.ad_account_id,
       campaign_name  = EXCLUDED.campaign_name,
       adset_name     = EXCLUDED.adset_name,
       ad_name        = EXCLUDED.ad_name,
       objective      = EXCLUDED.objective,
       amount_spent   = EXCLUDED.amount_spent,
       impressions    = EXCLUDED.impressions,
       reach          = EXCLUDED.reach,
       link_clicks    = EXCLUDED.link_clicks,
       purchases      = EXCLUDED.purchases,
       purchase_value = EXCLUDED.purchase_value,
       metrics        = EXCLUDED.metrics,
       fetch_run_id   = EXCLUDED.fetch_run_id,
       fetched_at     = now()`,
    [brandId, accountType, adAccountId, JSON.stringify(rows), runId],
  );
  return rowCount;
}

// End of a successful run: whatever of that month this run did not write is
// stale (a campaign/day that no longer exists in Meta's numbers).
export async function deleteStaleRows({ brandId, accountType, adAccountId, startDate, endDate, runId }, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM meta_ads_insights_daily
     WHERE brand_id = $1 AND account_type = $2 AND ad_account_id = $3
       AND entry_date >= $4 AND entry_date <= $5 AND fetch_run_id <> $6`,
    [brandId, accountType, adAccountId, startDate, endDate, runId],
  );
  return rowCount;
}

export async function deleteMonthRows({ brandId, accountType, startDate, endDate }, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM meta_ads_insights_daily
     WHERE brand_id = $1 AND account_type = $2 AND entry_date >= $3 AND entry_date <= $4`,
    [brandId, accountType, startDate, endDate],
  );
  return rowCount;
}

// Every stored row in a date range, oldest first — the source for the library
// file (one month) and for the Report Generator's custom range.
export async function listRowsInRange({ brandId, accountType, startDate, endDate }, db = pool) {
  const { rows } = await db.query(
    `SELECT d.entry_date::text AS entry_date, d.ad_account_id, d.campaign_name, d.adset_name, d.ad_name, d.age, d.gender, d.objective,
            d.amount_spent, d.impressions, d.reach, d.link_clicks, d.purchases, d.purchase_value, d.metrics,
            p.preview_link
     FROM meta_ads_insights_daily d
     LEFT JOIN meta_ad_previews p ON p.brand_id = d.brand_id AND p.ad_id = d.ad_id
     WHERE d.brand_id = $1 AND d.account_type = $2 AND d.entry_date >= $3 AND d.entry_date <= $4
     ORDER BY d.entry_date, d.campaign_name, d.adset_name, d.ad_name, d.age, d.gender`,
    [brandId, accountType, startDate, endDate],
  );
  return rows;
}

// ---------------------------------------------------------------------
// meta_ad_previews
// ---------------------------------------------------------------------
export async function upsertAdPreviews({ brandId, ads }, db = pool) {
  if (!ads.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO meta_ad_previews (brand_id, ad_id, preview_link)
     SELECT $1, r.ad_id, r.preview_link
     FROM jsonb_to_recordset($2::jsonb) AS r(ad_id text, preview_link text)
     ON CONFLICT (brand_id, ad_id) DO UPDATE SET
       preview_link = EXCLUDED.preview_link,
       updated_at   = now()`,
    [brandId, JSON.stringify(ads)],
  );
  return rowCount;
}

// How each MAIN ad account of the brand splits Boost / Non-Boost — its kind
// (MIXED/BOOST/NONBOOST) and Kata Kunci Boost Post (kept lower-case) — from
// the Meta Ads Automation mirror (brand_ad_accounts).
export async function listMainAccountSplits(brandId, db = pool) {
  const { rows } = await db.query(
    "SELECT ad_account_id, main_kind, boost_keyword FROM brand_ad_accounts WHERE brand_id = $1 AND account_type = 'MAIN'",
    [brandId],
  );
  return new Map(rows.map((r) => [r.ad_account_id, r]));
}

// Per account type × month: what is actually stored.
export async function summariseMonths(brandId, db = pool) {
  const { rows } = await db.query(
    `SELECT account_type,
            to_char(date_trunc('month', entry_date), 'YYYY-MM') AS month,
            COUNT(*)::int                      AS row_count,
            COUNT(DISTINCT entry_date)::int    AS day_count,
            COUNT(DISTINCT campaign_id)::int   AS campaign_count,
            COALESCE(SUM(amount_spent), 0)     AS amount_spent,
            MAX(fetched_at)                    AS fetched_at
     FROM meta_ads_insights_daily
     WHERE brand_id = $1
     GROUP BY account_type, date_trunc('month', entry_date)
     ORDER BY month DESC, account_type`,
    [brandId],
  );
  return rows;
}

// Which days are stored, per account type — what the Report Generator's
// custom range can be picked from.
export async function listStoredDays(brandId, db = pool) {
  const { rows } = await db.query(
    `SELECT account_type, entry_date::text AS entry_date
     FROM meta_ads_insights_daily
     WHERE brand_id = $1
     GROUP BY account_type, entry_date
     ORDER BY account_type, entry_date`,
    [brandId],
  );
  return rows;
}

// ---------------------------------------------------------------------
// meta_ads_fetch_log
// ---------------------------------------------------------------------
export async function insertRun({ brandId, accountType, adAccountId, month, rangeStart, rangeEnd, trigger, runId }, db = pool) {
  await db.query(
    `INSERT INTO meta_ads_fetch_log (brand_id, account_type, ad_account_id, month, range_start, range_end, trigger, fetch_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [brandId, accountType, adAccountId, month, rangeStart, rangeEnd, trigger, runId],
  );
}

export async function getRun(runId, db = pool) {
  const { rows } = await db.query(
    `SELECT brand_id, account_type, ad_account_id, month::text AS month,
            range_start::text AS range_start, range_end::text AS range_end, status
     FROM meta_ads_fetch_log WHERE fetch_run_id = $1`,
    [runId],
  );
  return rows[0] ?? null;
}

export async function finishRun({ runId, status, rowCount, note }, db = pool) {
  await db.query(
    `UPDATE meta_ads_fetch_log
     SET status = $2, row_count = $3, note = $4, finished_at = now()
     WHERE fetch_run_id = $1`,
    [runId, status, rowCount, note ?? null],
  );
}

export async function listRecentRuns(brandId, limit = 30, db = pool) {
  const { rows } = await db.query(
    `SELECT account_type, to_char(month, 'YYYY-MM') AS month,
            range_start::text AS range_start, range_end::text AS range_end,
            trigger, status, row_count, note, started_at, finished_at
     FROM meta_ads_fetch_log
     WHERE brand_id = $1
     ORDER BY started_at DESC
     LIMIT $2`,
    [brandId, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------
// meta_ads_fetch_requests (migration 064): one row per "Tarik sekarang"
// ---------------------------------------------------------------------
export async function insertFetchRequest({ brandId, accountType, month, rangeStart, rangeEnd, accountIds, queuedItems, userId }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO meta_ads_fetch_requests (brand_id, account_type, month, range_start, range_end, account_ids, queued_items, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [brandId, accountType, `${month}-01`, rangeStart, rangeEnd, accountIds, queuedItems ?? null, userId ?? null],
  );
  return rows[0].id;
}

// The brand's presses of the last day, newest first.
export async function listRecentFetchRequests(brandId, db = pool) {
  const { rows } = await db.query(
    `SELECT r.id, r.account_type, to_char(r.month, 'YYYY-MM') AS month,
            r.range_start::text AS range_start, r.range_end::text AS range_end,
            r.account_ids, r.queued_items, r.requested_at, u.full_name AS requested_by_name
     FROM meta_ads_fetch_requests r
     LEFT JOIN users u ON u.user_id = r.requested_by
     WHERE r.brand_id = $1 AND r.requested_at > now() - interval '1 day'
     ORDER BY r.requested_at DESC
     LIMIT 8`,
    [brandId],
  );
  return rows;
}

// Manual runs of one brand/type/month that started from `since` on.
export async function listRunsSince({ brandId, accountType, month, since }, db = pool) {
  const { rows } = await db.query(
    `SELECT fetch_run_id, ad_account_id, range_start::text AS range_start, range_end::text AS range_end,
            status, row_count, note, started_at, finished_at
     FROM meta_ads_fetch_log
     WHERE brand_id = $1 AND account_type = $2 AND month = $3::date
       AND trigger = 'manual' AND started_at >= $4
     ORDER BY started_at`,
    [brandId, accountType, `${month}-01`, since],
  );
  return rows;
}

// How far running runs have got: the days and rows they have written so far.
export async function ingestedSoFar({ brandId, accountType, runIds, startDate, endDate }, db = pool) {
  if (!runIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT fetch_run_id, array_agg(DISTINCT entry_date::text) AS dates, COUNT(*)::int AS rows
     FROM meta_ads_insights_daily
     WHERE brand_id = $1 AND account_type = $2 AND entry_date BETWEEN $3 AND $4
       AND fetch_run_id = ANY($5::text[])
     GROUP BY fetch_run_id`,
    [brandId, accountType, startDate, endDate, runIds],
  );
  return new Map(rows.map((r) => [r.fetch_run_id, { dates: r.dates ?? [], rows: r.rows }]));
}

// The auto-filed library copies of a month, with when each was last written.
export async function autoLibraryFiles({ brandId, channels, month }, db = pool) {
  const { rows } = await db.query(
    `SELECT channel, original_filename, row_count, COALESCE(updated_at, uploaded_at) AS written_at
     FROM ads_reports.brand_library_files
     WHERE brand_id = $1 AND platform = 'meta'::ads_reports.platform_enum AND channel = ANY($2)
       AND period_month = $3::date`,
    [brandId, channels, `${month}-01`],
  );
  return rows;
}

// What else the shared Apps Script queue is busy with: runs going on now and
// presses still waiting, for other brands.
export async function queueActivityElsewhere(brandId, staleMinutes, db = pool) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM meta_ads_fetch_log
         WHERE brand_id <> $1 AND status = 'running' AND started_at > now() - make_interval(mins => $2)) AS running,
       (SELECT COUNT(DISTINCT brand_id)::int FROM meta_ads_fetch_log
         WHERE brand_id <> $1 AND status = 'running' AND started_at > now() - make_interval(mins => $2)) AS brands`,
    [brandId, staleMinutes],
  );
  return rows[0];
}
