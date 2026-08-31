import "server-only";

import { createAgentUIStreamResponse } from "ai";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { createTaxAgent, TAX_MODEL_ID } from "@/lib/ai/agents/tax-agent";
import { createDemoTaxResponse } from "@/lib/ai/demo-stream";
import { assertSafePrompt } from "@/lib/ai/guardrails";
import { verifiedToolOutputOnlyTransform } from "@/lib/ai/stream-policy";
import { resolveTaxMemoPrompt } from "@/lib/ai/prompts/tax-memo.v1";
import { normalizeAssistantMessages } from "@/lib/ai/message-validation";
import {
  assertAiBudget,
  defaultAiBudget,
  estimateAiCostKrw,
} from "@/lib/ai/budget";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { createTraceId, writeLog } from "@/lib/observability/logger";
import {
  appendAuditEvent,
  findMatter,
  getTenantAiPolicy,
  recordToolCall,
  startAgentRun,
  finishAgentRun,
} from "@/lib/repository";
import { rateLimit } from "@/lib/security/rate-limit";
import { protectAiOutboundWithDlp } from "@/lib/security/ai-policy";
import type { TaxAssistantMessage } from "@/lib/ai/types";
import type { SessionUser } from "@/lib/domain/types";
import {
  requiresTaxCalculation,
  taxPeriodReferenceDate,
} from "@/lib/tax/period";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";

const requestSchema = z.strictObject({
  messages: z.array(z.unknown()).min(1).max(30),
  matterId: z.string().min(3).max(80),
});

