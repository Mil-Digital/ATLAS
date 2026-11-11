import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowUpRight, Check, ChevronDown, Crosshair, Flag, History, Link2, Loader2, PencilLine, Scale, Wand2, X,
} from 'lucide-react';
import api from '../../api/client.js';
import { fmtRp, fmtRpShort } from '../../dailyTracking/lib/summary.js';
import { presetBrandSettings } from '../common/brandSettingsLink.js';
import {
  MONTH_LONG, MONTH_SHORT, changeFromOriginal, digits, followSales, monthLong, pct, signedPct, splitEqual, thousands,
} from './annualModel.js';
import './annualTarget.css';

// Brand Tracking › Target & Budget › Rencana tahunan — the year at a glance,
// then three tables, one shown at a time behind tabs, each with the 12
// months running down the side (grouped by quarter) and its figures across.
//
//   Target adjustment  the plan as it stands after every update — revenue,
//                      its share and growth, quarters and halves, the ad
//                      budget and its Cost per Revenue, daily targets. The
//                      split is edited right here: target by share (%) or
//                      amount, budget as a % of each month's target, a share
//                      of the year's budget, or an amount.
//   Realisasi          what was sold and spent, achievement against both
//                      plans, the gap and what is left to chase.
//   Target awal        the plan before the year ran (the baseline version's
//                      months, kept by the server since migration 063).
//
// The 12 months must add up exactly to the year set in Brand Setting; while
// the split is edited a check bar says how far off each total is, what to
// change, and offers to scale the months onto 100%.

const MODES_KEY = 'atlas.annualPlan.modes';
const UNIT_KEY = 'atlas.annualPlan.unit';
const SALES_MODES = [['pct', 'Kontribusi %'], ['rp', 'Nominal']];
const SPEND_MODES = [['cpr', '% dari target'], ['pct', 'Porsi %'], ['rp', 'Nominal']];
const QUARTERS = [0, 1, 2, 3];

const num2 = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 2 });
const xOf = (sales, spend) => (sales && spend ? `${(sales / spend).toLocaleString('id-ID', { maximumFractionDigits: 2 })}x` : '—');
const sum = (a) => a.reduce((x, y) => x + (y ?? 0), 0);
const ratio = (a, b) => (a != null && b ? a / b : null);
const growth = (cur, prev) => (cur != null && prev ? cur / prev - 1 : null);
const daysIn = (year, i) => new Date(year, i + 1, 0).getDate();
const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

// ── The split editor's units ─────────────────────────────────────────────
// pct: share of the year (0.085 = 8,5%) · rp: rupiah · cpr: budget ÷ the
// month's sales target (0.1 = 10%).
function unitsOf(mode, amounts, total, sales) {
  if (mode === 'rp') return amounts.map((v) => v ?? 0);
  if (mode === 'pct') return amounts.map((v) => (total ? (v ?? 0) / total : 0));
  return amounts.map((v, i) => (sales[i] ? (v ?? 0) / sales[i] : 0));
}
const textOf = (mode, v) => (mode === 'rp' ? String(Math.round(v)) : num2(v * 100));
function parseText(mode, text) {
  const t = String(text ?? '').trim();
  if (t === '') return 0;
  if (mode === 'rp') return Number(digits(t));
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n / 100 : null;
}
const makeSide = (mode, amounts, total, sales) => {
  const exact = unitsOf(mode, amounts, total, sales);
  return { texts: exact.map((v) => textOf(mode, v)), exact };
};
// Whole rupiah adding up exactly to `total`; the largest month takes the rounding.
function settle(raw, total) {
  const out = raw.map((v) => Math.round(v));
  const big = out.indexOf(Math.max(...out));
  out[big] += total - sum(out);
  return out;
}
// The rupiah a side gives. Shares and Cost per Revenue show and take two
// decimals, so each month can sit up to 0,005 points off what it holds:
// when they add up within that, they settle onto the year exactly. Typed
// amounts have to add up on their own. A Cost per Revenue typed as the
// year's own (as shown) counts as exactly the year's.
function resolve(mode, side, total, sales, yearRatio) {
  const vals = side.texts.map((t, i) => {
    if (side.exact[i] != null) return side.exact[i];
    if (mode === 'cpr' && yearRatio && String(t).trim() === textOf('cpr', yearRatio)) return yearRatio;
    return parseText(mode, t);
  });
  const valid = vals.every((v) => v != null);
  const raw = vals.map((v, i) => (v == null ? 0 : mode === 'pct' ? total * v : mode === 'rp' ? v : (sales[i] ?? 0) * v));
  const slack = mode === 'rp' ? 0 : mode === 'pct' ? total * 0.0006 + 12 : sum(sales) * 0.00005 + 12;
  const amounts = valid && Math.abs(sum(raw) - total) <= slack ? settle(raw, total) : raw.map((v) => Math.round(v));
  const got = sum(amounts);
  const bad = vals.flatMap((v, i) => (v == null ? [i] : []));
  return { valid, amounts, got, ok: valid && got === total, bad };
}

function readPref(key, fallback, allowed) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? fallback : allowed(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a per-viewer convenience only */ }
}
const readModes = () => {
  const m = readPref(MODES_KEY, {}, (v) => typeof v === 'object');
  return {
    sales: SALES_MODES.some(([k]) => k === m.sales) ? m.sales : 'pct',
    spend: SPEND_MODES.some(([k]) => k === m.spend) ? m.spend : 'cpr',
  };
};

