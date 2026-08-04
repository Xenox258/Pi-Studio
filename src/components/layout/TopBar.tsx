import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { ChevronDown, FolderOpen, Gauge, PanelRight } from 'lucide-solid';
import { open } from '@tauri-apps/plugin-dialog';
import { activeModel, activeProject, activeSession, availableModels, rightPanelOpen, setRightPanelOpen, startConfiguredSession } from '../../stores/appStore';
import { studioApi } from '../../api/invoke';
import { IconButton, Popover, ProgressBar } from '../ui';
import { formatReset, primaryLimit } from '../../models/usage';
import { refreshUsage, usageSnapshot } from '../../stores/usageStore';

export default function TopBar() {
  async function chooseProject() {
    const path = await open({ directory: true, multiple: false, title: 'Open project' });
    if (typeof path !== 'string') return;
    await startConfiguredSession(path);
  }
  const [suspendBackground, setSuspendBackground] = createSignal(true);
  onMount(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void studioApi.settings().then(settings => setSuspendBackground(settings.suspendBackground));
    void refreshUsage();
    const refreshAllowed = () => !suspendBackground() || document.visibilityState === 'visible';
    const timer = window.setInterval(() => { if (refreshAllowed()) void refreshUsage(); }, 60_000);
    const visibility = () => { if (document.visibilityState === 'visible') void refreshUsage(); };
    document.addEventListener('visibilitychange', visibility);
    onCleanup(() => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); });
  });
  // The badge tracks the provider that backs the currently selected model, not the worst provider overall.
  const activeProviderId = () => {
    const selector = activeModel();
    if (!selector) return undefined;
    return availableModels().find(model => model.selector === selector)?.provider ?? (selector.split('/')[0] || undefined);
  };
  const activeLimit = () => {
    const provider = usageSnapshot()?.providers.find(item => item.providerId === activeProviderId());
    if (!provider) return undefined;
    const account = provider.accounts.find(item => item.activeForSession) ?? provider.accounts[0];
    return account ? primaryLimit(account) : undefined;
  };
  const activePercent = createMemo(() => { const limit = activeLimit(); return limit ? Math.round(limit.usedPercent) : undefined; });
  const usageFill = () => Math.min(100, Math.max(0, activePercent() ?? 0));
  const usageWarning = () => usageFill() >= 85;

  return <header class="topbar">
    <div class="topbar-context"><strong>{activeSession()?.title ?? 'OMP workspace'}</strong><span>{activeProject()?.name ?? 'No project open'}</span></div>
    <div class="topbar-controls">
      <button class="topbar-action project-switcher" aria-label={activeProject()?.name ? `Open another project · ${activeProject()!.name}` : 'Open a project'} title={activeProject()?.path ?? 'Open a project'} onClick={() => void chooseProject()}><FolderOpen size={16} /><span>Open</span><ChevronDown size={14} /></button>
      <Popover label="Usage summary" trigger={
        <span class={`topbar-usage-trigger ${usageWarning() ? 'is-warning' : ''}`}>
          <Gauge size={14} />
          <span class="topbar-usage-label">Usage</span>
          <span class="topbar-usage-meter" aria-hidden="true"><span style={{ width: `${usageFill()}%` }} /></span>
          <strong>{activePercent() === undefined ? '—' : `${activePercent()}%`}</strong>
        </span>
      }>
        <div class="topbar-usage">
          <strong>Provider usage</strong>
          <For each={usageSnapshot()?.providers ?? []}>{provider => {
            const account = provider.accounts.find(item => item.activeForSession) ?? provider.accounts[0];
            const limit = account && primaryLimit(account);
            return <div class="topbar-usage-row">
              <span>{provider.providerName}</span>
              <Show when={limit} fallback={<em>No usage data</em>}>{value => <>
                <b>{Math.round(value().usedPercent)}%</b>
                <ProgressBar value={value().usedPercent} label={`${provider.providerName} ${value().label}`} tone={value().usedPercent >= 85 ? 'warning' : 'accent'} />
                <small>{value().label} · {formatReset(value().resetsAt)}</small>
              </>}</Show>
            </div>;
          }}</For>
        </div>
      </Popover>
      <span class="topbar-divider" aria-hidden="true" />
      <IconButton class={`topbar-panel-toggle ${rightPanelOpen() ? 'is-active' : ''}`} label={rightPanelOpen() ? 'Hide details panel' : 'Show details panel'} onClick={() => setRightPanelOpen(open => !open)}><PanelRight size={17} /></IconButton>
    </div>
  </header>;
}
