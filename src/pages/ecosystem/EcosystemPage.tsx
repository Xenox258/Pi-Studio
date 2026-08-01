import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { AlertCircle, Box, Check, Download, Folder, Loader, Loader2, Search, ShieldCheck, Sparkles, X, Zap } from 'lucide-solid';
import type { PackageInfo } from '../../types';
import { Badge, Button, Panel, Tabs, VirtualList } from '../../components/ui';
import Markdown from '../../components/ui/Markdown';
import { studioApi } from '../../api/invoke';
import { activeProject } from '../../stores/appStore';
import { beginCatalogLoading, catalogModeLoading, catalogUpdatesState, setCatalogNavigationPending, setCatalogUpdatesState, type CatalogMode } from '../../stores/catalogLoadingStore';

type Mode = CatalogMode;
type Action = 'install' | 'uninstall' | 'upgrade';
type Status = { kind: 'progress' | 'success' | 'error'; text: string };
const kinds = ['All', 'Extensions', 'Skills', 'Prompts', 'Themes', 'Packages'];
const actionVerb: Record<Action, string> = { install: 'Installing', uninstall: 'Removing', upgrade: 'Updating' };
const actionDone: Record<Action, string> = { install: 'installed', uninstall: 'removed', upgrade: 'updated' };

const catalogModes: readonly Mode[] = ['discover', 'installed', 'updates', 'local'];
const catalogModeLabels: Record<Mode, string> = { discover: 'Discover', installed: 'Installed', updates: 'Updates', local: 'Local resources' };
const emptyCatalog: PackageInfo[] = [];
const catalogCache = new Map<Mode, PackageInfo[]>();
const catalogInFlight = new Map<Mode, Promise<PackageInfo[]>>();
let catalogGeneration = 0;

function loadCatalog(mode: Mode): PackageInfo[] | Promise<PackageInfo[]> {
  const cached = catalogCache.get(mode);
  if (cached) {
    if (mode === 'updates') setCatalogUpdatesState({ kind: 'ready', count: cached.length });
    setCatalogNavigationPending(mode, false);
    return cached;
  }

  const inFlight = catalogInFlight.get(mode);
  if (inFlight) return inFlight;

  if (!('__TAURI_INTERNALS__' in window)) {
    if (mode === 'updates') setCatalogUpdatesState({ kind: 'unknown' });
    setCatalogNavigationPending(mode, false);
    return emptyCatalog;
  }

  const generation = catalogGeneration;
  if (mode === 'updates') setCatalogUpdatesState({ kind: 'loading' });
  const request = (async () => {
    try {
      const packages = await studioApi.catalog(mode);
      if (generation === catalogGeneration) {
        catalogCache.set(mode, packages);
        if (mode === 'updates') setCatalogUpdatesState({ kind: 'ready', count: packages.length });
      }
      return packages;
    } catch (error) {
      if (generation === catalogGeneration && mode === 'updates') {
        const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'OMP could not check configured marketplaces.';
        setCatalogUpdatesState({ kind: 'error', message });
      }
      throw error;
    }
  })();
  catalogInFlight.set(mode, request);
  const clearLoading = beginCatalogLoading(mode);

  const clearRequest = () => {
    if (catalogInFlight.get(mode) === request) catalogInFlight.delete(mode);
    clearLoading();
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

function warmCatalog(currentMode: Mode): void {
  const requests: Array<PackageInfo[] | Promise<PackageInfo[]>> = [];
  for (const mode of catalogModes) {
    if (mode !== currentMode) requests.push(loadCatalog(mode));
  }
  void Promise.allSettled(requests);
}

function invalidateCatalogCache(): void {
  catalogGeneration += 1;
  catalogCache.clear();
  catalogInFlight.clear();
  setCatalogUpdatesState({ kind: 'unknown' });
}

// npm READMEs are raw markdown that often open with HTML badge/logo blocks. Our Markdown renderer shows
// unknown tags as literal text, so strip HTML outside fenced code while preserving the prose and code.
function cleanReadme(source: string): string {
  return source.split(/(```[\s\S]*?```)/g).map((segment, index) => index % 2 === 1 ? segment : segment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|picture)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|table|thead|tbody|tr|section|blockquote|pre)>/gi, '\n')
    .replace(/<[^>\n]+>/g, ''),
  ).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function matchesKind(item: PackageInfo, selectedKind: string): boolean {
  const matches = (value: string) => value === selectedKind || `${value}s` === selectedKind;
  return selectedKind === 'All' || matches(item.kind) || item.resources.some(resource => matches(resource.type));
}

