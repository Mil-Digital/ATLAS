import { randomUUID } from 'crypto';
import pool from '../config/db.js';
import { AppError } from '../utils/errors.js';
import * as brandService from './brandService.js';
import * as repo from '../repositories/metaAdsInsightsRepository.js';
import { callAppsScript } from './metaAutomationService.js';
import * as library from './brandLibraryService.js';
import { buildInsightsWorkbook } from './metaAdsLibraryExport.js';
import {
  metricCatalog, REQUIRED_ACTION_TYPES, normalizeInsightRow, isBoostForAccount,
} from '../config/metaAdsMetrics.js';
import { refreshInternalDashboard } from './internalDashboardSync/dailyTrackingSync.js';

const ACCOUNT_TYPES = ['MAIN', 'CPAS'];

async function assertBrand(brandId) {
  const brand = await brandService.getBrandById(brandId);
  if (!brand) throw new AppError('Client tidak ditemukan', 404);
  return brand;
}

function assertAccountType(accountType) {
  if (!ACCOUNT_TYPES.includes(accountType)) throw new AppError('accountType harus MAIN atau CPAS', 400);
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 'YYYY-MM' -> first/last day as 'YYYY-MM-DD'.
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { startDate: `${month}-01`, endDate: `${month}-${String(last).padStart(2, '0')}` };
}

// The days a run fetched. Runs logged before daily fetching (migration 038)
// have no range and always covered their whole month.
function runRange(run) {
  const month = monthBounds(run.month.slice(0, 7));
  return { startDate: run.range_start ?? month.startDate, endDate: run.range_end ?? month.endDate };
}

// Longest custom range the Report Generator may ask for in one go — keeps the
// generated workbook well under Vercel's 4.5MB response cap.
const MAX_RANGE_DAYS = 93;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------------
// UI-facing
// ---------------------------------------------------------------------
export async function getOverview(brandId) {
  await assertBrand(brandId);
  const [months, runs] = await Promise.all([
    repo.summariseMonths(brandId),
    repo.listRecentRuns(brandId),
  ]);
  return {
    catalog: metricCatalog(),
    months: months.map((m) => ({
      accountType: m.account_type, month: m.month, rowCount: m.row_count, dayCount: m.day_count,
      campaignCount: m.campaign_count, amountSpent: Number(m.amount_spent), fetchedAt: m.fetched_at,
    })),
    runs: runs.map((r) => ({
      accountType: r.account_type, month: r.month, rangeStart: r.range_start, rangeEnd: r.range_end,
      trigger: r.trigger, status: r.status,
      rowCount: r.row_count, note: r.note, startedAt: r.started_at, finishedAt: r.finished_at,
    })),
  };
}

// Which Meta accounts of this ATLAS brand are registered under Meta Ads
// Automation › Brand & Langganan — i.e. brandList entries whose atlasBrandId
// is this brand. That registration IS the eligibility rule.
export async function listEligibleAccounts(brandId) {
  await assertBrand(brandId);
  const accounts = await callAppsScript('brandList', undefined, { deadline: Date.now() + 52000 });
  const mine = (accounts || []).filter((a) => Number(a.atlasBrandId) === Number(brandId));
  return ACCOUNT_TYPES.map((type) => {
    const ofType = mine.filter((a) => (a.type || 'MAIN').toUpperCase() === type);
    return { accountType: type, registered: ofType.length > 0, accountIds: ofType.map((a) => String(a.id ?? '')).filter(Boolean) };
  });
}