// The split being edited: what each mode shows, the rupiah it gives, and
// the shortcuts (target even, budget following the target).
function useSplitEditor(data, onChange) {
  const annual = data.annual;
  const hasSpend = annual.targetSpend != null;
  const totalSales = annual.targetSales ?? 0;
  const totalSpend = annual.targetSpend ?? 0;
  const yearRatio = hasSpend && totalSales ? totalSpend / totalSales : null;
  const [modes, setModes] = useState(readModes);
  const [draft, setDraft] = useState(null);
  const stored = useMemo(() => ({
    sales: data.months.map((m) => m.targetSales ?? 0),
    spend: data.months.map((m) => m.targetSpend ?? 0),
  }), [data]);
  useEffect(() => { setDraft(null); }, [data]);

  const base = useMemo(() => ({
    sales: makeSide(modes.sales, stored.sales, totalSales, stored.sales),
    spend: makeSide(modes.spend, stored.spend, totalSpend, stored.sales),
  }), [modes, stored, totalSales, totalSpend]);
  const cur = draft ?? base;
  const sales = useMemo(() => (draft ? resolve(modes.sales, cur.sales, totalSales, stored.sales, null)
    : { valid: true, amounts: stored.sales, got: sum(stored.sales), ok: true }), [draft, cur, modes, totalSales, stored]);
  const spend = useMemo(() => {
    if (!hasSpend) return null;
    if (!draft) return { valid: true, amounts: stored.spend, got: sum(stored.spend), ok: sum(stored.spend) === totalSpend };
    return resolve(modes.spend, cur.spend, totalSpend, sales.amounts, yearRatio);
  }, [hasSpend, draft, cur, modes, totalSpend, sales, stored, yearRatio]);

  // Whether the saved budget follows the saved target (one Cost per Revenue
  // every month): more than Rp1.000 or 0,5% off in any month says it doesn't.
  const followsTarget = useMemo(() => {
    if (!hasSpend) return true;
    const want = followSales(totalSpend, stored.sales);
    return want.every((v, i) => Math.abs(v - stored.spend[i]) <= Math.max(1000, v * 0.005));
  }, [hasSpend, totalSpend, stored]);

  const open = () => draft ?? base;
  const setMode = (key, mode) => {
    const next = { ...modes, [key]: mode };
    writePref(MODES_KEY, next);
    if (draft) {
      setDraft((d) => ({
        ...d,
        [key]: key === 'sales'
          ? makeSide(mode, sales.amounts, totalSales, sales.amounts)
          : makeSide(mode, spend.amounts, totalSpend, sales.amounts),
      }));
    }
    setModes(next);
  };
  const type = (key, i, value) => {
    onChange?.();
    const clean = modes[key] === 'rp' ? digits(value) : value.replace(/[^\d.,]/g, '');
    const d = open();
    const side = d[key];
    setDraft({ ...d, [key]: { texts: side.texts.map((t, j) => (j === i ? clean : t)), exact: side.exact.map((v, j) => (j === i ? null : v)) } });
  };
  const spreadSales = () => {
    const even = splitEqual(totalSales);
    setDraft({ ...open(), sales: makeSide(modes.sales, even, totalSales, even) });
  };
  const followTarget = () => {
    const d = open();
    const target = draft ? sales.amounts : stored.sales;
    if (modes.spend === 'cpr') setDraft({ ...d, spend: { texts: target.map(() => textOf('cpr', yearRatio)), exact: target.map(() => yearRatio) } });
    else setDraft({ ...d, spend: makeSide(modes.spend, followSales(totalSpend, target), totalSpend, target) });
  };
  // Every month scaled by the same factor so the 12 add up to the year:
  // the shape the person typed stays, only the total moves to 100%.
  const fit = (key) => {
    const d = open();
    if (key === 'sales') {
      if (!sales.valid) return;
      const next = sales.got > 0 ? settle(sales.amounts.map((v) => (v * totalSales) / sales.got), totalSales) : splitEqual(totalSales);
      setDraft({ ...d, sales: makeSide(modes.sales, next, totalSales, next) });
    } else if (spend?.valid) {
      const next = spend.got > 0 ? settle(spend.amounts.map((v) => (v * totalSpend) / spend.got), totalSpend) : followSales(totalSpend, sales.amounts);
      setDraft({ ...d, spend: makeSide(modes.spend, next, totalSpend, sales.amounts) });
    }
  };
  return {
    hasSpend, totalSales, totalSpend, yearRatio, modes, setMode, draft, reset: () => setDraft(null), cur, sales, spend,
    followsTarget, type, spreadSales, followTarget, fit, ok: sales.ok && (!spend || spend.ok),
  };
}

// Achievement tone: met, close, or short once the month is over.
const toneOf = (r, done) => (r == null ? '' : r >= 1 ? 'is-good' : r >= 0.9 ? 'is-warn' : done ? 'is-bad' : '');

function Seg({ value, options, onChange, label, disabled }) {
  return (
    <div className="at-mini-seg" role="radiogroup" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? 'is-on' : ''} onClick={() => onChange(k)} disabled={disabled}>{l}</button>
      ))}
    </div>
  );
}

// `children` (the month's pacing and channel budget) sit between the year at
// a glance and the month-by-month sheets: year, this month, then the detail.
export default function AnnualPlan({ brandId, month, canEdit, onSaved, children }) {
  const year = Number(String(month).slice(0, 4));
  const [state, setState] = useState({ status: 'loading', data: null });
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', data: null });
    setMessage(null);
    api.get('/daily-tracking/annual-targets', { params: { brandId, year } })
      .then(({ data }) => alive && setState({ status: 'ready', data }))
      .catch((err) => alive && setState({ status: 'error', error: err.response?.data?.message || 'Rencana tahunan tidak dapat dimuat' }));
    return () => { alive = false; };
  }, [brandId, year]);

  if (state.status === 'loading') return <><p className="at-state"><Loader2 size={14} className="dt-spin" /> Memuat rencana tahunan…</p>{children}</>;
  if (state.status === 'error') return <><p className="at-state is-error">{state.error}</p>{children}</>;
  if (!state.data.annual) {
    return (
      <>
      <section className="soft-card tb-card at-plan is-empty" data-feature="rencana-tahunan" aria-label="Rencana tahunan">
        <header className="tb-head">
          <div>
            <h2>Rencana tahunan {year}</h2>
            <p>Belum ada target tahunan untuk {year}.{canEdit ? ' Target bulanan di bawah tetap bisa diatur per bulan.' : ' Target diatur oleh tim MIL Digital.'}</p>
          </div>
          {canEdit && (
            <Link to={`/pengaturan-brand?detail=${brandId}`} className="bp-ghost" onClick={() => presetBrandSettings({ brandId })}>
              Isi di Brand Setting <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          )}
        </header>
      </section>
      {children}
      </>
    );
  }
  return (
    <PlanBody
      key={`${brandId}-${year}`}
      data={state.data}
      brandId={brandId}
      year={year}
      canEdit={canEdit}
      message={message}
      setMessage={setMessage}
      onSaved={(next) => {
        setState({ status: 'ready', data: next });
        setMessage({ tone: 'ok', text: `Pembagian ${year} tersimpan.` });
        onSaved?.();
      }}
    >
      {children}
    </PlanBody>
  );
}

