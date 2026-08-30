import {
  getToolName,
  isDataUIPart,
  isToolUIPart,
  type DataUIPart,
  type DynamicToolUIPart,
  type TextUIPart,
  type ToolUIPart,
} from "ai";
import {
  Check,
  Clock3,
  FileText,
  LoaderCircle,
  SearchCheck,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import {
  evidenceSnapshot,
  objectValue,
  type AssistantEvidence,
  type DisplayEvidence,
} from "@/components/assistant-message-model";
import type { TaxAssistantMessage, TaxDataParts } from "@/lib/ai/types";
import { formatWon } from "@/lib/format";
import {
  reviewVerdictLabel,
  toolLabel,
  toolStateLabel,
  workflowStageLabel,
} from "@/lib/ui/labels";

function AssistantText({ part }: { part: TextUIPart }) {
  return <div className="assistant-text">{part.text}</div>;
}

function DataPart({ part }: { part: DataUIPart<TaxDataParts> }) {
  if (part.type === "data-workflow") {
    return (
      <div className="inline-workflow">
        {part.data.status === "running" ? (
          <LoaderCircle className="spin" size={13} />
        ) : (
          <Check size={13} />
        )}
        <span>{part.data.label}</span>
        <code>{workflowStageLabel(part.data.stage)}</code>
      </div>
    );
  }
  if (part.type === "data-evidence") {
    return (
      <div className="inline-evidence">
        <span className="inline-evidence-number">
          {part.data.id.split("_").at(-1)?.slice(-2)}
        </span>
        <div>
          <strong>{part.data.documentName}</strong>
          <small>
            {part.data.location} · 관련도 {part.data.score.toFixed(2)}
          </small>
          <p>{part.data.excerpt}</p>
        </div>
      </div>
    );
  }
  if (part.type === "data-verification") {
    return (
      <div className="verification-banner">
        <ShieldCheck size={16} />
        <div>
          <strong>근거 검증 결과</strong>
          {part.data.totalClaims ? (
            <span>
              분석 항목 {part.data.totalClaims}개 중 {part.data.supportedClaims}
              개 근거 확인 · 충족률 {part.data.coverage}%
            </span>
          ) : (
            <span>
              자동 검증을 통과한 결론이 없어 전문가 확인이 필요합니다.
            </span>
          )}
        </div>
      </div>
    );
  }
  if (part.type === "data-budget") {
    return (
      <div className="answer-meta">
        <span>응답 {(part.data.latencyMs / 1000).toFixed(1)}초</span>
        <span>{part.data.tokens.toLocaleString("ko-KR")} 토큰</span>
        <span>예상 비용 {formatWon(part.data.estimatedCostKrw)}</span>
        <span>{part.data.promptVersion}</span>
      </div>
    );
  }
  return null;
}

function ToolResult({
  part,
  evidence,
  matterId,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  evidence: DisplayEvidence[];
  matterId: string;
}) {
  const name = getToolName(part);
  if (part.state !== "output-available") {
    const running =
      part.state === "input-streaming" || part.state === "input-available";
    const failed =
      part.state === "output-error" || part.state === "output-denied";
    const StateIcon = running ? LoaderCircle : failed ? TriangleAlert : Clock3;
    return (
      <div className="tool-call" data-state={part.state}>
        <StateIcon
          className={running ? "spin" : undefined}
          size={13}
          aria-hidden="true"
        />
        <span>{toolLabel(name)}</span>
        <code>{toolStateLabel(part.state)}</code>
      </div>
    );
  }
  const output = objectValue(part.output);
  if (name === "abstain" && output) {
    return (
      <div className="verification-banner">
        <ShieldCheck size={16} />
        <div>
          <strong>{String(output.message ?? "답변을 보류합니다.")}</strong>
          <span>{String(output.reason ?? output.nextAction ?? "")}</span>
        </div>
      </div>
    );
  }
  if (name === "deliverVerifiedAnswer" && output) {
    const citedIds = Array.isArray(output.evidenceIds)
      ? output.evidenceIds.filter((id): id is string => typeof id === "string")
      : [];
    const boundEvidence = evidenceSnapshot(output.evidence);
    const citations = citedIds.flatMap((id) => {
      const bound = boundEvidence.find((item) => item.id === id);
      if (bound) return [bound];
      const source = evidence.find((item) => item.id === id);
      return source ? [source] : [];
    });
    return (
      <div className="assistant-text">
        <strong>{String(output.title ?? "검증된 분석")}</strong>
        <p>{String(output.conclusion ?? "")}</p>
        <small>
          독립 검증 완료 · 근거 {citedIds.length}건 · 전문가 검토 필요
        </small>
        {citations.map((source) => (
          <div className="inline-evidence" key={source.id}>
            <SearchCheck size={14} />
            <div>
              <strong>{source.documentName}</strong>
              <small>{source.location}</small>
              <p>{source.excerpt}</p>
            </div>
          </div>
        ))}
        <Link href={`/documents?matter=${matterId}`}>원문 자료 보기</Link>
      </div>
    );
  }
  if (name === "proposeWorkpaper" && output) {
    return (
      <div className="verification-banner">
        <FileText size={16} />
        <div>
          <strong>검토조서 초안과 검토 요청을 저장했습니다.</strong>
          <span>
            버전 {String(output.version ?? "1")} · 검토 대상 ID{" "}
            {String(output.targetId ?? "").slice(0, 12)}…
          </span>
        </div>
      </div>
    );
  }
  if (name === "independentReview" && output) {
    return (
      <div className="verification-banner">
        <ShieldCheck size={16} />
        <div>
          <strong>
            독립 검증 {reviewVerdictLabel(String(output.verdict ?? "완료"))}
          </strong>
          <span>
            분석 항목 {String(output.totalClaimCount ?? 0)}개 중{" "}
            {String(output.supportedClaimCount ?? 0)}개 근거 확인
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="tool-call">
      <Check size={13} />
      <span>{toolLabel(name)}</span>
      <code>{toolStateLabel(part.state)}</code>
    </div>
  );
}

export function AssistantMessagePart({
  part,
  evidence,
  matterId,
}: {
  part: TaxAssistantMessage["parts"][number];
  evidence: AssistantEvidence[];
  matterId: string;
}) {
  if (part.type === "text") return <AssistantText part={part} />;
  if (isDataUIPart(part)) {
    return <DataPart part={part as DataUIPart<TaxDataParts>} />;
  }
  if (isToolUIPart(part)) {
    return <ToolResult part={part} evidence={evidence} matterId={matterId} />;
  }
  return null;
}
