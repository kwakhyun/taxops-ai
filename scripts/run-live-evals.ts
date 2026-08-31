import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import {
  createTaxAgent,
  VERIFIER_INPUT_VERSION,
} from "../src/lib/ai/agents/tax-agent";
import {
  RETRIEVER_VERSION,
  verifyCitationExcerpt,
} from "../src/lib/ai/retrieval";
import { evidence, demoUsers } from "../src/lib/domain/fixtures";
import { resolveTenantAiPolicy } from "../src/lib/security/ai-policy";
import { liveCases, LIVE_DATASET_VERSION } from "./evals/live-dataset";
import {
  validationCases,
  VALIDATION_DATASET_VERSION,
} from "./evals/validation-dataset";
import {
  livePromptVariants,
  resolveLivePrompt,
  type LivePromptVariant,
} from "./evals/live-prompts";
import {
  assertLiveEnvironment,
  estimateLiveUsd,
  gradeLiveCase,
  livePricing,
  percentile,
  type LiveModelId,
  type RecordedUsage,
} from "./evals/live-metrics";

const { values } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    repetitions: { type: "string", default: "2" },
    case: { type: "string" },
    model: { type: "string" },
    variant: { type: "string", default: "current" },
    dataset: { type: "string", default: "development" },
  },
});
const repetitions = Number(values.repetitions);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) {
  throw new Error("--repetitions must be an integer from 1 to 5.");
}
const candidates: LiveModelId[] = ["gpt-5.6-sol", "gpt-5.6-luna"];
if (values.model && !candidates.includes(values.model as LiveModelId)) {
  throw new Error("--model must be a registered comparison candidate.");
}
const models = values.model ? [values.model as LiveModelId] : candidates;
if (!["development", "validation"].includes(values.dataset)) {
  throw new Error("--dataset must be development or validation.");
}
const selectedCases =
  values.dataset === "validation" ? validationCases : liveCases;
const cases = values.case
  ? selectedCases.filter((item) => item.id === values.case)
  : selectedCases;
if (!cases.length) throw new Error("Unknown --case.");
if (!livePromptVariants.includes(values.variant as LivePromptVariant)) {
  throw new Error(
    `--variant must be one of: ${livePromptVariants.join(", ")}.`,
  );
}
const selectedPrompt = resolveLivePrompt(values.variant as LivePromptVariant);
const verifierModel: LiveModelId = "gpt-5.6-terra";
const timeoutMs = 90_000;
const plan = {
  dataset:
    values.dataset === "validation"
      ? VALIDATION_DATASET_VERSION
      : LIVE_DATASET_VERSION,
  primaryModels: models,
  verifierModel,
  cases: cases.map((item) => item.id),
  repetitions,
  runs: cases.length * models.length * repetitions,
  concurrency: 2,
  timeoutMs,
  prompt: selectedPrompt.id,
  variant: values.variant,
  verifierInputVersion: VERIFIER_INPUT_VERSION,
  paidExecution: values.execute,
};

if (!values.execute) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        ...plan,
        message:
          "No network requests. Add --execute only after authorizing API usage.",
      },
      null,
      2,
    ),
  );
} else {
  await execute();
}

type CallRecord = {
  model: LiveModelId;
  role: "primary" | "verifier";
  latencyMs: number;
  status: "ok" | "error";
  responseId?: string;
  responseModel?: string;
  usage?: RecordedUsage;
  estimatedUsd: number | null;
  errorName?: string;
  statusCode?: number;
  errorCode?: string;
};

function safeError(error: unknown) {
  const value = (error !== null && typeof error === "object" ? error : {}) as {
    name?: string;
    statusCode?: number;
    responseBody?: string;
    code?: string;
  };
  let errorCode = value.code;
  if (value.responseBody) {
    try {
      errorCode = JSON.parse(value.responseBody).error?.code;
    } catch {
      /* no raw provider body */
    }
  }
  return {
    errorName: value.name ?? "Error",
    statusCode: value.statusCode,
    errorCode:
      typeof errorCode === "string" ? errorCode.slice(0, 100) : undefined,
  };
}

