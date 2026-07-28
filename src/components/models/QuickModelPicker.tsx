import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { ArrowLeft, Check, LoaderCircle, Search } from 'lucide-solid';
import type { OmpModel } from '../../types';

type ProviderFilter = 'All' | 'Anthropic' | 'OpenAI' | 'DeepSeek' | 'Other';
const providerFilters: ProviderFilter[] = ['All', 'Anthropic', 'OpenAI', 'DeepSeek', 'Other'];
const initialModelLimit = 8;
const initialProviderLimit = 4;

function providerFilter(provider: string): Exclude<ProviderFilter, 'All'> {
  const value = provider.toLowerCase();
  if (value.includes('anthropic')) return 'Anthropic';
  if (value.includes('openai')) return 'OpenAI';
  if (value.includes('deepseek')) return 'DeepSeek';
  return 'Other';
}

function providerLabel(provider: string): string {
  const known = providerFilter(provider);
  if (known !== 'Other') return known;
  return provider.split(/[-_]/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function versionParts(id: string): number[] {
  const withoutDate = id.toLowerCase().replace(/20\d{6}/g, '');
  const match = withoutDate.match(/\d+(?:[.-]\d+)*/);
  return match ? match[0].split(/[.-]/).map(Number) : [];
}

function modelDate(id: string): number {
  const dates = id.match(/20\d{6}/g);
  return dates?.length ? Math.max(...dates.map(Number)) : 0;
}

function compareRecency(left: OmpModel, right: OmpModel): number {
  const leftVersion = versionParts(left.id);
  const rightVersion = versionParts(right.id);
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length, 3); index += 1) {
    const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
    if (difference) return difference;
  }
  return modelDate(right.id) - modelDate(left.id) || left.name.localeCompare(right.name);
}

function modelFamily(model: OmpModel): string {
  const semantic = model.id.toLowerCase().split(/[-_/.:]+/).filter(part => part && !/^(?:v?\d|20\d{6})/.test(part));
  return semantic[1] ?? semantic[0] ?? model.id.toLowerCase();
}

function representativeModels(models: OmpModel[], limit: number): OmpModel[] {
  if (limit <= 0) return [];
  const modern = models.filter(model => !isLegacy(model));
  const source = modern.length ? modern : models;
  if (source.length <= limit) return source.slice();
  const families = new Map<string, OmpModel[]>();
  for (const model of source) {
    const family = modelFamily(model);
    const entries = families.get(family);
    if (entries) entries.push(model); else families.set(family, [model]);
  }
  const first = source[0];
  const selected = [first];
  const firstFamily = modelFamily(first);
  const representatives = [...families].filter(([family]) => family !== firstFamily).map(([, entries]) => ({ model: entries[0], size: entries.length })).sort((left, right) => right.size - left.size || compareRecency(left.model, right.model));
  for (const entry of representatives) {
    if (selected.length >= limit) break;
    selected.push(entry.model);
  }
  for (const model of source) {
    if (selected.length >= limit) break;
    if (!selected.some(entry => entry.selector === model.selector)) selected.push(model);
  }
  return selected;
}

function isLegacy(model: OmpModel): boolean {
  const id = model.id.toLowerCase();
  if (/legacy|deprecated/.test(id)) return true;
  if (/claude-3(?:[-.]|$)|gpt-(?:3|4)(?:[-.]|$)|deepseek-v[123](?:[-.]|$)/.test(id)) return true;
  const dates = id.match(/20(\d{2})\d{4}/g) ?? [];
  return dates.some(date => Number(date.slice(0, 4)) <= new Date().getFullYear() - 2);
}

function contextLabel(model: OmpModel): string {
  if (model.contextWindow >= 1_000_000) return `${Math.round(model.contextWindow / 1_000_000)}M ctx`;
  return `${Math.round(model.contextWindow / 1_000)}k ctx`;
}

