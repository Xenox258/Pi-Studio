import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { ArrowRight, ChevronDown, Gauge, Repeat2, Settings2, Sparkles } from 'lucide-solid';
import { useNavigate } from '@solidjs/router';
import type { AdaptiveEffortConfig, EffortOption, OmpModel } from '../../types';
import { resolveEffortConfig } from '../../models/effort';
import QuickModelPicker from './QuickModelPicker';

export type ModelPopoverView = 'effort' | 'models';

function providerLabel(provider: string): string {
  const known: Record<string, string> = { anthropic: 'Anthropic', 'openai-codex': 'OpenAI', openai: 'OpenAI', deepseek: 'DeepSeek' };
  return known[provider.toLowerCase()] ?? provider.split(/[-_]/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

export function EffortIntensity(props: { option: EffortOption }) {
  return <span class={`effort-intensity effort-intensity--${props.option.intensity}`} aria-hidden="true"><For each={[1, 2, 3, 4]}>{level => <i class={level <= props.option.intensity ? 'is-active' : ''} />}</For><Show when={props.option.intensity >= 4}><Sparkles size={9} /></Show></span>;
}

export function ModelEffortTrigger(props: { model?: OmpModel; effort: EffortOption; expanded: boolean; onClick: () => void }) {
  return <button type="button" class="model-effort-trigger" aria-label="Active model and effort" aria-haspopup="dialog" aria-expanded={props.expanded} onClick={props.onClick}>
    <span class="model-effort-trigger__copy"><strong>{props.model?.name || 'Choose model'}</strong><i aria-hidden="true" /><small><EffortIntensity option={props.effort} />{props.effort.label}</small></span><ChevronDown size={14} />
  </button>;
}

export function EffortSegment(props: { option: EffortOption; selected: boolean; disabled: boolean; onSelect: () => void }) {
  return <button type="button" role="radio" aria-checked={props.selected} tabindex={props.selected ? 0 : -1} disabled={props.disabled} class="effort-segment" onClick={props.onSelect}><EffortIntensity option={props.option} /><span>{props.option.label}</span></button>;
}

export function AdaptiveEffortSelector(props: { config: AdaptiveEffortConfig; value: string; pending: boolean; onChange: (option: EffortOption) => void }) {
  let group!: HTMLDivElement;
  const selectedIndex = () => Math.max(0, props.config.options.findIndex(option => option.value === props.value));
  const style = () => ({ '--effort-count': String(props.config.options.length), '--effort-index': String(selectedIndex()) }) as JSX.CSSProperties;
  function navigate(event: KeyboardEvent) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key) || !props.config.configurable || props.pending) return;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : (current + 1) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  }
  return <div ref={group} class={`adaptive-effort-selector ${props.config.configurable ? '' : 'is-disabled'} ${props.pending ? 'is-pending' : ''}`} role="radiogroup" aria-label="Reasoning effort" aria-disabled={!props.config.configurable} style={style()} onKeyDown={navigate}>
    <span class="adaptive-effort-selector__indicator" aria-hidden="true" />
    <For each={props.config.options}>{option => <EffortSegment option={option} selected={option.value === props.value} disabled={!props.config.configurable || props.pending} onSelect={() => props.onChange(option)} />}</For>
  </div>;
}

export function EffortDescription(props: { option: EffortOption }) {
  return <Show when={props.option} keyed>{option => <div class="effort-description"><div class="effort-description__icon"><Gauge size={15} /></div><div><strong>{option.label} effort</strong><p>{option.description}</p></div></div>}</Show>;
}

export function ChangeModelButton(props: { onClick: () => void; disabled: boolean }) {
  return <button type="button" class="change-model-button" disabled={props.disabled} onClick={props.onClick}><Repeat2 size={15} /><span>Change model</span><ArrowRight size={14} /></button>;
}

export function ManageModelsLink(props: { onClick: () => void }) {
  return <button type="button" class="manage-models-link" onClick={props.onClick}><Settings2 size={14} />Manage models &amp; roles <span>›</span></button>;
}

