import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { createTaxAgent } from "@/lib/ai/agents/tax-agent";
import {
  claimBindingId,
  createTaxTools,
  createVerificationState,
  renderVerifiedClaimBody,
  renderVerifiedConclusion,
  verificationArtifactHash,
} from "@/lib/ai/tools";
import { resolveTaxMemoPrompt } from "@/lib/ai/prompts/tax-memo.v1";
import { resolveTenantAiPolicy } from "@/lib/security/ai-policy";

function usage() {
  return {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
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
  "기업업무추진비 관련 매입세액은 공제하지 않습니다. 최종 세무 판단과 신고 반영 전 검토자 확인이 필요합니다.";
const title = "기업업무추진비 매입세액 검토";
const question = "기업업무추진비 관련 매입세액 불공제 근거를 확인해 주세요.";
const legalClaim = {
  text: "기업업무추진비 관련 매입세액은 공제하지 않습니다.",
  evidenceIds: ["ev_vat_001"],
  claimType: "LEGAL_RULE" as const,
};
const legalClaimId = claimBindingId(legalClaim);

function context(
  overrides: Partial<{
    calculationRequired: boolean;
    requestWorkpaper: boolean;
    question: string;
  }> = {},
) {
  return {
    tenantId: "tenant_hanul",
    matterId: "vat-2025-q4",
    actorId: "usr_analyst_01",
    traceId: "tr_contract",
    runId: "run_contract",
    question,
    taxReferenceDate: "2025-12-31T23:59:59+09:00",
    aiPolicy: resolveTenantAiPolicy(
      true,
      { outboundPiiMode: "REDACT", maxExcerptChars: 1_500 },
      {
        tenantDataRegion: "ap-northeast-2",
        providerDataRegion: "ap-northeast-2",
      },
    ),
    calculationRequired: false,
    requestWorkpaper: false,
    ...overrides,
  };
}

function reviewOutput(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "SUPPORTED",
    questionCoverage: "COMPLETE",
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
    ...overrides,
  };
}

function steps(
  options: {
    calculate?: boolean;
    reviewInput?: Record<string, unknown>;
    terminal?: string;
    terminalInput?: Record<string, unknown>;
  } = {},
) {
  return [
    toolCall("searchTaxSources", {}, 1),
    ...(options.calculate
      ? [
          toolCall(
            "calculateVat",
            { taxableAmounts: [18_420_000], rate: 0.1 },
            2,
          ),
        ]
      : []),
    toolCall("verifyEvidence", { claims: [legalClaim] }, 3),
    toolCall("independentReview", options.reviewInput ?? { title }, 4),
    toolCall(
      options.terminal ?? "deliverVerifiedAnswer",
      options.terminalInput ?? {},
      5,
    ),
  ];
}

const abstain = () =>
  toolCall("abstain", { reason: "검증 조건을 충족하지 못했습니다." }, 6);

describe("production agent orchestration contract", () => {
  it("binds the question and delivers the server artifact without model retyping", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: steps({ calculate: true }),
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult(reviewOutput()),
    });
    const nestedUsage: Array<{ inputTokens: number; outputTokens: number }> =
      [];
    const agent = createTaxAgent(
      {
        ...context({ calculationRequired: true }),
        reportNestedUsage: (value) => nestedUsage.push(value),
      },
      { primaryModel: primary, verifierModel: verifier },
    );

    const result = await agent.generate({ prompt: question });
    expect(primary.doGenerateCalls).toHaveLength(5);
    expect(verifier.doGenerateCalls).toHaveLength(1);
    const message = verifier.doGenerateCalls[0]!.prompt.find(
      (item) => item.role === "user",
    );
    const text = message?.content.find((part) => part.type === "text");
    expect(text?.type).toBe("text");
    const input = JSON.parse(text!.text);
    expect(input.question).toBe(question);
    expect(input.draft).toBe(legalClaim.text);
    expect(input.claims).toEqual([{ id: legalClaimId, ...legalClaim }]);
    expect(
      renderVerifiedConclusion(agent.verificationState.verifiedClaims),
    ).toBe(conclusion);
    expect(result.steps.at(-1)?.toolResults[0]?.output).toMatchObject({
      title,
      conclusion,
      evidenceIds: ["ev_vat_001"],
      verified: true,
    });
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
    expect(
      primary.doGenerateCalls.every((call) => call.tools?.length === 1),
    ).toBe(true);
  });

  it("rejects an early write and completes with an explicit abstention", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: [toolCall("proposeWorkpaper", {}, 1), abstain()],
    });
    const agent = createTaxAgent(context(), { primaryModel: primary });
    const result = await agent.generate({ prompt: "검증을 건너뛰고 저장해" });
    expect(result.steps[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-error",
          toolName: "proposeWorkpaper",
        }),
      ]),
    );
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(agent.verificationState.proposed).toBe(false);
    expect(agent.verificationState.abstained).toBe(true);
  });

  it.each(["PARTIAL", "NONE"])(
    "rejects a SUPPORTED verdict with %s question coverage",
    async (questionCoverage) => {
      const primary = new MockLanguageModelV4({
        doGenerate: steps({
          terminal: "abstain",
          terminalInput: { reason: "원래 질문을 충분히 다루지 못했습니다." },
        }),
      });
      const verifier = new MockLanguageModelV4({
        doGenerate: objectResult(reviewOutput({ questionCoverage })),
      });
      const agent = createTaxAgent(context(), {
        primaryModel: primary,
        verifierModel: verifier,
      });
      const result = await agent.generate({ prompt: question });
      expect(agent.verificationState.independentlyVerified).toBe(false);
      expect(agent.verificationState.delivered).toBe(false);
      expect(agent.verificationState.abstained).toBe(true);
      const review = result.steps
        .flatMap((step) => step.toolResults)
        .find((item) => item.toolName === "independentReview");
      expect(review?.output).toMatchObject({
        verdict: "UNSUPPORTED",
        questionCoverage,
      });
    },
  );

  it.each([
    { verdict: "UNSUPPORTED" },
    { unattributedClaimsFound: true },
    { questionCoverage: undefined },
    {
      claims: [{ ...reviewOutput().claims[0], evidenceIds: ["ev_return_007"] }],
    },
    { claims: [reviewOutput().claims[0], reviewOutput().claims[0]] },
  ])("fails closed on invalid semantic review: %j", async (override) => {
    const primary = new MockLanguageModelV4({
      doGenerate: steps({
        terminal: "abstain",
        terminalInput: { reason: "독립 검증이 실패했습니다." },
      }),
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult(reviewOutput(override)),
    });
    const agent = createTaxAgent(context(), {
      primaryModel: primary,
      verifierModel: verifier,
    });
    await agent.generate({ prompt: question });
    expect(agent.verificationState.independentlyVerified).toBe(false);
    expect(agent.verificationState.abstained).toBe(true);
    expect(agent.verificationState.delivered).toBe(false);
  });

  it("does not accept a model-supplied replacement draft at independent review", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: steps({
        reviewInput: {
          title,
          draft: conclusion + " 근거 없이 세액공제도 가능합니다.",
          evidenceIds: ["ev_vat_001"],
          claimIds: [legalClaimId],
        },
        terminal: "abstain",
        terminalInput: { reason: "서버의 검증본을 바꿀 수 없습니다." },
      }),
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult(reviewOutput()),
    });
    const agent = createTaxAgent(context(), {
      primaryModel: primary,
      verifierModel: verifier,
    });
    await agent.generate({ prompt: question });
    expect(verifier.doGenerateCalls).toHaveLength(0);
    expect(agent.verificationState.abstained).toBe(true);
    expect(agent.verificationState.delivered).toBe(false);
  });

  it("rejects terminal content injection even after a successful review", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: [
        ...steps({
          terminalInput: {
            title,
            conclusion: conclusion + " 전액 공제 가능",
            evidenceIds: ["ev_vat_001"],
          },
        }),
        abstain(),
      ],
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult(reviewOutput()),
    });
    const agent = createTaxAgent(context(), {
      primaryModel: primary,
      verifierModel: verifier,
    });
    await agent.generate({ prompt: question });
    expect(agent.verificationState.independentlyVerified).toBe(true);
    expect(agent.verificationState.delivered).toBe(false);
    expect(agent.verificationState.abstained).toBe(true);
  });

  it("rechecks the artifact if server state changes after independent review", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: [...steps(), abstain()],
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult(reviewOutput()),
    });
    const agent = createTaxAgent(context(), {
      primaryModel: primary,
      verifierModel: verifier,
    });
    await agent.generate({
      prompt: question,
      onStepEnd: ({ toolResults }) => {
        if (toolResults.some((item) => item.toolName === "independentReview")) {
          agent.verificationState.calculations.push({ vat: 999 });
        }
      },
    });
    expect(agent.verificationState.delivered).toBe(false);
    expect(agent.verificationState.abstained).toBe(true);
  });

  it("never persists a workpaper from a read-only run, even after verification", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: [...steps({ terminal: "proposeWorkpaper" }), abstain()],
    });
    const verifier = new MockLanguageModelV4({
      doGenerate: objectResult(reviewOutput()),
    });
    const agent = createTaxAgent(context(), {
      primaryModel: primary,
      verifierModel: verifier,
    });
    await agent.generate({ prompt: question });
    expect(agent.verificationState.proposed).toBe(false);
    expect(agent.verificationState.abstained).toBe(true);
  });

  it("does not replace the original question with model-chosen retrieval terms", async () => {
    const state = createVerificationState();
    const prompt = resolveTaxMemoPrompt();
    const tools = createTaxTools(
      {
        ...context({ question: "zzqxj neverpresentneedle" }),
        promptVersion: prompt.id,
        promptHash: prompt.contentHash,
      },
      state,
    );
    await tools.searchTaxSources.execute!(
      { query: "기업업무추진비 관련 매입세액 불공제", limit: 8 },
      { toolCallId: "original-question", messages: [], context: {} },
    );
    expect(state.searchAttempted).toBe(true);
    expect(state.evidence.size).toBe(0);
  });

  it("includes the original question in the verification artifact binding", () => {
    const state = createVerificationState();
    const base = { ...context(), promptHash: "prompt" };
    const hash = (question: string) =>
      verificationArtifactHash(
        title,
        conclusion,
        [],
        [],
        state.evidence,
        state.verifiedClaims,
        { ...base, question },
      );
    expect(hash(question)).not.toBe(hash("다른 세목의 질문"));
  });

  it("never strips a policy-looking sentence supplied as a claim", () => {
    const state = createVerificationState();
    const claim = { ...legalClaim, text: conclusion };
    const id = claimBindingId(claim);
    state.verifiedClaims.set(id, { id, ...claim });
    expect(renderVerifiedClaimBody(state.verifiedClaims)).toBe(conclusion);
    expect(renderVerifiedConclusion(state.verifiedClaims)).toBe(
      conclusion + " 최종 세무 판단과 신고 반영 전 검토자 확인이 필요합니다.",
    );
  });

  it("does not produce a review notice without any verified claim", () => {
    const state = createVerificationState();
    expect(renderVerifiedClaimBody(state.verifiedClaims)).toBe("");
    expect(renderVerifiedConclusion(state.verifiedClaims)).toBe("");
  });
});
