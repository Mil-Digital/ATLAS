import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, CircleAlert, FolderInput, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import api from '../../api/client.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import SelectMenu from '../common/SelectMenu.jsx';
import { SPEC_INTRO, SPEC_NOTES } from './MetaDatasetSpecs.jsx';
import MetaFetchJobCard from './MetaFetchJobCard.jsx';
import './metaAdsAutoFetch.css';

// The breakdown every file carries, in this order (BREAKDOWNS in
// backend/src/config/metaAdsMetrics.js).
const BREAKDOWNS = ['Campaign name', 'Ad set name', 'Ad name', 'Age', 'Gender', 'Objective', 'Day'];

const TYPES = [
  { type: 'MAIN', label: 'Meta Ads' },
  { type: 'CPAS', label: 'CPAS' },
];
const MONTH_NAMES = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; };
const idr = (n) => `Rp${Math.round(n).toLocaleString('id-ID')}`;
const shortDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// A run that never reported back (Apps Script killed at its 6-minute cap, or
// ATLAS unreachable at the end) stays 'running' forever in the log; past
// this age it is shown as failed rather than as perpetually in progress.
const STALE_RUN_MS = 15 * 60 * 1000;
// Finished pulls stay on screen for a while, unless closed.
const SHOW_FINISHED_MS = 30 * 60 * 1000;
const DISMISSED_KEY = 'atlas.metaFetch.dismissed';
const readDismissed = () => {
  try { return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set(); }
};

// The running month is fetched up to yesterday, so it is offered from the
// 2nd onwards (on the 1st it has no complete day yet).
function monthOptions() {
  const now = new Date();
  const out = [];
  for (let i = now.getDate() > 1 ? 0 : 1; i <= 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ value, label: i === 0 ? `${monthName(value)} (s/d kemarin)` : monthName(value) });
  }
  return out;
}

// A run's days: a daily run covers a few days, a full-month run its month.
function runPeriod(run) {
  if (!run.rangeStart || !run.rangeEnd) return monthName(run.month.slice(0, 7));
  const [y, m] = run.month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const wholeMonth = run.rangeStart.endsWith('-01') && Number(run.rangeEnd.slice(8, 10)) === lastDay;
  if (wholeMonth) return monthName(run.month.slice(0, 7));
  return run.rangeStart === run.rangeEnd ? shortDay(run.rangeStart) : `${shortDay(run.rangeStart)} – ${shortDay(run.rangeEnd)} ${y}`;
}

function runState(run) {
  if (run.status === 'running' && Date.now() - new Date(run.startedAt).getTime() > STALE_RUN_MS) {
    return { key: 'failed', label: 'Tidak selesai' };
  }
  // Meta answered, but with nothing: usually a wrong ad account id or an
  // account with no ads running, so it is flagged rather than shown as fine.
  if (run.status === 'success' && run.rowCount === 0) {
    return { key: 'empty', label: 'Berhasil · 0 baris' };
  }
  return {
    running: { key: 'running', label: 'Berjalan' },
    success: { key: 'success', label: 'Berhasil' },
    failed: { key: 'failed', label: 'Gagal' },
  }[run.status];
}