function PlanBody({ data, brandId, year, canEdit, message, setMessage, onSaved, children }) {
  const [unit, setUnitState] = useState(() => readPref(UNIT_KEY, 'jt', (v) => v === 'full' || v === 'jt'));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('adj');
  const ed = useSplitEditor(data, () => setMessage(null));
  const setUnit = (v) => { writePref(UNIT_KEY, v); setUnitState(v); };

  const annual = data.annual;
  const original = data.original;
  const updates = data.updates ?? 0;
  const months = data.months;
  const { hasSpend } = ed;
  const today = new Date();
  const thisYear = today.getFullYear();
  const throughIdx = year < thisYear ? 11 : year > thisYear ? -1 : today.getMonth();
  const currentIdx = year === thisYear ? today.getMonth() : -1;
  const lastUpdate = [...(data.revisions ?? [])].reverse().find((r) => r.kind === 'revision');

  // Plans and actuals, month by month. Months to come have no actual yet;
  // the running month reads Rp0 so far rather than nothing.
  const adjS = ed.sales.amounts;
  const adjP = hasSpend ? ed.spend.amounts : months.map(() => null);
  const initS = months.map((m) => m.initialSales);
  const initP = months.map((m) => m.initialSpend);
  const seen = (i) => i <= throughIdx;
  const actS = months.map((m, i) => (seen(i) ? m.actualSales ?? (i === currentIdx ? 0 : null) : null));
  const actP = months.map((m, i) => (seen(i) ? m.actualSpend ?? (i === currentIdx ? 0 : null) : null));
  const done = (i) => i < throughIdx || year < thisYear;
  const ytdIdx = range(0, throughIdx + 1);
  const ytd = {
    actual: sum(ytdIdx.map((i) => actS[i])),
    spend: sum(ytdIdx.map((i) => actP[i])),
    adj: sum(ytdIdx.map((i) => adjS[i])),
    adjSpend: sum(ytdIdx.map((i) => adjP[i])),
    init: sum(ytdIdx.map((i) => initS[i])),
  };
  const T = annual.targetSales;
  const P = annual.targetSpend;
  const I = sum(initS);
  const IP = initP.some((v) => v != null) ? sum(initP) : null;

  const money = (v) => {
    if (v == null || !Number.isFinite(v)) return '—';
    return unit === 'jt' ? (v / 1e6).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Math.round(v).toLocaleString('id-ID');
  };
  const unitLabel = unit === 'jt' ? 'Rp juta' : 'Rp';

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { data: next } = await api.put('/daily-tracking/annual-targets/split', {
        brandId, year,
        months: months.map((m, i) => ({ month: m.month, targetSales: ed.sales.amounts[i], targetSpend: hasSpend ? ed.spend.amounts[i] : null })),
      });
      setEditing(false);
      onSaved(next);
    } catch (err) {
      setMessage({ tone: 'error', text: err.response?.data?.message || 'Pembagian gagal disimpan' });
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => { ed.reset(); setEditing(false); setMessage(null); };

  // One editable month: the mode's own unit, typed in place. A month that
  // is not a number is ringed red, matching the check bar's message.
  const input = (key, i, label) => {
    const mode = ed.modes[key];
    const text = ed.cur[key].texts[i];
    const wrong = ed.draft && ed[key]?.bad?.includes(i);
    return (
      <span className={`pt-in${wrong ? ' is-bad' : ''}`}>
        <input inputMode={mode === 'rp' ? 'numeric' : 'decimal'} aria-label={label} aria-invalid={wrong || undefined} value={mode === 'rp' ? thousands(text) : text} onChange={(e) => ed.type(key, i, e.target.value)} disabled={saving} />
        {mode !== 'rp' && <i>%</i>}
      </span>
    );
  };
  // The total of an edited column: what the 12 add up to, and how far off.
  const toneOfSide = (side) => (!side.valid || side.got > (side === ed.sales ? T : P) ? 'is-bad' : side.ok ? 'is-good' : 'is-warn');
  const sumCell = (side, total) => {
    const diff = side.got - total;
    return (
      <span className="pt-sum">
        <b>{money(side.got)}</b>
        <span className={`pt-pill ${toneOfSide(side)}`}>{!side.valid ? 'Tidak valid' : side.ok ? 'Pas' : `${diff > 0 ? 'Lebih' : 'Kurang'} ${fmtRpShort(Math.abs(diff))}`}</span>
      </span>
    );
  };
  const shareCell = (side, total) => <span className={`pt-pill is-solid ${toneOfSide(side)}`}>{pct(ratio(side.got, total), 2)}</span>;

  const qIdx = (q) => [q * 3, q * 3 + 1, q * 3 + 2];
  const qSum = (arr, q) => sum(qIdx(q).map((i) => arr[i]));
  const hSum = (arr, h) => sum(range(h * 6, h * 6 + 6).map((i) => arr[i]));
  const qTotal = (arr, q) => <QVal value={money(qSum(arr, q))} note={q ? growthChip(growth(qSum(arr, q), qSum(arr, q - 1)), 'QoQ') : null} />;
  const hTotal = (arr) => (h) => <QVal value={money(hSum(arr, h))} note={h ? growthChip(growth(hSum(arr, 1), hSum(arr, 0)), 'dari H1') : null} />;
  const shareMax = (arr, total) => Math.max(0.0001, ...arr.map((v) => ratio(v, total) ?? 0));

  // ── Target adjustment ────────────────────────────────────────────────
  const salesIn = editing && canEdit ? ed.modes.sales : null;
  const spendIn = editing && canEdit && hasSpend ? ed.modes.spend : null;
  const adjMax = shareMax(adjS, ed.sales.got || T);
  const adjCols = [
    {
      id: 'a-target', group: 'Target revenue', label: 'Target', hint: unitLabel, key: true, input: salesIn === 'rp',
      cell: (i) => (salesIn === 'rp' ? input('sales', i, `Target ${monthLong(months[i].month)}`) : money(adjS[i])),
      q: (q) => qTotal(adjS, q), h: hTotal(adjS),
      total: salesIn ? sumCell(ed.sales, T) : money(T),
    },
    {
      id: 'a-share', group: 'Target revenue', label: 'Kontribusi', hint: 'porsi setahun', input: salesIn === 'pct',
      cell: (i) => (salesIn === 'pct' ? input('sales', i, `Kontribusi ${monthLong(months[i].month)}`) : <Share r={ratio(adjS[i], T)} max={adjMax} />),
      q: (q) => pct(ratio(qSum(adjS, q), T), 1), h: (h) => pct(ratio(hSum(adjS, h), T), 1),
      total: salesIn === 'pct' ? shareCell(ed.sales, T) : '100%',
    },
    { id: 'a-growth', group: 'Target revenue', detail: true, label: 'Growth', hint: 'vs bulan lalu', cell: (i) => signedTone(i ? growth(adjS[i], adjS[i - 1]) : null) },
    {
      id: 'a-vs', group: 'Target revenue', detail: true, label: 'vs target awal', hint: 'perubahan',
      cell: (i) => { const g = growth(adjS[i], initS[i]); return g == null || Math.abs(g) < 0.0005 ? <span className="pt-dim">tetap</span> : signedTone(g); },
      q: (q) => signedTone(growth(qSum(adjS, q), qSum(initS, q))),
      total: signedTone(growth(T, I)),
    },
    ...(hasSpend ? [
      {
        id: 'a-budget', group: 'Budget iklan', label: 'Budget', hint: unitLabel, key: true, input: spendIn === 'rp',
        cell: (i) => (spendIn === 'rp' ? input('spend', i, `Budget ${monthLong(months[i].month)}`) : money(adjP[i])),
        q: (q) => <QVal value={money(qSum(adjP, q))} />, h: (h) => <QVal value={money(hSum(adjP, h))} />,
        total: spendIn ? sumCell(ed.spend, P) : money(P),
      },
      {
        id: 'a-cpr', group: 'Budget iklan', label: '% alokasi', hint: 'cost per revenue', input: spendIn === 'cpr',
        cell: (i) => (spendIn === 'cpr' ? input('spend', i, `Alokasi budget ${monthLong(months[i].month)}`) : pct(ratio(adjP[i], adjS[i]), 2)),
        q: (q) => pct(ratio(qSum(adjP, q), qSum(adjS, q)), 2),
        total: spendIn === 'cpr' ? <span className={`pt-pill is-solid ${toneOfSide(ed.spend)}`}>{pct(ratio(ed.spend.got, ed.sales.got), 2)}</span> : pct(ratio(P, T), 2),
      },
      ...(spendIn === 'pct' ? [{
        id: 'a-pshare', group: 'Budget iklan', label: 'Porsi budget', hint: 'porsi setahun', input: true,
        cell: (i) => input('spend', i, `Porsi budget ${monthLong(months[i].month)}`),
        q: (q) => pct(ratio(qSum(adjP, q), P), 1),
        total: shareCell(ed.spend, P),
      }] : []),
      { id: 'a-roas', group: 'Budget iklan', detail: true, label: 'Target ROAS', cell: (i) => xOf(adjS[i], adjP[i]), q: (q) => xOf(qSum(adjS, q), qSum(adjP, q)), total: xOf(T, P) },
    ] : []),
    { id: 'a-daily', group: 'Harian', detail: true, label: 'Target harian', hint: unitLabel, cell: (i) => money(adjS[i] / daysIn(year, i)), total: money(T / (year % 4 ? 365 : 366)) },
    ...(hasSpend ? [{ id: 'a-dbudget', group: 'Harian', detail: true, label: 'Budget harian', hint: unitLabel, cell: (i) => money(adjP[i] / daysIn(year, i)), total: money(P / (year % 4 ? 365 : 366)) }] : []),
  ];

  // ── Realisasi ─────────────────────────────────────────────────────────
  const chase = [];
  months.forEach((_, i) => { chase.push((chase[i - 1] ?? 0) + (adjS[i] ?? 0) - (actS[i] ?? 0)); });
  const seenOf = (q) => qIdx(q).filter(seen);
  const realCols = [
    {
      id: 'r-real', group: 'Revenue', label: 'Realisasi', hint: unitLabel, key: true,
      cell: (i) => money(actS[i]),
      tone: (i) => (actS[i] == null || !done(i) ? '' : actS[i] >= adjS[i] ? 'is-fill-good' : 'is-fill-bad'),
      q: (q) => { const idx = seenOf(q); return idx.length ? <QVal value={money(sum(idx.map((i) => actS[i])))} /> : <span className="pt-dim">—</span>; },
      total: money(ytd.actual),
    },
    {
      id: 'r-ach', group: 'Revenue', label: 'Achievement', hint: 'vs adjustment',
      cell: (i) => { const r = ratio(actS[i], adjS[i]); return r == null ? <span className="pt-dim">—</span> : <AchBar r={r} tone={toneOf(r, done(i))} />; },
      q: (q) => {
        const idx = seenOf(q);
        if (!idx.length) return <span className="pt-dim">—</span>;
        const r = ratio(sum(idx.map((i) => actS[i])), qSum(adjS, q));
        return <AchBar r={r} tone={toneOf(r, idx.length === 3 && done(q * 3 + 2))} />;
      },
      total: <AchBar r={ratio(ytd.actual, ytd.adj)} tone={toneOf(ratio(ytd.actual, ytd.adj), year < thisYear)} />,
    },
    {
      id: 'r-chase', group: 'Revenue', label: 'To be chased', hint: 'gap kumulatif',
      cell: (i) => <span className={i > throughIdx ? 'pt-ghost' : ''}>{gapCell(chase[i], money)}</span>,
      total: gapCell(T - ytd.actual, money),
    },
    { id: 'r-growth', group: 'Revenue', detail: true, label: 'Growth', hint: 'vs bulan lalu', cell: (i) => signedTone(i && done(i) ? growth(actS[i], actS[i - 1]) : null) },
    { id: 'r-ach0', group: 'Revenue', detail: true, label: 'Achievement', hint: 'vs target awal', cell: (i) => pct(ratio(actS[i], initS[i]), 0), total: pct(ratio(ytd.actual, ytd.init), 1) },
    { id: 'r-gap', group: 'Revenue', detail: true, label: 'Gap ke target', hint: 'target − realisasi', cell: (i) => (actS[i] == null ? <span className="pt-dim">—</span> : gapCell(adjS[i] - actS[i], money)), total: gapCell(ytd.adj - ytd.actual, money) },
    {
      id: 'r-spend', group: 'Budget iklan', label: 'Spend riil', hint: unitLabel, key: true, cell: (i) => money(actP[i]),
      q: (q) => { const idx = seenOf(q); return idx.length ? <QVal value={money(sum(idx.map((i) => actP[i])))} /> : <span className="pt-dim">—</span>; },
      total: money(ytd.spend),
    },
    {
      id: 'r-cpr', group: 'Budget iklan', label: 'CPR riil', hint: 'cost per revenue',
      cell: (i) => {
        const r = ratio(actP[i], actS[i]);
        if (r == null) return <span className="pt-dim">—</span>;
        const plan = ratio(adjP[i], adjS[i]);
        return <span className={plan == null ? '' : r > plan * 1.0005 ? 'pt-bad' : 'pt-good'}>{pct(r, 1)}</span>;
      },
      q: (q) => { const idx = seenOf(q); return idx.length ? pct(ratio(sum(idx.map((i) => actP[i])), sum(idx.map((i) => actS[i]))), 1) : <span className="pt-dim">—</span>; },
      total: pct(ratio(ytd.spend, ytd.actual), 2),
    },
    ...(hasSpend ? [{
      id: 'r-burn', group: 'Budget iklan', detail: true, label: 'Penyerapan', hint: 'spend ÷ budget',
      cell: (i) => { const r = ratio(actP[i], adjP[i]); return r == null ? <span className="pt-dim">—</span> : <span className={r > 1.02 ? 'pt-warn' : ''}>{pct(r, 1)}</span>; },
      total: pct(ratio(ytd.spend, ytd.adjSpend), 1),
    }] : []),
    { id: 'r-roas', group: 'Budget iklan', detail: true, label: 'ROAS riil', cell: (i) => (actP[i] == null ? <span className="pt-dim">—</span> : xOf(actS[i], actP[i])), total: xOf(ytd.actual, ytd.spend) },
  ];

  // ── Target awal ───────────────────────────────────────────────────────
  const initMax = shareMax(initS, I);
  const initCols = [
    { id: 'i-target', group: 'Target revenue', label: 'Target', hint: unitLabel, key: true, cell: (i) => money(initS[i]), q: (q) => qTotal(initS, q), h: hTotal(initS), total: money(I) },
    { id: 'i-share', group: 'Target revenue', label: 'Kontribusi', hint: 'porsi setahun', cell: (i) => <Share r={ratio(initS[i], I)} max={initMax} />, q: (q) => pct(ratio(qSum(initS, q), I), 1), h: (h) => pct(ratio(hSum(initS, h), I), 1), total: '100%' },
    { id: 'i-growth', group: 'Target revenue', detail: true, label: 'Growth', hint: 'vs bulan lalu', cell: (i) => signedTone(i ? growth(initS[i], initS[i - 1]) : null) },
    ...(IP != null ? [
      { id: 'i-budget', group: 'Budget iklan', label: 'Budget', hint: unitLabel, key: true, cell: (i) => money(initP[i]), q: (q) => <QVal value={money(qSum(initP, q))} />, total: money(IP) },
      { id: 'i-cpr', group: 'Budget iklan', label: '% alokasi', hint: 'cost per revenue', cell: (i) => pct(ratio(initP[i], initS[i]), 2), q: (q) => pct(ratio(qSum(initP, q), qSum(initS, q)), 2), total: pct(ratio(IP, I), 2) },
    ] : []),
  ];

  // ── The three tables, one at a time ──────────────────────────────────
  const achYtd = ratio(ytd.actual, ytd.adj);
  const tabs = [
    { id: 'adj', tone: 'adj', icon: Crosshair, step: '01', title: 'Target adjustment', feature: 'plan-adjustment', summary: `${fmtRpShort(T)}${hasSpend ? ` · budget ${fmtRpShort(P)}` : ''}` },
    { id: 'act', tone: 'act', icon: Activity, step: '02', title: 'Realisasi', feature: 'plan-actual', summary: throughIdx >= 0 ? `${pct(achYtd, 0)} achievement s.d. ${MONTH_SHORT[throughIdx]}` : `${year} belum berjalan` },
    { id: 'init', tone: 'init', icon: Flag, step: '03', title: 'Target awal', feature: 'plan-initial', summary: `${fmtRpShort(I)}${data.initialEstimated ? ' · perkiraan' : ''}` },
  ];
  const tabIdx = Math.max(0, tabs.findIndex((t) => t.id === tab));
  const pickTab = (id) => { if (!editing) setTab(id); };
  const startEdit = (then) => { setTab('adj'); setEditing(true); setMessage(null); then?.(); };

  const editTools = editing && (
    <div className="ps-edit">
      <div className="ps-edit-modes">
        <label><span>Isi target dengan</span><Seg value={ed.modes.sales} options={SALES_MODES} onChange={(m) => ed.setMode('sales', m)} label="Isi target dengan" disabled={saving} /></label>
        {hasSpend && <label><span>Isi budget dengan</span><Seg value={ed.modes.spend} options={SPEND_MODES} onChange={(m) => ed.setMode('spend', m)} label="Isi budget dengan" disabled={saving} /></label>}
      </div>
      <div className="ps-edit-tools">
        <button type="button" className="tb-link" onClick={ed.spreadSales} disabled={saving}><Scale size={14} aria-hidden="true" /> Target bagi rata</button>
        {hasSpend && <button type="button" className="tb-link" onClick={ed.followTarget} disabled={saving}><Link2 size={14} aria-hidden="true" /> Budget ikuti target · {pct(ed.yearRatio, 2)}</button>}
      </div>
      <p className="ps-edit-hint">
        Kolom kuning bisa diisi. {ed.modes.spend === 'cpr' && hasSpend ? 'Budget = % alokasi × target bulan itu, jadi ikut berubah saat target diubah. ' : ''}
        Total 12 bulan harus pas {fmtRp(T)}{hasSpend ? ` dan ${fmtRp(P)}` : ''}.{updates === 0 ? ' Belum ada update, jadi target awal ikut berubah.' : ''}
      </p>
    </div>
  );

  const panels = {
    adj: {
      sub: updates > 0 ? `Berlaku sekarang · ${updates} update${lastUpdate ? `, terakhir mulai ${monthLong(lastUpdate.effectiveMonth)}` : ''}` : 'Berlaku sekarang · belum ada update',
      cols: adjCols,
      actions: canEdit && !editing ? (
        <button type="button" className="bp-primary ps-edit-btn" onClick={() => startEdit()}>
          <PencilLine size={15} aria-hidden="true" /> Atur pembagian
        </button>
      ) : editing ? <span className="ps-editing"><i aria-hidden="true" /> Sedang diatur</span> : null,
      banner: (
        <>
          {editTools}
          {hasSpend && !ed.followsTarget && !ed.draft && (
            <div className="ps-banner">
              <Link2 size={16} aria-hidden="true" />
              <p><b>Budget belum mengikuti target.</b> Bulan dengan target besar dapat budget yang sama dengan bulan kecil. Dengan {pct(ed.yearRatio, 2)} dari target tiap bulan, totalnya tetap {fmtRp(P)}.</p>
              {canEdit && <button type="button" className="bp-ghost" onClick={() => startEdit(ed.followTarget)}>Ikuti target</button>}
            </div>
          )}
        </>
      ),
      footer: editing ? <SplitCheck ed={ed} T={T} P={P} saving={saving} onSave={save} onCancel={cancel} /> : null,
    },
    act: {
      sub: throughIdx >= 0 ? `Input harian Brand Tracking · s.d. ${monthLong(months[throughIdx].month)}` : `${year} belum berjalan`,
      cols: realCols,
      futureFrom: throughIdx + 1,
    },
    init: {
      sub: data.initialEstimated
        ? 'Sebelum tahun berjalan · per bulan diperkirakan (dibagi rata), pembagiannya belum tersimpan saat update'
        : `Sebelum tahun berjalan${original ? ` · disusun ${new Date(original.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}${data.corrected ? ' · dikoreksi' : ''}`,
      cols: initCols,
    },
  };
  const active = tabs[tabIdx];
  const panel = panels[active.id];

  return (
    <>
    <section className="at-plan ap-hero-block" data-feature="rencana-tahunan" aria-label="Rencana tahunan">
      <PlanHero
        year={year} T={T} P={P} I={I} IP={IP} ytd={ytd} updates={updates} lastUpdate={lastUpdate} corrected={data.corrected}
        throughIdx={throughIdx} currentIdx={currentIdx} adjS={adjS} actS={actS} initS={initS} done={done}
        hasSpend={hasSpend} unit={unit} setUnit={setUnit}
      />
    </section>

    {children}

    <section className="soft-card tb-card at-plan" data-feature="rencana-per-bulan" aria-label="Rencana per bulan">
      <header className="tb-head">
        <div>
          <h2>Rencana per bulan · {year}</h2>
          <p>Tiga tabel untuk 12 bulan: target yang berlaku, realisasinya, dan target awal sebelum ada update. Pembagian target dan budget diatur di Target adjustment.</p>
        </div>
      </header>

      {message && <p className={`tb-msg is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}

      <div className="pv-tabs" role="tablist" aria-label="Tabel rencana" style={{ '--n': tabs.length, '--at': tabIdx }}>
        <span className="pv-ink" aria-hidden="true" />
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = t.id === active.id;
          const locked = editing && !on;
          return (
            <button
              key={t.id} type="button" role="tab" id={`pv-tab-${t.id}`} aria-selected={on} aria-controls={`pv-panel-${t.id}`}
              className={`pv-tab is-${t.tone}${on ? ' is-on' : ''}`} data-feature={t.feature}
              onClick={() => pickTab(t.id)} aria-disabled={locked || undefined} title={locked ? 'Simpan atau batalkan pembagian dulu' : undefined}
            >
              <span className="pv-tab-icon" aria-hidden="true"><Icon size={16} /></span>
              <span className="pv-tab-text">
                <span className="pv-tab-title"><em>{t.step}</em>{t.title}</span>
                <small>{t.summary}</small>
              </span>
            </button>
          );
        })}
      </div>

      <PlanPanel
        key={active.id} id={active.id} tone={active.tone} title={active.title} sub={panel.sub}
        actions={panel.actions} banner={panel.banner} footer={panel.footer} editing={active.id === 'adj' && editing}
        cols={panel.cols} currentIdx={currentIdx} futureFrom={panel.futureFrom} unit={unit}
      />

      <p className="tb-foot">
        Target tahunan dan update-nya diatur di Brand Setting › Annual Target. Target awal mengikuti pembagian di sini sampai ada update pertama; setelah itu terkunci, dan pembagian di sini mengubah target adjustment.
      </p>
    </section>
    </>
  );
}