export default function QuickModelPicker(props: {
  models: OmpModel[]; value: string; pending?: string | null;
  onSelect: (model: OmpModel) => Promise<void> | void; onBack: () => void; onManage: () => void;
}) {
  const [query, setQuery] = createSignal('');
  const [filter, setFilter] = createSignal<ProviderFilter>('All');
  const [showAll, setShowAll] = createSignal(false);
  let searchInput!: HTMLInputElement;
  const selected = createMemo(() => props.models.find(model => model.selector === props.value));
  const matching = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return props.models.filter(model => (filter() === 'All' || providerFilter(model.provider) === filter()) && (!needle || `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(needle)));
  });
  const groups = createMemo(() => {
    const byProvider = new Map<string, OmpModel[]>();
    for (const model of matching()) {
      const models = byProvider.get(model.provider);
      if (models) models.push(model); else byProvider.set(model.provider, [model]);
    }
    return [...byProvider].map(([provider, models]) => ({ provider, label: providerLabel(provider), models: models.sort(compareRecency) })).sort((left, right) => {
      const order = ['Anthropic', 'OpenAI', 'DeepSeek', 'Other'];
      return order.indexOf(providerFilter(left.provider)) - order.indexOf(providerFilter(right.provider)) || left.label.localeCompare(right.label);
    });
  });
  const visibleGroups = createMemo(() => {
    if (showAll() || query().trim() || filter() !== 'All') return groups();
    let remaining = initialModelLimit;
    return groups().map(group => {
      const models = representativeModels(group.models, Math.min(initialProviderLimit, remaining));
      remaining -= models.length;
      const current = selected();
      if (current?.provider === group.provider && !models.some(model => model.selector === current.selector)) models.push(current);
      return { ...group, models };
    }).filter(group => group.models.length);
  });
  const visibleCount = createMemo(() => visibleGroups().reduce((total, group) => total + group.models.length, 0));
  onMount(() => queueMicrotask(() => searchInput?.focus()));

  return <div class="quick-model-picker" aria-busy={Boolean(props.pending)}>
    <header class="quick-model-picker__header"><button type="button" class="icon-button" aria-label="Back to effort levels" onClick={props.onBack}><ArrowLeft size={16} /></button><div><strong>Change model</strong><small>Current: {selected()?.name || props.value}</small></div></header>
    <label class="model-select__search"><Search size={15} /><input ref={searchInput} aria-label="Search models" placeholder="Search models…" value={query()} onInput={event => { setQuery(event.currentTarget.value); setShowAll(false); }} /></label>
    <div class="model-select__filters" aria-label="Provider filters"><For each={providerFilters}>{provider => <button type="button" class={filter() === provider ? 'is-active' : ''} aria-pressed={filter() === provider} onClick={() => { setFilter(provider); setShowAll(false); }}>{provider}</button>}</For></div>
    <div class="model-select__list" role="listbox" aria-label="Available models">
      <For each={visibleGroups()}>{group => <section class="model-select__group"><h3>{group.label}</h3><For each={group.models.filter(model => !isLegacy(model))}>{model => <button type="button" role="option" aria-selected={model.selector === props.value} disabled={Boolean(props.pending)} class="model-select__option" onClick={() => void props.onSelect(model)}><span><strong>{model.name}</strong><small>{contextLabel(model)}{model.reasoning ? ' · Reasoning' : ''}</small></span><Show when={props.pending === model.selector} fallback={<Show when={model.selector === props.value}><Check size={15} /></Show>}><LoaderCircle class="spin" size={15} /></Show></button>}</For><Show when={group.models.some(isLegacy)}><h4>Legacy</h4><For each={group.models.filter(isLegacy)}>{model => <button type="button" role="option" aria-selected={model.selector === props.value} disabled={Boolean(props.pending)} class="model-select__option model-select__option--legacy" onClick={() => void props.onSelect(model)}><span><strong>{model.name}</strong><small>{contextLabel(model)}</small></span><Show when={props.pending === model.selector} fallback={<Show when={model.selector === props.value}><Check size={15} /></Show>}><LoaderCircle class="spin" size={15} /></Show></button>}</For></Show></section>}</For>
      <Show when={!visibleCount()}><p class="model-select__empty">No models found.</p></Show>
    </div>
    <footer class="model-select__footer"><Show when={!showAll() && !query().trim() && visibleCount() < matching().length}><button type="button" onClick={() => setShowAll(true)}>View all models ({matching().length})</button></Show><button type="button" onClick={props.onManage}>Manage models &amp; roles</button></footer>
  </div>;
}
