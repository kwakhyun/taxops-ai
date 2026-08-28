export interface AiBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxEstimatedCostKrw: number;
  timeoutMs: number;
}

export const defaultAiBudget: AiBudget = {
  maxSteps: 8,
  maxToolCalls: 6,
  maxInputTokens: 18_000,
  maxOutputTokens: 3_000,
  maxEstimatedCostKrw: 300,
  timeoutMs: 20_000,
};

export class AiBudgetExceededError extends Error {
  readonly status = 429;
  readonly code = "AI_BUDGET_EXCEEDED";

  constructor(readonly dimension: keyof AiBudget) {
    super(`AI budget exceeded: ${dimension}`);
    this.name = "AiBudgetExceededError";
  }
}

export function estimateAiCostKrw(input: {
  inputTokens: number;
  outputTokens: number;
}) {
  const { inputKrwPerMillion, outputKrwPerMillion } = aiPricing();
  return (
    (input.inputTokens * inputKrwPerMillion +
      input.outputTokens * outputKrwPerMillion) /
    1_000_000
  );
}

export function aiPricing(
  input = {
    input: process.env.AI_INPUT_KRW_PER_MTOK ?? "5000",
    output: process.env.AI_OUTPUT_KRW_PER_MTOK ?? "25000",
  },
) {
  const inputKrwPerMillion = Number(input.input);
  const outputKrwPerMillion = Number(input.output);
  if (
    !Number.isFinite(inputKrwPerMillion) ||
    inputKrwPerMillion < 0 ||
    !Number.isFinite(outputKrwPerMillion) ||
    outputKrwPerMillion < 0
  ) {
    throw Object.assign(
      new Error("AI token pricing must be finite and non-negative"),
      {
        code: "AI_PRICING_INVALID",
        status: 503,
      },
    );
  }
  return { inputKrwPerMillion, outputKrwPerMillion };
}

export function assertAiBudget(
  usage: Partial<Record<keyof AiBudget, number>>,
  budget = defaultAiBudget,
) {
  for (const key of Object.keys(usage) as Array<keyof AiBudget>) {
    const value = usage[key];
    if (value !== undefined && value > budget[key])
      throw new AiBudgetExceededError(key);
  }
}
