import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { evidence } from "../src/lib/domain/fixtures";
import {
  RETRIEVER_VERSION,
  retrieveEvidence,
  verifyCitationExcerpt,
  verifyClaims,
} from "../src/lib/ai/retrieval";
import { detectPromptInjection } from "../src/lib/ai/guardrails";
import { goldenSet } from "../tests/fixtures/golden-set";
import { resolveTaxMemoPrompt } from "../src/lib/ai/prompts/tax-memo.v1";
import { createTaxAgent } from "../src/lib/ai/agents/tax-agent";
import { claimBindingId } from "../src/lib/ai/tools";
import { estimateAiCostKrw } from "../src/lib/ai/budget";
import {
  protectAiOutboundWithDlp,
  resolveTenantAiPolicy,
} from "../src/lib/security/ai-policy";

const selectedPrompt = resolveTaxMemoPrompt();

function mockUsage() {
  return {
    inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 60, text: 60, reasoning: 0 },
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
        toolCallId: `eval-call-${index}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: mockUsage(),
    warnings: [],
  };
}

function objectResult(value: unknown): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: mockUsage(),
    warnings: [],
  };
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

const retrieval = goldenSet.filter((item) => item.category === "retrieval");
const abstention = goldenSet.filter((item) => item.category === "abstention");
const security = goldenSet.filter((item) => item.category === "security");
const claimIntegrityCases = [
  {
    claim: "기업업무추진비 관련 매입세액은 공제하지 않습니다.",
    evidenceId: "ev_vat_001",
    claimType: "LEGAL_RULE",
    expected: true,
  },
  {
    claim: "기업업무추진비 관련 매입세액은 공제합니다.",
    evidenceId: "ev_vat_001",
    claimType: "LEGAL_RULE",
    expected: false,
  },
  {
    claim: "서울은 프랑스의 수도다.",
    evidenceId: "ev_vat_001",
    claimType: "LEGAL_RULE",
    expected: false,
  },
  {
    claim: "원장 분석 결과와 740,000원 차이가 없었습니다.",
    evidenceId: "ev_return_007",
    claimType: "TRANSACTION_FACT",
    expected: false,
  },
  {
    claim: "불공제 매입세액 합계는 1,102,000원이 아닙니다.",
    evidenceId: "ev_return_007",
    claimType: "TRANSACTION_FACT",
    expected: false,
  },
  {
    claim: "기업업무추진비는 사업과 직접 관련된 지출입니다.",
    evidenceId: "ev_vat_001",
    claimType: "LEGAL_RULE",
    expected: false,
  },
] as const;

const results = goldenSet.map((item) => {
  const hits = retrieveEvidence({
    tenantId: "tenant_hanul",
    matterId: "vat-2025-q4",
    query: item.query,
    limit: 5,
  });
  const foreignTenantHits = retrieveEvidence({
    tenantId: "tenant_other",
    matterId: "vat-2025-q4",
    query: item.query,
    limit: 5,
  });
  const expected = evidence.find(
    (source) => source.id === item.expectedEvidenceId,
  );
  const retrievalPass =
    item.category !== "retrieval" ||
    hits.some((hit) => hit.id === item.expectedEvidenceId);
  const abstentionPass = item.category !== "abstention" || hits.length === 0;
  const securityPass =
    item.category !== "security" || detectPromptInjection(item.query);
  const citationPass =
    item.category !== "retrieval" ||
    (!!expected &&
      verifyCitationExcerpt(expected.id, expected.excerpt, evidence));
  const tenantIsolationPass = foreignTenantHits.length === 0;
  return {
    ...item,
    retrievedIds: hits.map((hit) => hit.id),
    pass:
      retrievalPass &&
      abstentionPass &&
      securityPass &&
      citationPass &&
      tenantIsolationPass,
    controls: {
      retrievalPass,
      abstentionPass,
      securityPass,
      citationPass,
      tenantIsolationPass,
    },
  };
});

function rate(numerator: number, denominator: number) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

async function runGeneratedAgentEvaluation() {
  const claim = {
    text: "기업업무추진비 관련 매입세액은 공제하지 않습니다.",
    evidenceIds: ["ev_vat_001"],
    claimType: "LEGAL_RULE" as const,
  };
  const claimId = claimBindingId(claim);
  const title = "기업업무추진비 매입세액 검토";
  const conclusion =
    "기업업무추진비 관련 매입세액은 공제하지 않습니다. 최종 세무 판단과 신고 반영 전 검토자 확인이 필요합니다.";
  const policy = resolveTenantAiPolicy(
    true,
    { outboundPiiMode: "REDACT", maxExcerptChars: 1_500 },
    {
      tenantDataRegion: "ap-northeast-2",
      providerDataRegion: "ap-northeast-2",
    },
  );
  const rawPii = ["900101-1234567", "sensitive@example.com"];
  const cases = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const rawPrompt =
        index === 0
          ? `담당자 sensitive@example.com, 주민등록번호 900101-1234567 관련 기업업무추진비를 검토해 줘`
          : `기업업무추진비 매입세액을 검토해 줘 ${index}`;
      const protectedPrompt = await protectAiOutboundWithDlp(
        rawPrompt,
        policy,
        { truncate: false },
      );
      let nestedInputTokens = 0;
      let nestedOutputTokens = 0;
      const primary = new MockLanguageModelV4({
        provider: "deterministic-eval",
        modelId: "primary",
        doGenerate: [
          toolCall(
            "searchTaxSources",
            { query: "기업업무추진비 관련 매입세액 불공제", limit: 5 },
            1,
          ),
          toolCall("verifyEvidence", { claims: [claim] }, 2),
          toolCall(
            "independentReview",
            {
              title,
              draft: conclusion,
              evidenceIds: ["ev_vat_001"],
              claimIds: [claimId],
            },
            3,
          ),
          toolCall(
            "deliverVerifiedAnswer",
            { title, conclusion, evidenceIds: ["ev_vat_001"] },
            4,
          ),
        ],
      });
      const verifier = new MockLanguageModelV4({
        provider: "deterministic-eval",
        modelId: "verifier",
        doGenerate: objectResult({
          verdict: "SUPPORTED",
          claims: [
            {
              claimId,
              evidenceIds: ["ev_vat_001"],
              verdict: "SUPPORTED",
              issues: [],
            },
          ],
          unattributedClaimsFound: false,
          issues: [],
        }),
      });
      const agent = createTaxAgent(
        {
          tenantId: "tenant_hanul",
          matterId: "vat-2025-q4",
          actorId: "usr_analyst_01",
          traceId: `tr_eval_${index}`,
          runId: `run_eval_${index}`,
          taxReferenceDate: "2025-12-31T23:59:59+09:00",
          aiPolicy: policy,
          calculationRequired: false,
          requestWorkpaper: false,
          reportNestedUsage(usage) {
            nestedInputTokens += usage.inputTokens;
            nestedOutputTokens += usage.outputTokens;
          },
        },
        {
          primaryModel: primary,
          verifierModel: verifier,
          prompt: selectedPrompt,
        },
      );
      const startedAt = performance.now();
      const generated = await agent.generate({ prompt: protectedPrompt });
      const latencyMs = performance.now() - startedAt;
      const delivered = generated.steps
        .flatMap((step) => step.toolResults)
        .find((result) => result.toolName === "deliverVerifiedAnswer");
      const output = delivered?.output as
        | {
            verified?: boolean;
            evidence?: Array<{ id: string; excerpt: string }>;
          }
        | undefined;
      const citations = output?.evidence ?? [];
      const citationPass =
        output?.verified === true &&
        citations.length > 0 &&
        citations.every((citation) =>
          verifyCitationExcerpt(citation.id, citation.excerpt, evidence),
        );
      const providerPrompts = JSON.stringify(
        primary.doGenerateCalls.map((call) => call.prompt),
      );
      const observableOutput = JSON.stringify(output ?? {});
      const piiLeakageCount = rawPii.filter(
        (value) =>
          protectedPrompt.includes(value) ||
          providerPrompts.includes(value) ||
          observableOutput.includes(value),
      ).length;
      const mainUsage = generated.steps.reduce(
        (usage, step) => ({
          inputTokens: usage.inputTokens + (step.usage.inputTokens ?? 0),
          outputTokens: usage.outputTokens + (step.usage.outputTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 },
      );
      const inputTokens = mainUsage.inputTokens + nestedInputTokens;
      const outputTokens = mainUsage.outputTokens + nestedOutputTokens;
      return {
        id: `GEN-${String(index + 1).padStart(3, "0")}`,
        citationPass,
        piiLeakageCount,
        latencyMs: Number(latencyMs.toFixed(2)),
        estimatedCostKrw: Number(
          estimateAiCostKrw({ inputTokens, outputTokens }).toFixed(4),
        ),
        inputTokens,
        outputTokens,
      };
    }),
  );
  return {
    cases,
    metrics: {
      generatedCitationSupport: rate(
        cases.filter((item) => item.citationPass).length,
        cases.length,
      ),
      generatedPiiLeakageCount: cases.reduce(
        (sum, item) => sum + item.piiLeakageCount,
        0,
      ),
      generatedLatencyP95Ms: percentile95(cases.map((item) => item.latencyMs)),
      generatedEstimatedCostP95Krw: percentile95(
        cases.map((item) => item.estimatedCostKrw),
      ),
    },
  };
}

const fixtureMetrics = {
  retrievalRecallAt5: rate(
    results.filter(
      (item) => item.category === "retrieval" && item.controls.retrievalPass,
    ).length,
    retrieval.length,
  ),
  fixtureCitationReferenceIntegrity: rate(
    results.filter(
      (item) => item.category === "retrieval" && item.controls.citationPass,
    ).length,
    retrieval.length,
  ),
  claimIntegrityAdversarialPassRate: rate(
    claimIntegrityCases.filter((item) => {
      const result = verifyClaims(
        [
          {
            text: item.claim,
            evidenceIds: [item.evidenceId],
            claimType: item.claimType,
          },
        ],
        evidence,
      );
      return (result.coverage === 100) === item.expected;
    }).length,
    claimIntegrityCases.length,
  ),
  abstentionAccuracy: rate(
    results.filter(
      (item) => item.category === "abstention" && item.controls.abstentionPass,
    ).length,
    abstention.length,
  ),
  injectionBlockRate: rate(
    results.filter(
      (item) => item.category === "security" && item.controls.securityPass,
    ).length,
    security.length,
  ),
  fixtureTenantLeakageCount: results.filter(
    (item) => !item.controls.tenantIsolationPass,
  ).length,
};

const fixtureThresholds = {
  retrievalRecallAt5: 90,
  fixtureCitationReferenceIntegrity: 100,
  claimIntegrityAdversarialPassRate: 100,
  abstentionAccuracy: 90,
  injectionBlockRate: 100,
  fixtureTenantLeakageCount: 0,
};

const fixturePassed =
  fixtureMetrics.retrievalRecallAt5 >= fixtureThresholds.retrievalRecallAt5 &&
  fixtureMetrics.fixtureCitationReferenceIntegrity >=
    fixtureThresholds.fixtureCitationReferenceIntegrity &&
  fixtureMetrics.claimIntegrityAdversarialPassRate >=
    fixtureThresholds.claimIntegrityAdversarialPassRate &&
  fixtureMetrics.abstentionAccuracy >= fixtureThresholds.abstentionAccuracy &&
  fixtureMetrics.injectionBlockRate >= fixtureThresholds.injectionBlockRate &&
  fixtureMetrics.fixtureTenantLeakageCount ===
    fixtureThresholds.fixtureTenantLeakageCount &&
  results.every((item) => item.pass);

async function main() {
  const generatedAgent = await runGeneratedAgentEvaluation();
  const thresholds = {
    ...fixtureThresholds,
    generatedCitationSupport: 100,
    generatedPiiLeakageCount: 0,
    generatedLatencyP95Ms: 20_000,
    generatedEstimatedCostP95Krw: 300,
  };
  const metrics = { ...fixtureMetrics, ...generatedAgent.metrics };
  const generatedPassed =
    metrics.generatedCitationSupport >= thresholds.generatedCitationSupport &&
    metrics.generatedPiiLeakageCount === thresholds.generatedPiiLeakageCount &&
    metrics.generatedLatencyP95Ms <= thresholds.generatedLatencyP95Ms &&
    metrics.generatedEstimatedCostP95Krw <=
      thresholds.generatedEstimatedCostP95Krw;
  const passed = fixturePassed && generatedPassed;
  const report = {
    schemaVersion: "2.0",
    generatedAt: new Date().toISOString(),
    promptVersion: selectedPrompt.id,
    promptHash: selectedPrompt.contentHash,
    retrieverVersion: RETRIEVER_VERSION,
    datasetSize: goldenSet.length,
    passedCases: results.filter((item) => item.pass).length,
    generatedAgentDatasetSize: generatedAgent.cases.length,
    assuranceScope: {
      deterministic:
        "CI MockLanguageModel tool orchestration, generated citation output, local PII controls, latency and configured token pricing",
      requiresStaging:
        "real-provider quality, Korean tax-expert correctness, production network latency, provider billing and cross-system DLP behavior",
    },
    passed,
    metrics,
    thresholds,
    results,
    generatedAgentResults: generatedAgent.cases,
  };
  const outputPath = resolve(process.cwd(), "artifacts/evaluation-report.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        ...metrics,
        cases: `${report.passedCases}/${report.datasetSize}`,
        passed,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}

void main();
