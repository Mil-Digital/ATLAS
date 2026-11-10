import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Loader2, RotateCcw, X } from 'lucide-react';

// One "Tarik sekarang" pull, from the press to the month landing in the
// Performance Database: the share done as a display figure, the four steps,
// the month's days filling in as Meta returns them, the figures that say it
// is moving, and — on request — the timestamped log of what happened.

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const monthOf = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
const typeLabel = (t) => (t === 'CPAS' ? 'CPAS' : 'Meta Ads');
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');
const stamp = (iso) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const num = (n) => Number(n ?? 0).toLocaleString('id-ID');

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
  const month = `${monthOf(job.month)} ${job.month.slice(0, 4)}`;
  switch (job.phase) {
    case 'queued':
      return {
        title: `Menunggu antrean · ${month}`,
        text: queue?.running
          ? `Apps Script sedang menarik ${queue.running} rentang untuk ${queue.brands} brand lain. Penarikan ini mulai setelah itu.`
          : 'Google biasanya menjalankan antrean Apps Script 1–2 menit setelah tombol ditekan. Setelah mulai, sebulan penuh selesai dalam beberapa menit.',
      };
    case 'fetching':
      return { title: `Menarik ${month} dari Meta`, text: `${job.daysDone} dari ${job.totalDays} hari${job.accounts > 1 ? ` (${job.accounts} akun)` : ''} sudah masuk ke ATLAS.` };
    case 'filing':
      return { title: `Menyimpan ${month}`, text: 'Semua hari sudah masuk. File bulanannya sedang ditulis ke Performance Database.' };
    case 'done':
      return { title: `${month} masuk ke Performance Database`, text: job.note ?? `${num(job.rows)} baris dari Meta, siap dipakai Report Generator dan Brand Overview.` };
    default:
      return {
        title: `Penarikan ${month} gagal`,
        text: `${job.note ?? 'Coba tarik ulang.'}${job.daysDone ? ` ${job.daysDone} dari ${job.totalDays} hari sudah tersimpan.` : ''}`,
      };
  }
}

export default function MetaFetchJobCard({ job, queue, onShow, onRetry, onDismiss, retrying }) {
  const live = job.active;
  const [now, setNow] = useState(Date.now());
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const tone = job.phase === 'failed' ? 'is-failed' : job.phase === 'done' ? (job.note ? 'is-warn' : 'is-done') : 'is-live';
  const { title, text } = headline(job, queue);
  const step = job.phase === 'failed' ? -1 : ORDER[job.phase];
  const elapsed = ((live ? now : new Date(job.finishedAt ?? now).getTime()) - new Date(job.requestedAt).getTime()) / 1000;
  const month = monthOf(job.month);
  const days = job.days ?? [];
  const events = job.events ?? [];

  return (
    <article className={`mfj ${tone}`} data-feature="meta-fetch-progress" aria-live="polite">
      <div className="mfj-figure" aria-label={`${job.percent}% selesai`}>
        <span className="mfj-pct">
          {job.phase === 'done' ? <Check size={30} strokeWidth={2.4} aria-hidden="true" /> : <>{job.percent}<i>%</i></>}
        </span>
        <span className="mfj-figure-label">{job.phase === 'done' ? 'selesai' : job.phase === 'failed' ? 'terhenti' : 'progres'}</span>
        <span className={`mfj-meter${job.phase === 'queued' ? ' is-wait' : ''}`} aria-hidden="true"><i style={{ transform: `scaleX(${job.percent / 100})` }} /></span>
      </div>

      <div className="mfj-main">
        <header className="mfj-head">
          <span className={`mfj-type is-${job.accountType === 'CPAS' ? 'cpas' : 'main'}`}>{typeLabel(job.accountType)}</span>
          <h4>{title}</h4>
          {live && <span className="mfj-live"><i aria-hidden="true" />Live</span>}
          {!live && onDismiss && <button type="button" className="mfj-x" onClick={onDismiss} aria-label="Tutup"><X size={15} /></button>}
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

        {days.length > 0 && (
          <ol className="mfj-days" style={{ '--n': days.length }} aria-label={`${job.daysDone} dari ${job.totalDays} hari masuk`}>
            {days.map((d) => (
              <li key={d.date} className={`is-${d.state}`} title={`${Number(d.date.slice(8))} ${month}: ${d.state === 'done' ? 'masuk' : d.state === 'pulling' ? 'sedang ditarik' : 'menunggu'}`}>
                {Number(d.date.slice(8))}
              </li>
            ))}
          </ol>
        )}

        <dl className="mfj-stats">
          <div><dt>Hari</dt><dd>{job.daysDone}<small>/{job.totalDays}</small></dd></div>
          <div><dt>Baris</dt><dd>{num(job.rows)}</dd></div>
          <div><dt>{live ? 'Berjalan' : 'Durasi'}</dt><dd>{duration(elapsed)}</dd></div>
          <div><dt>{live ? 'Perkiraan selesai' : 'Selesai'}</dt><dd>{live ? (job.etaSeconds != null ? `± ${duration(job.etaSeconds)}` : job.phase === 'filing' ? 'sebentar lagi' : 'menghitung…') : clock(job.finishedAt) || '—'}</dd></div>
        </dl>

        {logOpen && events.length > 0 && (
          <ol className="mfj-log">
            {events.map((e, i) => (
              <li key={`${e.kind}-${i}`} className={`is-${e.kind}`}>
                <time>{stamp(e.at)}</time>
                <span>{e.text}</span>
                {e.rows != null && <small>{num(e.rows)} baris</small>}
              </li>
            ))}
          </ol>
        )}

        <footer className="mfj-foot">
          <span>Ditekan {job.requestedBy ? `oleh ${job.requestedBy} ` : ''}pukul {clock(job.requestedAt)} · {Number(job.rangeStart.slice(8))}–{Number(job.rangeEnd.slice(8))} {month.slice(0, 3)}</span>
          <span className="mfj-actions">
            {events.length > 1 && (
              <button type="button" className={`mfj-btn is-ghost${logOpen ? ' is-on' : ''}`} onClick={() => setLogOpen((v) => !v)} aria-expanded={logOpen}>
                <ChevronDown size={14} aria-hidden="true" /> {logOpen ? 'Tutup log' : `Lihat log · ${events.length}`}
              </button>
            )}
            {job.phase === 'done' && onShow && (
              <button type="button" className="mfj-btn is-primary" onClick={onShow}>
                Lihat {month} di grid <ArrowUpRight size={14} aria-hidden="true" />
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
