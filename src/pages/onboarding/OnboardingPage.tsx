import { For, Show, createEffect, createMemo, createResource, createSignal, onMount } from 'solid-js';
import { ArrowRight, Check, CircleHelp, ExternalLink, KeyRound, Moon, Search, ShieldCheck, Sparkles, Sun, UserRound } from 'lucide-solid';
import { useNavigate } from '@solidjs/router';
import { Badge, Button, Select, Tabs } from '../../components/ui';
import ProviderLogo from '../../components/providers/ProviderLogo';
import { studioApi } from '../../api/invoke';
import { providerPresentation } from '../../data/providers';
import { resolveEffortConfig } from '../../models/effort';
import { activeModel, availableModels, modelOptions, selectPreferredModel, setPreferredThinkingLevel, thinkingLevel } from '../../stores/appStore';

const setupTabs = [
  { id: 'providers', label: 'Providers' },
  { id: 'signin', label: 'Sign in' },
  { id: 'web', label: 'Web search' },
];

const tabDescriptions: Record<string, string> = {
  providers: 'All model providers reported by OMP.',
  signin: 'Providers that support a browser sign-in flow.',
  web: 'Model providers that can also power OMP web search.',
};

export default function OnboardingPage(props: { onComplete?: () => Promise<void> | void }) {
  const navigate = useNavigate();
  const [step, setStep] = createSignal(1);
  const [selectedProviderId, setSelectedProviderId] = createSignal('');
  const [connected, setConnected] = createSignal(new Set<string>());
  const [disconnected, setDisconnected] = createSignal(new Set<string>());
  const [tab, setTab] = createSignal('providers');
  const [status, setStatus] = createSignal('');
  const [providerQuery, setProviderQuery] = createSignal('');
  const [apiKeyValue, setApiKeyValue] = createSignal('');
  const [useApiKey, setUseApiKey] = createSignal(false);
  const [ompProviders] = createResource(() => '__TAURI_INTERNALS__' in window ? studioApi.providers() : Promise.resolve([]));

  const detectedProviders = createMemo(() => new Set(availableModels().map(model => model.provider)));
  const providers = createMemo(() => {
    const query = providerQuery().trim().toLowerCase();
    return (ompProviders() ?? []).filter(provider => {
      const presentation = providerPresentation(provider.id);
      const matchesTab = tab() === 'providers'
        || (tab() === 'signin' && (presentation.auth === 'oauth' || presentation.auth === 'both'))
        || (tab() === 'web' && presentation.webSearch);
      return matchesTab && (!query || `${provider.name} ${provider.id}`.toLowerCase().includes(query));
    });
  });
  const selectedProvider = createMemo(() => providers().find(provider => provider.id === selectedProviderId()) ?? providers()[0]);
  const selectedPresentation = createMemo(() => providerPresentation(selectedProvider()?.id ?? ''));
  const onboardingEffort = createMemo(() => resolveEffortConfig(availableModels().find(model => model.selector === activeModel()), thinkingLevel()));
  const readyProviderCount = createMemo(() => (ompProviders() ?? []).filter(provider => isProviderReady(provider.id)).length);

  createEffect(() => {
    const first = providers()[0];
    if (!providers().some(provider => provider.id === selectedProviderId())) setSelectedProviderId(first?.id ?? '');
  });

  onMount(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    try {
      const settings = await studioApi.settings();
      if (settings.connectedProviders?.length) setConnected(new Set(settings.connectedProviders));
    } catch {
      // Existing OMP models still provide an independent connected-state signal.
    }
  });

  function isProviderReady(providerId: string) {
    return !disconnected().has(providerId) && (connected().has(providerId) || detectedProviders().has(providerId));
  }

  function chooseProvider(providerId: string) {
    setSelectedProviderId(providerId);
    setApiKeyValue('');
    setUseApiKey(false);
    setStatus('');
  }

  function selectDefaultModel(selector: string) {
    const model = availableModels().find(candidate => candidate.selector === selector);
    if (model) selectPreferredModel(model);
  }

  async function connect() {
    const provider = selectedProvider();
    if (!provider) return;
    setStatus(`Opening ${provider.name} sign in…`);
    try {
      await studioApi.providerLogin(provider.id);
      setConnected(current => new Set([...current, provider.id]));
      setDisconnected(current => { const next = new Set(current); next.delete(provider.id); return next; });
      setStatus(`${provider.name} is connected`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Connection failed');
    }
  }

  async function saveApiKey() {
    const provider = selectedProvider();
    const key = apiKeyValue().trim();
    if (!provider || !key) return;
    setStatus('Saving API key in OMP…');
    try {
      await studioApi.providerApiKeyLogin(provider.id, key);
      setConnected(current => new Set([...current, provider.id]));
      setDisconnected(current => { const next = new Set(current); next.delete(provider.id); return next; });
      setApiKeyValue('');
      setStatus(`${provider.name} API key saved`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'API key login failed');
    }
  }

  async function disconnect() {
    const provider = selectedProvider();
    if (!provider) return;
    setStatus('Disconnecting…');
    try {
      await studioApi.providerLogout(provider.id);
      setConnected(current => { const next = new Set(current); next.delete(provider.id); return next; });
      setDisconnected(current => new Set([...current, provider.id]));
      setStatus(`${provider.name} disconnected`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Disconnect failed');
    }
  }


  async function advance() {
    if (step() < 3) { setStep(step() + 1); return; }
    setStatus('Saving setup…');
    try {
      await props.onComplete?.();
      navigate('/');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save setup');
    }
  }

  return (
    <div class="app onboarding">
      <aside class="onboarding-sidebar">
        <div class="onboarding-brand"><img src="/favicon.svg" alt="" /><span>OMP Studio</span></div>
        <ol>
          <For each={[["Welcome", "Set up your providers"], ["Models", "Select & configure models"], ["Finish", "Review & complete"]]}>
            {(item, index) => <li class={step() === index() + 1 ? 'is-active' : step() > index() + 1 ? 'is-done' : ''}><span>{step() > index() + 1 ? <Check size={14} /> : index() + 1}</span><div><strong>{item[0]}</strong><small>{item[1]}</small></div></li>}
          </For>
        </ol>
        <div class="help-panel"><p><CircleHelp size={16} />Need help?</p><a href="https://omp.sh/docs" target="_blank" rel="noreferrer">Docs <ExternalLink /></a><a href="https://github.com/can1357/oh-my-pi/issues" target="_blank" rel="noreferrer">Support <ExternalLink /></a></div>
        <button class="theme-switch"><Sun /><Moon /><span>Dark</span></button>
      </aside>

      <main class="onboarding-main">
        <header><h1>{step() === 1 ? 'Welcome to OMP Studio' : step() === 2 ? 'Choose your models' : 'Ready to build'}</h1><p>Setup step {step()} of 3</p><div class="step-progress"><i class="is-active" /><i class={step() >= 2 ? 'is-active' : ''} /><i class={step() >= 3 ? 'is-active' : ''} /></div></header>

        <Show when={step() === 1}>
          <section class="provider-setup">
            <div class="provider-list-pane">
              <h2>Set up your providers</h2>
              <p>{tabDescriptions[tab()]}</p>
              <Tabs wide items={setupTabs} value={tab()} onChange={value => { setTab(value); setProviderQuery(''); }} />
              <label class="search-box"><Search /><input placeholder="Search providers…" value={providerQuery()} onInput={event => setProviderQuery(event.currentTarget.value)} /></label>
              <h3>{tab() === 'providers' ? 'Available providers' : tab() === 'signin' ? 'Browser sign in' : 'Web search providers'}</h3>
              <div class="provider-list">
                <Show when={!ompProviders.loading} fallback={<p class="provider-list-empty">Loading providers from OMP…</p>}>
                  <For each={providers()}>{provider => (
                    <button class={selectedProvider()?.id === provider.id ? 'is-selected' : ''} onClick={() => chooseProvider(provider.id)}>
                      <ProviderLogo id={provider.id} name={provider.name} />
                      <span><strong>{provider.name}</strong><small>{provider.id}</small></span>
                      <Show when={isProviderReady(provider.id)}><b class="success">● {providerPresentation(provider.id).auth === 'local' ? 'Available' : 'Logged in'}</b></Show>
                      <ArrowRight />
                    </button>
                  )}</For>
                  <Show when={!providers().length}><p class="provider-list-empty">{ompProviders.error ? ompProviders.error.message : tab() === 'web' ? 'No web-search provider is reported by this OMP installation.' : 'No matching providers reported by OMP.'}</p></Show>
                </Show>
              </div>
            </div>

            <div class="provider-detail-pane">
              <Show when={selectedProvider()} fallback={<section class="provider-card provider-card--empty">Select a provider to view setup options.</section>}>
                {provider => (
                  <section class="provider-card">
                    <header>
                      <ProviderLogo id={provider().id} name={provider().name} size="large" />
                      <div><h2>{provider().name}</h2><p>{provider().id}</p></div>
                      <Badge tone={isProviderReady(provider().id) ? 'success' : 'default'}>{isProviderReady(provider().id) ? (selectedPresentation().auth === 'local' ? '● Available' : '● Logged in') : 'Setup required'}</Badge>
                    </header>
                    <h3>{selectedPresentation().auth === 'local' ? 'Local provider' : selectedPresentation().auth === 'api-key' ? 'API key authentication' : 'OMP authentication'}</h3>
                    <p>{selectedPresentation().auth === 'local' ? `${provider().name} is detected automatically when its local endpoint is available.` : `Credentials are stored and refreshed by OMP; OMP Studio never reads the secret value back.`}</p>
                    <div class="capability-row"><span><ShieldCheck />OMP credential vault</span><Show when={selectedPresentation().webSearch}><span><Search />Web search capable</span></Show><span><Sparkles />Live model catalog</span></div>

                    <div class={`connection-status ${isProviderReady(provider().id) ? 'is-ready' : ''}`}>
                      {isProviderReady(provider().id) ? <ShieldCheck /> : <KeyRound />}
                      <span><strong>{isProviderReady(provider().id) ? (selectedPresentation().auth === 'local' ? 'Available in OMP' : 'Connected in OMP') : (selectedPresentation().auth === 'local' ? 'Local endpoint not detected' : 'Authentication required')}</strong><small>{isProviderReady(provider().id) ? 'At least one model from this provider is available, or it was connected in OMP Studio.' : (selectedPresentation().auth === 'api-key' ? 'Enter an API key below to make this provider available.' : 'Complete sign in to make its models available.')}</small></span>
                    </div>

                    <Show when={!isProviderReady(provider().id) && selectedPresentation().auth !== 'local'}>
                      <h3>Connect {provider().name}</h3>
                      <Show when={selectedPresentation().auth === 'oauth' || (selectedPresentation().auth === 'both' && !useApiKey())}>
                        <div class="provider-actions provider-actions--signin"><Button variant="solid" tone="accent" onClick={() => void connect()}>Sign in with {provider().name}</Button><Show when={selectedPresentation().auth === 'both'}><button class="api-key-toggle" onClick={() => setUseApiKey(true)}>Use an API key instead</button></Show></div>
                      </Show>
                      <Show when={selectedPresentation().auth === 'api-key' || (selectedPresentation().auth === 'both' && useApiKey())}>
                        <div class="api-key-form">
                          <label><span>API key</span><input type="password" autocomplete="off" placeholder="Paste API key" value={apiKeyValue()} onInput={event => setApiKeyValue(event.currentTarget.value)} /></label>
                          <div><Button variant="solid" tone="accent" disabled={!apiKeyValue().trim()} onClick={() => void saveApiKey()}>Save API key</Button><Show when={selectedPresentation().auth === 'both'}><button class="api-key-toggle" onClick={() => setUseApiKey(false)}>Use browser sign in</button></Show></div>
                          <Show when={selectedPresentation().apiKeyUrl}>{url => <a class="api-key-link" href={url()} target="_blank" rel="noreferrer">Find your API key on {provider().name} <ExternalLink /></a>}</Show>
                        </div>
                      </Show>
                    </Show>
                    <Show when={isProviderReady(provider().id) && selectedPresentation().auth !== 'local'}><div class="provider-actions provider-actions--disconnect"><Button tone="danger" onClick={() => void disconnect()}>Disconnect {provider().name}</Button></div></Show>
                    <Show when={status()}><small class="provider-status" role="status">{status()}</small></Show>
                  </section>
                )}
              </Show>
            </div>
          </section>
        </Show>

        <Show when={step() === 2}><section class="onboarding-models"><h2>Default model</h2><p>Choose a reliable model for everyday work. You can configure each role later.</p><Show when={modelOptions().length} fallback={<p>No models are currently reported by OMP. Configure a provider, then restart setup.</p>}><Select label="Default model" value={activeModel()} onChange={selectDefaultModel} options={modelOptions()} /></Show><h2>Thinking level</h2><Select label="Thinking level" value={onboardingEffort().selectedValue} onChange={setPreferredThinkingLevel} options={onboardingEffort().options.map(option => ({ value: option.value, label: option.label }))} /></section></Show>
        <Show when={step() === 3}><section class="onboarding-finish"><span><Check /></span><h2>OMP Studio is configured</h2><p>{readyProviderCount()} provider{readyProviderCount() === 1 ? '' : 's'} available; your default model is ready.</p><ul><li><UserRound />Provider credentials remain in OMP</li><li><ShieldCheck />Economy process policy enabled</li><li><Sparkles />Plan and Advisor ready</li></ul></section></Show>
        <footer class="onboarding-footer"><Button disabled={step() === 1} onClick={() => setStep(step() - 1)}>Back</Button><Button variant="solid" tone="accent" onClick={() => void advance()}>{step() === 3 ? 'Open OMP Studio' : 'Continue'} <ArrowRight /></Button></footer>
      </main>
    </div>
  );
}
