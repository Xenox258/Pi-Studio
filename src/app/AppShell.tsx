import { Show, Suspense, onCleanup, onMount, type JSX } from 'solid-js';
import { Loader2 } from 'lucide-solid';
import Sidebar from '../components/layout/Sidebar';
import TopBar from '../components/layout/TopBar';
import { setRightPanelOpen } from '../stores/appStore';
import { catalogNavigationMode, type CatalogMode } from '../stores/catalogLoadingStore';

const catalogModeLabels: Record<CatalogMode, string> = { discover: 'Discover', installed: 'Installed', updates: 'Updates', errors: 'Plugin errors' };

export default function AppShell(props: { children?: JSX.Element }) {
  onMount(() => {
    const compact = window.matchMedia('(max-width: 1100px)');
    const sync = () => setRightPanelOpen(document.visibilityState === 'visible' && !compact.matches);
    sync();
    compact.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    onCleanup(() => { compact.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync); });
  });
  return <div class="app app-shell"><Sidebar /><div class="app-column"><TopBar /><main class="page-host"><Show when={catalogNavigationMode()}>{mode => <div class="page-transition-status" role="status" aria-live="polite" aria-atomic="true"><Loader2 size={24} class="loading-status__spinner" aria-hidden="true" /><strong>{`Loading ${catalogModeLabels[mode()]} catalog…`}</strong><span>Fetching Pi packages and marketplaces</span></div>}</Show><Suspense fallback={<div class="page-loading" role="status" aria-live="polite"><div class="loading-status"><Loader2 size={15} class="loading-status__spinner" aria-hidden="true" /><span>Loading page…</span></div></div>}>{props.children}</Suspense></main></div></div>;
}
