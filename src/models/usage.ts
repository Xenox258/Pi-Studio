import type { AccountUsage, UsageLimit } from '../types';

/** Human-readable countdown until a limit's window resets, e.g. `Resets in 4d 18h`. */
export function formatReset(resetsAt?: string): string {
  if (!resetsAt) return 'Reset time unavailable';
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return 'Reset time unavailable';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Resetting now';
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = days > 0 ? [`${days}d`, `${hours}h`] : hours > 0 ? [`${hours}h`, `${minutes}m`] : [`${minutes}m`];
  return `Resets in ${parts.join(' ')}`;
}

/** Prefer the short rolling window (5h); fall back to the weekly window when a provider has no 5h meter. */
export function primaryLimit(account: AccountUsage): UsageLimit | undefined {
  const match = (fragment: string) => account.limits.find(limit => limit.id.toLowerCase().includes(fragment) || limit.label.toLowerCase().includes(fragment));
  return match('5h') ?? match('5 hour') ?? match('7d') ?? match('7 day') ?? account.limits[0];
}