function PackageGlyph(props: { item: PackageInfo }) { return <span class={`catalog-icon catalog-icon--${props.item.kind.toLowerCase()}`}>{props.item.kind === 'Skill' ? <Zap /> : props.item.kind === 'Theme' ? <Sparkles /> : <Box />}</span>; }

function DiscoverCard(props: { item: PackageInfo; selected: boolean; busy: string; onSelect: () => void; onInstall: () => void }) {
  const installing = () => props.busy === `install:${props.item.id}`;
  return <button class={`discover-card ${props.selected ? 'is-selected' : ''}`} onClick={() => props.onSelect()}>
    <div class="discover-card__head"><PackageGlyph item={props.item} /><span><strong>{props.item.name}</strong><em>{props.item.author || 'Unknown author'}</em></span><Show when={props.item.updateAvailable}><Badge tone="warning">Update available</Badge></Show><Badge tone="accent">{props.item.kind}</Badge></div>
    <p class="discover-card__desc">{props.item.description || 'No description reported'}</p>
    <div class="discover-card__foot"><span class="download-copy">{props.item.downloads ? `↓ ${props.item.downloads}` : 'Downloads not reported'}</span><Button variant="solid" tone="accent" disabled={props.item.installed || installing()} onClick={event => { event.stopPropagation(); props.onInstall(); }}>{installing() ? 'Installing…' : props.item.installed ? 'Installed' : 'Install'}</Button></div>
  </button>;
}

function PackageDetail(props: { item: PackageInfo; scope: 'user' | 'project'; busy: string; readme: string; readmeLoading: boolean; onScope: (scope: 'user' | 'project') => void; onAction: (action: Action) => void }) {
  const pending = (action: Action) => props.busy === `${action}:${props.item.id}`;
  return <aside class="package-detail"><header><PackageGlyph item={props.item} /><div><h2>{props.item.name} <Check size={15} class="accent" /></h2><div><Badge tone="accent">{props.item.kind}</Badge><Show when={props.item.updateAvailable}><Badge tone="warning">Update available</Badge></Show></div></div><Badge>v{props.item.version}</Badge></header><p>{props.item.description || 'No description reported by OMP.'}</p><Show when={props.item.downloads}><div class="package-stats"><span><Download />{props.item.downloads}</span></div></Show><section><h3>Compatibility</h3><div class="badge-row"><Badge tone={props.item.compatibility === 'Not reported' ? 'default' : 'success'}>{props.item.compatibility}</Badge></div></section><Show when={props.item.resources.length}><section><h3>Includes</h3><div class="resource-grid"><For each={props.item.resources}>{resource => <div><Box size={15} /><span>{resource.type}</span><b>{resource.count}</b></div>}</For></div></section></Show><section><h3>Install scope</h3><div class="scope-options"><button class={props.scope === 'user' ? 'is-selected' : ''} onClick={() => props.onScope('user')}><i />User<small>Available across all projects</small></button><button class={props.scope === 'project' ? 'is-selected' : ''} disabled={!activeProject()} onClick={() => props.onScope('project')}><i />Project<small>{activeProject() ? 'Install only in current project' : 'Open a project first'}</small></button></div></section><div class="detail-actions"><Show when={props.item.installed} fallback={<Button variant="solid" tone="accent" disabled={pending('install')} onClick={() => props.onAction('install')}>{pending('install') ? 'Installing…' : 'Install'}</Button>}><Button tone="danger" disabled={pending('uninstall')} onClick={() => props.onAction('uninstall')}>{pending('uninstall') ? 'Removing…' : 'Remove'}</Button><Show when={props.item.updateAvailable}><Button variant="solid" tone="accent" disabled={pending('upgrade')} onClick={() => props.onAction('upgrade')}>{pending('upgrade') ? 'Updating…' : 'Update'}</Button></Show></Show></div><Show when={props.item.permissions.length}><section><h3>Permissions</h3><div class="badge-row"><For each={props.item.permissions}>{permission => <Badge>{permission}</Badge>}</For></div></section></Show><Show when={props.readmeLoading || props.readme}><section class="package-readme"><h3>Readme</h3><Show when={!props.readmeLoading} fallback={<p class="package-readme__status">Loading readme…</p>}><Markdown source={cleanReadme(props.readme)} /></Show></section></Show></aside>;
}

