"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isDataUIPart,
  isToolUIPart,
  type DataUIPart,
  type DynamicToolUIPart,
  type TextUIPart,
  type ToolUIPart,
} from "ai";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleDollarSign,
  FileText,
  LoaderCircle,
  Paperclip,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { TaxAssistantMessage, TaxDataParts } from "@/lib/ai/types";
import { evidence as seededEvidence } from "@/lib/domain/fixtures";
import type { Matter } from "@/lib/domain/types";

const suggestions = [
  "매입세액 불공제 의심 항목과 신고서 반영 차이를 찾아줘",
  "영세율 첨부서류 누락 여부를 근거와 함께 점검해줘",
  "워크페이퍼 초안의 핵심 결론과 확인 요청을 정리해줘",
];

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
        <code>{part.data.stage}</code>
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
            {part.data.location} · score {part.data.score.toFixed(2)}
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
              {part.data.totalClaims}개 주장 중 {part.data.supportedClaims}개
              지원 · 커버리지 {part.data.coverage}%
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
        <span>{(part.data.latencyMs / 1000).toFixed(1)}초</span>
        <span>{part.data.tokens.toLocaleString("ko-KR")} tokens</span>
        <span>약 ₩{part.data.estimatedCostKrw.toLocaleString("ko-KR")}</span>
        <span>{part.data.promptVersion}</span>
      </div>
    );
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type DisplayEvidence = {
  id: string;
  documentName: string;
  location: string;
  excerpt: string;
};

