import { For, Show, createSignal, onMount } from 'solid-js';
import { Clock3, RefreshCw, ShieldCheck } from 'lucide-solid';
import { studioApi } from '../../api/invoke';
import { Button, Dialog, EmptyState, ProgressBar } from '../../components/ui';
import ProviderLogo from '../../components/providers/ProviderLogo';
import type { AccountUsage } from '../../types';
import { formatReset } from '../../models/usage';
import { refreshUsage, usageError, usageRefreshing, usageSnapshot } from '../../stores/usageStore';

export default function UsagePage() {
  const [confirming, setConfirming] = createSignal<AccountUsage | null>(null);
  const [resetState, setResetState] = createSignal<Record<string, string>>({});

  // The badge poller (always-mounted top bar) owns periodic refresh; opening this page just pulls once
  // more so a freshly navigated view is current. Both read the one shared snapshot, so they never drift.
  onMount(() => { void refreshUsage(); });

  const accounts = () => usageSnapshot()?.providers.flatMap(provider => provider.accounts.map(account => ({ provider, account }))) ?? [];
  const applicableCredit = (account: AccountUsage) => account.resetCredits?.credits.find(credit => credit.applicable);
  const setAccountResetState = (credentialId: string, message: string) => setResetState(prev => ({ ...prev, [credentialId]: message }));
  // The org label is noise when OMP derives it from the account email (`<email>'s Organization`).
  const orgLabel = (account: AccountUsage) => account.organizationLabel && !account.organizationLabel.startsWith(account.displayLabel) ? account.organizationLabel : undefined;

  async function consumeReset() {
    const account = confirming();
    const credit = account && applicableCredit(account);
    if (!account || !credit) {
      if (account) setAccountResetState(account.credentialId, 'No applicable saved reset is available.');
      setConfirming(null);
      return;
    }
    setAccountResetState(account.credentialId, 'Submitting…');
    setConfirming(null);
    try {
      const result = await studioApi.consumeReset(account.credentialId, credit.id, crypto.randomUUID());
      setAccountResetState(account.credentialId, result);
      await refreshUsage(true);
    } catch (error) {
      setAccountResetState(account.credentialId, error instanceof Error ? error.message : 'Reset failed');
    }
  }

  return <div class="page usage-page">
    <header class="page-heading usage-heading">
      <div><h1>Usage & limits</h1><p>Every connected account is shown at once; provider limits are never combined.</p></div>
      <Button disabled={usageRefreshing()} onClick={() => void refreshUsage(true)}><RefreshCw class={usageRefreshing() ? 'spin' : ''} size={16} />{usageRefreshing() ? 'Refreshing…' : 'Refresh'}</Button>
    </header>
    <Show when={usageSnapshot()} fallback={<Show when={usageError()} fallback={<div class="usage-skeleton" />}><EmptyState title="Usage unavailable" message={usageError()} /></Show>}>
      <Show when={accounts().length > 0} fallback={<EmptyState title="Usage unavailable" message="Connect a subscription provider to see account limits." />}>
        <div class="usage-list">
          <For each={accounts()}>{({ provider, account }) => <section class="usage-account">
            <div class="usage-account__head">
              <ProviderLogo id={provider.providerId} name={provider.providerName} size="large" />
              <div class="usage-account__id"><h2>{provider.providerName}</h2><p>{account.displayLabel}</p><Show when={orgLabel(account)}>{label => <small>{label()}</small>}</Show></div>
              <Show when={usageSnapshot()!.stale || account.activeForSession}><span class={`usage-tag${account.activeForSession && !usageSnapshot()!.stale ? ' usage-tag--active' : ''}`}>{usageSnapshot()!.stale ? 'Stale data' : 'Active session'}</span></Show>
            </div>
            <Show when={account.limits.length > 0} fallback={<p class="usage-empty">No limits reported for this account.</p>}>
              <div class="usage-limits">
                <For each={account.limits}>{limit => <div class="usage-limit">
                  <div class="usage-limit__row"><span class="usage-limit__label">{limit.label}</span><span class="usage-limit__pct">{Math.round(limit.usedPercent)}%</span></div>
                  <ProgressBar label={limit.label} value={limit.usedPercent} tone={limit.usedPercent >= 85 ? 'warning' : 'accent'} />
                  <span class="usage-limit__reset">{formatReset(limit.resetsAt)}</span>
                </div>}</For>
              </div>
            </Show>
            <Show when={(account.resetCredits?.available ?? 0) > 0 || applicableCredit(account)}>
              <div class="usage-resets">
                <span><strong>{account.resetCredits?.available ?? 0}</strong>saved resets available</span>
                <Button disabled={!applicableCredit(account)} onClick={() => setConfirming(account)} variant="solid" tone="accent">Use a saved reset</Button>
                <Show when={resetState()[account.credentialId]}><small>{resetState()[account.credentialId]}</small></Show>
              </div>
            </Show>
          </section>}</For>
        </div>
        <p class="usage-source"><span><ShieldCheck size={14} /> Credentials managed by OMP</span><span class="sep">·</span><span><Clock3 size={14} /> Updated {new Date(usageSnapshot()!.fetchedAt).toLocaleTimeString()}</span><span class="sep">·</span><span>Source: {usageSnapshot()!.source}</span></p>
      </Show>
    </Show>
    <Dialog open={!!confirming()} title="Use one saved rate-limit reset?" onClose={() => setConfirming(null)} actions={<><Button onClick={() => setConfirming(null)}>Cancel</Button><Button variant="solid" tone="danger" onClick={consumeReset}>Use reset</Button></>}>
      <div class="reset-dialog-copy"><dl><dt>Account</dt><dd>{confirming()?.displayLabel}</dd><dt>Saved resets</dt><dd>{confirming()?.resetCredits?.available ?? 0} available</dd></dl><p>This action consumes one saved reset and cannot be undone.</p></div>
    </Dialog>
  </div>;
}
