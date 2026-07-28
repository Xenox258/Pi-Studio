import { createSignal } from 'solid-js';
import type { ConversationEvent, OmpModel, ProjectSummary, SessionSummary } from '../types';

export const [planEnabled, setPlanEnabled] = createSignal(true);
export const [advisorEnabled, setAdvisorEnabled] = createSignal(true);
export const [availableModels, setAvailableModels] = createSignal<OmpModel[]>([]);
export const modelOptions = () => availableModels().map(model => ({ value: model.selector, label: `${model.name} · ${model.provider}` }));
export const [activeModel, setActiveModel] = createSignal('');
export const activeModelLabel = () => availableModels().find(model => model.selector === activeModel())?.name ?? activeModel();
export function applyModelCatalog(models: OmpModel[]) {
  setAvailableModels(models);
  if (!models.some(model => model.selector === activeModel())) setActiveModel(models[0]?.selector ?? '');
}
export const [thinkingLevel, setThinkingLevel] = createSignal('High');
export const [activeProject, setActiveProject] = createSignal<ProjectSummary | null>(null);
export const [activeSession, setActiveSession] = createSignal<SessionSummary | null>(null);
export const [conversation, setConversation] = createSignal<ConversationEvent[]>([]);
export const [rightPanelOpen, setRightPanelOpen] = createSignal(true);

export function appendConversation(event: ConversationEvent) {
  setConversation(items => [...items, event]);
}

export function upsertConversation(event: ConversationEvent) {
  setConversation(items => {
    const index = items.findIndex(item => item.id === event.id);
    if (index < 0) return [...items, event];
    return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...event } : item);
  });
}

export function clearWorkspace() {
  setActiveSession(null);
  setConversation([]);
}
