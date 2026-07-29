import { For, Show, createEffect, createSignal, onMount } from 'solid-js';
import { Bot, Clock3, Eye, Globe2, KeyRound, Leaf, Pencil, RefreshCw, Rocket, Save, Sparkles, SquareDashed, Target, TriangleAlert } from 'lucide-solid';
import { A } from '@solidjs/router';
import { defaultRoles } from '../../data/catalog';
import { Button, Panel, Select, Tabs } from '../../components/ui';
import type { RoleMapping } from '../../types';
import { studioApi } from '../../api/invoke';
import { activeModel, activeProject, activeSession, applyModelCatalog, availableModels, changeActiveModel, modelOptions } from '../../stores/appStore';

const icons = [Sparkles, Leaf, Clock3, SquareDashed, Sparkles, Eye, Target, Pencil];
const levels = ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Very High', 'Max'];

const builtInRoleIds = new Set(defaultRoles.map(role => role.id));

function mergeRoleMappings(savedRoles: RoleMapping[]) {
  const savedById = new Map(savedRoles.map(role => [role.id, role]));
  return [
    ...defaultRoles.map(role => savedById.get(role.id) ?? role),
    ...savedRoles.filter(role => !builtInRoleIds.has(role.id)),
  ];
}

export default function ModelsRolesPage() {
  const [scope, setScope] = createSignal('global');
  const [roles, setRoles] = createSignal<RoleMapping[]>(defaultRoles);
  const [status, setStatus] = createSignal('');
  const [modelsRefreshing, setModelsRefreshing] = createSignal(false);
  const [modelsError, setModelsError] = createSignal('');
  const modelKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const resolveModel = (value: string) => availableModels().find(model => model.selector === value || modelKey(model.name) === modelKey(value))?.selector ?? activeModel();
  const modelName = (selector: string) => availableModels().find(model => model.selector === selector)?.name ?? selector;
  createEffect(() => { if (!availableModels().length) return; setRoles(items => items.map(item => { const model = resolveModel(item.model); return model === item.model ? item : { ...item, model }; })); });
  async function update(id: string, key: 'model' | 'thinking', value: string) {
    const previousValue = roles().find(role => role.id === id)?.[key];
    const setValue = (nextValue: string) => setRoles(items => items.map(item => item.id === id ? { ...item, [key]: nextValue } : item));
    setValue(value);
    if (id !== 'default' || key !== 'model') return;
    const model = availableModels().find(candidate => candidate.selector === value);
    if (!model) {
      if (previousValue) setValue(previousValue);
      setStatus('The selected model is no longer available');
      return;
    }
    try {
      await changeActiveModel(model);
      setStatus('Active model changed; save to keep this role mapping');
    } catch (error) {
      if (previousValue) setValue(previousValue);
      setStatus(error instanceof Error ? error.message : 'Unable to change the active model');
    }
  }
  async function refreshModels() {
    setModelsRefreshing(true);
    setModelsError('');
    try {
      const catalog = await studioApi.models();
      if (!catalog.length) throw new Error('OMP returned an empty model catalog. Check that at least one provider is connected.');
      applyModelCatalog(catalog, roles().find(role => role.id === 'default')?.model);
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unable to refresh models.');
    } finally {
      setModelsRefreshing(false);
    }
  }
  function scopeKey(target: string) { if (target === 'global') return target; if (target === 'project' && activeProject()) return `project:${activeProject()!.id}`; if (target === 'session' && activeSession()) return `session:${activeSession()!.id}`; throw new Error(`Open an active ${target} before configuring this scope.`); }
  async function save(target: string) { try { await studioApi.saveRoles(scopeKey(target), roles()); setStatus('Mappings saved'); } catch (error) { setStatus(error instanceof Error ? error.message : 'Save failed'); } }
  async function changeScope(target: string) { setScope(target); if (!('__TAURI_INTERNALS__' in window)) return; try { setRoles(mergeRoleMappings(await studioApi.roles(scopeKey(target)))); setStatus(''); } catch (error) { setStatus(error instanceof Error ? error.message : 'Unable to load mappings'); } }
  function addRole() { setRoles(items => [...items, { id: crypto.randomUUID(), label: `Custom role ${items.length + 1}`, description: 'Project-specific role', model: activeModel(), thinking: 'Medium', tone: 'purple' }]); }
  function reset() { setRoles(defaultRoles.map(role => ({ ...role, model: resolveModel(role.model) }))); setStatus('Defaults restored locally'); }
  onMount(() => void changeScope('global'));
  return <div class="page models-page"><div class="models-main"><header class="page-heading"><h1>Models & Roles</h1><p>Configure which model and thinking level each role uses to best fit its purpose.</p></header><Tabs wide items={[{ id: 'global', label: 'Global' }, { id: 'project', label: 'Project' }, { id: 'session', label: 'Session' }]} value={scope()} onChange={value => void changeScope(value)} /><section class="roles-table"><header><span>Role</span><span>Model</span><span>Thinking level</span></header><Show when={availableModels().length} fallback={<div class="models-unavailable" role="alert" aria-live="polite"><span class="models-unavailable__icon"><TriangleAlert size={20} /></span><div class="models-unavailable__copy"><strong>No models available</strong><p>OMP did not return a model catalog. Your role mappings are preserved while you reconnect a provider or retry.</p>{modelsError() && <small>{modelsError()}</small>}</div><div class="models-unavailable__actions"><Button disabled={modelsRefreshing()} onClick={() => void refreshModels()}><RefreshCw size={15} class={modelsRefreshing() ? 'spin' : ''} />{modelsRefreshing() ? 'Refreshing…' : 'Retry'}</Button><A class="button button--outline button--default" href="/providers"><KeyRound size={15} />Open providers</A></div></div>}><For each={roles()}>{(role, index) => { const Icon = icons[index()] ?? Bot; return <div class="role-row"><div class="role-name"><span class={`role-icon role-icon--${role.tone}`}><Icon size={22} /></span><div><strong>{role.label}</strong><small>{role.description}</small></div></div><Select label={`${role.label} model`} value={role.model} options={modelOptions()} onChange={value => update(role.id, 'model', value)} /><Select label={`${role.label} thinking`} value={role.thinking} options={levels} onChange={value => update(role.id, 'thinking', value)} /></div>; }}</For><button class="add-role" onClick={addRole}>＋ Add custom role</button></Show></section></div><aside class="models-summary"><Panel title="Active mapping summary"><div class="mapping-list"><For each={roles()}>{role => <div><Sparkles size={15} class="accent" /><span>{role.label}</span><span>{modelName(role.model)}</span><span>{role.thinking}</span></div>}</For></div></Panel><Panel title="Where these settings apply"><div class="scope-list"><div><Globe2 /><span><strong>Global</strong><small>Applies to all projects and sessions unless overridden.</small></span><b class="success">Active</b></div><div><SquareDashed /><span><strong>Project</strong><small>Override role mappings in project settings.</small></span><b class="accent">Configurable</b></div><div><Clock3 /><span><strong>Session</strong><small>Temporarily override within a session.</small></span><b class="accent">Configurable</b></div></div></Panel><Button class="apply-role" variant="solid" tone="accent" onClick={() => save('project')}><Rocket size={17} />Apply to project</Button><div class="summary-actions"><Button onClick={() => save('global')}><Save size={17} />Save globally</Button><Button onClick={reset}>Reset defaults</Button></div>{status() && <small>{status()}</small>}</aside></div>;
}
