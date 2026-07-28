export type RouteId = 'workspace' | 'usage' | 'models' | 'discover' | 'installed' | 'updates' | 'local' | 'settings' | 'onboarding';

export interface OmpCapabilities {
  version: string | null; rpc: boolean; workflowModeControl: boolean; advisorControl: boolean; loginControl: boolean; extensionUi: boolean; subagentEvents: boolean; usageCliJson: boolean; usageRpcRead: boolean; usageRpcReset: boolean; usageEvents: boolean;
}
export interface ProjectSummary { id: string; name: string; path: string; branch?: string; status?: string; }
export interface SessionSummary { id: string; title: string; projectId: string; updatedAt: string; active: boolean; }
export interface StudioSettings { processPolicy: 'Economy' | 'Balanced' | 'Parallel'; suspendBackground: boolean; cacheLimitMb: 50 | 100 | 200; onboardingCompleted: boolean; }
export interface RuntimeStats { activeProcesses: number; }
export interface OmpModel { provider: string; id: string; selector: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; thinking: string[] | null; input: string[]; }
export interface OmpProvider { id: string; name: string; }
export interface UsageLimit { id: string; label: string; usedPercent: number; resetsAt?: string; }
export interface ResetCredits { available: number; credits: { id: string; applicable: boolean; expiresAt?: string }[]; }
export interface AccountUsage { credentialId: string; displayLabel: string; organizationLabel?: string; authKind: 'subscription' | 'apiKey' | 'unknown'; planType?: string; activeForSession: boolean; limits: UsageLimit[]; resetCredits?: ResetCredits; }
export interface ProviderUsage { providerId: string; providerName: string; accounts: AccountUsage[]; }
export interface UsageSnapshot { fetchedAt: string; source: 'ompRpc' | 'ompCli' | 'cache'; stale: boolean; providers: ProviderUsage[]; }
export interface RoleMapping { id: string; label: string; description: string; model: string; thinking: string; tone: string; }
export interface PackageInfo { id: string; name: string; author: string; description: string; kind: string; version: string; downloads?: string; installed?: boolean; updateAvailable?: boolean; compatibility: string; permissions: string[]; resources: { type: string; count: number }[]; }
export interface CatalogMarketplace { name: string; source: string; }
export interface GitSnapshot { branch: string; remoteUrl?: string; clean: boolean; changedFiles: { path: string; additions: number; deletions: number }[]; lastCommit?: string; branches: string[]; worktrees: string[]; }
export interface GithubSnapshot { available: boolean; repository?: string; url?: string; pullRequest?: string; checkedAt: string; }
export interface ConversationEvent { id: string; kind: 'user' | 'assistant' | 'planner' | 'advisor' | 'subagent' | 'tool' | 'error'; title: string; body: string; status?: string; timestamp: string; }
