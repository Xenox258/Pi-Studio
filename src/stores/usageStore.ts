import { createSignal } from 'solid-js';
import { studioApi } from '../api/invoke';
import type { UsageSnapshot } from '../types';
import { activeSession } from './appStore';

// A single usage snapshot is shared by every view (Usage page + top-bar badge) so they never drift
// apart: one fetch, one cache, one set of numbers. Independent resources previously diverged because
// each held its own copy refreshed on a different schedule.
const [usageSnapshot, setUsageSnapshot] = createSignal<UsageSnapshot | null>(null);
const [usageError, setUsageError] = createSignal('');
const [usageRefreshing, setUsageRefreshing] = createSignal(false);

export { usageSnapshot, usageError, usageRefreshing };

let inflight: Promise<UsageSnapshot | null> | null = null;

export async function refreshUsage(force = false): Promise<UsageSnapshot | null> {
  if (!('__TAURI_INTERNALS__' in window)) {
    setUsageError('Usage is available in the installed OMP Studio application.');
    return null;
  }
  // Coalesce concurrent callers (badge poll + page mount) onto one request, unless a forced refresh
  // must bypass the backend cache.
  if (inflight && !force) return inflight;
  if (force) setUsageRefreshing(true);
  const request = (async () => {
    try {
      const snapshot = await studioApi.usage(activeSession()?.id, force);
      setUsageSnapshot(snapshot);
      setUsageError('');
      return snapshot;
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : 'OMP did not return usage data.');
      return null;
    } finally {
      if (force) setUsageRefreshing(false);
      inflight = null;
    }
  })();
  inflight = request;
  return request;
}
