import { A, useLocation, useNavigate } from '@solidjs/router';
import { Box, CircleDot, Folder, Gauge, KeyRound, PackageCheck, PackageOpen, Plus, Search, Settings, Sparkles } from 'lucide-solid';
import { For, createResource, createSignal } from 'solid-js';
import { open } from '@tauri-apps/plugin-dialog';
import VirtualList from '../ui/VirtualList';
import { studioApi } from '../../api/invoke';
import { activeModelLabel, activeProject, activeSession, setActiveProject, setActiveSession } from '../../stores/appStore';
import type { ProjectSummary } from '../../types';

const ecosystem = [
  { href: '/discover', label: 'Discover', icon: Search },
  { href: '/installed', label: 'Installed', icon: Box },
  { href: '/updates', label: 'Updates', icon: PackageCheck },
  { href: '/local', label: 'Local resources', icon: PackageOpen },
  { href: '/usage', label: 'Usage & limits', icon: Gauge },
];

export default function Sidebar() {
  const location = useLocation(); const navigate = useNavigate(); const [status, setStatus] = createSignal('');
  const fetchProjects = async () => '__TAURI_INTERNALS__' in window ? studioApi.recentProjects() : []; const fetchSessions = async () => '__TAURI_INTERNALS__' in window ? studioApi.recentSessions() : [];
  const [projects, { refetch: refetchProjects }] = createResource(fetchProjects); const [sessions, { refetch: refetchSessions }] = createResource(fetchSessions);
  const active = (href: string) => location.pathname === href;
  async function activate(project: ProjectSummary) { try { if (activeSession()) await studioApi.stopSession(activeSession()!.id); const opened = await studioApi.openProject(project.path); const id = await studioApi.startSession(opened.id, opened.path); setActiveProject(opened); setActiveSession({ id, title: opened.name, projectId: opened.id, updatedAt: new Date().toISOString(), active: true }); await Promise.all([refetchProjects(), refetchSessions()]); navigate('/'); } catch (error) { setStatus(error instanceof Error ? error.message : 'Unable to open project'); } }
  async function chooseProject() { const path = await open({ directory: true, multiple: false, title: 'Open project' }); if (typeof path !== 'string') return; await activate({ id: '', name: '', path }); }
  return <aside class="sidebar">
    <div class="window-dots"><i /><i /><i /></div>
    <A href="/" class="brand"><span class="brand-mark"><Box size={22} /></span><strong>OMP Studio</strong></A>
    <nav aria-label="Main navigation">
      <p class="nav-label">Projects</p>
      <For each={projects() ?? []}>{project => <button class={`nav-item ${activeProject()?.id === project.id ? 'is-active' : ''}`} title={project.path} onClick={() => void activate(project)}><Folder size={17} /><span>{project.name}</span></button>}</For>
      <button class="nav-item nav-item--accent" onClick={() => void chooseProject()}><Plus size={18} /><span>Open Project</span></button>
      <p class="nav-label">Sessions</p>
      <VirtualList items={sessions() ?? []} estimateSize={39} class="sidebar-sessions">{session => <div class={`nav-item ${activeSession()?.id === session.id ? 'is-active' : ''}`}><CircleDot size={17} /><span>{session.title}</span>{activeSession()?.id === session.id && <i class="presence-dot" />}</div>}</VirtualList>
      <p class="nav-label">Ecosystem</p>
      <For each={ecosystem}>{item => <A href={item.href} class={`nav-item ${active(item.href) ? 'is-active' : ''}`}><item.icon size={17} /><span>{item.label}</span></A>}</For>
      <p class="nav-label">Models</p>
      <A href="/models" class={`nav-item ${active('/models') ? 'is-active' : ''}`}><Sparkles size={17} /><span>{activeModelLabel()}</span></A>
      <A href="/providers" class={`nav-item ${active('/providers') ? 'is-active' : ''}`}><KeyRound size={17} /><span>Providers</span></A>
    </nav>
    {status() && <small class="warning">{status()}</small>}
    <div class="sidebar-footer"><A href="/settings" class={`nav-item ${active('/settings') ? 'is-active' : ''}`}><Settings size={18} /><span>Settings</span></A>{activeProject() && <div class="branch-row"><Folder size={17} /><span>{activeProject()!.name}</span></div>}</div>
  </aside>;
}
