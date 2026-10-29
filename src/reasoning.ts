import type { AccountModel } from './bridge';
import { BridgeError } from './errors';

// Only single-response efforts supported by this Responses bridge. Catalog-only
// modes such as ultra require agent orchestration that Assistant does not supply.
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ReasoningSource = 'assistant' | 'model-default' | 'unspecified';
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function reasoningCapabilities(model: AccountModel): { levels?: ReasoningEffort[]; defaultEffort?: ReasoningEffort } {
  let levels: ReasoningEffort[] | undefined;
  let defaultEffort: ReasoningEffort | undefined;
  // Prefer account-specific metadata, including an explicitly empty list.
  if (Array.isArray(model.supported_reasoning_levels)) {
    const offered = model.supported_reasoning_levels.map((level: any) => typeof level === 'string' ? level : level?.effort);
    levels = REASONING_EFFORTS.filter(level => offered.includes(level));
  } else {
    // Documented fallbacks for the existing account families only. Unknown and
    // future families must supply metadata instead of inheriting capabilities.
    if (/^gpt-(?:6\.1-sol|6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.slug)) levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-(?:6-(?:sol|luna)|5\.6(?:-(?:sol|terra|luna))?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.slug)) levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (levels) defaultEffort = 'medium';
  }
  if (isReasoningEffort(model.default_reasoning_level) && (!levels || levels.includes(model.default_reasoning_level))) defaultEffort = model.default_reasoning_level;
  return { levels, defaultEffort };
}

export function applyReasoning(request: any, model: AccountModel): { reasoningEffort?: ReasoningEffort; reasoningSource: ReasoningSource } {
  if (request.reasoning != null && (typeof request.reasoning !== 'object' || Array.isArray(request.reasoning)))
    throw new BridgeError(400, 'invalid_reasoning', 'Reasoning options must be an object.');
  const { levels, defaultEffort } = reasoningCapabilities(model);
  const selected = request.reasoning?.effort;
  if (selected != null) {
    if (!isReasoningEffort(selected)) throw new BridgeError(400, 'invalid_reasoning_effort', 'Select a thinking level offered by this model in Posit Assistant.');
    if (levels && !levels.includes(selected)) throw new BridgeError(400, 'unsupported_reasoning_effort', `Thinking level ${selected} is unavailable for this model. Select a supported level in Posit Assistant.`);
    return { reasoningEffort: selected, reasoningSource: 'assistant' };
  }
  if (defaultEffort) {
    // Make the default explicit so diagnostics describe the actual sent level.
    // Preserve summary/context and any other reasoning options from Assistant.
    request.reasoning = { ...request.reasoning, effort: defaultEffort };
    return { reasoningEffort: defaultEffort, reasoningSource: 'model-default' };
  }
  return { reasoningSource: 'unspecified' };
}

export function thinkingLabel(effort?: ReasoningEffort): string {
  if (!effort) return 'Model default (not reported)';
  if (effort === 'none') return 'None';
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