// Auto-fetch of Meta Ads / CPAS insights into ATLAS. Lives under Performance Database
// › Meta Ads. An account is eligible exactly when it is registered in Meta
// Brand › Meta Automation and linked to this ATLAS brand — the
// same rule Daily Tracking's auto-fill uses. Admin only: it reaches the Meta
// tokens held in Apps Script.
// `onOpenAutomation` scrolls to the account form in the same Meta Ads channel.
// `specFocus` ({ type, sections, at }, from a Meta dataset row) switches to
// that account type, scrolls to the breakdown & metrics, and briefly
// highlights the sections that dataset's file holds.
// `fetchJobs` (useMetaFetchJobs, shared with the grid) carries the pulls in
// progress; `onShowMonth(month)` takes the user to that month in the grid.
export default function MetaAdsAutoFetchPanel({ brand, accountsVersion = 0, onLibraryChanged, onOpenAutomation, specFocus, fetchJobs, onShowMonth }) {
  const { isAdmin, isViewOnly } = useAuth();
  const brandId = brand?.brand_id;

  const [overview, setOverview] = useState(null);
  const [accounts, setAccounts] = useState(null); // null = still asking Apps Script
  const [accountsError, setAccountsError] = useState('');
  const [error, setError] = useState('');
  const [type, setType] = useState('MAIN');
  const [month, setMonth] = useState(() => monthOptions()[0].value);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [dismissed, setDismissed] = useState(readDismissed);
  const specsRef = useRef(null);
  const rootRef = useRef(null);
  const [highlight, setHighlight] = useState([]);
  // The column list is reference, not something read every visit: folded,
  // and opened by a dataset row's "lihat kolom" jump (specFocus).
  const [specsOpen, setSpecsOpen] = useState(false);

  useEffect(() => {
    if (!specFocus) return undefined;
    setType(specFocus.type);
    setHighlight(specFocus.sections ?? []);
    setSpecsOpen(true);
    const frame = requestAnimationFrame(() => {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      // Still loading: the metrics block is not there yet, land on the panel.
      const target = specsRef.current ?? rootRef.current;
      target?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      specsRef.current?.focus({ preventScroll: true });
    });
    const timer = setTimeout(() => setHighlight([]), 2600);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [specFocus]);

  const loadOverview = useCallback(async () => {
    if (!brandId) return null;
    try {
      const res = await api.get('/meta-ads-insights/overview', { params: { brandId } });
      setOverview(res.data);
      setError('');
      return res.data;
    } catch (err) {
      setError(err.response?.data?.message || 'Gagal memuat data Meta Ads');
      return null;
    }
  }, [brandId]);

  // Stored months and runs come from ATLAS's own DB (fast); eligibility needs Apps Script
  // (seconds to a minute) — loaded separately so the panel is usable at once.
  useEffect(() => {
    if (!isAdmin || !brandId) return;
    setOverview(null); setNotice('');
    loadOverview();
  }, [isAdmin, brandId, loadOverview]);

  useEffect(() => {
    if (!isAdmin || !brandId) return undefined;
    let cancelled = false;
    setAccounts(null); setAccountsError('');
    api.get('/meta-ads-insights/accounts', { params: { brandId } })
      .then((res) => { if (!cancelled) setAccounts(res.data.accounts); })
      .catch((err) => { if (!cancelled) setAccountsError(err.response?.data?.message || 'Gagal memeriksa akun di Meta Ads Automation'); });
    return () => { cancelled = true; };
  }, [isAdmin, brandId, accountsVersion]);

  // The stored months and run history follow the pulls: each step a pull
  // moves on (a run done, the month filed) refreshes them.
  const jobs = fetchJobs?.jobs ?? [];
  const jobSignature = jobs.map((j) => `${j.id}:${j.phase}:${j.runsDone}`).join('|');
  useEffect(() => {
    if (jobSignature) loadOverview();
  }, [jobSignature, loadOverview]);

  // The fixed metric set per campaign type (backend/src/config/metaAdsMetrics.js).
  const sections = (overview?.catalog ?? []).filter((s) => s.accountType === type);
  const registered = (t) => accounts?.find((a) => a.accountType === t)?.registered;
  const readOnly = isViewOnly;

  const fetchNow = async (pick = { type, month }) => {
    setBusy('fetch'); setNotice(''); setError('');
    try {
      const { data } = await api.post('/meta-ads-insights/fetch', { brandId, accountType: pick.type, month: pick.month });
      if (data?.reused) setNotice(`${monthName(pick.month)} sedang ditarik — progresnya ada di bawah.`);
      // Before migration 064 there is no progress to follow: say so plainly.
      else if (!data?.job) setNotice(`Penarikan ${monthName(pick.month)} dijadwalkan di Apps Script. Biasanya selesai dalam beberapa menit.`);
      await fetchJobs?.refresh();
      await loadOverview();
    } catch (err) {
      setError(err.response?.data?.message || 'Gagal menjadwalkan penarikan');
    } finally { setBusy(''); }
  };
  const dismiss = (id) => setDismissed((d) => {
    const next = new Set(d).add(id);
    try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next])); } catch { /* per-viewer convenience only */ }
    return next;
  });
  // Pulls on show: every one still going, and finished ones of the last half hour.
  const shownJobs = jobs.filter((j) => j.active || (!dismissed.has(j.id)
    && Date.now() - new Date(j.finishedAt ?? j.requestedAt).getTime() < SHOW_FINISHED_MS));
  const pulling = jobs.find((j) => j.active && j.accountType === type && j.month === month);

  // Rebuilds the Performance Database library copy of a fetched month — for months
  // fetched before that step existed, or when it was skipped or failed.
  const syncLibrary = async (row) => {
    setBusy(`lib:${row.accountType}:${row.month}`); setNotice(''); setError('');
    try {
      await api.post('/meta-ads-insights/library', { brandId, accountType: row.accountType, month: row.month });
      setNotice(`${monthName(row.month)} disimpan ke Performance Database — sekarang bisa dipilih di Report Generator.`);
      onLibraryChanged?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Gagal menyimpan ke Performance Database');
    } finally { setBusy(''); }
  };

  const deleteMonth = async (row) => {
    if (!window.confirm(`Hapus data Meta Ads ${monthName(row.month)} (${row.accountType === 'CPAS' ? 'CPAS' : 'Meta Ads'})? Tidak bisa dikembalikan.`)) return;
    setBusy(`del:${row.accountType}:${row.month}`); setNotice(''); setError('');
    try {
      await api.delete('/meta-ads-insights/months', { params: { brandId, accountType: row.accountType, month: row.month } });
      await loadOverview();
      onLibraryChanged?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Gagal menghapus data');
    } finally { setBusy(''); }
  };

  if (!isAdmin || !brandId) return null;

  const typeRegistered = registered(type);
  const typeLabel = TYPES.find((t) => t.type === type).label;
  const canAct = typeRegistered && !readOnly;

  return (
    <section ref={rootRef} className="maf mx-card" aria-label="Tarik otomatis Meta Ads">
      <header className="mx-head">
        <span className="mx-head-ico" aria-hidden="true"><CalendarClock size={18} /></span>
        <div className="mx-head-copy">
          <h3>Automate Input with API</h3>
          <p>
            Setiap hari ATLAS menarik 7 hari terakhir dari akun di{' '}
            <button type="button" className="mx-link" onClick={onOpenAutomation}>Meta Automation</button>
            {' '}— tanggal 1 menarik seluruh bulan sebelumnya.
          </p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {/* Same cause as the Meta Automation card above, so said quietly here. */}
      {accountsError && <p className="mx-notice is-muted"><CircleAlert size={15} aria-hidden="true" /> Status akun belum bisa diperiksa — lihat pesan di Meta Automation.</p>}

      <div className="mx-tabs" role="tablist" aria-label="Jenis akun">
        {TYPES.map((t) => {
          const reg = registered(t.type);
          const state = accounts == null && !accountsError ? 'checking' : reg ? 'on' : 'off';
          return (
            <button
              key={t.type} type="button" role="tab" aria-selected={type === t.type}
              className={`mx-tab${type === t.type ? ' is-on' : ''}`} onClick={() => setType(t.type)}
            >
              {t.label}
              <span className={`mx-status is-${state}`}>{state === 'checking' ? 'memeriksa…' : state === 'on' ? 'terdaftar' : 'belum terdaftar'}</span>
            </button>
          );
        })}
      </div>

      {accounts != null && !typeRegistered && (
        <div className="maf-empty">
          <CircleAlert size={16} />
          <span>
            Belum ada akun {typeLabel} yang tertaut ke brand ini. Daftarkan di{' '}
            <button type="button" className="brand-inline-link" onClick={onOpenAutomation}>Meta Automation</button> (tipe {type}) agar penarikan otomatis berjalan.
          </span>
        </div>
      )}

      {!overview ? (
        <p className="maf-loading"><Loader2 size={14} className="maf-spin" /> Memuat…</p>
      ) : (
        <>
          <div className="mx-fetch">
            <div className="mx-fetch-copy">
              <h4>Tarik sekarang</h4>
              <p>Bulan yang sudah ada diganti data terbaru; hasilnya masuk ke Performance Database.</p>
            </div>
            <div className="maf-month"><SelectMenu value={month} onChange={setMonth} options={monthOptions()} label="Bulan" /></div>
            <button
              type="button" className={`bp-primary maf-pull${pulling ? ' is-pulling' : ''}`} onClick={() => fetchNow()} data-feature="meta-pull-now"
              disabled={!canAct || busy === 'fetch' || Boolean(pulling)}
              title={pulling ? `${monthName(month)} sedang ditarik (${pulling.percent}%)` : undefined}
            >
              {busy === 'fetch' || pulling ? <Loader2 size={15} className="maf-spin" /> : <RefreshCw size={15} />}
              {busy === 'fetch' ? 'Menjadwalkan…' : pulling ? `Sedang ditarik · ${pulling.percent}%` : `Tarik ${typeLabel}`}
            </button>
          </div>

          {shownJobs.length > 0 && (
            <div className="mfj-list">
              {shownJobs.map((job) => (
                <MetaFetchJobCard
                  key={job.id} job={job} queue={fetchJobs?.queue}
                  onShow={onShowMonth ? () => onShowMonth(job.month, job.accountType) : undefined}
                  onRetry={canAct ? () => fetchNow({ type: job.accountType, month: job.month }) : undefined}
                  retrying={busy === 'fetch'}
                  onDismiss={() => dismiss(job.id)}
                />
              ))}
            </div>
          )}

          <div className="maf-block">
            <h4 className="mx-h">Data tersimpan <small>{overview.months.length} bulan</small></h4>
            {overview.months.length === 0 ? (
              <p className="mx-empty">Belum ada data yang ditarik.</p>
            ) : (
              <div className="maf-table-wrap mx-table">
                <table className="maf-table">
                  <thead>
                    <tr><th>Bulan</th><th>Akun</th><th className="is-num">Baris</th><th className="is-num">Hari</th><th className="is-num">Campaign</th><th className="is-num">Amount spent</th><th>Terakhir ditarik</th><th aria-label="Aksi" /></tr>
                  </thead>
                  <tbody>
                    {overview.months.map((row) => (
                      <tr key={`${row.accountType}-${row.month}`}>
                        <td><strong>{monthName(row.month)}</strong></td>
                        <td><span className={`mx-type is-${row.accountType === 'CPAS' ? 'cpas' : 'main'}`}>{row.accountType === 'CPAS' ? 'CPAS' : 'Meta Ads'}</span></td>
                        <td className="is-num">{row.rowCount.toLocaleString('id-ID')}</td>
                        <td className="is-num">{row.dayCount}</td>
                        <td className="is-num">{row.campaignCount}</td>
                        <td className="is-num">{idr(row.amountSpent)}</td>
                        <td className="maf-run-meta">{dateTime(row.fetchedAt)}</td>
                        <td className="maf-row-actions">
                          <button
                            type="button" className="btn btn-icon" title="Simpan ke Performance Database"
                            aria-label={`Simpan ${monthName(row.month)} ke Performance Database`}
                            onClick={() => syncLibrary(row)} disabled={readOnly || busy === `lib:${row.accountType}:${row.month}`}
                          >
                            {busy === `lib:${row.accountType}:${row.month}` ? <Loader2 size={14} className="maf-spin" /> : <FolderInput size={14} />}
                          </button>
                          <button
                            type="button" className="btn btn-icon" title="Hapus bulan ini" aria-label={`Hapus ${monthName(row.month)}`}
                            onClick={() => deleteMonth(row)} disabled={readOnly || busy === `del:${row.accountType}:${row.month}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="maf-block">
            <h4 className="mx-h">Riwayat penarikan <small>5 terakhir</small></h4>
            {overview.runs.length === 0 ? (
              <p className="mx-empty">Belum ada penarikan.</p>
            ) : (
              <ul className="maf-runs mx-runs">
                {overview.runs.slice(0, 5).map((run, index) => {
                  const state = runState(run);
                  return (
                    <li key={`${run.startedAt}-${index}`} className={state.key === 'empty' ? 'is-empty' : undefined}>
                      <span className={`maf-badge is-${state.key}`}>
                        {state.key === 'running' ? <Loader2 size={12} className="maf-spin" /> : state.key === 'success' ? <Check size={12} /> : <CircleAlert size={12} />}
                        {state.label}
                      </span>
                      <span>{runPeriod(run)} · {run.accountType === 'CPAS' ? 'CPAS' : 'Meta Ads'} · {run.trigger === 'scheduled' ? 'otomatis' : 'manual'}</span>
                      <span className="maf-run-meta">
                        {run.status === 'success' ? `${run.rowCount.toLocaleString('id-ID')} baris · ` : ''}{dateTime(run.startedAt)}
                        {run.note ? ` · ${run.note}` : ''}
                      </span>
                      {state.key === 'empty' && (
                        <span className="maf-run-check">
                          Patut dicek: pastikan akun ini memang tidak beriklan pada rentang tersebut dan ID akun iklannya benar di Meta Automation.
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <details className="mx-specs" data-feature="meta-kolom-ditarik" open={specsOpen} onToggle={(e) => setSpecsOpen(e.currentTarget.open)}>
            <summary>
              <span>Kolom yang ditarik</span>
              <small>{BREAKDOWNS.length} breakdown · {sections.reduce((n, sec) => n + sec.metrics.length, 0)} metrik</small>
            </summary>
            <div className="maf-block" ref={specsRef} tabIndex={-1}>
              <h4>Breakdown</h4>
              <div className="maf-chips" aria-label="Breakdown">
                {BREAKDOWNS.map((b) => <span key={b} className="maf-chip is-locked">{b}</span>)}
              </div>
              <h4 className="maf-sub">Metrik per jenis campaign</h4>
              {sections.map((section) => (
                <div key={section.key} className={`maf-section${highlight.includes(section.key) ? ' is-highlight' : ''}`}>
                  <h5>{section.label}</h5>
                  <div className="maf-chips" aria-label={`Metrik ${section.label}`}>
                    {section.metrics.map((m) => <span key={m.key} className="maf-chip is-locked">{m.label}</span>)}
                  </div>
                </div>
              ))}
              <p className="maf-hint">{SPEC_INTRO} {SPEC_NOTES[type]}</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
