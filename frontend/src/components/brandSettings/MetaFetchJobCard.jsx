import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, CloudDownload, Hourglass, Loader2, RotateCcw, X } from 'lucide-react';

// One "Tarik sekarang" pull, from the press to the month landing in the
// Performance Database: a ring with the share done, the four steps, and the
// figures that say it is moving (days, rows, time so far, time left).

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const typeLabel = (t) => (t === 'CPAS' ? 'CPAS' : 'Meta Ads');
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');

function duration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} dtk`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt ${String(s % 60).padStart(2, '0')} dtk`;
  return `${Math.floor(m / 60)} jam ${m % 60} mnt`;
}

const STEPS = [
  { key: 'queued', label: 'Antre', hint: 'Apps Script' },
  { key: 'fetching', label: 'Tarik dari Meta', hint: 'per 7 hari' },
  { key: 'filing', label: 'Simpan ke Database', hint: 'Performance Database' },
  { key: 'done', label: 'Selesai', hint: 'siap dipakai' },
];
const ORDER = { queued: 0, fetching: 1, filing: 2, done: 3 };

function headline(job, queue) {
  const month = monthName(job.month);
  switch (job.phase) {
    case 'queued':
      return {
        title: `Menunggu antrean · ${month}`,
        text: queue?.running
          ? `Apps Script sedang menarik ${queue.running} rentang untuk ${queue.brands} brand lain. Penarikan ini mulai setelah itu.`
          : 'Apps Script akan memulai dalam beberapa detik.',
      };
    case 'fetching':
      return {
        title: `Menarik ${month} dari Meta`,
        text: `${job.daysDone} dari ${job.totalDays} hari${job.accounts > 1 ? ` (${job.accounts} akun)` : ''} sudah masuk ke ATLAS.`,
      };
    case 'filing':
      return { title: `Menyimpan ${month}`, text: 'Semua hari sudah masuk. File bulanannya sedang ditulis ke Performance Database.' };
    case 'done':
      return {
        title: `${month} masuk ke Performance Database`,
        text: job.note ?? `${job.rows.toLocaleString('id-ID')} baris dari Meta, siap dipakai Report Generator dan Brand Overview.`,
      };
    default:
      return { title: `Penarikan ${month} gagal`, text: job.note ?? 'Coba tarik ulang.' };
  }
}

export default function MetaFetchJobCard({ job, queue, onShow, onRetry, onDismiss, retrying }) {
  const live = job.active;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const tone = job.phase === 'failed' ? 'is-failed' : job.phase === 'done' ? (job.note ? 'is-warn' : 'is-done') : 'is-live';
  const { title, text } = headline(job, queue);
  const step = job.phase === 'failed' ? -1 : ORDER[job.phase];
  const elapsed = ((live ? now : new Date(job.finishedAt ?? now).getTime()) - new Date(job.requestedAt).getTime()) / 1000;
  const R = 30;
  const C = 2 * Math.PI * R;
  const Icon = job.phase === 'failed' ? CircleAlert : job.phase === 'done' ? Check : job.phase === 'queued' ? Hourglass : CloudDownload;

  return (
    <article className={`mfj ${tone}`} data-feature="meta-fetch-progress" aria-live="polite">
      <div className="mfj-ring" role="img" aria-label={`${job.percent}% selesai`}>
        <svg viewBox="0 0 72 72">
          <defs>
            <linearGradient id={`mfj-g-${job.id}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" className="mfj-stop-a" />
              <stop offset="100%" className="mfj-stop-b" />
            </linearGradient>
          </defs>
          <circle cx="36" cy="36" r={R} className="mfj-ring-track" />
          <circle
            cx="36" cy="36" r={R} className={`mfj-ring-val${job.phase === 'queued' ? ' is-spin' : ''}`}
            stroke={`url(#mfj-g-${job.id})`} strokeDasharray={C}
            strokeDashoffset={job.phase === 'queued' ? C * 0.78 : C * (1 - job.percent / 100)}
          />
        </svg>
        <span className="mfj-ring-text">
          {job.phase === 'done' || job.phase === 'failed' ? <Icon size={26} strokeWidth={2.6} aria-hidden="true" /> : <span className="mfj-ring-num"><b>{job.percent}</b><i>%</i></span>}
        </span>
      </div>

      <div className="mfj-main">
        <header className="mfj-head">
          <span className={`mfj-type is-${job.accountType === 'CPAS' ? 'cpas' : 'main'}`}>{typeLabel(job.accountType)}</span>
          <h4>{title}</h4>
          {live && <span className="mfj-live"><i aria-hidden="true" />Live</span>}
          {!live && onDismiss && (
            <button type="button" className="mfj-x" onClick={onDismiss} aria-label="Tutup"><X size={15} /></button>
          )}
        </header>
        <p className="mfj-text">{text}</p>

        <ol className="mfj-steps" aria-label="Tahap penarikan">
          {STEPS.map((s, i) => {
            const state = step < 0 ? (i === 0 ? 'done' : 'todo') : i < step || (i === step && job.phase === 'done') ? 'done' : i === step ? 'now' : 'todo';
            return (
              <li key={s.key} className={`is-${state}`}>
                <span className="mfj-dot" aria-hidden="true">
                  {state === 'done' ? <Check size={11} strokeWidth={3} /> : state === 'now' ? <Loader2 size={11} className="mfj-spin" /> : i + 1}
                </span>
                <span className="mfj-step-text">
                  <b>{s.label}</b>
                  <small>{i === 1 && job.totalDays ? `${job.daysDone}/${job.totalDays} hari` : s.hint}</small>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mfj-bar" aria-hidden="true">
          <i className={job.phase === 'queued' ? 'is-wait' : ''} style={{ transform: `scaleX(${job.phase === 'queued' ? 1 : job.percent / 100})` }} />
        </div>

        <dl className="mfj-stats">
          <div><dt>Hari</dt><dd>{job.daysDone}<small>/{job.totalDays}</small></dd></div>
          <div><dt>Baris</dt><dd>{job.rows.toLocaleString('id-ID')}</dd></div>
          <div><dt>{live ? 'Berjalan' : 'Durasi'}</dt><dd>{duration(elapsed)}</dd></div>
          <div><dt>{live ? 'Perkiraan selesai' : 'Selesai'}</dt><dd>{live ? (job.etaSeconds != null ? `± ${duration(job.etaSeconds)}` : job.phase === 'filing' ? 'sebentar lagi' : 'menghitung…') : clock(job.finishedAt) || '—'}</dd></div>
        </dl>

        <footer className="mfj-foot">
          <span>Ditekan {job.requestedBy ? `oleh ${job.requestedBy} ` : ''}pukul {clock(job.requestedAt)} · {job.rangeStart.slice(8)}–{job.rangeEnd.slice(8)} {MONTHS[Number(job.month.slice(5, 7)) - 1].slice(0, 3)}</span>
          <span className="mfj-actions">
            {job.phase === 'done' && onShow && (
              <button type="button" className="mfj-btn is-primary" onClick={onShow}>
                Lihat {MONTHS[Number(job.month.slice(5, 7)) - 1]} di grid <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
            {job.phase === 'failed' && onRetry && (
              <button type="button" className="mfj-btn is-primary" onClick={onRetry} disabled={retrying}>
                {retrying ? <Loader2 size={14} className="mfj-spin" /> : <RotateCcw size={14} aria-hidden="true" />} Tarik ulang
              </button>
            )}
          </span>
        </footer>
      </div>
    </article>
  );
}
