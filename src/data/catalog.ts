import type { RoleMapping } from '../types';

export const defaultRoles: RoleMapping[] = [
  { id: 'default', label: 'Default', description: 'Fallback role used when no specific role is selected.', model: '', thinking: 'Medium', tone: 'purple' },
  { id: 'smol', label: 'Smol', description: 'Fast and efficient for simple, low-latency tasks.', model: '', thinking: 'Low', tone: 'green' },
  { id: 'slow', label: 'Slow', description: 'Maximum depth for complex analysis and reasoning.', model: '', thinking: 'Very High', tone: 'amber' },
  { id: 'plan', label: 'Plan', description: 'Break down objectives and create clear, actionable plans.', model: '', thinking: 'High', tone: 'blue' },
  { id: 'advisor', label: 'Advisor', description: 'Provide expert guidance and informed recommendations.', model: '', thinking: 'High', tone: 'purple' },
  { id: 'vision', label: 'Vision', description: 'Analyze images, diagrams, and visual context.', model: '', thinking: 'High', tone: 'cyan' },
  { id: 'task', label: 'Task', description: 'Execute tasks and complete focused work.', model: '', thinking: 'Medium', tone: 'amber' },
  { id: 'designer', label: 'Designer', description: 'Create and refine UI/UX and visual designs.', model: '', thinking: 'Medium', tone: 'pink' },
];

