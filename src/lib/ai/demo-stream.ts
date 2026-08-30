import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { retrieveEvidenceForContext } from "@/lib/ai/retrieval-service";
import type { TaxAssistantMessage } from "@/lib/ai/types";
import { TAX_MODEL_ID } from "@/lib/ai/agents/tax-agent";
import type { TaxMemoPromptAsset } from "@/lib/ai/prompts/tax-memo.v1";
import type { TenantAiPolicy } from "@/lib/security/ai-policy";
import { verifyClaims, type SupportedClaim } from "@/lib/ai/retrieval";

export const demoReconciliationClaims = [
  {
    text: "원장 분석 결과와 740,000원 차이가 있습니다.",
    evidenceIds: ["ev_return_007"],
    claimType: "TRANSACTION_FACT",
  },
  {
    text: "공급가액 18,420,000원, 부가가치세액 1,842,000원.",
    evidenceIds: ["ev_ledger_019"],
    claimType: "TRANSACTION_FACT",
  },
  {
    text: "신고서 불공제 매입세액 합계는 1,102,000원입니다.",
    evidenceIds: ["ev_return_007"],
    claimType: "TRANSACTION_FACT",
  },
  {
    text: "거래처 6곳 중 2곳은 업무 관련성 메모가 비어 있습니다.",
    evidenceIds: ["ev_ledger_019"],
    claimType: "TRANSACTION_FACT",
  },
  {
    text: "기업업무추진비 관련 매입세액은 공제하지 않습니다.",
    evidenceIds: ["ev_vat_001"],
    claimType: "LEGAL_RULE",
  },
  {
    text: "사업과 직접 관련이 없는 지출의 매입세액은 공제하지 않습니다.",
    evidenceIds: ["ev_vat_001"],
    claimType: "LEGAL_RULE",
  },
] satisfies SupportedClaim[];

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function latestQuestion(messages: UIMessage[]) {
  const message = [...messages].reverse().find((item) => item.role === "user");
  return (
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ") ?? ""
  );
}

