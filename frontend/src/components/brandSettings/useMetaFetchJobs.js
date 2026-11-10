import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';

// The brand's Meta Ads pulls ("Tarik sekarang"), as the server reads them
// from the runs Apps Script reports (GET /meta-ads-insights/fetch-status).
// Shared by the Data Collection Hub grid (cells being pulled, the month
// that just arrived) and the auto-fetch panel (the progress card), so both
// show the same pull to everyone working on the brand.
//
// Watched every few seconds while a pull is going, and not at all while the
// tab is hidden. `onSettled(job)` fires once when a pull this page saw
// running comes to an end — done or failed.
const ACTIVE_MS = 4000;
const IDLE_MS = 60000;

export default function useMetaFetchJobs(brandId, { enabled = true, onSettled } = {}) {
  const [state, setState] = useState({ jobs: [], queue: null, tracked: false, loaded: false });
  const timer = useRef(null);
  const seenActive = useRef(new Set());
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!brandId || !enabled) return null;
    try {
      const { data } = await api.get('/meta-ads-insights/fetch-status', { params: { brandId } });
      if (!alive.current) return null;
      for (const job of data.jobs) {
        if (job.active) seenActive.current.add(job.id);
        else if (seenActive.current.delete(job.id)) settled.current?.(job);
      }
      setState({ ...data, loaded: true });
      return data;
    } catch {
      // No access, or the server is busy: the page works without it.
      if (alive.current) setState((s) => ({ ...s, loaded: true }));
      return null;
    }
  }, [brandId, enabled]);

  const schedule = useCallback((data) => {
    clearTimeout(timer.current);
    if (document.hidden) return;
    const busy = data?.jobs?.some((j) => j.active);
    timer.current = setTimeout(async () => schedule(await load()), busy ? ACTIVE_MS : IDLE_MS);
  }, [load]);

  const refresh = useCallback(async () => {
    const data = await load();
    schedule(data);
    return data;
  }, [load, schedule]);

  useEffect(() => {
    alive.current = true;
    seenActive.current = new Set();
    setState({ jobs: [], queue: null, tracked: false, loaded: false });
    refresh();
    const onVisible = () => { if (!document.hidden) refresh(); else clearTimeout(timer.current); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { ...state, refresh };
}

// The Performance Database rows a pull writes to.
export const channelsOf = (accountType) => (accountType === 'CPAS' ? ['cpas'] : ['boost', 'nonboost']);
