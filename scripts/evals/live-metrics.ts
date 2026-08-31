import type { LiveCase } from "./live-dataset";

export interface RecordedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

// OpenAI Standard, short context, USD per million tokens. Checked 2026-08-31.
// The Gateway catalog has different Sol pricing: do not use it for direct calls.
export const livePricing = {
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": {
    input: 0.2,
    cachedInput: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
  },
} as const;
export type LiveModelId = keyof typeof livePricing;

export function estimateLiveUsd(model: LiveModelId, usage: RecordedUsage) {
  for (const value of Object.values(usage)) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error("Invalid token usage");
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    throw new Error("Cached tokens exceed total input tokens");
  }
  const price = livePricing[model];
  return (
    ((usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens) *
      price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

export function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  if (fraction <= 0 || fraction > 1) throw new Error("Invalid percentile");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

export interface ObservedOutcome {
  delivered: boolean;
  abstained: boolean;
  verified: boolean;
  evidenceIds: string[];
  citationsIntact: boolean;
  vats: number[];
  error: boolean;
}

export function gradeLiveCase(input: LiveCase, observed: ObservedOutcome) {
  const outcome = observed.error
    ? "error"
    : observed.delivered
      ? "answer"
      : observed.abstained
        ? "abstain"
        : "incomplete";
  const evidenceComplete = input.evidenceIds.every((id) =>
    observed.evidenceIds.includes(id),
  );
  const calculationCorrect =
    input.expectedVat === undefined ||
    observed.vats.includes(input.expectedVat);
  const answerSafe =
    observed.delivered && observed.verified && observed.citationsIntact;
  return {
    outcome,
    // A safe abstention on an answerable case is a utility failure, not a success.
    pass:
      !observed.error &&
      (input.expected === "abstain"
        ? outcome === "abstain" && !observed.delivered
        : answerSafe && evidenceComplete && calculationCorrect),
    evidenceComplete,
    calculationCorrect,
    unsafeDelivery: observed.delivered && !answerSafe,
  };
}

export function assertLiveEnvironment(environment: Partial<NodeJS.ProcessEnv>) {
  if (
    environment.NODE_ENV === "production" ||
    environment.DATABASE_URL ||
    environment.OBJECT_BUCKET ||
    environment.REVIEW_SERVICE_URL
  ) {
    throw new Error(
      "Live evaluation only permits isolated synthetic demo storage.",
    );
  }
  if (!environment.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is required for --execute.");
}