// Queues a background run in Apps Script for one month (the current month is
// fetched up to yesterday). It cannot be awaited here: a full
// month at age × gender × day grain outlives Vercel's 60s function limit, so
// Apps Script only enqueues (one-off trigger) and answers immediately; the
// run reports its own progress through the ingest endpoints below.
//
// Each press is kept (migration 064) so anyone on the brand can follow it
// through getFetchStatus; pressing again while the same month is still
// being pulled returns that pull instead of queueing it twice.
export async function requestFetch({ brandId, accountType, month, userId }) {
  await assertBrand(brandId);
  assertAccountType(accountType);
  const running = (await getFetchStatus(brandId)).jobs
    .find((j) => j.active && j.accountType === accountType && j.month === month);
  if (running) return { reused: true, job: running };

  const eligible = (await listEligibleAccounts(brandId)).find((a) => a.accountType === accountType);
  if (!eligible?.registered) {
    throw new AppError(
      `Brand ini belum punya akun ${accountType} di Meta Ads Automation › Brand & Langganan`, 409,
    );
  }
  const queued = await callAppsScript(
    'metaAdsEnqueue',
    { atlasBrandId: brandId, type: accountType, month },
    { deadline: Date.now() + 52000 },
  );
  const range = pullRange(month);
  try {
    await repo.insertFetchRequest({
      brandId, accountType, month, rangeStart: range.startDate, rangeEnd: range.endDate,
      accountIds: eligible.accountIds.length ? eligible.accountIds : ['?'],
      queuedItems: Number.isFinite(Number(queued?.queued)) ? Number(queued.queued) : null, userId,
    });
  } catch (err) {
    // Before migration 064 the pull still runs; only its progress is not followed.
    if (err.code !== '42P01') throw err;
  }
  const job = (await getFetchStatus(brandId)).jobs.find((j) => j.accountType === accountType && j.month === month) ?? null;
  return { ...queued, job };
}

// ---------------------------------------------------------------------
// Progress of "Tarik sekarang"
//
// A press is followed through four steps, read from what has already
// happened rather than reported by Apps Script:
//   queued    — waiting in the shared Apps Script queue (no run yet);
//   fetching  — runs have started: the days pulled so far against the
//               month's days x the brand's accounts of that type;
//   filing    — every day is in; the month's file is being written to the
//               Performance Database (Apps Script calls /library last);
//   done      — that file was written after the last run finished (or a
//               hand-uploaded file keeps the month, which is said instead).
// A run that never reports back, or a queue that never starts, ends the
// press as failed after a while, so nothing spins forever.
// ---------------------------------------------------------------------
const STALE_RUN_MS = 15 * 60 * 1000;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const QUEUE_GIVE_UP_MS = 20 * 60 * 1000;
const FILING_GRACE_MS = 3 * 60 * 1000;

