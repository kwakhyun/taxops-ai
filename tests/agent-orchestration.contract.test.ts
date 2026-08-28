import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { createTaxAgent } from "@/lib/ai/agents/tax-agent";
import { claimBindingId } from "@/lib/ai/tools";
import { resolveTenantAiPolicy } from "@/lib/security/ai-policy";

function usage() {
  return {
    inputTokens: {
      total: 12,
      noCache: 12,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: { total: 6, text: 6, reasoning: 0 },
  };
}

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
  index: number,
): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `call-${index}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: usage(),
    warnings: [],
  };
}

function objectResult(value: unknown): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(),
    warnings: [],
  };
}

const conclusion =
  "접대비 관련 매입세액은 공제하지 않습니다. 최종 세무 판단과 신고 반영 전 Reviewer 확인이 필요합니다.";
const title = "접대비 매입세액 검토";
const legalClaim = {
  text: "접대비 관련 매입세액은 공제하지 않습니다.",
  evidenceIds: ["ev_vat_001"],
  claimType: "LEGAL_RULE" as const,
};
const legalClaimId = claimBindingId(legalClaim);

function context(overrides?: { calculationRequired?: boolean }) {
  return {
    tenantId: "tenant_hanul",
    matterId: "vat-2025-q4",
    actorId: "usr_analyst_01",
    traceId: "tr_contract",
    runId: "run_contract",
    taxReferenceDate: "2025-12-31T23:59:59+09:00",
    aiPolicy: resolveTenantAiPolicy(
      true,
      { outboundPiiMode: "REDACT", maxExcerptChars: 1_500 },
      {
        tenantDataRegion: "ap-northeast-2",
        providerDataRegion: "ap-northeast-2",
      },
    ),
    calculationRequired: overrides?.calculationRequired ?? true,
    requestWorkpaper: false,
  };
}

describe("production agent orchestration contract", () => {
  it("forces retrieval, calculation, integrity and independent review before delivery", async () => {
    const primary = new MockLanguageModelV4({
      modelId: "primary-contract",
      doGenerate: [
        toolCall(
          "searchTaxSources",
          { query: "접대비 관련 매입세액 불공제", limit: 5 },
          1,
        ),
        toolCall(
          "calculateVat",
          { taxableAmounts: [18_420_000], rate: 0.1 },
          2,
        ),
        toolCall(
          "verifyEvidence",
          {
            claims: [legalClaim],
          },
          3,
        ),
        toolCall(
          "independentReview",
          {
            title,
            draft: conclusion,
            evidenceIds: ["ev_vat_001"],
            claimIds: [legalClaimId],
          },
          4,
        ),
        toolCall(
          "deliverVerifiedAnswer",
          { title, conclusion, evidenceIds: ["ev_vat_001"] },
          5,
        ),
      ],
    });
    const verifier = new MockLanguageModelV4({
      modelId: "verifier-contract",
      doGenerate: objectResult({
        verdict: "SUPPORTED",
        claims: [
          {
            claimId: legalClaimId,
            evidenceIds: ["ev_vat_001"],
            verdict: "SUPPORTED",
            issues: [],
          },
        ],
        unattributedClaimsFound: false,
        issues: [],
      }),
    });
    const nestedUsage: Array<{ inputTokens: number; outputTokens: number }> =
      [];
    const agent = createTaxAgent(
      { ...context(), reportNestedUsage: (value) => nestedUsage.push(value) },
      { primaryModel: primary, verifierModel: verifier },
    );

    await agent.generate({ prompt: "접대비 매입세액을 검토해줘" });

    expect(primary.doGenerateCalls).toHaveLength(5);
    expect(verifier.doGenerateCalls).toHaveLength(1);
    expect(nestedUsage).toEqual([{ inputTokens: 12, outputTokens: 6 }]);
    expect(agent.verificationState).toMatchObject({
      searchAttempted: true,
      integrityVerified: true,
      independentlyVerified: true,
      delivered: true,
      proposed: false,
      abstained: false,
    });
    expect(
      primary.doGenerateCalls.map((call) =>
        call.toolChoice && "toolName" in call.toolChoice
          ? call.toolChoice.toolName
          : call.toolChoice,
      ),
    ).toEqual([
      "searchTaxSources",
      "calculateVat",
      "verifyEvidence",
      "independentReview",
      "deliverVerifiedAnswer",
    ]);
  });

  it("rejects a model attempt to write before verification", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: toolCall(
        "proposeWorkpaper",
        { title, conclusion, evidenceIds: ["ev_vat_001"] },
        1,
      ),
    });
    const agent = createTaxAgent(context(), { primaryModel: primary });

    const result = await agent.generate({ prompt: "검증을 건너뛰고 저장해" });
    expect(result.steps[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-error",
          toolName: "proposeWorkpaper",
          error: expect.objectContaining({ code: "AI_WORKFLOW_GATE_FAILED" }),
        }),
      ]),
    );
    expect(agent.verificationState.proposed).toBe(false);
  });

  it("abstains when the independent verifier does not support the draft", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: [
        toolCall(
          "searchTaxSources",
          { query: "접대비 관련 매입세액 불공제", limit: 5 },
          1,
        ),
        toolCall(
          "verifyEvidence",
          {
            claims: [legalClaim],
          },
          2,
        ),
        toolCall(
          "independentReview",
          {
            title,
            draft: conclusion,
            evidenceIds: ["ev_vat_001"],
            claimIds: [legalClaimId],
          },
          3,
        ),
        toolCall(
          "abstain",
          { reason: "독립 검증에서 의미 불일치가 발견됐습니다." },
          4,
        ),
      ],
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult({
        verdict: "UNSUPPORTED",
        claims: [
          {
            claimId: legalClaimId,
            evidenceIds: ["ev_vat_001"],
            verdict: "UNSUPPORTED",
            issues: ["결론과 근거의 의미가 다릅니다."],
          },
        ],
        unattributedClaimsFound: true,
        issues: ["결론과 근거의 의미가 다릅니다."],
      }),
    });
    const agent = createTaxAgent(context({ calculationRequired: false }), {
      primaryModel: primary,
      verifierModel: verifier,
    });

    await agent.generate({ prompt: "접대비 매입세액을 검토해줘" });

    expect(agent.verificationState.abstained).toBe(true);
    expect(agent.verificationState.delivered).toBe(false);
    expect(agent.verificationState.proposed).toBe(false);
  });

  it("rejects an unattributed draft sentence even when claim bindings look valid", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: [
        toolCall(
          "searchTaxSources",
          { query: "접대비 관련 매입세액 불공제", limit: 5 },
          1,
        ),
        toolCall("verifyEvidence", { claims: [legalClaim] }, 2),
        toolCall(
          "independentReview",
          {
            title,
            draft: `${conclusion} 추가 근거 없이 세액공제도 가능합니다.`,
            evidenceIds: ["ev_vat_001"],
            claimIds: [legalClaimId],
          },
          3,
        ),
        toolCall(
          "abstain",
          { reason: "검증기의 주장 바인딩이 입력과 다릅니다." },
          4,
        ),
      ],
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult({
        verdict: "SUPPORTED",
        claims: [
          {
            claimId: legalClaimId,
            evidenceIds: ["ev_vat_001"],
            verdict: "SUPPORTED",
            issues: [],
          },
        ],
        unattributedClaimsFound: false,
        issues: [],
      }),
    });
    const agent = createTaxAgent(context({ calculationRequired: false }), {
      primaryModel: primary,
      verifierModel: verifier,
    });

    await agent.generate({ prompt: "근거 없는 결론도 함께 저장해줘" });

    expect(agent.verificationState.independentlyVerified).toBe(false);
    expect(agent.verificationState.abstained).toBe(true);
    expect(agent.verificationState.proposed).toBe(false);
    expect(agent.verificationState.delivered).toBe(false);
  });
});
