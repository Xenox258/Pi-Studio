import { invoke } from '@tauri-apps/api/core';
import type { CatalogMarketplace, GitSnapshot, GithubSnapshot, ImageAttachment, LoadedAttachment, OmpCapabilities, OmpMessage, OmpModel, OmpProvider, PackageInfo, ProjectSummary, RoleMapping, RuntimeStats, SessionConfiguration, SessionSnapshot, SessionSummary, SlashCommand, StudioSettings, UsageSnapshot } from '../types';

const isTauri = () => '__TAURI_INTERNALS__' in window;

// Tauri rejects with the plain `Err(String)` payload, not an Error, so every `catch` that tested
// `instanceof Error` silently replaced the backend's real reason with a generic fallback.
export async function callBackend<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error('This action requires the installed OMP Studio application.');
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    if (cause instanceof Error) throw cause;
    throw new Error(typeof cause === 'string' ? cause : `${command} failed: ${JSON.stringify(cause)}`);
  }
}

export const studioApi = {
  capabilities: () => callBackend<OmpCapabilities>('detect_omp_capabilities'),
  settings: () => callBackend<StudioSettings>('get_studio_settings'),
  saveSettings: (settings: StudioSettings) => callBackend<void>('save_studio_settings', { settings }),
  runtimeStats: () => callBackend<RuntimeStats>('runtime_stats'),
  catalog: (mode: 'discover' | 'installed' | 'updates' | 'local') => callBackend<PackageInfo[]>('catalog_packages', { mode }),
  marketplaces: () => callBackend<CatalogMarketplace[]>('catalog_marketplaces'),
  addMarketplace: (source: string) => callBackend<void>('add_catalog_marketplace', { source }),
  catalogReadme: (packageId: string) => callBackend<string>('catalog_readme', { packageId }),
  models: () => callBackend<OmpModel[]>('available_models'),
  providers: () => callBackend<OmpProvider[]>('available_providers'),
  openProject: (path: string) => callBackend<{ id: string; name: string; path: string }>('open_project', { path }),
  createProject: (parentPath: string, name: string) => callBackend<{ id: string; name: string; path: string }>('create_project', { parentPath, name }),
  recentProjects: () => callBackend<ProjectSummary[]>('recent_projects'),
  recentSessions: () => callBackend<SessionSummary[]>('recent_sessions'),
  setSessionTitle: (sessionId: string, title: string) => callBackend<void>('set_session_title', { sessionId, title }),
  startSession: (projectId: string, projectPath: string, advisorEnabled: boolean) => callBackend<string>('start_session', { projectId, projectPath, advisorEnabled }),
  resumeSession: (sessionId: string, advisorEnabled: boolean) => callBackend<ProjectSummary>('resume_session', { sessionId, advisorEnabled }),
  conversationHistory: (sessionId: string) => callBackend<OmpMessage[]>('conversation_history', { sessionId }),
  sessionConfiguration: (sessionId: string) => callBackend<SessionConfiguration>('session_configuration', { sessionId }),
  sessionSnapshot: (sessionId: string) => callBackend<SessionSnapshot>('session_snapshot', { sessionId }),
  availableCommands: (sessionId: string) => callBackend<SlashCommand[]>('available_commands', { sessionId }),
  stopSession: (sessionId: string) => callBackend<void>('stop_session', { sessionId }),
  deleteSession: (sessionId: string) => callBackend<void>('delete_session', { sessionId }),
  sendPrompt: (sessionId: string, message: string, images?: ImageAttachment[]) => callBackend<boolean>('send_prompt', { sessionId, message, images: images ?? [] }),
  steerPrompt: (sessionId: string, message: string, images?: ImageAttachment[]) => callBackend<boolean>('steer_prompt', { sessionId, message, images: images ?? [] }),
  followUpPrompt: (sessionId: string, message: string, images?: ImageAttachment[]) => callBackend<boolean>('follow_up_prompt', { sessionId, message, images: images ?? [] }),
  stopRun: (sessionId: string) => callBackend<void>('stop_run', { sessionId }),
  readClipboardImage: () => callBackend<string | null>('read_clipboard_image'),
  loadAttachment: (path: string) => callBackend<LoadedAttachment>('load_attachment', { path }),
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
  providerApiKeyLogin: (providerId: string, apiKey: string) => callBackend<void>('provider_api_key_login', { providerId, apiKey }),
  managePackage: (packageId: string, action: 'install' | 'uninstall' | 'upgrade' | 'enable' | 'disable', scope: 'user' | 'project', projectPath?: string) => callBackend<void>('manage_package', { packageId, action, scope, projectPath }),
};