export async function handleAssistantRequest(request: Request) {
  const requestId = requestIdFrom(request);
  const traceId = createTraceId();
  let activeRun:
    { user: SessionUser; runId: string; startedAt: number } | undefined;
  try {
    const user = await getSessionUser();
    requirePermission(user, "assistant:run");
    await rateLimit(
      `${user.tenantId}:${user.id}:assistant`,
      12,
      60_000,
      user.tenantId,
    );

    const parsed = requestSchema.parse(await request.json());
    const normalized = await normalizeAssistantMessages(parsed.messages);
    const prompt = resolveTaxMemoPrompt();
    const aiPolicy = await getTenantAiPolicy(user);
    const matter = await findMatter(user, parsed.matterId);
    if (!matter) {
      return Response.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "세무 업무를 찾을 수 없습니다.",
          },
          meta: { requestId },
        },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }

    const question = await protectAiOutboundWithDlp(
      normalized.question,
      aiPolicy,
      { truncate: false },
    );
    const messages: TaxAssistantMessage[] = [
      {
        id: normalized.messages[0]!.id,
        role: "user",
        parts: [{ type: "text", text: question }],
      },
    ];
    assertSafePrompt(question);
    assertAiBudget({
      maxInputTokens: Math.ceil(Buffer.byteLength(question, "utf8") / 3),
    });
    writeLog("info", "ai.run_started", {
      requestId,
      traceId,
      tenantId: user.tenantId,
      actorId: user.id,
      targetType: "matter",
      targetId: matter.id,
      outcome: "SUCCESS",
    });
    const taxReferenceDate = taxPeriodReferenceDate(matter.period);
    if (!taxReferenceDate) {
      throw Object.assign(
        new Error("신고 대상 기간을 검색 기준일로 해석할 수 없습니다."),
        { status: 422, code: "UNSUPPORTED_TAX_PERIOD" },
      );
    }

    if (!process.env.AI_GATEWAY_API_KEY) {
      if (process.env.NODE_ENV === "production" && !isPortfolioDemo()) {
        throw Object.assign(
          new Error("AI Gateway is not configured for production"),
          { status: 503, code: "AI_GATEWAY_NOT_CONFIGURED" },
        );
      }
      await appendAuditEvent(user, {
        action: "AI_DEMO_RUN_CREATED",
        targetType: "matter",
        targetId: matter.id,
        outcome: "SUCCESS",
        traceId,
      });
      return await createDemoTaxResponse({
        messages,
        tenantId: user.tenantId,
        matterId: matter.id,
        taxReferenceDate,
        traceId,
        aiPolicy,
        prompt,
      });
    }

    const startedAt = Date.now();
    const runId = await startAgentRun(user, {
      matterId: matter.id,
      traceId,
      modelId: TAX_MODEL_ID,
      monthlyBudgetKrw: aiPolicy.monthlyBudgetKrw,
    });
    activeRun = { user, runId, startedAt };

    const budgetController = new AbortController();
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const agent = createTaxAgent(
      {
        tenantId: user.tenantId,
        matterId: matter.id,
        actorId: user.id,
        traceId,
        aiPolicy,
        runId,
        question,
        taxReferenceDate,
        calculationRequired: requiresTaxCalculation(question),
        requestWorkpaper:
          /(워크페이퍼|검토조서|검토\s*요청|승인\s*요청|초안\s*(?:작성|만들))/.test(
            question,
          ),
        reportNestedUsage(usage) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          try {
            assertAiBudget({
              maxInputTokens: inputTokens,
              maxOutputTokens: outputTokens,
              maxToolCalls: toolCalls,
              maxEstimatedCostKrw: estimateAiCostKrw({
                inputTokens,
                outputTokens,
              }),
            });
          } catch (budgetError) {
            budgetController.abort(budgetError);
          }
        },
      },
      { prompt },
    );

    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      abortSignal: AbortSignal.any([request.signal, budgetController.signal]),
      timeout: { totalMs: defaultAiBudget.timeoutMs },
      experimental_transform: verifiedToolOutputOnlyTransform,
      sendReasoning: false,
      sendSources: false,
      headers: {
        "x-ai-mode": "gateway",
        "x-trace-id": traceId,
        "x-request-id": requestId,
      },
      async onStepEnd({
        stepNumber,
        usage,
        performance,
        toolCalls: stepToolCalls,
        content,
      }) {
        toolCalls += stepToolCalls.length;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        try {
          assertAiBudget({
            maxInputTokens: inputTokens,
            maxOutputTokens: outputTokens,
            maxToolCalls: toolCalls,
            maxEstimatedCostKrw: estimateAiCostKrw({
              inputTokens,
              outputTokens,
            }),
          });
        } catch (budgetError) {
          budgetController.abort(budgetError);
        }
        writeLog("info", "ai.step_completed", {
          requestId,
          traceId,
          tenantId: user.tenantId,
          actorId: user.id,
          workflowId: traceId,
          latencyMs: performance.stepTimeMs,
          tokens: usage.totalTokens,
          action: `step:${stepNumber}`,
          outcome: "SUCCESS",
        });
        for (const part of content) {
          if (part.type !== "tool-error") continue;
          const errorCode =
            part.error instanceof Error ? part.error.name : "TOOL_ERROR";
          writeLog("warn", "ai.tool_failed", {
            requestId,
            traceId,
            tenantId: user.tenantId,
            actorId: user.id,
            action: part.toolName,
            workflowId: traceId,
            latencyMs: performance.toolExecutionMs[part.toolCallId] ?? 0,
            errorCode,
            outcome: "FAILED",
          });
          await recordToolCall({
            tenantId: user.tenantId,
            runId,
            name: part.toolName,
            toolInput: part.input,
            toolOutput: { errorCode },
            status: "FAILED",
            latencyMs: performance.toolExecutionMs[part.toolCallId] ?? 0,
          }).catch(() => undefined);
        }
      },
      onError(error) {
        const run = activeRun;
        activeRun = undefined;
        writeLog("warn", "ai.run_failed", {
          requestId,
          traceId,
          tenantId: user.tenantId,
          actorId: user.id,
          targetType: "matter",
          targetId: matter.id,
          errorCode: error instanceof Error ? error.name : "STREAM_ERROR",
          outcome: "FAILED",
        });
        if (run) {
          void finishAgentRun(run.user, {
            runId: run.runId,
            status: "FAILED",
            inputTokens,
            outputTokens,
            estimatedCostKrw: estimateAiCostKrw({
              inputTokens,
              outputTokens,
            }),
            latencyMs: Date.now() - run.startedAt,
            evidenceCoverage: 0,
            errorCode: error instanceof Error ? error.name : "STREAM_ERROR",
          }).catch(() => undefined);
        }
        return "AI 실행 중 오류가 발생했습니다. 요청 ID로 운영 로그를 확인해 주세요.";
      },
      async onEnd() {
        const proposed = agent.verificationState.proposed;
        const delivered = agent.verificationState.delivered;
        const latencyMs = Date.now() - startedAt;
        const estimatedCostKrw = estimateAiCostKrw({
          inputTokens,
          outputTokens,
        });
        await finishAgentRun(user, {
          runId,
          status: proposed
            ? "AWAITING_REVIEW"
            : delivered
              ? "VERIFY"
              : "FAILED",
          inputTokens,
          outputTokens,
          estimatedCostKrw,
          latencyMs,
          evidenceCoverage: agent.verificationState.integrityVerified ? 100 : 0,
          errorCode:
            proposed || delivered ? undefined : "ABSTAINED_OR_UNVERIFIED",
        });
        if (
          agent.verificationState.independentAttempted &&
          !agent.verificationState.independentlyVerified
        ) {
          writeLog("warn", "ai.verifier_rejected", {
            requestId,
            traceId,
            tenantId: user.tenantId,
            actorId: user.id,
            targetType: "matter",
            targetId: matter.id,
            outcome: "FAILED",
          });
        }
        writeLog("info", "ai.run_completed", {
          requestId,
          traceId,
          tenantId: user.tenantId,
          actorId: user.id,
          targetType: "matter",
          targetId: matter.id,
          latencyMs,
          tokens: inputTokens + outputTokens,
          estimatedCostKrw,
          model: TAX_MODEL_ID,
          promptVersion: prompt.id,
          outcome: proposed || delivered ? "SUCCESS" : "FAILED",
        });
        activeRun = undefined;
      },
    });
  } catch (error) {
    if (activeRun) {
      try {
        await finishAgentRun(activeRun.user, {
          runId: activeRun.runId,
          status: "FAILED",
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostKrw: 0,
          latencyMs: Date.now() - activeRun.startedAt,
          evidenceCoverage: 0,
          errorCode: error instanceof Error ? error.name : "UNKNOWN",
        });
      } catch {
        // The original failure remains the response cause; lifecycle repair is
        // also visible through the structured error log below.
      }
    }
    writeLog("warn", "ai.run_failed", {
      requestId,
      traceId,
      errorCode: error instanceof Error ? error.name : "UNKNOWN",
      outcome: "FAILED",
    });
    return apiError(error, requestId);
  }
}
