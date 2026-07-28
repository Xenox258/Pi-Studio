import { onCleanup, onMount, type JSX } from 'solid-js';
import Sidebar from '../components/layout/Sidebar';
import TopBar from '../components/layout/TopBar';
import { setRightPanelOpen } from '../stores/appStore';

export default function AppShell(props: { children?: JSX.Element }) {
  onMount(() => {
    const compact = window.matchMedia('(max-width: 1100px)');
    const sync = () => setRightPanelOpen(document.visibilityState === 'visible' && !compact.matches);
    sync();
    compact.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    onCleanup(() => { compact.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync); });
  });
  return <div class="app app-shell"><Sidebar /><div class="app-column"><TopBar /><main class="page-host">{props.children}</main></div></div>;
}
