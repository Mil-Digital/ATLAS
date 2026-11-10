-- =====================================================================
-- 064 — "Tarik sekarang" requests for Meta Ads auto-fetch
--
-- Pressing "Tarik Meta Ads" only queues work in Apps Script: the month is
-- split into 7-day runs per ad account, run one after another in a queue
-- shared by every brand, and each run reports to meta_ads_fetch_log once it
-- starts. Between the press and the first run nothing in ATLAS said a pull
-- was coming, so the page stopped watching and nobody — the person who
-- pressed it or anyone else on the brand — could tell when it finished.
--
-- One row per press. Its progress is not stored: it is read from the runs
-- that started after it (days fetched against range days × accounts) and
-- from the library file the last run writes, so nothing here needs
-- updating by Apps Script.
--
-- Additive only; idempotent / re-runnable.
-- =====================================================================

SET search_path TO public;

CREATE TABLE IF NOT EXISTS meta_ads_fetch_requests (
    id            BIGSERIAL PRIMARY KEY,
    brand_id      INTEGER NOT NULL REFERENCES brands(brand_id) ON DELETE CASCADE,
    account_type  TEXT    NOT NULL,
    month         DATE    NOT NULL,
    range_start   DATE    NOT NULL,
    range_end     DATE    NOT NULL,
    account_ids   TEXT[]  NOT NULL DEFAULT '{}',
    queued_items  INTEGER,
    requested_by  INTEGER REFERENCES users(user_id),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_mafr_account_type CHECK (account_type IN ('MAIN', 'CPAS')),
    CONSTRAINT ck_mafr_range CHECK (range_start <= range_end)
);

CREATE INDEX IF NOT EXISTS ix_mafr_brand_requested ON meta_ads_fetch_requests (brand_id, requested_at DESC);
