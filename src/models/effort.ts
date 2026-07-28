import type { AdaptiveEffortConfig, EffortOption, OmpModel } from '../types';

export function normalizeEffortValue(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'veryhigh' || normalized === 'ultracode') return 'xhigh';
  return value.trim().toLowerCase();
}

function effortLabel(backendValue: string): string {
  return backendValue.trim().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[-_\s]+/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function effortDescription(label: string, index: number, count: number): string {
  if (count === 1) return `${label} is the only reasoning level reported by OMP for this model.`;
  return `${label} · OMP reasoning level ${index + 1} of ${count} for this model.`;
}

export function resolveEffortConfig(model: OmpModel | undefined, selected: string): AdaptiveEffortConfig {
  const seen = new Set<string>();
  const available = (model?.thinking ?? []).flatMap(backendValue => {
    const value = normalizeEffortValue(backendValue);
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [{ value, backendValue }];
  });
  const levels: EffortOption[] = available.map(({ value, backendValue }, index) => {
    const label = effortLabel(backendValue);
    const intensity = value === 'off' ? 0 : Math.max(1, Math.ceil(((index + 1) / available.length) * 4));
    return { value, backendValue, label, description: effortDescription(label, index, available.length), intensity };
  });
  if (!levels.length) {
    return { modelId: model?.selector ?? '', providerId: model?.provider ?? '', selectedValue: 'default', configurable: false, options: [{ value: 'default', label: 'Default', description: 'OMP reports no configurable reasoning levels for this model.', intensity: 0, backendValue: '' }] };
  }
  const requested = normalizeEffortValue(selected);
  const selectedValue = levels.some(option => option.value === requested) ? requested : (levels.find(option => option.value === 'high') ?? levels.find(option => option.value === 'medium') ?? levels[0]).value;
  return { modelId: model?.selector ?? '', providerId: model?.provider ?? '', selectedValue, configurable: true, options: levels };
}
