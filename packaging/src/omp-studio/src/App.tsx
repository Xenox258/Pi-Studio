import { Show, createEffect, createResource, lazy, type JSX } from 'solid-js';
import { Navigate, Route, Router } from '@solidjs/router';
import AppShell from './app/AppShell';
import { studioApi } from './api/invoke';
import { applyModelCatalog } from './stores/appStore';
import type { StudioSettings } from './types';

const WorkspacePage = lazy(() => import('./pages/workspace/WorkspacePage'));
const ModelsRolesPage = lazy(() => import('./pages/models/ModelsRolesPage'));
const EcosystemPage = lazy(() => import('./pages/ecosystem/EcosystemPage'));
const UsagePage = lazy(() => import('./pages/usage/UsagePage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const OnboardingPage = lazy(() => import('./pages/onboarding/OnboardingPage'));
const browserSettings: StudioSettings = { processPolicy: 'Economy', suspendBackground: true, cacheLimitMb: 100, onboardingCompleted: true };

export default function App() {
  const isTauri = '__TAURI_INTERNALS__' in window;
  const [settings, { mutate: setSettings }] = createResource(() => isTauri ? studioApi.settings() : Promise.resolve(browserSettings));
  const [models] = createResource(() => isTauri ? studioApi.models() : Promise.resolve([]));
  createEffect(() => { const catalog = models(); if (catalog) applyModelCatalog(catalog); });
  async function completeOnboarding() {
    const next = { ...(settings() ?? browserSettings), onboardingCompleted: true };
    if (isTauri) await studioApi.saveSettings(next);
    setSettings(next);
  }
  function ProtectedShell(props: { children?: JSX.Element }) {
    return <Show when={!settings.loading} fallback={<div class="app">Loading OMP Studio…</div>}><Show when={settings()?.onboardingCompleted} fallback={<Navigate href="/onboarding" />}><AppShell>{props.children}</AppShell></Show></Show>;
  }
  return <Router><Route path="/onboarding" component={() => <OnboardingPage onComplete={completeOnboarding} />} /><Route path="/providers" component={() => <OnboardingPage onComplete={completeOnboarding} />} /><Route path="/" component={ProtectedShell}><Route path="/" component={WorkspacePage} /><Route path="/models" component={ModelsRolesPage} /><Route path="/usage" component={UsagePage} /><Route path="/discover" component={() => <EcosystemPage mode="discover" />} /><Route path="/installed" component={() => <EcosystemPage mode="installed" />} /><Route path="/updates" component={() => <EcosystemPage mode="updates" />} /><Route path="/local" component={() => <EcosystemPage mode="local" />} /><Route path="/settings" component={SettingsPage} /></Route></Router>;
}
