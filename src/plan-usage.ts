export const PLAN_WINDOWS = ['5h', '7d'] as const;

export interface PlanWindowReading {
  usedPercent: number;
  remainingPercent: number;
  observedAt: string;
  resetsAt?: number;
  sharedChangePoints?: number;
}

export type PlanWindows = Partial<Record<typeof PLAN_WINDOWS[number], PlanWindowReading>>;

export interface ResponseTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PlanUsage {
  windows: PlanWindows;
  lastAssistantResponse?: { sequence: number; tokenUsage?: ResponseTokenUsage };
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
}

export function readPlanWindows(headers: Headers, previous: PlanWindows, now = Date.now()): PlanWindows {
  const readings: PlanWindows = {};
  for (const slot of ['primary', 'secondary']) {
    const prefix = `x-codex-${slot}`;
    const minutes = numericHeader(headers, `${prefix}-window-minutes`);
    const window = minutes === 300 ? '5h' : minutes === 10080 ? '7d' : undefined;
    const usedPercent = numericHeader(headers, `${prefix}-used-percent`);
    if (!window || usedPercent === undefined || usedPercent > 100 || readings[window]) continue;

    const reset = numericHeader(headers, `${prefix}-reset-at`);
    const resetsAt = reset !== undefined && Number.isSafeInteger(reset) && reset > 0 && reset <= 8.64e12 ? reset : undefined;
    const prior = previous[window];
    const reading: PlanWindowReading = {
      usedPercent,
      remainingPercent: Number(Math.max(0, 100 - usedPercent).toPrecision(12)),
      observedAt: new Date(now).toISOString(),
      resetsAt,
    };
    // Only compare readings known to belong to the same unexpired window.
    // The change is shared account activity, not a charge for either request.
    if (resetsAt && prior?.resetsAt === resetsAt && now < resetsAt * 1000)
      reading.sharedChangePoints = Number((usedPercent - prior.usedPercent).toPrecision(12));
    readings[window] = reading;
  }
  return readings;
}

export function readResponseTokens(usage: unknown): ResponseTokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return;
  const { input_tokens, output_tokens, total_tokens } = usage as Record<string, unknown>;
  const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (isCount(input_tokens) && isCount(output_tokens) && isCount(total_tokens))
    return { inputTokens: input_tokens, outputTokens: output_tokens, totalTokens: total_tokens };
}