// A growth or change, signed and coloured.
function signedTone(g) {
  if (g == null) return <span className="pt-dim">—</span>;
  return <span className={g > 0.0005 ? 'pt-good' : g < -0.0005 ? 'pt-bad' : 'pt-dim'}>{signedPct(g, 1)}</span>;
}
function growthChip(g, label) {
  if (g == null) return null;
  return <span className={`pt-chip ${g > 0.0005 ? 'is-up' : g < -0.0005 ? 'is-down' : ''}`}>{signedPct(g, 1)} {label}</span>;
}
// Target − actual: still to go (red), or past it (green, shown as a surplus).
function gapCell(v, money) {
  if (v == null) return '—';
  if (Math.abs(v) < 1) return <span className="pt-dim">0</span>;
  return v > 0 ? <span className="pt-bad">{money(v)}</span> : <span className="pt-good">+{money(-v)}</span>;
}
// Achievement as a figure over a thin meter.
function AchBar({ r, tone }) {
  if (r == null) return <span className="pt-dim">—</span>;
  return (
    <span className={`pt-ach ${tone}`}>
      <b>{pct(r, 0)}</b>
      <i aria-hidden="true"><em style={{ transform: `scaleX(${Math.min(r, 1)})` }} /></i>
    </span>
  );
}

