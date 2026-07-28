import { invoke } from '@tauri-apps/api/core';
import type { CatalogMarketplace, GitSnapshot, GithubSnapshot, OmpCapabilities, OmpModel, OmpProvider, PackageInfo, ProjectSummary, RoleMapping, RuntimeStats, SessionSummary, StudioSettings, UsageSnapshot } from '../types';

const isTauri = () => '__TAURI_INTERNALS__' in window;

export async function callBackend<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error('This action requires the installed OMP Studio application.');
  return invoke<T>(command, args);
}

export const studioApi = {
  capabilities: () => callBackend<OmpCapabilities>('detect_omp_capabilities'),
  settings: () => callBackend<StudioSettings>('get_studio_settings'),
  saveSettings: (settings: StudioSettings) => callBackend<void>('save_studio_settings', { settings }),
  runtimeStats: () => callBackend<RuntimeStats>('runtime_stats'),
  catalog: (mode: 'discover' | 'installed' | 'updates' | 'local') => callBackend<PackageInfo[]>('catalog_packages', { mode }),
  marketplaces: () => callBackend<CatalogMarketplace[]>('catalog_marketplaces'),
  addMarketplace: (source: string) => callBackend<void>('add_catalog_marketplace', { source }),
  models: () => callBackend<OmpModel[]>('available_models'),
  providers: () => callBackend<OmpProvider[]>('available_providers'),
  openProject: (path: string) => callBackend<{ id: string; name: string; path: string }>('open_project', { path }),
  recentProjects: () => callBackend<ProjectSummary[]>('recent_projects'),
  recentSessions: () => callBackend<SessionSummary[]>('recent_sessions'),
  startSession: (projectId: string, projectPath: string) => callBackend<string>('start_session', { projectId, projectPath }),
  stopSession: (sessionId: string) => callBackend<void>('stop_session', { sessionId }),
  sendPrompt: (sessionId: string, message: string) => callBackend<void>('send_prompt', { sessionId, message }),
  steerPrompt: (sessionId: string, message: string) => callBackend<void>('steer_prompt', { sessionId, message }),
  followUpPrompt: (sessionId: string, message: string) => callBackend<void>('follow_up_prompt', { sessionId, message }),
  stopRun: (sessionId: string) => callBackend<void>('stop_run', { sessionId }),
  setWorkflowMode: (sessionId: string, mode: 'plan' | 'build') => callBackend<void>('set_workflow_mode', { sessionId, mode }),
  setAdvisor: (sessionId: string, enabled: boolean) => callBackend<void>('set_advisor_enabled', { sessionId, enabled }),
  setModel: (sessionId: string, model: string) => callBackend<void>('set_model', { sessionId, model }),
  setThinking: (sessionId: string, level: string) => callBackend<void>('set_thinking_level', { sessionId, level }),
  usage: (sessionId?: string, forceRefresh = false) => callBackend<UsageSnapshot>('usage_get_snapshot', { sessionId, forceRefresh }),
  consumeReset: (credentialId: string, creditId: string, idempotencyKey: string) => callBackend<string>('usage_consume_reset', { request: { credentialId, creditId, idempotencyKey } }),
  roles: (scope: string) => callBackend<RoleMapping[]>('get_role_mappings', { scope }),
  saveRoles: (scope: string, roles: RoleMapping[]) => callBackend<void>('save_role_mappings', { scope, roles }),
  git: (projectPath: string) => callBackend<GitSnapshot>('git_snapshot', { projectPath }),
  github: (projectPath: string) => callBackend<GithubSnapshot>('github_snapshot', { projectPath }),
  diff: (projectPath: string, filePath: string) => callBackend<string>('git_diff', { projectPath, filePath }),
  readFile: (projectPath: string, filePath: string) => callBackend<string>('read_project_file', { projectPath, filePath }),
  providerLogin: (providerId: string) => callBackend<void>('provider_login', { providerId }),
  providerLogout: (providerId: string) => callBackend<void>('provider_logout', { providerId }),
  providerTest: (providerId: string) => callBackend<boolean>('provider_test', { providerId }),
  managePackage: (packageId: string, action: 'install' | 'uninstall' | 'upgrade' | 'enable' | 'disable', scope: 'user' | 'project', projectPath?: string) => callBackend<void>('manage_package', { packageId, action, scope, projectPath }),
};
