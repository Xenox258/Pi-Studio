import { For, Show, createEffect, createSignal, onMount } from 'solid-js';
import { Bot, Clock3, Eye, Globe2, Leaf, Pencil, Rocket, Save, Sparkles, SquareDashed, Target } from 'lucide-solid';
import { defaultRoles } from '../../data/catalog';
import { Button, Panel, Select, Tabs } from '../../components/ui';
import type { RoleMapping } from '../../types';
import { studioApi } from '../../api/invoke';
import { activeModel, activeProject, activeSession, availableModels, modelOptions } from '../../stores/appStore';

const icons = [Sparkles, Leaf, Clock3, SquareDashed, Sparkles, Eye, Target, Pencil];
const levels = ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Very High', 'Max'];

export default function ModelsRolesPage() {
  const [scope, setScope] = createSignal('global');
  const [roles, setRoles] = createSignal<RoleMapping[]>(defaultRoles);
  const [status, setStatus] = createSignal('');
  const modelKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const resolveModel = (value: string) => availableModels().find(model => model.selector === value || modelKey(model.name) === modelKey(value))?.selector ?? activeModel();
  const modelName = (selector: string) => availableModels().find(model => model.selector === selector)?.name ?? selector;
  createEffect(() => { if (!availableModels().length) return; setRoles(items => items.map(item => { const model = resolveModel(item.model); return model === item.model ? item : { ...item, model }; })); });
  const update = (id: string, key: 'model' | 'thinking', value: string) => setRoles(items => items.map(item => item.id === id ? { ...item, [key]: value } : item));
  function scopeKey(target: string) { if (target === 'global') return target; if (target === 'project' && activeProject()) return `project:${activeProject()!.id}`; if (target === 'session' && activeSession()) return `session:${activeSession()!.id}`; throw new Error(`Open an active ${target} before configuring this scope.`); }
  async function save(target: string) { try { await studioApi.saveRoles(scopeKey(target), roles()); setStatus('Mappings saved'); } catch (error) { setStatus(error instanceof Error ? error.message : 'Save failed'); } }
  async function changeScope(target: string) { setScope(target); if (!('__TAURI_INTERNALS__' in window)) return; try { setRoles(await studioApi.roles(scopeKey(target))); setStatus(''); } catch (error) { setStatus(error instanceof Error ? error.message : 'Unable to load mappings'); } }
  function addRole() { setRoles(items => [...items, { id: crypto.randomUUID(), label: `Custom role ${items.length + 1}`, description: 'Project-specific role', model: activeModel(), thinking: 'Medium', tone: 'purple' }]); }
  function reset() { setRoles(defaultRoles.map(role => ({ ...role, model: resolveModel(role.model) }))); setStatus('Defaults restored locally'); }
  onMount(() => void changeScope('global'));
  return <div class="page models-page"><div class="models-main"><header class="page-heading"><h1>Models & Roles</h1><p>Configure which model and thinking level each role uses to best fit its purpose.</p></header><Tabs wide items={[{ id: 'global', label: 'Global' }, { id: 'project', label: 'Project' }, { id: 'session', label: 'Session' }]} value={scope()} onChange={value => void changeScope(value)} /><section class="roles-table"><header><span>Role</span><span>Model</span><span>Thinking level</span></header><Show when={availableModels().length} fallback={<p class="warning">OMP did not report any available models. Configure or refresh providers in OMP.</p>}><For each={roles()}>{(role, index) => { const Icon = icons[index()] ?? Bot; return <div class="role-row"><div class="role-name"><span class={`role-icon role-icon--${role.tone}`}><Icon size={22} /></span><div><strong>{role.label}</strong><small>{role.description}</small></div></div><Select label={`${role.label} model`} value={role.model} options={modelOptions()} onChange={value => update(role.id, 'model', value)} /><Select label={`${role.label} thinking`} value={role.thinking} options={levels} onChange={value => update(role.id, 'thinking', value)} /></div>; }}</For><button class="add-role" onClick={addRole}>＋ Add custom role</button></Show></section></div><aside class="models-summary"><Panel title="Active mapping summary"><div class="mapping-list"><For each={roles()}>{role => <div><Sparkles size={15} class="accent" /><span>{role.label}</span><span>{modelName(role.model)}</span><span>{role.thinking}</span></div>}</For></div></Panel><Panel title="Where these settings apply"><div class="scope-list"><div><Globe2 /><span><strong>Global</strong><small>Applies to all projects and sessions unless overridden.</small></span><b class="success">Active</b></div><div><SquareDashed /><span><strong>Project</strong><small>Override role mappings in project settings.</small></span><b class="accent">Configurable</b></div><div><Clock3 /><span><strong>Session</strong><small>Temporarily override within a session.</small></span><b class="accent">Configurable</b></div></div></Panel><Button class="apply-role" variant="solid" tone="accent" onClick={() => save('project')}><Rocket size={17} />Apply to project</Button><div class="summary-actions"><Button onClick={() => save('global')}><Save size={17} />Save globally</Button><Button onClick={reset}>Reset defaults</Button></div>{status() && <small>{status()}</small>}</aside></div>;
}