export async function createDemoTaxResponse(input: {
  messages: TaxAssistantMessage[];
  tenantId: string;
  matterId: string;
  taxReferenceDate: string;
  traceId: string;
  aiPolicy: TenantAiPolicy;
  prompt: TaxMemoPromptAsset;
}) {
  const question = latestQuestion(input.messages);
  const reconciliationQuestion =
    /(매입세액|접대비|기업업무추진비)/.test(question) &&
    /(불공제|신고서|차이)/.test(question);
  const sources = await retrieveEvidenceForContext({
    tenantId: input.tenantId,
    matterId: input.matterId,
    taxReferenceDate: input.taxReferenceDate,
    query: reconciliationQuestion
      ? "기업업무추진비 매입세액 불공제 신고서 원장 업무 관련성 메모"
      : question,
    limit: 3,
    aiPolicy: input.aiPolicy,
  });
  const requiredEvidence = new Set([
    "ev_vat_001",
    "ev_ledger_019",
    "ev_return_007",
  ]);
  const hasReconciliationEvidence =
    reconciliationQuestion &&
    sources.length === requiredEvidence.size &&
    sources.every((source) => requiredEvidence.has(source.id));
  const reconciliationVerification = verifyClaims(
    demoReconciliationClaims,
    sources,
  );
  const hasVerifiedReconciliation =
    hasReconciliationEvidence && reconciliationVerification.coverage === 100;

  const stream = createUIMessageStream<TaxAssistantMessage>({
    originalMessages: input.messages,
    async execute({ writer }) {
      writer.write({
        type: "data-workflow",
        id: "workflow-status",
        data: {
          stage: "INTAKE",
          label: "요청 범위와 민감정보 정책을 확인했습니다.",
          status: "complete",
          traceId: input.traceId,
        },
      });
      await wait(40);

      writer.write({
        type: "data-workflow",
        id: "workflow-status",
        data: {
          stage: "RETRIEVE",
          label: "업무 자료와 세무 지식을 함께 검색하고 있습니다.",
          status: "running",
          traceId: input.traceId,
        },
      });
      await wait(55);

      for (const source of sources) {
        writer.write({
          type: "data-evidence",
          id: source.id,
          data: {
            id: source.id,
            documentName: source.documentName,
            location: source.page
              ? `${source.page}쪽 · ${source.section}`
              : source.section,
            excerpt: source.excerpt,
            score: source.score,
          },
        });
      }

      writer.write({
        type: "data-workflow",
        id: "workflow-status",
        data: {
          stage: "DRAFT",
          label: "세액 계산 결과를 반영해 초안을 작성하고 있습니다.",
          status: "running",
          traceId: input.traceId,
        },
      });

      const textId = `answer-${input.traceId}`;
      writer.write({ type: "text-start", id: textId });
      const chunks = hasVerifiedReconciliation
        ? [
            "검토 결론\n",
            "매입세액 불공제 금액이 신고서 초안에 740,000원 적게 반영된 것으로 보입니다. ",
            "기업업무추진비 계정의 부가가치세액 1,842,000원 중 신고서에는 1,102,000원만 불공제 처리되었습니다. [근거 1][근거 2][근거 3]\n\n",
            "확인이 필요한 항목\n",
            "• 업무 관련성 메모가 없는 거래 2건의 지출 목적과 참석자를 확인하세요.\n",
            "• 소명되지 않으면 불공제 매입세액 740,000원을 추가 반영하는 것이 보수적입니다.\n",
            "• 이 결과는 검토조서 초안이며 검토자 승인 전에는 신고서에 반영되지 않습니다.",
          ]
        : sources.length
          ? [
              "확인된 근거 범위에서 요약합니다.\n\n",
              ...sources.map(
                (source, index) =>
                  `[근거 ${index + 1}] ${source.documentName}, ${source.section}: ${source.excerpt}\n`,
              ),
              "\n현재 자료만으로 확정적인 세무 결론은 내리지 않았습니다. 검토자가 근거의 완전성을 확인해 주세요.",
            ]
          : [
              "답변을 보류합니다.\n\n",
              "현재 세무 업무의 승인된 자료에서 질문을 뒷받침할 근거를 찾지 못했습니다. ",
              "관련 자료를 등록해 검색 준비를 완료하거나 질문 범위를 좁혀 주세요. 근거 없이 세무 결론을 만들지 않습니다.",
            ];
      for (const delta of chunks) {
        writer.write({ type: "text-delta", id: textId, delta });
        await wait(26);
      }
      writer.write({ type: "text-end", id: textId });

      writer.write({
        type: "data-workflow",
        id: "workflow-status",
        data: {
          stage: "VERIFY",
          label: hasVerifiedReconciliation
            ? "결정론적 검증이 주장과 원문 인용을 확인했습니다."
            : "검색 근거를 연결했으며 전문가 확인이 필요합니다.",
          status: "complete",
          traceId: input.traceId,
        },
      });
      writer.write({
        type: "data-verification",
        id: "verification",
        data: {
          supportedClaims: hasVerifiedReconciliation
            ? reconciliationVerification.supportedClaims
            : 0,
          totalClaims: hasVerifiedReconciliation
            ? reconciliationVerification.totalClaims
            : 0,
          coverage: hasVerifiedReconciliation
            ? reconciliationVerification.coverage
            : 0,
          status: hasVerifiedReconciliation ? "verified" : "needs-review",
        },
      });
      writer.write({
        type: "data-budget",
        id: "budget",
        data: {
          latencyMs: 8420,
          tokens: 5842,
          estimatedCostKrw: 42,
          model: `${TAX_MODEL_ID} · deterministic demo`,
          promptVersion: input.prompt.id,
        },
      });
      writer.write({
        type: "data-workflow",
        id: "workflow-status",
        data: {
          stage: "AWAITING_REVIEW",
          label: "전문가 검토를 기다리고 있습니다.",
          status: "complete",
          traceId: input.traceId,
        },
      });
      writer.setOutcome({ status: "completed" });
    },
    onError: () => "AI 분석 스트림을 처리하지 못했습니다.",
  });

  return createUIMessageStreamResponse({
    stream,
    headers: { "x-ai-mode": "deterministic-demo", "x-trace-id": input.traceId },
  });
}