async function execute() {
  assertLiveEnvironment(process.env);
  const openai = createOpenAI();
  // Validate access before any paid call; never print credentials or HTTP headers.
  const catalogue = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!catalogue.ok)
    throw new Error(`Model catalogue access failed (${catalogue.status}).`);
  const available = (await catalogue.json()) as { data: Array<{ id: string }> };
  for (const model of [...models, verifierModel]) {
    if (!available.data.some((item) => item.id === model))
      throw new Error(`Model unavailable: ${model}`);
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = resolve("artifacts/portfolio/live-evals", runId);
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const sourceFiles = [
    "src/lib/ai/agents/tax-agent.ts",
    "src/lib/ai/agents/evidence-verifier.ts",
    "src/lib/ai/tools.ts",
    "src/lib/ai/prompts/tax-memo.v1.ts",
    "src/lib/ai/retrieval.ts",
    "src/lib/ai/retrieval-service.ts",
    "src/lib/domain/fixtures.ts",
    "scripts/evals/live-dataset.ts",
    "scripts/evals/validation-dataset.ts",
    "scripts/evals/live-metrics.ts",
    "scripts/evals/live-prompts.ts",
    "scripts/run-live-evals.ts",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
  const policy = resolveTenantAiPolicy(
    true,
    {
      outboundPiiMode: "BLOCK",
      maxExcerptChars: 1500,
      allowedProviderRegions: ["synthetic-evaluation"],
    },
    {
      tenantDataRegion: "synthetic-evaluation",
      providerDataRegion: "synthetic-evaluation",
    },
  );

  const jobs = Array.from({ length: repetitions }, (_, repetition) =>
    cases.flatMap((testCase) =>
      models.map((model) => ({ testCase, model, repetition: repetition + 1 })),
    ),
  ).flat();
  const results: Array<Awaited<ReturnType<typeof runCase>>> = [];
  let nextJob = 0;
  let fatalProviderError = false;

  function instrument(
    model: LiveModelId,
    role: CallRecord["role"],
    calls: CallRecord[],
    controller: AbortController,
  ) {
    return wrapLanguageModel({
      model: openai(model),
      middleware: {
        specificationVersion: "v4",
        transformParams: async ({ params }) => ({
          ...params,
          abortSignal: params.abortSignal
            ? AbortSignal.any([params.abortSignal, controller.signal])
            : controller.signal,
          providerOptions: {
            ...params.providerOptions,
            openai: {
              ...params.providerOptions?.openai,
              store: false,
              reasoningEffort: "low",
              serviceTier: "default",
              parallelToolCalls: false,
            },
          },
        }),
        wrapGenerate: async ({ doGenerate }) => {
          const started = performance.now();
          try {
            const response = await doGenerate();
            const usage: RecordedUsage = {
              inputTokens: response.usage.inputTokens.total ?? 0,
              cachedInputTokens: response.usage.inputTokens.cacheRead ?? 0,
              cacheWriteTokens: response.usage.inputTokens.cacheWrite ?? 0,
              outputTokens: response.usage.outputTokens.total ?? 0,
            };
            const known =
              response.usage.inputTokens.total !== undefined &&
              response.usage.outputTokens.total !== undefined;
            calls.push({
              model,
              role,
              status: "ok",
              latencyMs: performance.now() - started,
              responseId: response.response?.id,
              responseModel: response.response?.modelId,
              usage: known ? usage : undefined,
              estimatedUsd: known ? estimateLiveUsd(model, usage) : null,
            });
            return response;
          } catch (error) {
            const details = safeError(error);
            calls.push({
              model,
              role,
              status: "error",
              latencyMs: performance.now() - started,
              estimatedUsd: null,
              ...details,
            });
            if (
              [401, 403].includes(details.statusCode ?? 0) ||
              details.errorCode === "insufficient_quota"
            ) {
              fatalProviderError = true;
            }
            // Abort instead of allowing implicit retries to conceal a failed paid request.
            const failure = Object.assign(
              new Error("Provider request failed; see safe call metadata."),
              details,
            );
            controller.abort(failure);
            throw failure;
          }
        },
      },
    });
  }

  async function runCase(job: (typeof jobs)[number]) {
    const { testCase, model, repetition } = job;
    const calls: CallRecord[] = [];
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Live evaluation timeout")),
      timeoutMs,
    );
    const traceId = `live-${randomUUID()}`;
    const agent = createTaxAgent(
      {
        tenantId: testCase.tenantId ?? "tenant_hanul",
        matterId: testCase.matterId ?? "vat-2025-q4",
        actorId: demoUsers.analyst!.id,
        traceId,
        runId: traceId,
        question: testCase.question,
        taxReferenceDate: "2025-12-31T23:59:59+09:00",
        aiPolicy: policy,
        calculationRequired: testCase.expectedVat !== undefined,
        requestWorkpaper: false,
      },
      {
        primaryModel: instrument(model, "primary", calls, controller),
        verifierModel: instrument(verifierModel, "verifier", calls, controller),
        prompt: selectedPrompt,
      },
    );
    const steps: Array<{
      tool: string;
      input: unknown;
      output?: unknown;
      errorName?: string;
    }> = [];
    let error: ReturnType<typeof safeError> | undefined;
    const started = performance.now();
    try {
      await agent.generate({
        prompt: testCase.question,
        abortSignal: controller.signal,
        onStepEnd: ({ toolResults, content }) => {
          for (const result of toolResults)
            steps.push({
              tool: result.toolName,
              input: result.input,
              output: result.output,
            });
          for (const part of content)
            if (part.type === "tool-error") {
              steps.push({
                tool: part.toolName,
                input: part.input,
                errorName: safeError(part.error).errorName,
              });
            }
        },
      });
    } catch (cause) {
      error = safeError(cause);
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = performance.now() - started;
    const state = agent.verificationState;
    const delivered = steps.find(
      (step) => step.tool === "deliverVerifiedAnswer" && step.output,
    )?.output as
      | {
          conclusion: string;
          evidence: Array<{ id: string; excerpt: string }>;
          evidenceIds: string[];
        }
      | undefined;
    const observed = {
      delivered: state.delivered,
      abstained: state.abstained,
      verified: state.independentlyVerified && state.integrityVerified,
      evidenceIds: delivered?.evidenceIds ?? [],
      citationsIntact:
        Boolean(delivered?.evidence.length) &&
        (delivered?.evidence.every((item) =>
          verifyCitationExcerpt(item.id, item.excerpt, evidence),
        ) ??
          false),
      vats: state.calculations.map((item) => Number(item.vat)),
      error: Boolean(error),
    };
    const record = {
      caseId: testCase.id,
      category: testCase.category,
      model,
      verifierModel,
      repetition,
      question: testCase.question,
      expected: testCase.expected,
      expectedEvidenceIds: testCase.evidenceIds,
      ...gradeLiveCase(testCase, observed),
      observed,
      error,
      latencyMs,
      withinProductionLatencyTarget: latencyMs <= 20_000,
      estimatedKnownCostUsd: calls.reduce(
        (sum, call) => sum + (call.estimatedUsd ?? 0),
        0,
      ),
      unknownCostCalls: calls.filter((call) => call.estimatedUsd === null)
        .length,
      calls,
      steps,
      answer: delivered?.conclusion ?? null,
    };
    await writeFile(
      resolve(directory, `${testCase.id}-${model}-${repetition}.json`),
      JSON.stringify(record, null, 2) + "\n",
    );
    console.log(
      `${model} ${testCase.id} #${repetition}: ${record.pass ? "PASS" : "FAIL"} (${record.outcome}, ${(latencyMs / 1000).toFixed(1)}s)`,
    );
    return record;
  }

  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (nextJob < jobs.length && !fatalProviderError) {
        const job = jobs[nextJob++]!;
        results.push(await runCase(job));
      }
    }),
  );
  const summary = models.map((model) => {
    const group = results.filter((item) => item.model === model);
    const answered = group.filter((item) => item.outcome === "answer");
    return {
      model,
      completed: group.length,
      planned: cases.length * repetitions,
      passed: group.filter((item) => item.pass).length,
      answered: answered.length,
      abstained: group.filter((item) => item.outcome === "abstain").length,
      errors: group.filter((item) => item.outcome === "error").length,
      unsafeDeliveries: group.filter((item) => item.unsafeDelivery).length,
      unexpectedAnswers: group.filter(
        (item) => item.expected === "abstain" && item.observed.delivered,
      ).length,
      unnecessaryAbstentions: group.filter(
        (item) => item.expected === "answer" && item.observed.abstained,
      ).length,
      incomplete: group.filter(
        (item) => !item.observed.delivered && !item.observed.abstained,
      ).length,
      p50Ms: percentile(
        group.map((item) => item.latencyMs),
        0.5,
      ),
      p95Ms: percentile(
        group.map((item) => item.latencyMs),
        0.95,
      ),
      answeredP50Ms: percentile(
        answered.map((item) => item.latencyMs),
        0.5,
      ),
      estimatedKnownCostUsd: group.reduce(
        (sum, item) => sum + item.estimatedKnownCostUsd,
        0,
      ),
      unknownCostCalls: group.reduce(
        (sum, item) => sum + item.unknownCostCalls,
        0,
      ),
      providerCalls: group.reduce((sum, item) => sum + item.calls.length, 0),
    };
  });
  const report = {
    schemaVersion: 1,
    kind: "live-model-synthetic-agent-comparison",
    startedAt,
    finishedAt: new Date().toISOString(),
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceHashes,
    plan,
    promptHash: selectedPrompt.contentHash,
    retrieverVersion: RETRIEVER_VERSION,
    dataProvenance:
      "Public repository synthetic fixtures; TAX_AUTHORITY is a fixture classification, not expert validation.",
    runtimeScope:
      "Production ToolLoopAgent and tools; in-memory fixture retrieval, local redaction/classifier, no production DB, embedding, auth route or persistence.",
    evaluationScope:
      "Read-only response contracts, evidence identity, source excerpt integrity, deterministic VAT result and abstention. Not legal or semantic accuracy.",
    runtimeDifferences: [
      "OpenAI direct instead of Gateway",
      "fixed low reasoning for both primary and verifier",
      "90-second per-run timeout instead of 20-second production timeout",
      "requestWorkpaper=false; no write tools executed",
      "production aggregate token/cost budget is not applied by this isolated harness",
    ],
    pricing: {
      source: "https://developers.openai.com/api/docs/pricing",
      checkedAt: "2026-08-31",
      currency: "USD",
      basis: "Standard short-context public list rates, not a billing invoice",
      perMillion: livePricing,
    },
    completed: results.length === jobs.length,
    fatalProviderError,
    summary,
    results: results.sort(
      (a, b) =>
        a.caseId.localeCompare(b.caseId) ||
        a.model.localeCompare(b.model) ||
        a.repetition - b.repetition,
    ),
  };
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        report: resolve(directory, "report.json"),
        completed: report.completed,
        summary,
      },
      null,
      2,
    ),
  );
  if (!report.completed) process.exitCode = 2;
  else if (report.results.some((item) => !item.pass)) process.exitCode = 1;
}