export default function AdaptiveEffortPopover(props: {
  models: OmpModel[]; recentModels?: OmpModel[]; modelValue: string; effortValue: string;
  onEffortChange: (backendValue: string) => Promise<void>;
  onModelChange: (model: OmpModel) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [view, setView] = createSignal<ModelPopoverView>('effort');
  const [pendingEffort, setPendingEffort] = createSignal<string | null>(null);
  const [pendingModel, setPendingModel] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  let root!: HTMLDivElement;
  const activeModel = createMemo(() => props.models.find(model => model.selector === props.modelValue));
  const recentChoices = createMemo(() => (props.recentModels ?? []).filter(model => model.selector !== props.modelValue).slice(0, 3));
  const config = createMemo(() => resolveEffortConfig(activeModel(), props.effortValue));
  const displayedValue = createMemo(() => pendingEffort() ?? config().selectedValue);
  const selectedOption = createMemo(() => config().options.find(option => option.value === displayedValue()) ?? config().options[0]);

  function close() { setOpen(false); setView('effort'); setError(''); }
  function toggle() { if (open()) close(); else { setOpen(true); setView('effort'); setError(''); } }
  function manageModels() { close(); navigate('/models'); }
  async function changeEffort(option: EffortOption) {
    if (!config().configurable || option.value === config().selectedValue || pendingEffort() || pendingModel()) return;
    setPendingEffort(option.value); setError('');
    try { await props.onEffortChange(option.backendValue); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPendingEffort(null); }
  }
  async function changeModel(model: OmpModel) {
    if (model.selector === props.modelValue || pendingModel() || pendingEffort()) { if (model.selector === props.modelValue) setView('effort'); return; }
    setPendingModel(model.selector); setError('');
    try { await props.onModelChange(model); setView('effort'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPendingModel(null); }
  }
  function handlePointerDown(event: PointerEvent) { if (open() && !root.contains(event.target as Node)) close(); }
  function handleKeyDown(event: KeyboardEvent) { if (event.key === 'Escape' && open()) { event.preventDefault(); close(); } }
  onMount(() => { document.addEventListener('pointerdown', handlePointerDown); document.addEventListener('keydown', handleKeyDown); });
  onCleanup(() => { document.removeEventListener('pointerdown', handlePointerDown); document.removeEventListener('keydown', handleKeyDown); });

  return <div class="model-effort" ref={root}>
    <ModelEffortTrigger model={activeModel()} effort={selectedOption()} expanded={open()} onClick={toggle} />
    <Show when={open()}><section class="adaptive-effort-popover" role="dialog" aria-label="Model and reasoning effort" data-view={view()}>
      <Show when={view() === 'effort'} fallback={<QuickModelPicker models={props.models} value={props.modelValue} pending={pendingModel()} onSelect={changeModel} onBack={() => setView('effort')} onManage={manageModels} />}>
        <header class="current-model-header"><div><small>Current model</small><strong>{activeModel()?.name || 'No model selected'}</strong><span>{providerLabel(activeModel()?.provider ?? '')}</span></div><span class="active-model-chip">Active</span></header>
        <Show when={recentChoices().length}><div class="recent-model-switcher"><span>Recent</span><div><For each={recentChoices()}>{model => <button type="button" title={`${model.name} · ${providerLabel(model.provider)}`} disabled={Boolean(pendingEffort() || pendingModel())} onClick={() => void changeModel(model)}>{model.name}</button>}</For></div></div></Show>
        <div class="adaptive-effort-popover__body"><AdaptiveEffortSelector config={config()} value={displayedValue()} pending={Boolean(pendingEffort())} onChange={option => void changeEffort(option)} /><EffortDescription option={selectedOption()} /></div>
        <footer class="adaptive-effort-popover__footer"><ChangeModelButton disabled={!props.models.length || Boolean(pendingEffort() || pendingModel())} onClick={() => { setError(''); setView('models'); }} /><ManageModelsLink onClick={manageModels} /></footer>
      </Show>
      <Show when={error()}><p class="model-effort-error" role="alert">{error()}</p></Show>
    </section></Show>
  </div>;
}