export default function EcosystemPage(props: { mode: Mode }) {
  const navigate = useNavigate();
  const [catalog, { refetch }] = createResource(() => props.mode, loadCatalog);
  const [marketplaces, { refetch: refetchMarketplaces }] = createResource(() => props.mode === 'discover', discover => discover && '__TAURI_INTERNALS__' in window ? studioApi.marketplaces() : Promise.resolve([]));
  createEffect(() => warmCatalog(props.mode));
  const [kind, setKind] = createSignal('All'); const [query, setQuery] = createSignal(''); const [selected, setSelected] = createSignal<PackageInfo>(); const [scope, setScope] = createSignal<'user' | 'project'>('user'); const [status, setStatus] = createSignal<Status | null>(null); const [marketplaceSource, setMarketplaceSource] = createSignal(''); const [busy, setBusy] = createSignal('');
  let statusTimer: number | undefined;
  createEffect(() => { const items = catalog(); if (items?.length && !items.some(item => item.id === selected()?.id)) setSelected(items[0]); });
  // Readmes are fetched from the npm registry on demand for the selected discover package only.
  const [readme] = createResource(() => props.mode === 'discover' ? selected()?.id : undefined, id => id && '__TAURI_INTERNALS__' in window ? studioApi.catalogReadme(id).catch(() => '') : Promise.resolve(''));
  const visible = createMemo(() => (catalog() ?? []).filter(item => matchesKind(item, kind()) && `${item.name} ${item.description} ${item.author}`.toLowerCase().includes(query().toLowerCase())));
  // Discover renders a virtualized two-column grid: each virtual row holds a pair of package cards.
  const rows = createMemo(() => { const list = visible(); const paired: PackageInfo[][] = []; for (let index = 0; index < list.length; index += 2) paired.push(list.slice(index, index + 2)); return paired; });
  const installedMode = () => props.mode !== 'discover';
  const catalogLoading = () => catalogModeLoading(props.mode) || catalog.loading;
  const modes = () => [{ id: 'discover', label: 'Discover' }, { id: 'installed', label: 'Installed' }, { id: 'updates', label: 'Updates', count: knownUpdatesCount() }, { id: 'local', label: 'Local resources' }];
  const updatesSummary = () => {
    const state = catalogUpdatesState();
    if (state.kind === 'loading') return 'Checking for package updates…';
    if (state.kind === 'error') return `Update check failed: ${state.message}`;
    if (state.kind === 'ready') return state.count === 0 ? 'No updates available' : `${state.count} ${state.count === 1 ? 'update' : 'updates'} available`;
    return 'Package update status is available in the installed OMP Studio app.';
  };
  const knownUpdatesCount = () => { const state = catalogUpdatesState(); return state.kind === 'ready' ? state.count : undefined; };
  // One status line pinned to the bottom: green while working, green check on success, red on failure.
  function report(kind: Status['kind'], text: string) { clearTimeout(statusTimer); setStatus({ kind, text }); if (kind === 'success') statusTimer = window.setTimeout(() => setStatus(null), 5_000); }
  async function manage(item: PackageInfo, action: Action) {
    if (busy()) return;
    setBusy(`${action}:${item.id}`); report('progress', `${actionVerb[action]} ${item.name}…`);
    try {
      await studioApi.managePackage(item.id, action, scope(), activeProject()?.path);
      invalidateCatalogCache();
      await refetch();
      report('success', `${item.name} ${actionDone[action]}`);
    } catch (error) {
      report('error', `${item.name}: ${error instanceof Error ? error.message : typeof error === 'string' ? error : 'package action failed'}`);
    } finally {
      setBusy('');
    }
  }
  async function addMarketplace() { const source = marketplaceSource().trim(); if (!source) return; try { report('progress', 'Adding marketplace…'); await studioApi.addMarketplace(source); setMarketplaceSource(''); invalidateCatalogCache(); await refetchMarketplaces(); await refetch(); report('success', 'Marketplace added'); } catch (error) { report('error', error instanceof Error ? error.message : 'Unable to add marketplace'); } }
  return <div class={`ecosystem-page ${installedMode() ? 'ecosystem-page--installed' : ''}`}><section class="catalog-main page"><header class="page-heading"><h1>{props.mode === 'discover' ? 'Pi Catalog' : props.mode === 'updates' ? 'Package updates' : props.mode === 'local' ? 'Local resources' : 'Installed resources'}</h1><p>{installedMode() ? 'Manage resources reported by your OMP installation.' : 'Discover packages published for the Pi ecosystem.'}</p><Show when={props.mode === 'updates'}><p class={`catalog-update-summary catalog-update-summary--${catalogUpdatesState().kind}`} role={catalogUpdatesState().kind === 'error' ? 'alert' : 'status'} aria-live="polite">{updatesSummary()}</p></Show></header><Show when={installedMode()}><div class="stat-grid"><Panel><Box /><strong>{props.mode === 'updates' ? knownUpdatesCount() ?? '—' : catalog()?.length ?? 0}</strong><span>{props.mode === 'updates' ? 'Updates' : 'Resources'}</span><small>Reported by OMP</small></Panel><Panel><Folder /><strong>{props.mode === 'local' ? catalog()?.length ?? 0 : '—'}</strong><span>Local resources</span><small>{props.mode === 'local' ? 'From local plugin storage' : 'Open Local resources to inspect'}</small></Panel><Panel><ShieldCheck /><strong>{catalog()?.filter(item => item.compatibility !== 'Not reported').length ?? 0}</strong><span>Compatibility reports</span><small>Declared by package metadata</small></Panel></div></Show><Tabs items={modes()} value={props.mode} onChange={id => navigate(`/${id}`)} /><div class="catalog-toolbar"><label class="search-box"><Search size={17} /><input placeholder="Search packages…" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label><Show when={props.mode === 'discover'}><input class="marketplace-source" aria-label="Marketplace source" placeholder="Repository or local marketplace path" value={marketplaceSource()} onInput={event => setMarketplaceSource(event.currentTarget.value)} /><Button variant="solid" tone="accent" disabled={!marketplaceSource().trim()} onClick={() => void addMarketplace()}>Add marketplace</Button></Show></div><Show when={props.mode === 'discover' && marketplaces()?.length}><p class="marketplace-note">Also searching {marketplaces()?.map(marketplace => marketplace.name).join(', ')}</p></Show><Tabs items={kinds.map(label => ({ id: label, label }))} value={kind()} onChange={setKind} /><div class={`package-list ${installedMode() ? 'package-list--table' : ''}`} aria-busy={catalogModeLoading(props.mode)}><Show when={installedMode()}><div class="package-table-head"><span>Name</span><span>Type</span><span>Version</span><span>Scope</span><span>Status</span></div></Show><Show when={!catalogLoading()} fallback={<div class="catalog-loading" role="status" aria-live="polite"><Loader2 size={20} class="spin" aria-hidden="true" /><span>{`Loading ${catalogModeLabels[props.mode]} catalog…`}</span></div>}><Show when={installedMode()} fallback={<VirtualList items={rows()} estimateSize={180} class="catalog-results catalog-results--grid">{pair => <div class="discover-grid"><For each={pair}>{item => <DiscoverCard item={item} selected={selected()?.id === item.id} busy={busy()} onSelect={() => setSelected(item)} onInstall={() => void manage(item, 'install')} />}</For></div>}</VirtualList>}><VirtualList items={visible()} estimateSize={99} class="catalog-results">{item => <button class={`package-row ${selected()?.id === item.id ? 'is-selected' : ''}`} onClick={() => setSelected(item)}><PackageGlyph item={item} /><span class="package-copy"><strong>{item.name}</strong><small>{item.description || 'No description reported'}</small><em>{item.author || 'Unknown author'}</em></span><Badge tone="accent">{item.kind}</Badge><span>v{item.version}</span><span>OMP</span><span class={item.updateAvailable ? 'warning' : 'success'}>● {item.updateAvailable ? 'Update available' : 'Installed'}</span></button>}</VirtualList></Show><Show when={!visible().length && !(props.mode === 'updates' && catalogUpdatesState().kind !== 'ready')}><Panel>{props.mode === 'discover' && !marketplaces()?.length ? 'No packages matched. Try a different search or type filter.' : 'No packages reported by OMP for this view.'}</Panel></Show></Show></div><footer class="pagination"><span>Showing {visible().length} resources</span></footer></section><Show when={selected()}>{item => <PackageDetail item={item()} scope={scope()} busy={busy()} readme={readme() ?? ''} readmeLoading={props.mode === 'discover' && readme.loading} onScope={setScope} onAction={action => void manage(item(), action)} />}</Show><Show when={status()}>{state => <div class={`install-status install-status--${state().kind}`} role="status">{state().kind === 'progress' ? <Loader size={15} class="spin" /> : state().kind === 'success' ? <Check size={15} /> : <AlertCircle size={15} />}<span>{state().text}</span><button class="install-status__close" type="button" aria-label="Dismiss" onClick={() => setStatus(null)}><X size={15} /></button></div>}</Show></div>;
}
