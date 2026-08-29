"use client";

import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Paperclip,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { useState } from "react";
import { AssistantMessagePart } from "@/components/assistant-message-part";
import type { AssistantEvidence } from "@/components/assistant-message-model";
import { useTaxAssistant } from "@/components/use-tax-assistant";
import type { Matter } from "@/lib/domain/types";
import { workflowStageLabel } from "@/lib/ui/labels";

const suggestions = [
  "매입세액 불공제 의심 항목과 신고서 반영 차이를 찾아 주세요",
  "영세율 첨부서류 누락 여부를 근거와 함께 점검해 주세요",
  "검토조서 초안의 핵심 결론과 추가 확인 사항을 정리해 주세요",
];

export function AssistantWorkspace({
  matter,
  userName,
  userInitials,
  documentCount,
  initialEvidence,
}: {
  matter: Matter;
  userName: string;
  userInitials: string;
  documentCount: number;
  initialEvidence: AssistantEvidence[];
}) {
  const [input, setInput] = useState("");
  const {
    messages,
    sendMessage,
    stop,
    regenerate,
    error,
    busy,
    currentStage,
    streamedEvidence,
    latestVerification,
    panelEvidence,
  } = useTaxAssistant({ matterId: matter.id, initialEvidence });

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
              <ShieldCheck size={12} /> 승인된 자료만 검색
            </span>
            {currentStage ? (
              <span className="context-stage">
                <Sparkles size={12} /> {workflowStageLabel(currentStage)}
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
              <span className="card-kicker">근거 기반 세무 분석</span>
              <h1>근거를 확인하며 세무 업무를 시작하세요.</h1>
              <p>
                TaxOps AI는 현재 업무에서 보안 검사를 통과한 자료만 검색하고,
                계산과 독립 검증을 거쳐 답합니다. 근거가 부족하면 결론을
                보류합니다.
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
                    {message.parts.map((part, index) => (
                      <AssistantMessagePart
                        part={part}
                        evidence={streamedEvidence}
                        matterId={matter.id}
                        key={
                          "toolCallId" in part
                            ? part.toolCallId
                            : "id" in part && typeof part.id === "string"
                              ? part.id
                              : index
                        }
                      />
                    ))}
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
              placeholder="현재 세무 업무의 자료에 대해 질문해 주세요…"
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
              <ShieldCheck size={11} /> 전문가 검토 전 초안
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
            <span className="card-kicker">근거 검색 범위</span>
            <h2>참고 근거</h2>
          </div>
          <SearchCheck size={18} />
        </div>
        <div className="evidence-scope">
          <div>
            <span>검색 범위</span>
            <strong>현재 업무 자료 및 승인된 세무 지식</strong>
          </div>
          <div>
            <span>조직 데이터 범위</span>
            <strong>
              <Check size={11} /> 현재 조직으로 제한
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
              <code>
                {item.contentHash === item.id
                  ? `근거 ID ${item.id}`
                  : `내용 해시 ${item.contentHash}`}
              </code>
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
              <strong>근거 검증</strong>
              {latestVerification
                ? `분석 항목 ${latestVerification.totalClaims}개 중 ${latestVerification.supportedClaims}개 근거 확인`
                : "검증 결과 대기"}
            </span>
          </div>
          <div>
            <CircleDollarSign size={15} />
            <span>
              <strong>응답 한도</strong>응답당 최대 300원 · 최대 8단계
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}
