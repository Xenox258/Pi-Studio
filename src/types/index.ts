export type RouteId = 'workspace' | 'usage' | 'models' | 'discover' | 'installed' | 'updates' | 'settings' | 'onboarding';

export interface OmpCapabilities {
  version: string | null; rpc: boolean; workflowModeControl: boolean; advisorControl: boolean; loginControl: boolean; extensionUi: boolean; subagentEvents: boolean; usageCliJson: boolean; usageRpcRead: boolean; usageRpcReset: boolean; usageEvents: boolean;
}
export interface ProjectSummary { id: string; name: string; path: string; branch?: string; status?: string; }
export interface SessionSummary { id: string; title: string; projectId: string; updatedAt: string; active: boolean; }
export interface SessionConfiguration { model?: string; thinkingLevel?: string; sessionName?: string; }
export interface SessionSnapshot { project: ProjectSummary; messages: OmpMessage[]; model?: string; thinkingLevel?: string; title?: string; }
export interface SlashCommand { name: string; description?: string; aliases?: string[]; input?: { hint?: string }; subcommands?: { name: string; description?: string; usage?: string }[]; source?: string; }
export interface StudioSettings { processPolicy: 'Economy' | 'Balanced' | 'Parallel'; suspendBackground: boolean; cacheLimitMb: 50 | 100 | 200; onboardingCompleted: boolean; connectedProviders: string[]; }
export interface RuntimeStats { activeProcesses: number; }
export interface OmpModel { provider: string; id: string; selector: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; thinking: string[] | null; input: string[]; }
export interface EffortOption { value: string; label: string; description: string; intensity: number; backendValue: string; }
export interface AdaptiveEffortConfig { modelId: string; providerId: string; selectedValue: string; options: EffortOption[]; configurable: boolean; }
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
export type OmpMessage = Record<string, unknown>;
export interface OmpFramePayload { sessionId?: string; raw: Record<string, unknown>; }
export interface AdvisorNote { note: string; severity?: 'nit' | 'concern' | 'blocker'; advisor?: string; }
export interface ConversationMessageBase { id: string; title: string; body: string; timestamp: string; sequence: number; }
export interface ImageAttachment { id: string; dataUrl: string; mediaType: string; fileName?: string; }
export interface FileAttachment { id: string; path: string; fileName: string; }
export interface LoadedAttachment { fileName: string; path: string; mediaType: string | null; dataUrl: string | null; }
export interface UserMessageItem extends ConversationMessageBase { kind: 'user'; images?: ImageAttachment[]; files?: FileAttachment[]; }
export interface AdvisorMessageItem extends ConversationMessageBase { kind: 'advisor'; severity?: 'nit' | 'concern' | 'blocker'; }
export interface AssistantMessageItem extends ConversationMessageBase { kind: 'assistant' | 'error'; status?: 'streaming' | 'failed'; }
export type ConversationMessageItem = UserMessageItem | AdvisorMessageItem | AssistantMessageItem;
export type ToolActivityStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ToolActivityItem { id: string; toolName: string; displayName: string; status: ToolActivityStatus; input?: unknown; output?: unknown; summary?: string; startedAt: string; completedAt?: string; important: boolean; outputTruncated?: boolean; }
export interface RunActivity { id: string; runId: string; tools: ToolActivityItem[]; expanded: boolean; autoCollapsed: boolean; hasErrors: boolean; hasPendingConfirmation: boolean; userOpenedDuringRun: boolean; }
export interface ConversationRun { id: string; sessionId: string; userMessage: UserMessageItem; activity: RunActivity; advisorMessages: AdvisorMessageItem[]; assistantMessages: AssistantMessageItem[]; status: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt: string; completedAt?: string; }
export interface ActivitySummary { total: number; completed: number; failed: number; cancelled: number; searches: number; reads: number; edits: number; writes: number; commands: number; other: number; }
export interface ConversationNotice extends ConversationMessageBase { kind: 'error' | 'notice'; }