// ── The year at a glance: achievement so far and the 12 months as bars ──
function PlanHero({ year, T, P, I, IP, ytd, updates, lastUpdate, corrected, throughIdx, currentIdx, adjS, actS, initS, done, hasSpend, unit, setUnit }) {
  const ach = ratio(ytd.actual, ytd.adj);
  const max = Math.max(1, ...adjS, ...actS.map((v) => v ?? 0), ...(updates > 0 ? initS.map((v) => v ?? 0) : []));
  const h = (v) => `${Math.max(((v ?? 0) / max) * 100, v ? 1.5 : 0)}%`;
  const R = 52;
  const C = 2 * Math.PI * R;
  const change = changeFromOriginal(T, I);
  return (
    <div className="ph" data-feature="plan-hero">
      <div className="ph-top">
        <div>
          <span className="ph-eyebrow">Rencana tahunan · {year}</span>
          <h2>{fmtRp(T)}</h2>
          <p>
            Target adjustment
            {updates > 0
              ? <> · <b className={change >= 0 ? 'is-up' : 'is-down'}>{signedPct(change)}</b> dari target awal {fmtRpShort(I)} · <History size={12} aria-hidden="true" /> {updates} update{lastUpdate ? `, mulai ${MONTH_SHORT[Number(lastUpdate.effectiveMonth.slice(5, 7)) - 1]}` : ''}</>
              : ' · belum ada update'}
            {corrected ? ' · target awal dikoreksi' : ''}
          </p>
        </div>
        <div className="ph-unit">
          <span>Angka tabel</span>
          <Seg value={unit} options={[['jt', 'Juta'], ['full', 'Rupiah penuh']]} onChange={setUnit} label="Satuan angka tabel" />
        </div>
      </div>

      <div className="ph-body">
        <div className="ph-gauge">
          <svg viewBox="0 0 128 128" role="img" aria-label={`Achievement ${pct(ach)} dari target adjustment`}>
            <defs>
              <linearGradient id="ph-ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#5eead4" />
                <stop offset="100%" stopColor="#818cf8" />
              </linearGradient>
            </defs>
            <circle cx="64" cy="64" r={R} className="ph-ring-track" />
            <circle cx="64" cy="64" r={R} className="ph-ring-val" stroke="url(#ph-ring)" strokeDasharray={C} style={{ '--ph-off': C * (1 - Math.min(ach ?? 0, 1)), '--ph-c': C }} />
          </svg>
          <div className="ph-gauge-text">
            <strong>{throughIdx >= 0 ? pct(ach, 0) : '—'}</strong>
            <span>{throughIdx >= 0 ? `achievement s.d. ${MONTH_SHORT[throughIdx]}` : 'belum berjalan'}</span>
          </div>
        </div>

        <dl className="ph-stats">
          <div><dt>Realisasi</dt><dd>{fmtRpShort(ytd.actual)}</dd><small>dari {fmtRpShort(ytd.adj)} target s.d. {throughIdx >= 0 ? MONTH_SHORT[throughIdx] : '—'}</small></div>
          <div><dt>Sisa dikejar</dt><dd>{fmtRpShort(Math.max(T - ytd.actual, 0))}</dd><small>{pct(ratio(ytd.actual, T))} dari target setahun</small></div>
          <div><dt>Budget terpakai</dt><dd>{fmtRpShort(ytd.spend)}</dd><small>{hasSpend ? `${pct(ratio(ytd.spend, P))} dari ${fmtRpShort(P)}` : 'budget belum diisi'}</small></div>
          <div><dt>CPR riil</dt><dd>{pct(ratio(ytd.spend, ytd.actual), 1)}</dd><small>{hasSpend ? `rencana ${pct(ratio(P, T), 1)} · ROAS ${xOf(ytd.actual, ytd.spend)}` : `ROAS ${xOf(ytd.actual, ytd.spend)}`}</small></div>
          <div className="is-init"><dt>Target awal</dt><dd>{fmtRpShort(I)}</dd><small>{IP != null ? `budget ${fmtRpShort(IP)} · CPR ${pct(ratio(IP, I), 1)}` : 'tanpa budget'}</small></div>
        </dl>

        <div className="ph-chart" role="img" aria-label="Target dan realisasi per bulan">
          <div className="ph-bars">
            {adjS.map((v, i) => {
              const a = actS[i];
              const r = ratio(a, v);
              const tone = a == null ? '' : r >= 1 ? 'is-good' : r >= 0.9 ? 'is-warn' : done(i) ? 'is-bad' : 'is-run';
              return (
                <div key={MONTH_SHORT[i]} className={`ph-col${i === currentIdx ? ' is-now' : ''}`} style={{ '--i': i }} title={`${MONTH_LONG[i]}: target ${fmtRpShort(v)}${a != null ? ` · realisasi ${fmtRpShort(a)} (${pct(r, 0)})` : ''}${updates > 0 ? ` · target awal ${fmtRpShort(initS[i])}` : ''}`}>
                  <span className="ph-pct">{a != null && r != null ? pct(r, 0) : ''}</span>
                  <div className="ph-track">
                    <span className="ph-target" style={{ height: h(v) }} />
                    {a != null && <span className={`ph-real ${tone}`} style={{ height: h(a) }} />}
                    {updates > 0 && initS[i] != null && <span className="ph-init" style={{ bottom: h(initS[i]) }} />}
                  </div>
                  <span className="ph-month">{MONTH_SHORT[i]}</span>
                </div>
              );
            })}
          </div>
          <div className="ph-legend">
            <span><i className="is-target" /> Target adjustment</span>
            <span><i className="is-real" /> Realisasi</span>
            {updates > 0 && <span><i className="is-init" /> Target awal</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// A quarter's or half's figure with its change beside it.
function QVal({ value, note }) {
  return <span className="mt-qv"><b>{value}</b>{note}</span>;
}
// A month's share of the year, with a bar scaled to the largest month.
function Share({ r, max }) {
  if (r == null) return <span className="pt-dim">—</span>;
  return (
    <span className="mt-share">
      <i aria-hidden="true"><em style={{ transform: `scaleX(${Math.min(r / max, 1)})` }} /></i>
      <b>{pct(r, 2)}</b>
    </span>
  );
}

// ── The check under the split being edited ───────────────────────────
// Whether the 12 months add up to the year, said in words: how far over or
// under, in the unit the person is typing, what to do about it, and a
// one-click fix. Simpan stays pressable: pressed too early it points at
// what is still off instead of doing nothing.
const LIST = new Intl.ListFormat('id-ID', { style: 'long', type: 'conjunction' });
const monthsList = (idx) => LIST.format(idx.slice(0, 4).map((i) => MONTH_LONG[i])) + (idx.length > 4 ? ` dan ${idx.length - 4} bulan lain` : '');

function checkOf(kind, mode, side, total, yearRatio) {
  const what = kind === 'sales' ? 'target' : 'budget';
  const r = total ? side.got / total : null;
  if (!side.valid) {
    return { state: 'invalid', r, title: `Isian ${what} ${monthsList(side.bad)} bukan angka`, text: 'Pakai angka saja; desimal dengan koma, misalnya 8,5.' };
  }
  if (side.ok) {
    return { state: 'ok', r: 1, title: 'Pas', text: `12 bulan = ${fmtRp(total)}, sama dengan ${what} setahun.` };
  }
  const diff = side.got - total;
  const over = diff > 0;
  const gap = Math.abs(diff);
  const word = over ? 'lebih' : 'kurang';
  const gapPct = pct(gap / total, 2);
  if (kind === 'spend' && mode === 'cpr') {
    return {
      state: over ? 'over' : 'under', r,
      title: `Budget ${word} ${fmtRpShort(gap)} dari setahun`,
      text: `% alokasi × target = ${fmtRp(side.got)}, budget setahun ${fmtRp(total)}. ${over ? 'Turunkan' : 'Naikkan'} % alokasi di beberapa bulan.`,
    };
  }
  const name = kind === 'sales' ? 'kontribusi' : 'porsi budget';
  return {
    state: over ? 'over' : 'under', r,
    title: mode === 'pct' ? `Total ${name} ${pct(r, 2)}, ${word} ${gapPct}` : `Total ${what} ${word} ${fmtRp(gap)}`,
    text: `12 bulan = ${fmtRp(side.got)}, ${what} setahun ${fmtRp(total)}. ${over ? 'Kurangi' : 'Tambahkan'} ${mode === 'pct' ? gapPct : fmtRp(gap)} di bulan mana saja.`,
  };
}

function SplitCheck({ ed, T, P, saving, onSave, onCancel }) {
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (!nudge) return undefined;
    const id = setTimeout(() => setNudge(0), 700);
    return () => clearTimeout(id);
  }, [nudge]);

  const items = [
    { key: 'sales', label: 'Target revenue', ...checkOf('sales', ed.modes.sales, ed.sales, T, null) },
    ...(ed.hasSpend ? [{ key: 'spend', label: 'Budget iklan', ...checkOf('spend', ed.modes.spend, ed.spend, P, ed.yearRatio) }] : []),
  ];
  const open = items.filter((it) => it.state !== 'ok');
  const changed = !!ed.draft;
  const ready = changed && ed.ok;
  const state = !changed ? 'idle' : ready ? 'ok' : 'blocked';
  const head = {
    idle: ['Belum ada perubahan', 'Ubah angka di kolom kuning. Totalnya dicek di sini setiap kali Anda mengetik.'],
    ok: ['Siap disimpan', `Total 12 bulan sudah pas dengan ${ed.hasSpend ? 'target dan budget' : 'target'} setahun.`],
    blocked: ['Belum bisa disimpan', `${open.map((it) => it.label).join(' dan ')} belum pas 100%.`],
  }[state];

  const press = () => {
    if (saving) return;
    if (ready) onSave();
    else setNudge((n) => n + 1);
  };

  return (
    <div className={`sc is-${state}${nudge ? ' is-nudge' : ''}`} role="region" aria-label="Cek total pembagian">
      <div className="sc-head" aria-live="polite">
        <span className="sc-badge" aria-hidden="true">{state === 'ok' ? <Check size={16} strokeWidth={2.6} /> : state === 'blocked' ? <AlertTriangle size={16} /> : <PencilLine size={15} />}</span>
        <div>
          <b>{head[0]}</b>
          <small>{head[1]}</small>
        </div>
      </div>

      <div className="sc-items">
        {items.map((it) => {
          const fill = it.r == null ? 0 : Math.min(it.r, 1.2) / 1.2;
          return (
            <div key={it.key} className={`sc-item is-${it.state}`}>
              <div className="sc-top">
                <span className="sc-label">{it.label}</span>
                <span className="sc-meter" aria-hidden="true">
                  <i style={{ transform: `scaleX(${fill})` }} />
                  <em title="100%" />
                </span>
                <span className="sc-fig">{it.state === 'invalid' ? '—' : pct(it.r, 2)}</span>
              </div>
              <p><b>{it.title}.</b> {it.text}</p>
              {(it.state === 'over' || it.state === 'under') && (
                <div className="sc-fixes">
                  <button type="button" className="sc-fix" onClick={() => ed.fit(it.key)} disabled={saving}>
                    <Wand2 size={13} aria-hidden="true" /> Jadikan 100%
                  </button>
                  {it.key === 'spend' && ed.modes.spend === 'cpr' && (
                    <button type="button" className="sc-fix is-quiet" onClick={ed.followTarget} disabled={saving}>
                      <Link2 size={13} aria-hidden="true" /> Samakan ke {pct(ed.yearRatio, 2)}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sc-actions">
        <button type="button" className="bp-ghost" onClick={onCancel} disabled={saving}><X size={15} aria-hidden="true" /> Batal</button>
        <button
          type="button" className={`bp-primary sc-save${ready ? '' : ' is-blocked'}`} onClick={press} aria-disabled={!ready || saving || undefined}
          title={ready ? undefined : head[1]}
        >
          {saving ? <Loader2 size={15} className="dt-spin" /> : <Check size={15} />} Simpan
        </button>
      </div>
    </div>
  );
}

// ── One table: its header, then the months down the side ─────────────
// Growth, daily figures and the like hide behind "Kolom detail".
function PlanPanel({ id, tone, title, sub, actions, banner, footer, editing, cols, currentIdx, futureFrom, unit }) {
  const [detail, setDetail] = useState(false);
  const hidden = cols.filter((c) => c.detail).length;
  const shown = cols.filter((c) => detail || !c.detail);
  return (
    <section
      id={`pv-panel-${id}`} role="tabpanel" aria-labelledby={`pv-tab-${id}`}
      className={`ps-sheet is-${tone}${editing ? ' is-editing' : ''}`} aria-label={title}
    >
      <header className="ps-head">
        <div className="ps-title">
          <h3>{title}</h3>
          <p>{sub}</p>
        </div>
        <div className="ps-actions">
          {hidden > 0 && (
            <button type="button" className={`ps-detail${detail ? ' is-on' : ''}`} aria-expanded={detail} onClick={() => setDetail((d) => !d)}>
              <ChevronDown size={14} aria-hidden="true" /> {detail ? 'Sembunyikan detail' : `Kolom detail · ${hidden}`}
            </button>
          )}
          {actions}
        </div>
      </header>
      {banner}
      <div className="ps-scroll">
        <MonthTable cols={shown} detail={detail} currentIdx={currentIdx} futureFrom={futureFrom} unit={unit} />
      </div>
      {footer}
    </section>
  );
}

// Months down, figures across, grouped under Target / Budget headings.
// Each quarter opens with its own totals; the running month is lit.
function MonthTable({ cols, detail, currentIdx, futureFrom = 12, unit }) {
  const groups = [];
  cols.forEach((c) => {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.span += 1;
    else groups.push({ name: c.group, span: 1 });
  });
  const startsGroup = new Set(cols.flatMap((c, k) => (k && c.group !== cols[k - 1].group ? [k] : [])));
  const colCls = (c, k) => `${c.key ? ' is-key' : ''}${c.input ? ' is-input' : ''}${k && startsGroup.has(k) ? ' is-gstart' : ''}`;
  const halves = detail && cols.some((c) => c.h);
  let n = 0;
  return (
    <table className={`mt${unit === 'jt' ? ' is-jt' : ''}`}>
      <thead>
        {groups.length > 1 && (
          <tr className="mt-groups">
            <th aria-hidden="true" className="mt-month" />
            {groups.map((g, k) => <th key={g.name} colSpan={g.span} scope="colgroup" className={k ? 'is-gstart' : ''}><span>{g.name}</span></th>)}
          </tr>
        )}
        <tr className="mt-cols">
          <th scope="col" className="mt-month">Bulan</th>
          {cols.map((c, k) => (
            <th key={c.id} scope="col" className={colCls(c, k)}>
              {c.label}{c.hint && <small>{c.hint}</small>}
            </th>
          ))}
        </tr>
      </thead>
      {QUARTERS.map((q) => (
        <tbody key={q} className="mt-quarter">
          <tr className="mt-q" style={{ '--r': n++ }}>
            <th scope="rowgroup" className="mt-month"><span className="mt-qname">Q{q + 1}</span><small>{MONTH_SHORT[q * 3]}–{MONTH_SHORT[q * 3 + 2]}</small></th>
            {cols.map((c, k) => <td key={c.id} className={colCls(c, k)}>{c.q ? c.q(q) : null}</td>)}
          </tr>
          {[q * 3, q * 3 + 1, q * 3 + 2].map((i) => (
            <tr key={i} className={`mt-m${i === currentIdx ? ' is-now' : ''}${i >= futureFrom ? ' is-future' : ''}`} style={{ '--r': n++ }}>
              <th scope="row" className="mt-month">
                <b>{MONTH_LONG[i]}</b>
                {i === currentIdx && <span className="mt-now">berjalan</span>}
              </th>
              {cols.map((c, k) => <td key={c.id} className={`${colCls(c, k)}${c.tone ? ` ${c.tone(i)}` : ''}`}>{c.cell(i)}</td>)}
            </tr>
          ))}
        </tbody>
      ))}
      <tfoot>
        {halves && [0, 1].map((h) => (
          <tr key={h} className="mt-h">
            <th scope="row" className="mt-month">{h ? 'Semester 2' : 'Semester 1'}<small>{h ? 'Jul–Des' : 'Jan–Jun'}</small></th>
            {cols.map((c, k) => <td key={c.id} className={colCls(c, k)}>{c.h ? c.h(h) : null}</td>)}
          </tr>
        ))}
        <tr className="mt-total">
          <th scope="row" className="mt-month">Total setahun</th>
          {cols.map((c, k) => <td key={c.id} className={colCls(c, k)}>{c.total ?? <span className="pt-dim">—</span>}</td>)}
        </tr>
      </tfoot>
    </table>
  );
}