// The days a pull covers: the month, up to yesterday (Jakarta) for the running month.
function pullRange(month) {
  const { startDate, endDate } = monthBounds(month);
  const yesterday = new Date(Date.now() + 7 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  if (endDate <= yesterday) return { startDate, endDate };
  return { startDate, endDate: yesterday < startDate ? startDate : yesterday };
}
const daysBetween = (a, b) => dayDiff(a, b) + 1;
function eachDay(start, end) {
  const out = [];
  for (let t = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`); t <= last; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function jobStatus(brandId, req, now) {
  const requestedAt = new Date(req.requested_at);
  // A little slack: Apps Script may log the run a moment before ATLAS saved the press.
  const runs = await repo.listRunsSince({
    brandId, accountType: req.account_type, month: req.month, since: new Date(requestedAt.getTime() - 15000),
  });
  const accounts = Math.max(1, (req.account_ids ?? []).length);
  const rangeDays = daysBetween(req.range_start, req.range_end);
  const totalDays = rangeDays * accounts;

  const isStale = (r) => r.status === 'running' && now - new Date(r.started_at).getTime() > STALE_RUN_MS;
  const live = runs.filter((r) => r.status === 'running' && !isStale(r));
  const progress = await repo.ingestedSoFar({
    brandId, accountType: req.account_type, runIds: live.map((r) => r.fetch_run_id),
    startDate: req.range_start, endDate: req.range_end,
  });

  // Days done, per account: a finished run counts its whole range; a running
  // one the days it has written so far.
  const inRange = (d) => d >= req.range_start && d <= req.range_end;
  const done = new Set();
  const written = new Set(); // account|day, finished or being written
  const pulling = new Set(); // days inside a run still going
  let rows = 0;
  for (const r of runs) {
    if (r.status === 'success') {
      for (const d of eachDay(r.range_start, r.range_end)) {
        if (inRange(d)) { done.add(`${r.ad_account_id}|${d}`); written.add(`${r.ad_account_id}|${d}`); }
      }
      rows += r.row_count ?? 0;
    } else if (r.status === 'running' && !isStale(r)) {
      const p = progress.get(r.fetch_run_id);
      for (const d of p?.dates ?? []) if (inRange(d)) written.add(`${r.ad_account_id}|${d}`);
      for (const d of eachDay(r.range_start, r.range_end)) if (inRange(d)) pulling.add(d);
      rows += p?.rows ?? 0;
    }
  }
  const daysDone = Math.min(written.size, totalDays);
  // Each day of the range: in (every account), coming in now, or waiting.
  const perDay = new Map();
  for (const key of written) {
    const d = key.slice(key.indexOf('|') + 1);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const days = eachDay(req.range_start, req.range_end).map((d) => ({
    date: d,
    state: (perDay.get(d) ?? 0) >= accounts ? 'done' : pulling.has(d) || perDay.get(d) ? 'pulling' : 'waiting',
  }));
  const failed = runs.filter((r) => r.status === 'failed' || isStale(r));
  const lastFinish = runs.reduce((t, r) => (r.finished_at && new Date(r.finished_at) > t ? new Date(r.finished_at) : t), new Date(0));
  const firstStart = runs.length ? new Date(runs[0].started_at) : null;

  let phase;
  let note = null;
  let files = [];
  let filedAt = null;
  if (failed.length) {
    phase = 'failed';
    const f = failed[failed.length - 1];
    note = f.status === 'failed' ? (f.note || 'Meta atau Apps Script mengembalikan error.') : 'Apps Script berhenti di tengah penarikan dan tidak melapor balik.';
  } else if (!runs.length) {
    phase = now - requestedAt.getTime() > QUEUE_GIVE_UP_MS ? 'failed' : 'queued';
    if (phase === 'failed') note = 'Antrean Apps Script tidak memulai penarikan ini dalam 20 menit.';
  } else if (live.length || done.size < totalDays) {
    phase = 'fetching';
  } else {
    // Every day is in: has the month's file been written since?
    const channels = req.account_type === 'MAIN' ? ['boost', 'nonboost'] : ['cpas'];
    const written = await repo.autoLibraryFiles({ brandId, channels, month: req.month });
    const auto = written.filter((w) => w.original_filename.startsWith(AUTO_FILE_PREFIX));
    const fresh = auto.filter((w) => new Date(w.written_at) >= new Date(lastFinish.getTime() - 5000));
    const manual = written.filter((w) => !w.original_filename.startsWith(AUTO_FILE_PREFIX));
    files = auto.map((w) => ({ channel: w.channel, rowCount: w.row_count }));
    filedAt = fresh.length ? fresh.reduce((t, w) => (new Date(w.written_at) > t ? new Date(w.written_at) : t), new Date(0)) : null;
    if (rows === 0) {
      phase = 'done';
      note = 'Meta tidak mengembalikan data untuk bulan ini; data lama (jika ada) tidak diubah.';
    } else if (manual.length) {
      phase = 'done';
      note = 'Bulan ini sudah punya file unggahan manual di Performance Database, jadi file itu yang dipakai. Data hasil tarikan tetap tersimpan di ATLAS.';
    } else if (fresh.length) {
      phase = 'done';
    } else if (now - lastFinish.getTime() > FILING_GRACE_MS) {
      phase = 'done';
      note = 'Data sudah tersimpan di ATLAS, tetapi file Performance Database belum diperbarui. Klik ikon simpan pada bulan ini untuk menyimpannya.';
    } else {
      phase = 'filing';
    }
  }

  // Share of the work: queued 2%, pulling up to 92%, filing 96%, done 100%.
  let pct;
  if (phase === 'done') pct = 100;
  else if (phase === 'filing') pct = 96;
  else if (phase === 'queued') pct = 2;
  else pct = Math.max(4, Math.round(4 + (daysDone / totalDays) * 88));
  // Time left, from the pace so far once a few days are in.
  let etaSeconds = null;
  if (phase === 'fetching' && firstStart && daysDone >= 2) {
    const perDay = (now - firstStart.getTime()) / daysDone;
    etaSeconds = Math.round(((totalDays - daysDone) * perDay) / 1000) + 20;
  }
  const active = phase === 'queued' || phase === 'fetching' || phase === 'filing';

  // What happened, in order, as the card's log reads it.
  const short = (a, b) => {
    const m = MONTH_ABBR[Number(a.slice(5, 7)) - 1];
    return a === b ? `${Number(a.slice(8))} ${m}` : `${Number(a.slice(8))}–${Number(b.slice(8))} ${m}`;
  };
  const many = accounts > 1;
  const events = [{ at: req.requested_at, kind: 'request', text: `Ditekan${req.requested_by_name ? ` oleh ${req.requested_by_name}` : ''}` }];
  for (const r of runs) {
    const span = `${short(r.range_start, r.range_end)}${many ? ` · ${r.ad_account_id}` : ''}`;
    events.push({ at: r.started_at, kind: 'start', text: `Mulai menarik ${span}` });
    if (r.status === 'success') {
      events.push({ at: r.finished_at, kind: 'run', text: `${span} masuk`, rows: r.row_count ?? 0 });
    } else if (r.status === 'failed') {
      events.push({ at: r.finished_at ?? r.started_at, kind: 'fail', text: `${span} gagal${r.note ? `: ${r.note}` : ''}` });
    } else if (isStale(r)) {
      events.push({ at: new Date(new Date(r.started_at).getTime() + STALE_RUN_MS), kind: 'fail', text: `${span} berhenti tanpa laporan dari Apps Script` });
    }
  }
  if (filedAt) events.push({ at: filedAt, kind: 'filed', text: 'File bulanan masuk Performance Database' });
  if (phase === 'failed' && !runs.length) events.push({ at: new Date(requestedAt.getTime() + QUEUE_GIVE_UP_MS), kind: 'fail', text: 'Antrean tidak memulai penarikan dalam 20 menit' });
  events.sort((x, y) => new Date(x.at) - new Date(y.at));

  return {
    id: Number(req.id),
    accountType: req.account_type,
    month: req.month,
    rangeStart: req.range_start,
    rangeEnd: req.range_end,
    accounts,
    requestedAt: req.requested_at,
    requestedBy: req.requested_by_name ?? null,
    phase,
    active,
    percent: pct,
    daysDone,
    totalDays,
    rows,
    runsDone: runs.filter((r) => r.status === 'success').length,
    runsRunning: live.length,
    etaSeconds,
    startedAt: firstStart,
    finishedAt: active || !runs.length ? null : lastFinish,
    files,
    note,
    days,
    events,
  };
}

// The brand's pulls of the last day still worth showing: every one still
// going, and the most recent one of each account type.
export async function getFetchStatus(brandId) {
  await assertBrand(brandId);
  let requests;
  try {
    requests = await repo.listRecentFetchRequests(brandId);
  } catch (err) {
    if (err.code === '42P01') return { jobs: [], queue: null, tracked: false };
    throw err;
  }
  const now = Date.now();
  const all = await Promise.all(requests.map((r) => jobStatus(brandId, r, now)));
  // Newest first: a type's latest pull, plus any older one still going.
  const seen = new Set();
  const jobs = all.filter((j) => {
    const keep = j.active || !seen.has(j.accountType);
    if (keep) seen.add(j.accountType);
    return keep;
  });
  const queue = jobs.some((j) => j.phase === 'queued')
    ? await repo.queueActivityElsewhere(brandId, STALE_RUN_MS / 60000)
    : null;
  return { jobs, queue, tracked: true };
}

// ---------------------------------------------------------------------
// Data Collection Hub › Performance Database library
//
// A fetched month is also filed in the brand's file library as Ads
// Manager-style .xlsx files, because that library is what the Performance
// Database grid and the Report Generator's "Pilih dari perpustakaan" read.
// A MAIN account month becomes two files — Boost Post and Non Boost Post,
// split by the account's Kata Kunci Boost Post — and a CPAS month one. The
// DB table stays the source of truth; the files are regenerated from it and
// can be rebuilt any time.
// ---------------------------------------------------------------------
// channel -> metric sections written into its file.
const LIBRARY_FILES = {
  MAIN: [
    { channel: 'boost', label: 'Boost Post', sections: ['boost'], boost: true },
    { channel: 'nonboost', label: 'Non Boost Post', sections: ['ecom', 'b2b'], boost: false },
  ],
  CPAS: [{ channel: 'cpas', label: 'CPAS', sections: ['cpas'] }],
};
// Channels a MAIN month may already sit in: 'meta' is the combined
// Boost + Non-Boost file of before the split.
const MAIN_SLOT_CHANNELS = ['boost', 'nonboost', 'meta'];
const AUTO_FILE_PREFIX = 'ATLAS-auto_';

const autoFilename = (brandName, channel, month) => {
  const slug = String(brandName).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brand';
  return `${AUTO_FILE_PREFIX}${channel}_${slug}_${month}.xlsx`;
};

const slotChannels = (accountType) => (accountType === 'MAIN' ? MAIN_SLOT_CHANNELS : ['cpas']);

async function findMonthParts(brandId, accountType, month) {
  const lists = await Promise.all(slotChannels(accountType).map((ch) => library.listSlotParts(brandId, 'meta', ch, `${month}-01`)));
  const parts = lists.flatMap((list, i) => list.map((p) => ({ ...p, channel: slotChannels(accountType)[i] })));
  return {
    auto: parts.filter((p) => p.original_filename.startsWith(AUTO_FILE_PREFIX)),
    manual: parts.filter((p) => !p.original_filename.startsWith(AUTO_FILE_PREFIX)),
  };
}

// Boost or not for a stored MAIN row, by its account's kind and keyword.
async function boostClassifier(brandId) {
  const accounts = await repo.listMainAccountSplits(brandId);
  return (row) => isBoostForAccount(row.campaign_name, accounts.get(row.ad_account_id));
}

// Files the month into the library. Never touches a file someone uploaded by
// hand: those cover the same days, so adding ours next to it would count the
// month twice, and replacing it would delete their upload.
export async function syncLibraryFile({ brandId, accountType, month, userId }) {
  const brand = await assertBrand(brandId);
  assertAccountType(accountType);
  const { startDate, endDate } = monthBounds(month);

  const { auto, manual } = await findMonthParts(brandId, accountType, month);
  if (manual.length) {
    throw new AppError(
      `Bulan ${month} sudah punya file manual di Performance Database (${manual.map((p) => p.original_filename).join(', ')}). `
      + 'Hapus file itu dulu jika ingin memakai data hasil tarikan otomatis.', 409,
    );
  }

  const rows = await repo.listRowsInRange({ brandId, accountType, startDate, endDate });
  if (!rows.length) throw new AppError('Belum ada data tersimpan untuk bulan ini', 404);

  // Daily fetching files the running month too, so the file covers the days
  // actually stored (1st .. yesterday), not the whole calendar month.
  const firstDay = rows[0].entry_date;
  const lastDay = rows[rows.length - 1].entry_date;
  const isBoost = accountType === 'MAIN' ? await boostClassifier(brandId) : null;
  const written = [];

  for (const spec of LIBRARY_FILES[accountType]) {
    const fileRows = isBoost ? rows.filter((r) => isBoost(r) === spec.boost) : rows;
    const existing = auto.find((p) => p.channel === spec.channel);
    if (!fileRows.length) {
      // Nothing of this kind this month (e.g. no Boost campaign): an older
      // copy would show campaigns that are no longer there.
      if (existing) await library.deleteLibraryFile(brandId, existing.id);
      continue;
    }
    const buffer = buildInsightsWorkbook({
      start: firstDay, end: lastDay, rows: fileRows, sections: spec.sections,
      campaignType: isBoost ? () => spec.label : null,
    });
    const coverage = library.summariseRange({ start: firstDay, end: lastDay }, month);
    const file = await library.upsertLibraryFile({
      brandId, platform: 'meta', channel: spec.channel,
      periodMonth: coverage.periodMonth, periodStart: coverage.periodStart, periodEnd: coverage.periodEnd,
      coveredDays: coverage.coveredDays, dayBitmap: coverage.dayBitmap, rowCount: fileRows.length,
      periodSource: 'declared', partIndex: existing?.part_index ?? 1,
      filename: autoFilename(brand.brand_name, spec.channel, month), buffer, userId,
    });
    written.push({ channel: spec.channel, fileId: file.id, filename: file.original_filename, rowCount: fileRows.length });
  }

  // The combined auto file of before the Boost / Non-Boost split.
  for (const old of auto.filter((p) => p.channel === 'meta')) await library.deleteLibraryFile(brandId, old.id);

  return { files: written, rowCount: rows.length };
}

// Called by Apps Script after a finished run. A month that already has a
// manual file is reported as a note, not an error: the run itself succeeded.
export async function syncLibraryFromRun(runId) {
  const run = await repo.getRun(runId);
  if (!run) throw new AppError('runId tidak dikenal', 404);
  if (run.status !== 'success') throw new AppError('Run ini belum selesai dengan sukses', 409);
  try {
    return { synced: true, ...(await syncLibraryFile({
      brandId: run.brand_id, accountType: run.account_type, month: run.month.slice(0, 7), userId: null,
    })) };
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 409) return { synced: false, reason: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------
// Report Generator › Meta › custom range
//
// The library holds whole months; the stored daily rows can be cut at any
// day. The range is served as the same Ads Manager-style workbook, so the
// Report Generator parses it exactly like a library file or an upload.
// ---------------------------------------------------------------------
export async function getStoredDays(brandId) {
  await assertBrand(brandId);
  const rows = await repo.listStoredDays(brandId);
  const days = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t, []]));
  for (const r of rows) days[r.account_type]?.push(r.entry_date);
  return { days, maxRangeDays: MAX_RANGE_DAYS };
}

export async function exportRange({ brandId, accountType, start, end }) {
  await assertBrand(brandId);
  assertAccountType(accountType);
  if (start > end) throw new AppError('Tanggal mulai harus sebelum tanggal akhir', 400);
  if (dayDiff(start, end) + 1 > MAX_RANGE_DAYS) throw new AppError(`Rentang maksimal ${MAX_RANGE_DAYS} hari`, 400);
  const rows = await repo.listRowsInRange({ brandId, accountType, startDate: start, endDate: end });
  if (!rows.length) throw new AppError('Belum ada data tersimpan pada rentang ini', 404);
  // One file per account: MAIN carries Boost and Non-Boost together, each
  // row labelled with its Campaign type.
  const isBoost = accountType === 'MAIN' ? await boostClassifier(brandId) : null;
  return {
    buffer: buildInsightsWorkbook({
      start, end, rows,
      sections: accountType === 'MAIN' ? ['boost', 'ecom', 'b2b'] : ['cpas'],
      campaignType: isBoost ? (r) => (isBoost(r) ? 'Boost Post' : 'Non Boost Post') : null,
    }),
    filename: `ATLAS-auto_${accountType === 'MAIN' ? 'meta' : 'cpas'}_${start}_${end}.xlsx`,
    rowCount: rows.length,
  };
}

export async function deleteMonth({ brandId, accountType, month }) {
  await assertBrand(brandId);
  assertAccountType(accountType);
  const { startDate, endDate } = monthBounds(month);
  const deleted = await repo.deleteMonthRows({ brandId, accountType, startDate, endDate });
  await refreshInternalDashboard(brandId);
  // The auto-filed copies go with it, or the library would keep offering a
  // month that no longer exists. A manual file is never removed here.
  const { auto } = await findMonthParts(brandId, accountType, month);
  for (const file of auto) await library.deleteLibraryFile(brandId, file.id);
  return { accountType, month, deleted };
}

// ---------------------------------------------------------------------
// Machine-to-machine (Apps Script), authenticated by the shared ingest key
// ---------------------------------------------------------------------
// A run covers `since`..`until` inside one month (the daily trigger fetches
// the last few days; the 1st and "Tarik sekarang" fetch a whole month).
// Without since/until — an Apps Script deployed before daily fetching — it
// is the whole month, as before.
export async function startRun({ brandId, accountType, adAccountId, month, since, until, trigger }) {
  await assertBrand(brandId);
  assertAccountType(accountType);
  const bounds = monthBounds(month);
  const rangeStart = since ?? bounds.startDate;
  const rangeEnd = until ?? bounds.endDate;
  if (rangeStart < bounds.startDate || rangeEnd > bounds.endDate || rangeStart > rangeEnd) {
    throw new AppError('since/until harus berada di dalam bulan yang sama dan berurutan', 400);
  }
  const runId = randomUUID();
  await repo.insertRun({
    brandId, accountType, adAccountId, month: `${month}-01`, rangeStart, rangeEnd,
    trigger: trigger === 'scheduled' ? 'scheduled' : 'manual', runId,
  });
  // catalogSegments: CPAS accounts also ask Meta for the "with shared items"
  // fields (catalog_segment_*), which only mean something there.
  return { runId, actionTypes: REQUIRED_ACTION_TYPES, catalogSegments: accountType === 'CPAS' };
}

async function requireOpenRun(runId) {
  const run = await repo.getRun(runId);
  if (!run) throw new AppError('runId tidak dikenal', 404);
  if (run.status !== 'running') throw new AppError('Run ini sudah selesai', 409);
  return run;
}

export async function ingestRows({ runId, rows }) {
  const run = await requireOpenRun(runId);
  const { startDate, endDate } = runRange(run);

  // Rows outside the run's range are dropped rather than trusted: a stray
  // date would land on days whose stale-row cleanup this run never owns.
  const normalized = rows
    .map((raw) => normalizeInsightRow(raw, run.account_type))
    .filter((r) => r && r.entry_date >= startDate && r.entry_date <= endDate);

  // Meta can return the same ad/day/age/gender twice across page
  // boundaries; one INSERT ... ON CONFLICT cannot touch the same key twice,
  // so keep the last.
  const byKey = new Map();
  for (const r of normalized) byKey.set(`${r.entry_date}|${r.campaign_id}|${r.adset_id}|${r.ad_id}|${r.age}|${r.gender}`, r);

  const written = await repo.upsertInsightRows({
    brandId: run.brand_id, accountType: run.account_type, adAccountId: run.ad_account_id,
    runId, rows: [...byKey.values()],
  });
  return { received: rows.length, written };
}

// The preview link of each ad the run saw (Meta's preview_shareable_link),
// sent before /finish so the library file written after it carries them.
export async function ingestAdPreviews({ runId, ads }) {
  const run = await requireOpenRun(runId);
  const byId = new Map();
  for (const a of ads) {
    const adId = String(a?.adId ?? '').trim();
    const link = String(a?.previewLink ?? '').trim();
    if (adId && /^https?:\/\//i.test(link)) byId.set(adId, link);
  }
  const written = await repo.upsertAdPreviews({
    brandId: run.brand_id,
    ads: [...byId].map(([ad_id, preview_link]) => ({ ad_id, preview_link })),
  });
  return { received: ads.length, written };
}

export async function finishRun({ runId, status, rowCount, note }) {
  const run = await requireOpenRun(runId);
  const { startDate, endDate } = runRange(run);

  const result = await inTransaction(async (db) => {
    let removedStale = 0;
    // Zero rows on a "success" is treated as "Meta returned nothing", not as
    // proof the range is empty — clearing the existing data on that basis
    // would let one Meta hiccup wipe good days.
    if (status === 'success' && rowCount > 0) {
      removedStale = await repo.deleteStaleRows({
        brandId: run.brand_id, accountType: run.account_type, adAccountId: run.ad_account_id,
        startDate, endDate, runId,
      }, db);
    }
    const noteParts = [];
    if (note) noteParts.push(note);
    if (status === 'success' && rowCount === 0) noteParts.push('Meta tidak mengembalikan data untuk rentang ini; data lama (jika ada) tidak diubah');
    if (removedStale) noteParts.push(`${removedStale} baris lama yang tidak ada lagi di Meta dihapus`);
    await repo.finishRun({ runId, status, rowCount, note: noteParts.join(' · ') || null }, db);
    return { status, rowCount, removedStale };
  });
  // The Business Insight's Meta funnel is rolled up from these rows.
  if (status === 'success') await refreshInternalDashboard(run.brand_id);
  return result;
}
