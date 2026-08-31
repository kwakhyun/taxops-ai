import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLiveEnvironment,
  estimateLiveUsd,
  gradeLiveCase,
  percentile,
} from "../scripts/evals/live-metrics";
import { liveCases } from "../scripts/evals/live-dataset";
import { validationCases } from "../scripts/evals/validation-dataset";
import { resolveLivePrompt } from "../scripts/evals/live-prompts";
import { resolveTaxMemoPrompt } from "../src/lib/ai/prompts/tax-memo.v1";

describe("live evaluation honesty and isolation", () => {
  it("preserves the rejected experiment and selects only the registered release", () => {
    const current = resolveLivePrompt("current");
    const candidate = resolveLivePrompt("grounded");
    expect(current.contentHash).toBe(
      resolveTaxMemoPrompt("tax-memo.v1.3.1").contentHash,
    );
    expect(resolveLivePrompt("question-bound").contentHash).toBe(
      resolveTaxMemoPrompt().contentHash,
    );
    expect(candidate.contentHash).not.toBe(current.contentHash);
    expect(candidate.id).toBe("tax-memo.v1.3.2-candidate");
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(() => resolveTaxMemoPrompt(candidate.id)).toThrow();
  });
  it("keeps the separately frozen validation questions out of the development set", () => {
    expect(validationCases).toHaveLength(12);
    expect(
      validationCases.filter((item) => item.expected === "answer"),
    ).toHaveLength(6);
    expect(
      validationCases.every(
        (item) =>
          !liveCases.some(
            (development) =>
              development.id === item.id ||
              development.question === item.question,
          ),
      ),
    ).toBe(true);
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            new URL("../scripts/evals/validation-dataset.ts", import.meta.url),
          ),
        )
        .digest("hex"),
    ).toBe("1253741ee1be637d365fb25d1d9002d974a3f35e728ab3df993df47c98e14490");
  });
  const valid = {
    delivered: true,
    abstained: false,
    verified: true,
    evidenceIds: ["ev_vat_001"],
    citationsIntact: true,
    vats: [],
    error: false,
  };
  it("does not count a safe but unnecessary abstention as an answer success", () => {
    expect(
      gradeLiveCase(liveCases[0]!, {
        ...valid,
        delivered: false,
        abstained: true,
      }).pass,
    ).toBe(false);
    expect(gradeLiveCase(liveCases[0]!, valid).pass).toBe(true);
  });
  it("requires intact citations and independent verification for delivery", () => {
    expect(
      gradeLiveCase(liveCases[0]!, { ...valid, citationsIntact: false })
        .unsafeDelivery,
    ).toBe(true);
    expect(
      gradeLiveCase(liveCases[0]!, { ...valid, verified: false }).pass,
    ).toBe(false);
  });
  it("requires abstention, not provider errors or unrelated verified answers", () => {
    expect(gradeLiveCase(liveCases[5]!, valid)).toMatchObject({
      outcome: "answer",
      pass: false,
      unsafeDelivery: false,
    });
    expect(
      gradeLiveCase(liveCases[5]!, {
        ...valid,
        delivered: false,
        abstained: true,
        error: true,
      }).pass,
    ).toBe(false);
  });
  it("requires the expected VAT and all case evidence", () => {
    expect(gradeLiveCase(liveCases[4]!, valid).pass).toBe(false);
    expect(
      gradeLiveCase(liveCases[4]!, {
        ...valid,
        evidenceIds: ["ev_vat_001", "ev_ledger_019"],
        vats: [1842000],
      }).pass,
    ).toBe(true);
  });
  it("accounts for cached input once and rejects invalid usage", () => {
    expect(
      estimateLiveUsd("gpt-5.6-luna", {
        inputTokens: 1000,
        cachedInputTokens: 500,
        cacheWriteTokens: 0,
        outputTokens: 100,
      }),
    ).toBeCloseTo(0.00023);
    expect(() =>
      estimateLiveUsd("gpt-5.6-sol", {
        inputTokens: 10,
        cachedInputTokens: 11,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toThrow();
  });
  it("reports nearest-rank p95 and no statistic for an empty sample", () => {
    expect(percentile([30, 10, 20], 0.95)).toBe(30);
    expect(percentile([], 0.95)).toBeNull();
  });
  it("refuses production data even with a valid key", () => {
    expect(() =>
      assertLiveEnvironment({
        NODE_ENV: "production",
        OPENAI_API_KEY: "test-only",
      }),
    ).toThrow();
    expect(() =>
      assertLiveEnvironment({
        DATABASE_URL: "configured",
        OPENAI_API_KEY: "test-only",
      }),
    ).toThrow();
    expect(() =>
      assertLiveEnvironment({ OPENAI_API_KEY: "test-only" }),
    ).not.toThrow();
  });
});