function evidenceSnapshot(value: unknown): DisplayEvidence[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = objectValue(candidate);
        return item &&
          typeof item.id === "string" &&
          typeof item.documentName === "string" &&
          typeof item.excerpt === "string"
          ? [
              {
                id: item.id,
                documentName: item.documentName,
                location: item.page
                  ? `${String(item.page)}쪽 · ${String(item.section ?? "문서 본문")}`
                  : String(item.section ?? "문서 본문"),
                excerpt: item.excerpt,
              },
            ]
          : [];
      })
    : [];
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
    return (
      <div className="tool-call">
        <LoaderCircle className="spin" size={13} />
        <span>{name}</span>
        <code>{part.state}</code>
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
          독립 근거 검증 통과 / 근거 {citedIds.length}건 / 검토자 확인 필요
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
        <Link href={`/documents?matter=${matterId}`}>원문 문서 확인</Link>
      </div>
    );
  }
  if (name === "proposeWorkpaper" && output) {
    return (
      <div className="verification-banner">
        <FileText size={16} />
        <div>
          <strong>워크페이퍼 초안과 승인 요청을 저장했습니다.</strong>
          <span>
            version {String(output.version ?? "1")} / target{" "}
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
          <strong>독립 근거 검증 {String(output.verdict ?? "완료")}</strong>
          <span>
            지원 주장 {String(output.supportedClaimCount ?? 0)}/
            {String(output.totalClaimCount ?? 0)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="tool-call">
      <Check size={13} />
      <span>{name}</span>
      <code>{part.state}</code>
    </div>
  );
}

function extractCitedEvidenceIds(message?: TaxAssistantMessage) {
  if (message?.role !== "assistant") return [];
  for (const part of message.parts.toReversed()) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;
    const name = getToolName(part);
    if (name !== "deliverVerifiedAnswer" && name !== "proposeWorkpaper") {
      continue;
    }
    const output = objectValue(part.output);
    if (!Array.isArray(output?.evidenceIds)) return [];
    return output.evidenceIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  return [];
}

export function AssistantWorkspace({
  matter,
  userName,
  userInitials,
  documentCount,
  showSeededEvidence,
}: {
  matter: Matter;
  userName: string;
  userInitials: string;
  documentCount: number;
  showSeededEvidence: boolean;
}) {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () =>
      new DefaultChatTransport<TaxAssistantMessage>({
        api: "/api/v1/assistant",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages, matterId: matter.id },
        }),
      }),
    [matter.id],
  );
  const { messages, sendMessage, status, stop, regenerate, error } =
    useChat<TaxAssistantMessage>({
      id: `taxops-${matter.id}`,
      transport,
    });
  const busy = status === "submitted" || status === "streaming";

  const currentStage = useMemo(() => {
    for (const message of [...messages].reverse()) {
      for (const part of [...message.parts].reverse()) {
        if (part.type === "data-workflow") return part.data.stage;
      }
    }
    return undefined;
  }, [messages]);

  const streamedEvidence = useMemo(() => {
    const latestMessage = messages.at(-1);
    if (latestMessage?.role !== "assistant") return [];
    return latestMessage.parts.flatMap((part) => {
      if (part.type === "data-evidence") {
        return [
          {
            id: part.data.id,
            documentName: part.data.documentName,
            location: part.data.location,
            excerpt: part.data.excerpt,
            score: part.data.score,
            contentHash: part.data.id,
          },
        ];
      }
      if (
        isToolUIPart(part) &&
        [
          "searchTaxSources",
          "deliverVerifiedAnswer",
          "proposeWorkpaper",
        ].includes(getToolName(part)) &&
        part.state === "output-available"
      ) {
        const output = objectValue(part.output);
        const values = Array.isArray(part.output)
          ? part.output
          : Array.isArray(output?.evidence)
            ? output.evidence
            : [];
        return values.flatMap((value) => {
          const item = objectValue(value);
          return item &&
            typeof item.id === "string" &&
            typeof item.documentName === "string" &&
            typeof item.excerpt === "string"
            ? [
                {
                  id: item.id,
                  documentName: item.documentName,
                  location: String(item.location ?? "문서 본문"),
                  excerpt: item.excerpt,
                  score: Number(item.score ?? 0),
                  contentHash: String(item.contentHash ?? item.id),
                },
              ]
            : [];
        });
      }
      return [];
    });
  }, [messages]);

  const latestVerification = useMemo(() => {
    const latestMessage = messages.at(-1);
    if (latestMessage?.role !== "assistant") return undefined;
    for (const part of latestMessage.parts.toReversed()) {
      if (part.type === "data-verification") return part.data;
    }
    return undefined;
  }, [messages]);

  const citedEvidenceIds = extractCitedEvidenceIds(messages.at(-1));

  const citedStreamedEvidence = citedEvidenceIds.length
    ? streamedEvidence.filter((item) => citedEvidenceIds.includes(item.id))
    : streamedEvidence;
  const panelEvidence = citedStreamedEvidence.length
    ? citedStreamedEvidence
    : messages.length
      ? []
      : (showSeededEvidence ? seededEvidence : []).map((item) => ({
          id: item.id,
          documentName: item.documentName,
          location: item.page
            ? `${item.page}쪽 · ${item.section}`
            : item.section,
          excerpt: item.excerpt,
          score: item.score,
          contentHash: item.contentHash,
        }));

  function submit(text = input) {
    const value = text.trim();
    if (!value || busy) return;
    void sendMessage({ text: value });
    setInput("");
  }

  return (
    <div className="assistant-layout">
      <section className="assistant-chat">
        <div className="assistant-context-bar">
          <div className="assistant-context-primary">
            <span className="case-logo">{matter.client.slice(0, 1)}</span>
            <div>
              <strong>{matter.client}</strong>
              <span>
                {matter.taxType} · {matter.period}
              </span>
            </div>
          </div>
          <div className="context-chips">
            <span>
              <FileText size={12} /> 자료 {documentCount}건
            </span>
            <span>
              <ShieldCheck size={12} /> 보호 모드
            </span>
            {currentStage ? (
              <span className="context-stage">
                <Sparkles size={12} /> {currentStage}
              </span>
            ) : null}
          </div>
        </div>

        <div className="message-scroll" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 ? (
            <div className="assistant-empty">
              <span className="assistant-orb">
                <Sparkles size={24} />
              </span>
              <span className="card-kicker">근거 기반 AI 업무 파트너</span>
              <h1>근거를 확인하며 세무 업무를 시작하세요.</h1>
              <p>
                TaxOps AI는 현재 케이스의 검역된 자료만 검색하고, 계산 도구와
                독립 검증을 거쳐 답합니다. 근거가 부족하면 추측하지 않습니다.
              </p>
              <div className="suggestion-list">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => submit(suggestion)}
                  >
                    <span>{suggestion}</span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article
                  className={`message message-${message.role}`}
                  key={message.id}
                >
                  <div className="message-avatar">
                    {message.role === "user" ? userInitials : <Bot size={16} />}
                  </div>
                  <div className="message-content">
                    <div className="message-label">
                      <strong>
                        {message.role === "user" ? userName : "TaxOps AI"}
                      </strong>
                      {message.role === "assistant" ? (
                        <span>근거 기반 분석</span>
                      ) : null}
                    </div>
                    {message.parts.map((part, index) => {
                      if (part.type === "text")
                        return <AssistantText part={part} key={index} />;
                      if (isDataUIPart(part)) {
                        return (
                          <DataPart
                            part={part as DataUIPart<TaxDataParts>}
                            key={part.id ?? index}
                          />
                        );
                      }
                      if (isToolUIPart(part)) {
                        return (
                          <ToolResult
                            part={part}
                            evidence={streamedEvidence}
                            matterId={matter.id}
                            key={part.toolCallId}
                          />
                        );
                      }
                      return null;
                    })}
                  </div>
                </article>
              ))}
              {error ? (
                <p className="assistant-error" role="alert">
                  {error.message}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value.slice(0, 2_000))}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="현재 케이스의 자료에 대해 질문하세요…"
              aria-label="AI에게 질문"
              rows={2}
            />
            <div className="composer-actions">
              <div>
                <button
                  type="button"
                  aria-label="파일 첨부"
                  title="파일 첨부는 문서 보관함에서 할 수 있습니다."
                >
                  <Paperclip size={16} />
                </button>
                <span>{input.length}/2,000</span>
              </div>
              {busy ? (
                <button
                  className="send-button send-button-stop"
                  type="button"
                  onClick={stop}
                  aria-label="응답 중지"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  type="button"
                  onClick={() => submit()}
                  disabled={!input.trim()}
                  aria-label="질문 보내기"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="composer-note">
            <span>
              <ShieldCheck size={11} /> 승인 전 초안
            </span>
            <span>AI 결과는 전문가 검토가 필요합니다.</span>
            {messages.length ? (
              <button
                type="button"
                onClick={() => void regenerate()}
                disabled={busy}
              >
                <RefreshCw size={11} /> 마지막 답변 다시 생성
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <aside className="assistant-evidence-panel">
        <div className="evidence-panel-header">
          <div>
            <span className="card-kicker">검색 적용 범위</span>
            <h2>검색 근거</h2>
          </div>
          <SearchCheck size={18} />
        </div>
        <div className="evidence-scope">
          <div>
            <span>검색 범위</span>
            <strong>현재 케이스 + 승인된 세무 지식</strong>
          </div>
          <div>
            <span>테넌트 필터</span>
            <strong>
              <Check size={11} /> 서버 강제
            </strong>
          </div>
        </div>
        <div className="evidence-panel-list">
          {panelEvidence.map((item, index) => (
            <article key={item.id}>
              <div className="evidence-panel-title">
                <span>0{index + 1}</span>
                <div>
                  <strong>{item.documentName}</strong>
                  <small>{item.location}</small>
                </div>
                <em>{Math.round(item.score * 100)}%</em>
              </div>
              <p>{item.excerpt}</p>
              <code>{item.contentHash}</code>
            </article>
          ))}
          {!panelEvidence.length ? (
            <div className="empty-state">
              <p>
                현재 응답에 연결된 근거가 없습니다. 근거가 확인되면 이곳에
                표시됩니다.
              </p>
            </div>
          ) : null}
        </div>
        <div className="evidence-panel-footer">
          <div>
            <ShieldCheck size={15} />
            <span>
              <strong>인용 검증</strong>
              {latestVerification
                ? `지원 주장 ${latestVerification.supportedClaims}/${latestVerification.totalClaims}`
                : "검증 결과 대기"}
            </span>
          </div>
          <div>
            <CircleDollarSign size={15} />
            <span>
              <strong>실행 예산</strong>최대 ₩300 · 8 steps
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}
