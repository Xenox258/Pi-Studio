import { Show, children, createEffect, createResource, lazy, onCleanup, type JSX } from 'solid-js';
import { Box, Loader2 } from 'lucide-solid';
import { Navigate, Route, Router } from '@solidjs/router';
import AppShell from './app/AppShell';
import { studioApi } from './api/invoke';
import { bootstrapModelCatalog } from './stores/appStore';
import type { StudioSettings } from './types';

const WorkspacePage = lazy(() => import('./pages/workspace/WorkspacePage'));
const ModelsRolesPage = lazy(() => import('./pages/models/ModelsRolesPage'));
const EcosystemPage = lazy(() => import('./pages/ecosystem/EcosystemPage'));
const UsagePage = lazy(() => import('./pages/usage/UsagePage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const OnboardingPage = lazy(() => import('./pages/onboarding/OnboardingPage'));
const browserSettings: StudioSettings = { processPolicy: 'Economy', suspendBackground: true, cacheLimitMb: 100, onboardingCompleted: true, connectedProviders: [] };

let guiInteractiveLogged = false;


export default function App() {
  const isTauri = '__TAURI_INTERNALS__' in window;
  const [settings, { mutate: setSettings }] = createResource(() => isTauri ? studioApi.settings() : Promise.resolve(browserSettings));
  if (isTauri) void bootstrapModelCatalog().catch(() => undefined);
  async function completeOnboarding() {
    const next = { ...(settings() ?? browserSettings), onboardingCompleted: true };
    if (isTauri) await studioApi.saveSettings(next);
    setSettings(next);
  }
  function ProtectedShell(props: { children?: JSX.Element }) {
    const routeChildren = children(() => props.children);
    let firstFrame: number | undefined;
    let secondFrame: number | undefined;

    createEffect(() => {
      if (!import.meta.env.DEV || guiInteractiveLogged || firstFrame !== undefined || secondFrame !== undefined || settings.loading || !settings()?.onboardingCompleted) return;
      firstFrame = requestAnimationFrame(() => {
        firstFrame = undefined;
        secondFrame = requestAnimationFrame(() => {
          secondFrame = undefined;
          if (guiInteractiveLogged) return;
          guiInteractiveLogged = true;
          console.info(`[startup] gui-interactive: ${Math.round(performance.now())} ms`);
        });
      });
    });

    onCleanup(() => {
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    });

    return <Show when={!settings.loading} fallback={<div class="app startup-loading" role="status" aria-live="polite"><div class="startup-loading__content"><div class="loading-brand"><Box size={28} aria-hidden="true" /><strong>OMP Studio</strong></div><div class="loading-status"><Loader2 size={15} class="loading-status__spinner" aria-hidden="true" /><span>Starting workspace…</span></div></div></div>}><Show when={settings()?.onboardingCompleted} fallback={<Navigate href="/onboarding" />}><AppShell>{routeChildren()}</AppShell></Show></Show>;
  }
  return <Router><Route path="/onboarding" component={() => <OnboardingPage onComplete={completeOnboarding} />} /><Route path="/providers" component={() => <OnboardingPage onComplete={completeOnboarding} />} /><Route path="/" component={ProtectedShell}><Route path="/" component={WorkspacePage} /><Route path="/models" component={ModelsRolesPage} /><Route path="/usage" component={UsagePage} /><Route path="/discover" component={() => <EcosystemPage mode="discover" />} /><Route path="/installed" component={() => <EcosystemPage mode="installed" />} /><Route path="/updates" component={() => <EcosystemPage mode="updates" />} /><Route path="/local" component={() => <EcosystemPage mode="local" />} /><Route path="/settings" component={SettingsPage} /></Route></Router>;
}
