import { useEffect, useState } from 'react';
import { ArrowRight, RotateCcw, X } from 'lucide-react';

// One "Tarik sekarang" pull, read like a job log: where it stands, the
// month's days filling in as Meta returns them, and what happened when.
// Every line is something that actually happened (from the runs Apps
// Script reported), so the card can be trusted at a glance and checked in
// detail.

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const monthOf = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
const time = (iso) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const num = (n) => Number(n ?? 0).toLocaleString('id-ID');

// 2:43, 1:05:09 — a stopwatch reads faster than "2 mnt 43 dtk".
function stopwatch(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
const about = (sec) => (sec < 60 ? 'kurang dari 1 menit' : `± ${Math.round(sec / 60)} menit`);

function status(job) {
  switch (job.phase) {
    case 'queued': return { tone: 'wait', label: 'Menunggu antrean' };
    case 'fetching': return { tone: 'live', label: `Menarik · ${job.daysDone}/${job.totalDays} hari` };
    case 'filing': return { tone: 'live', label: 'Menyimpan file' };
    case 'done': return job.note ? { tone: 'warn', label: 'Selesai, dengan catatan' } : { tone: 'done', label: 'Selesai' };
    default: return { tone: 'fail', label: 'Gagal' };
  }
}

// The step going on right now, as the log's last, open line.
function pending(job, queue, waited) {
  if (job.phase === 'queued') {
    return {
      text: queue?.running
        ? `Menunggu Apps Script, yang masih menarik ${queue.running} rentang untuk ${queue.brands} brand lain`
        : 'Menunggu Apps Script memulai (biasanya 1–2 menit)',
      side: stopwatch(waited),
    };
  }
  if (job.phase === 'fetching') {
    return { text: 'Menarik dari Meta', side: job.etaSeconds != null ? `sisa ${about(job.etaSeconds)}` : 'menghitung sisa waktu' };
  }
  if (job.phase === 'filing') return { text: 'Menulis file bulanan ke Performance Database', side: 'sebentar lagi' };
  return null;
}

export default function MetaFetchJobCard({ job, queue, onShow, onRetry, onDismiss, retrying }) {
  const live = job.active;
  const [now, setNow] = useState(Date.now());
  const [fullLog, setFullLog] = useState(false);
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const st = status(job);
  const end = live ? now : new Date(job.finishedAt ?? job.requestedAt).getTime();
  const elapsed = (end - new Date(job.requestedAt).getTime()) / 1000;
  const lastEvent = job.events?.length ? new Date(job.events[job.events.length - 1].at).getTime() : now;
  const open = pending(job, queue, (now - lastEvent) / 1000);
  const month = monthOf(job.month);
  const days = job.days ?? [];
  // The log stays short: the last few lines while it runs, only the outcome
  // once it is over; the whole of it on request.
  const events = job.events ?? [];
  const keep = fullLog ? events.length : live ? 4 : 1;
  const shown = events.slice(Math.max(0, events.length - keep));
  const hidden = events.length - shown.length;

  return (
    <article className={`mfj is-${st.tone}`} data-feature="meta-fetch-progress" aria-live="polite">
      <header className="mfj-head">
        <span className="mfj-status"><i aria-hidden="true" />{st.label}</span>
        <h4>{month} {job.month.slice(0, 4)} <span>· {job.accountType === 'CPAS' ? 'CPAS' : 'Meta Ads'}{job.accounts > 1 ? ` · ${job.accounts} akun` : ''}</span></h4>
        <span className="mfj-meta">
          <b>{num(job.rows)}</b> baris
          <em aria-hidden="true">/</em>
          <b>{stopwatch(elapsed)}</b>
        </span>
        {!live && onDismiss && <button type="button" className="mfj-x" onClick={onDismiss} aria-label="Tutup"><X size={14} /></button>}
      </header>

      {days.length > 0 && (
        <ol className="mfj-days" style={{ '--n': days.length }} aria-label={`${job.daysDone} dari ${job.totalDays} hari masuk`}>
          {days.map((d) => (
            <li key={d.date} className={`is-${d.state}`} title={`${Number(d.date.slice(8))} ${month}: ${d.state === 'done' ? 'masuk' : d.state === 'pulling' ? 'sedang ditarik' : 'menunggu'}`}>
              {Number(d.date.slice(8))}
            </li>
          ))}
        </ol>
      )}

      <ol className="mfj-log">
        {hidden > 0 && (
          <li className="is-more">
            <button type="button" onClick={() => setFullLog(true)}>{live ? `${hidden} kejadian sebelumnya` : `Lihat log lengkap · ${events.length} kejadian`}</button>
          </li>
        )}
        {shown.map((e, i) => (
          <li key={`${e.kind}-${i}`} className={`is-${e.kind}`}>
            <time>{time(e.at)}</time>
            <span>{e.text}</span>
            {e.rows != null && <small>{num(e.rows)} baris</small>}
          </li>
        ))}
        {open && (
          <li className="is-open">
            <time>{time(now)}</time>
            <span>{open.text}</span>
            <small>{open.side}</small>
          </li>
        )}
      </ol>

      {(job.note || (!live && (onShow || onRetry))) && (
        <footer className="mfj-foot">
          <p>
            {job.phase === 'failed'
              ? (job.daysDone ? `${job.daysDone} dari ${job.totalDays} hari sudah tersimpan; tarik ulang untuk melengkapi sisanya.` : 'Belum ada hari yang tersimpan. Alasannya ada di log di atas.')
              : job.note ?? `Data ${month} sudah ada di grid Performance Database.`}
          </p>
          {job.phase === 'done' && onShow && (
            <button type="button" className="mfj-link" onClick={onShow}>Lihat {month} di grid <ArrowRight size={14} aria-hidden="true" /></button>
          )}
          {job.phase === 'failed' && onRetry && (
            <button type="button" className="mfj-link" onClick={onRetry} disabled={retrying}><RotateCcw size={14} aria-hidden="true" /> Tarik ulang</button>
          )}
        </footer>
      )}
    </article>
  );
}
