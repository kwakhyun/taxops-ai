import { isStepCount, ToolLoopAgent, tool, type LanguageModel } from "ai";
import { z } from "zod";
import {
  createTaxTools,
  createVerificationState,
  WorkflowGateError,
  type TaxToolContext,
} from "@/lib/ai/tools";
import {
  createIndependentReviewTool,
  type VerifiedTaxAnswer,
} from "@/lib/ai/agents/evidence-verifier";
import {
  resolveTaxMemoPrompt,
  type TaxMemoPromptAsset,
} from "@/lib/ai/prompts/tax-memo.v1";
import { defaultAiBudget } from "@/lib/ai/budget";

export { VERIFIER_INPUT_VERSION } from "@/lib/ai/agents/evidence-verifier";

export const TAX_MODEL_ID = process.env.AI_MODEL_ID ?? "openai/gpt-5.6-sol";
export const TAX_VERIFIER_MODEL_ID =
  process.env.AI_VERIFIER_MODEL_ID ?? "openai/gpt-5.6-terra";

export interface TaxAgentDependencies {
  primaryModel?: LanguageModel;
  verifierModel?: LanguageModel;
  prompt?: TaxMemoPromptAsset;
}

type TaxAgentContext = Omit<TaxToolContext, "promptVersion" | "promptHash">;

export function createTaxAgent(
  context: TaxAgentContext,
  dependencies: TaxAgentDependencies = {},
) {
  const prompt = dependencies.prompt ?? resolveTaxMemoPrompt();
  const toolContext: TaxToolContext = {
    ...context,
    promptVersion: prompt.id,
    promptHash: prompt.contentHash,
  };
  const state = createVerificationState();
  const tools = createTaxTools(toolContext, state);
  let verifiedAnswer: VerifiedTaxAnswer | undefined;
  function boundAnswer() {
    if (!verifiedAnswer) {
      throw new WorkflowGateError(
        "서버에 보관된 독립 검증 완료 답변이 없습니다.",
      );
    }
    return { ...verifiedAnswer, evidenceIds: [...verifiedAnswer.evidenceIds] };
  }
  const agentTools = {
    ...tools,
    searchTaxSources: tool({
      description:
        "서버가 원래 질문으로 현재 업무의 승인된 근거를 검색합니다. 검색어를 새로 작성하지 않습니다.",
      inputSchema: z.strictObject({}),
      execute: async (_input, options) =>
        tools.searchTaxSources.execute!(
          { query: context.question, limit: 8 },
          options,
        ),
    }),
    independentReview: createIndependentReviewTool(
      toolContext,
      state,
      dependencies.verifierModel ?? TAX_VERIFIER_MODEL_ID,
      (answer) => {
        verifiedAnswer = answer;
      },
    ),
    deliverVerifiedAnswer: tool({
      description:
        "서버에 보관된 독립 검증 완료 답변을 읽기 전용으로 전달합니다. 본문이나 근거 번호를 입력하지 않습니다.",
      inputSchema: z.strictObject({}),
      execute: async (_input, options) =>
        tools.deliverVerifiedAnswer.execute!(boundAnswer(), options),
    }),
    proposeWorkpaper: tool({
      description:
        "서버에 보관된 독립 검증 완료 답변으로 검토조서 초안과 승인 요청을 저장합니다. 본문이나 근거 번호를 입력하지 않습니다.",
      inputSchema: z.strictObject({}),
      execute: async (_input, options) =>
        tools.proposeWorkpaper.execute!(boundAnswer(), options),
    }),
  };
  function nextTool(failed: boolean): keyof typeof agentTools {
    if (failed) return "abstain";
    if (!state.searchAttempted) return "searchTaxSources";
    if (state.evidence.size === 0) return "abstain";
    if (context.calculationRequired && state.calculations.length === 0)
      return "calculateVat";
    if (!state.integrityAttempted) return "verifyEvidence";
    if (!state.integrityVerified) return "abstain";
    if (!state.independentAttempted) return "independentReview";
    if (!state.independentlyVerified) return "abstain";
    return context.requestWorkpaper
      ? "proposeWorkpaper"
      : "deliverVerifiedAnswer";
  }
  const agent = new ToolLoopAgent({
    model: dependencies.primaryModel ?? TAX_MODEL_ID,
    instructions: `${prompt.content}

현재 실행 컨텍스트:
- matterId: ${context.matterId}
- traceId: ${context.traceId}

searchTaxSources는 원래 질문으로 검색하며 입력은 {}입니다. 숫자 계산은 calculateVat를 사용합니다.
verifyEvidence에서 각 주장을 LEGAL_RULE, TRANSACTION_FACT, INTERNAL_PROCESS로 분류합니다. 법적 규칙에는 TAX_AUTHORITY, 거래 사실에는 BUSINESS_RECORD, 내부 절차에는 INTERNAL_POLICY 근거를 연결합니다.
verifyEvidence는 ID, 숫자, 어휘, 출처 등급의 무결성 검사이며 최종 의미 판정이 아닙니다. 질문의 각 확인 항목을 빠짐없이 다루되 관련 없는 주장을 추가하지 마세요. 세무 분석의 법적 원칙을 뒷받침하는 TAX_AUTHORITY 주장도 포함하세요.
independentReview에는 간결한 title만 입력합니다. 서버가 검증된 주장과 원래 질문을 연결하며 질문 관련성까지 별도로 확인합니다.
독립 검증을 통과하면 최종 도구를 {}로 호출합니다. 결론이나 근거 번호를 다시 작성하지 않습니다. 서버에 보관된 검증본만 전달 또는 저장됩니다.
독립 검증을 통과하지 못하면 abstain으로 답변을 보류합니다.`,
    tools: agentTools,
    prepareStep: ({ steps }) => {
      const failed = steps.some((step) =>
        step.content.some((part) => part.type === "tool-error"),
      );
      const toolName = nextTool(failed);
      return {
        activeTools: [toolName],
        toolChoice: { type: "tool" as const, toolName },
      };
    },
    stopWhen: [
      isStepCount(defaultAiBudget.maxSteps),
      () => state.proposed || state.abstained || state.delivered,
    ],
    maxOutputTokens: defaultAiBudget.maxOutputTokens,
  });
  return Object.assign(agent, { verificationState: state });
}
