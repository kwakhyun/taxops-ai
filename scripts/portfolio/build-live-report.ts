import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// Bundle complete runs, including failures. This command never calls a model.
const stages = [
  "pilot",
  "before-current",
  "before-grounded",
  "after-current",
  "after-grounded",
] as const;
type Stage = (typeof stages)[number];
type Result = {
  caseId: string;
  model: string;
  repetition: number;
  expected: "answer" | "abstain";
  pass: boolean;
  outcome: string;
  unsafeDelivery: boolean;
  estimatedKnownCostUsd: number;
  unknownCostCalls: number;
  calls: Array<{ status: string; responseId?: string }>;
};
type Report = {
  kind: string;
  completed: boolean;
  plan: {
    dataset: string;
    runs: number;
    prompt: string;
    variant?: string;
    verifierInputVersion?: string;
  };
  summary: unknown;
  results: Result[];
};

const { values } = parseArgs({
  options: { report: { type: "string", multiple: true } },
});
const inputs = new Map<Stage, string>();
for (const input of values.report ?? []) {
  const separator = input.indexOf("=");
  const stage = input.slice(0, separator) as Stage;
  if (separator < 1 || !stages.includes(stage) || inputs.has(stage)) {
    throw new Error("Use each --report stage=path exactly once.");
  }
  inputs.set(stage, input.slice(separator + 1));
}
if (inputs.size !== stages.length) {
  throw new Error(`Required stages: ${stages.join(", ")}`);
}

const seenResponses = new Set<string>();
const experiments = [];
for (const stage of stages) {
  const content = await readFile(resolve(inputs.get(stage)!), "utf8");
  const report = JSON.parse(content) as Report;
  // Early reports preceded named variants; retain their registered prompt ID.
  const variant =
    report.plan.variant ??
    (report.plan.prompt === "tax-memo.v1.3.1" ? "current" : undefined);
  if (
    report.kind !== "live-model-synthetic-agent-comparison" ||
    !report.completed ||
    report.results.length !== report.plan.runs ||
    report.plan.dataset !== "portfolio-synthetic.v1" ||
    report.plan.runs !== (stage === "pilot" ? 2 : 32) ||
    variant !== (stage.endsWith("grounded") ? "grounded" : "current") ||
    (stage.startsWith("after-") &&
      report.plan.verifierInputVersion !== "claims-only.v1")
  ) {
    throw new Error(`Invalid or incomplete input report: ${stage}`);
  }
  const uniqueRuns = new Set(
    report.results.map((run) => `${run.caseId}/${run.model}/${run.repetition}`),
  );
  if (uniqueRuns.size !== report.results.length) {
    throw new Error(`Duplicate case runs in ${stage}`);
  }
  for (const run of report.results) {
    for (const call of run.calls) {
      if (!call.responseId) continue;
      if (seenResponses.has(call.responseId)) {
        throw new Error(
          "A provider response was counted in multiple experiments.",
        );
      }
      seenResponses.add(call.responseId);
    }
  }
  const utility = [...new Set(report.results.map((run) => run.model))].map(
    (model) => {
      const group = report.results.filter((run) => run.model === model);
      const answerable = group.filter((run) => run.expected === "answer");
      const expectedAbstentions = group.filter(
        (run) => run.expected === "abstain",
      );
      return {
        model,
        answerablePassed: answerable.filter((run) => run.pass).length,
        answerableTotal: answerable.length,
        expectedAbstentionsPassed: expectedAbstentions.filter((run) => run.pass)
          .length,
        expectedAbstentionsTotal: expectedAbstentions.length,
        unexpectedAnswers: expectedAbstentions.filter(
          (run) => run.outcome === "answer",
        ).length,
        incomplete: group.filter((run) => run.outcome === "incomplete").length,
      };
    },
  );
  experiments.push({
    stage,
    sourceReportSha256: createHash("sha256").update(content).digest("hex"),
    utility,
    report,
  });
}
const runs = experiments.flatMap((experiment) => experiment.report.results);
const bundle = {
  schemaVersion: 1,
  kind: "live-model-experiment-bundle",
  generatedAt: new Date().toISOString(),
  disclosure:
    "Synthetic development set reused during debugging, not a held-out tax accuracy benchmark. Original failed runs are retained. Candidate prompt is not the app default.",
  experimentalDesign:
    "Compare current and grounded prompts with identical claim grading before and after separating the server notice from verifier input. Keep both primary models and the same Terra verifier.",
  metricDefinitions: {
    unsafeDelivery:
      "Only delivery without independent verification or intact source excerpts. Zero is NOT evidence of zero hallucinations or task relevance.",
    unexpectedAnswers:
      "A delivered answer for a case requiring abstention; counted as a failed case even when every citation passes integrity gates.",
  },
  totals: {
    caseRuns: runs.length,
    providerCalls: runs.reduce((sum, run) => sum + run.calls.length, 0),
    estimatedKnownCostUsd: runs.reduce(
      (sum, run) => sum + run.estimatedKnownCostUsd,
      0,
    ),
    unknownCostCalls: runs.reduce((sum, run) => sum + run.unknownCostCalls, 0),
  },
  experiments,
};
const output = resolve("artifacts/portfolio/live-evaluation-report.json");
await writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
console.log(JSON.stringify({ output, totals: bundle.totals }, null, 2));
