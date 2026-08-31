import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveTaxMemoPrompt } from "../../src/lib/ai/prompts/tax-memo.v1";
import { liveCases, LIVE_DATASET_VERSION } from "../evals/live-dataset";
import {
  validationCases,
  VALIDATION_DATASET_VERSION,
} from "../evals/validation-dataset";
import {
  gradeLiveCase,
  percentile,
  type ObservedOutcome,
} from "../evals/live-metrics";

type Run = {
  caseId: string;
  question: string;
  expected: "answer" | "abstain";
  model: string;
  repetition: number;
  pass: boolean;
  observed: ObservedOutcome;
  latencyMs: number;
  estimatedKnownCostUsd: number;
  unknownCostCalls: number;
  calls: Array<{ status: string; responseId?: string }>;
};
type Report = {
  kind: string;
  completed: boolean;
  promptHash: string;
  sourceHashes: Record<string, string>;
  plan: {
    dataset: string;
    runs: number;
    repetitions: number;
    primaryModels: string[];
    prompt: string;
    verifierInputVersion: string;
  };
  results: Run[];
};

const phases = ["development", "validation"] as const;
const { values } = parseArgs({
  options: { development: { type: "string" }, validation: { type: "string" } },
});
const prompt = resolveTaxMemoPrompt("tax-memo.v1.4.0");
const candidates = ["gpt-5.6-sol", "gpt-5.6-luna"];
const selectedModel = "gpt-5.6-sol";
const seenResponses = new Set<string>();
const experiments = [];
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function summarize(runs: Run[]) {
  return {
    runs: runs.length,
    passed: runs.filter((run) => run.pass).length,
    answerablePassed: runs.filter(
      (run) => run.expected === "answer" && run.pass,
    ).length,
    answerableTotal: runs.filter((run) => run.expected === "answer").length,
    expectedAbstentionsPassed: runs.filter(
      (run) => run.expected === "abstain" && run.pass,
    ).length,
    expectedAbstentionsTotal: runs.filter((run) => run.expected === "abstain")
      .length,
    unexpectedAnswers: runs.filter(
      (run) => run.expected === "abstain" && run.observed.delivered,
    ).length,
    unnecessaryAbstentions: runs.filter(
      (run) => run.expected === "answer" && run.observed.abstained,
    ).length,
    incomplete: runs.filter(
      (run) => !run.observed.delivered && !run.observed.abstained,
    ).length,
    errors: runs.filter((run) => run.observed.error).length,
    p50Ms: percentile(
      runs.map((run) => run.latencyMs),
      0.5,
    ),
    p95Ms: percentile(
      runs.map((run) => run.latencyMs),
      0.95,
    ),
    providerCalls: runs.reduce((sum, run) => sum + run.calls.length, 0),
    estimatedKnownCostUsd: runs.reduce(
      (sum, run) => sum + run.estimatedKnownCostUsd,
      0,
    ),
    unknownCostCalls: runs.reduce((sum, run) => sum + run.unknownCostCalls, 0),
  };
}

for (const phase of phases) {
  assert(values[phase], `--${phase} report.json is required`);
  const content = await readFile(resolve(values[phase]!), "utf8");
  const report = JSON.parse(content) as Report;
  const cases = phase === "development" ? liveCases : validationCases;
  assert.equal(report.kind, "live-model-synthetic-agent-comparison");
  assert.equal(report.completed, true);
  assert.equal(
    report.plan.dataset,
    phase === "development" ? LIVE_DATASET_VERSION : VALIDATION_DATASET_VERSION,
  );
  assert.equal(report.plan.prompt, prompt.id);
  assert.equal(report.promptHash, prompt.contentHash);
  assert.equal(report.plan.verifierInputVersion, "question-bound-claims.v2");
  assert.equal(report.plan.repetitions, 2);
  assert.deepEqual(report.plan.primaryModels, candidates);
  assert.equal(report.plan.runs, cases.length * candidates.length * 2);
  assert.equal(report.results.length, report.plan.runs);
  assert.equal(
    new Set(
      report.results.map(
        (run) => `${run.model}/${run.caseId}/${run.repetition}`,
      ),
    ).size,
    report.results.length,
  );
  for (const [file, expectedHash] of Object.entries(report.sourceHashes)) {
    // Promotion changes only the registered default reference in this file.
    // The selected immutable prompt asset is independently checked above.
    if (file === "src/lib/ai/prompts/tax-memo.v1.ts") continue;
    assert.equal(
      sha256(await readFile(resolve(file))),
      expectedHash,
      `Source changed after evaluation: ${file}`,
    );
  }
  for (const run of report.results) {
    const expected = cases.find((item) => item.id === run.caseId);
    assert(expected, `Unknown case: ${run.caseId}`);
    assert(candidates.includes(run.model));
    assert([1, 2].includes(run.repetition));
    assert.equal(run.question, expected.question);
    assert.equal(run.expected, expected.expected);
    assert.equal(run.pass, gradeLiveCase(expected, run.observed).pass);
    for (const call of run.calls) {
      if (call.status !== "ok") continue;
      assert(call.responseId, "Successful paid call must have a response ID");
      assert(
        !seenResponses.has(call.responseId),
        "Duplicate provider response",
      );
      seenResponses.add(call.responseId);
    }
  }
  experiments.push({
    phase,
    sourceReportSha256: sha256(content),
    summary: candidates.map((model) => ({
      model,
      ...summarize(report.results.filter((run) => run.model === model)),
    })),
    report,
  });
}

const runs = experiments.flatMap((item) => item.report.results);
const selected = runs.filter((run) => run.model === selectedModel);
const promotionGate = {
  selectedModel,
  selectedPrompt: prompt.id,
  passed: selected.every((run) => run.pass),
  metrics: summarize(selected),
};
const bundle = {
  schemaVersion: 1,
  kind: "live-model-release-evaluation",
  generatedAt: new Date().toISOString(),
  disclosure:
    "Synthetic response-contract validation, not expert-reviewed tax accuracy or production readiness. Validation questions were frozen before implementation and not used to tune this release. Failed comparison-model runs are retained.",
  historicalReport: "artifacts/portfolio/live-evaluation-report.json",
  sourceCheck:
    "Runtime/evaluation source hashes match; the immutable selected prompt hash is checked separately from promotion of its default reference.",
  promotionGate,
  totals: summarize(runs),
  experiments,
};
const output = resolve("artifacts/portfolio/live-release-report.json");
await writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
console.log(
  JSON.stringify({ output, promotionGate, totals: bundle.totals }, null, 2),
);
if (!promotionGate.passed) process.exitCode = 1;
