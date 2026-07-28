import { For, createResource } from 'solid-js';
import { ChevronDown, Gauge, GitBranch } from 'lucide-solid';
import { open } from '@tauri-apps/plugin-dialog';
import { activeModel, activeProject, activeSession, advisorEnabled, modelOptions, planEnabled, setActiveModel, setActiveProject, setActiveSession, setAdvisorEnabled, setPlanEnabled, setThinkingLevel, thinkingLevel } from '../../stores/appStore';
import { studioApi } from '../../api/invoke';
import { Badge, Popover, ProgressBar, Select, Toggle } from '../ui';

export default function TopBar() {
  async function chooseProject() {
    const path = await open({ directory: true, multiple: false, title: 'Open project' });
    if (typeof path !== 'string') return;
    if (activeSession()) await studioApi.stopSession(activeSession()!.id);
    const project = await studioApi.openProject(path); const id = await studioApi.startSession(project.id, project.path);
    setActiveProject(project); setActiveSession({ id, title: project.name, projectId: project.id, updatedAt: new Date().toISOString(), active: true });
  }
  async function changePlan(enabled: boolean) { const previous = planEnabled(); setPlanEnabled(enabled); const id = activeSession()?.id; if (id) try { await studioApi.setWorkflowMode(id, enabled ? 'plan' : 'build'); } catch { setPlanEnabled(previous); } }
  async function changeAdvisor(enabled: boolean) { const previous = advisorEnabled(); setAdvisorEnabled(enabled); const id = activeSession()?.id; if (id) try { await studioApi.setAdvisor(id, enabled); } catch { setAdvisorEnabled(previous); } }
  async function changeModel(model: string) { const previous = activeModel(); setActiveModel(model); const id = activeSession()?.id; if (id) try { await studioApi.setModel(id, model); } catch { setActiveModel(previous); } }
  async function changeThinking(level: string) { const previous = thinkingLevel(); setThinkingLevel(level); const id = activeSession()?.id; if (id) try { await studioApi.setThinking(id, level); } catch { setThinkingLevel(previous); } }
  const usageSource = () => '__TAURI_INTERNALS__' in window ? activeSession()?.id ?? 'cli' : undefined;
  const [usage] = createResource(usageSource, source => studioApi.usage(source === 'cli' ? undefined : source));
  const usagePercent = () => { const values = usage()?.providers.flatMap(provider => provider.accounts.flatMap(account => account.limits.map(limit => limit.usedPercent))) ?? []; return values.length ? Math.max(...values) : undefined; };
  return <header class="topbar">
    <button class="project-switcher" onClick={() => void chooseProject()}><GitBranch size={17} /><strong>{activeProject()?.name ?? 'Open a project'}</strong><span>{activeProject() ? '• active' : 'Choose directory'}</span><ChevronDown size={15} /></button>
    <div class="topbar-controls">
      <Popover label="Usage summary" trigger={<Badge tone={usagePercent() !== undefined && usagePercent()! >= 90 ? 'warning' : 'default'}><Gauge size={13} />{usagePercent() === undefined ? 'Usage —' : `${usagePercent()}%`}</Badge>}><strong>Provider usage</strong><For each={usage()?.providers ?? []}>{provider => <div class="topbar-usage-row"><span>{provider.providerName}</span><For each={provider.accounts}>{account => <small>{account.displayLabel}</small>}</For></div>}</For>{usagePercent() !== undefined && <ProgressBar value={usagePercent()!} label="Highest usage" />}</Popover>
      <label>Plan <Toggle checked={planEnabled()} onChange={enabled => void changePlan(enabled)} label="Plan mode" /></label>
      <label>Advisor <Toggle checked={advisorEnabled()} onChange={enabled => void changeAdvisor(enabled)} label="Advisor" /></label>
      <label>Model <Select label="Active model" value={activeModel()} onChange={model => void changeModel(model)} options={modelOptions()} /></label>
      <label>Thinking <Select label="Thinking level" value={thinkingLevel()} onChange={level => void changeThinking(level)} options={['Off', 'Minimal', 'Low', 'Medium', 'High', 'Very High', 'Max']} /></label>
    </div>
  </header>;
}
