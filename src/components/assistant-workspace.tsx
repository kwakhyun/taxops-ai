"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  Bot,
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
import { useEffect, useRef, useState } from "react";
import { AssistantMessagePart } from "@/components/assistant-message-part";
import {
  assistantErrorMessage,
  streamedAssistantEvidence,
  type AssistantEvidence,
} from "@/components/assistant-message-model";
import { Dialog } from "@/components/dialog";
import { UploadPanel } from "@/components/upload-panel";
import { useTaxAssistant } from "@/components/use-tax-assistant";
import type { Matter } from "@/lib/domain/types";
import { workflowStageLabel } from "@/lib/ui/labels";
import styles from "./assistant-workspace.module.css";

const suggestions = [
  "매입세액 불공제 의심 항목과 신고서 반영 차이를 찾아 주세요",
  "영세율 첨부서류 누락 여부를 근거와 함께 점검해 주세요",
  "검토조서 초안의 핵심 결론과 추가 확인 사항을 정리해 주세요",
];
const views = [
  { key: "chat", label: "대화" },
  { key: "evidence", label: "참고 근거" },
] as const;

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
  const [view, setView] = useState<"chat" | "evidence">("chat");
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followResponse = useRef(true);
  const {
    messages,
    sendMessage,
    stop,
    regenerate,
    error,
    busy,
    currentStage,
    latestVerification,
    panelEvidence,
  } = useTaxAssistant({ matterId: matter.id, initialEvidence });

  useEffect(() => {
    const scroll = scrollRef.current;
    if (
      scroll &&
      messages.length > 0 &&
      followResponse.current &&
      view === "chat"
    ) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  }, [messages, busy, view]);

  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
  }, [input]);

  function submit(text = input) {
    const value = text.trim();
    if (!value || busy) return;
    followResponse.current = true;
    setShowLatest(false);
    setView("chat");
    void sendMessage({ text: value });
    setInput("");
  }

  return (
    <div className={styles.workspace} data-view={view} id="analysis-workspace">
      <header className={styles.context}>
        <Link
          className={styles.matter}
          href={`/cases/${matter.id}`}
          title="현재 세무 업무 보기"
        >
          <span className="case-logo" aria-hidden="true">
            {matter.client.slice(0, 1)}
          </span>
          <span className={styles.matterCopy}>
            <strong>{matter.client}</strong>
            <small>
              {matter.taxType} · {matter.period}
            </small>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </Link>
        <Link
          className={styles.documentsLink}
          href={`/documents?matter=${matter.id}`}
        >
          <FileText size={15} aria-hidden="true" /> 자료 {documentCount}건
        </Link>
      </header>

      <div className={styles.tabs} role="tablist" aria-label="AI 작업 영역">
        {views.map(({ key, label }, index) => (
          <button
            type="button"
            role="tab"
            id={`assistant-tab-${key}`}
            aria-selected={view === key}
            aria-controls={`assistant-panel-${key}`}
            tabIndex={view === key ? 0 : -1}
            onClick={() => setView(key)}
            key={key}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : event.key === "ArrowRight" || event.key === "ArrowLeft"
                      ? 1 - index
                      : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setView(views[next]!.key);
              document
                .getElementById(`assistant-tab-${views[next]!.key}`)
                ?.focus();
            }}
          >
            {label}
            {key === "evidence" ? <span>{panelEvidence.length}</span> : null}
          </button>
        ))}
      </div>

      <section
        className={styles.chat}
        id="assistant-panel-chat"
        aria-label="AI 답변과 질문"
      >
        <div className={styles.conversation}>
          <div
            ref={scrollRef}
            className={styles.messages}
            data-testid="message-scroll"
            tabIndex={0}
            role="region"
            aria-label="대화 내용"
            onScroll={(event) => {
              const el = event.currentTarget;
              const atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              followResponse.current = atBottom;
              setShowLatest(!atBottom && messages.length > 0);
            }}
          >
            {messages.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.orb}>
                  <Sparkles size={23} aria-hidden="true" />
                </span>
                <h1>어떤 세무 업무를 도와드릴까요?</h1>
                <p>현재 업무의 승인된 자료를 근거로 분석합니다.</p>
                <div className={styles.suggestions}>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => submit(suggestion)}
                      disabled={busy}
                    >
                      <span>{suggestion}</span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div
                className={styles.messageList}
                role="log"
                aria-live="polite"
                aria-busy={busy}
              >
                <h1 className="sr-only">세무 AI 파트너 대화</h1>
                {messages.map((message) => {
                  const messageEvidence = streamedAssistantEvidence(message);
                  return (
                    <article
                      className={`message message-${message.role}`}
                      key={message.id}
                    >
                      <div className="message-avatar" aria-hidden="true">
                        {message.role === "user" ? (
                          userInitials
                        ) : (
                          <Bot size={16} />
                        )}
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
                            evidence={messageEvidence}
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
                  );
                })}
              </div>
            )}
          </div>
          {showLatest ? (
            <button
              className={styles.latest}
              type="button"
              onClick={() => {
                followResponse.current = true;
                if (scrollRef.current)
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                setShowLatest(false);
              }}
            >
              <ArrowDown size={14} aria-hidden="true" /> 최신 답변
            </button>
          ) : null}
        </div>

        <div className={styles.composerWrap}>
          {error ? (
            <p className={styles.error} role="alert">
              {assistantErrorMessage(error)}
            </p>
          ) : null}
          {busy ? (
            <p className={styles.progress} role="status">
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
              {currentStage ? workflowStageLabel(currentStage) : "응답 준비 중"}
            </p>
          ) : null}
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              maxLength={2_000}
              rows={1}
              onChange={(event) => setInput(event.target.value)}
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
              placeholder="세무 업무에 대해 질문해 주세요"
              aria-label="AI에게 질문"
              aria-describedby="assistant-draft-notice"
            />
            <div className={styles.composerActions}>
              <div>
                <button
                  type="button"
                  aria-label="자료 첨부"
                  onClick={() => setAttachmentOpen(true)}
                >
                  <Paperclip size={19} aria-hidden="true" />
                </button>
                <span>{input.length.toLocaleString("ko-KR")}/2,000</span>
              </div>
              {busy ? (
                <button
                  className={styles.send}
                  type="button"
                  onClick={stop}
                  aria-label="응답 중지"
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className={styles.send}
                  type="submit"
                  disabled={!input.trim()}
                  aria-label="질문 보내기"
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </form>
          <div className={styles.note}>
            <span id="assistant-draft-notice">
              <ShieldCheck size={13} aria-hidden="true" /> 전문가 검토 전 초안
            </span>
            {messages.length ? (
              <button
                type="button"
                onClick={() => {
                  followResponse.current = true;
                  void regenerate();
                }}
                disabled={busy}
              >
                <RefreshCw size={13} aria-hidden="true" /> 다시 생성
              </button>
            ) : (
              <span className={styles.keyboardHint}>Shift + Enter 줄바꿈</span>
            )}
          </div>
        </div>
      </section>

      <aside
        className={`${styles.evidence} assistant-evidence-panel`}
        id="assistant-panel-evidence"
        aria-label="응답 참고 근거"
        tabIndex={0}
      >
        <header className={styles.evidenceHeader}>
          <h2>참고 근거</h2>
          <SearchCheck size={20} aria-hidden="true" />
        </header>
        <details className={styles.scope}>
          <summary>
            <ShieldCheck size={15} aria-hidden="true" /> 검색 범위와 AI 실행
            정보
          </summary>
          <dl>
            <div>
              <dt>검색 범위</dt>
              <dd>현재 업무 자료 및 승인된 세무 지식</dd>
            </div>
            <div>
              <dt>자료 조회 범위</dt>
              <dd>현재 조직의 자료만 조회</dd>
            </div>
            <div>
              <dt>실행 상태</dt>
              <dd>
                {busy && currentStage
                  ? workflowStageLabel(currentStage)
                  : busy
                    ? "응답 준비 중"
                    : "실행 준비"}
              </dd>
            </div>
          </dl>
          <p>
            근거가 부족하면 답변을 보류합니다. 모든 결과는 전문가 검토 전
            초안입니다.
          </p>
        </details>
        <div className={styles.evidenceList}>
          {panelEvidence.map((item, index) => (
            <article key={item.id}>
              <div className={styles.evidenceTitle}>
                <span>{String(index + 1).padStart(2, "0")}</span>
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
        <footer className={styles.evidenceFooter}>
          <div>
            <ShieldCheck size={17} aria-hidden="true" />
            <span>
              <strong>근거 검증</strong>
              {latestVerification
                ? `분석 항목 ${latestVerification.totalClaims}개 중 ${latestVerification.supportedClaims}개 근거 확인`
                : "검증 결과 대기"}
            </span>
          </div>
          <div>
            <CircleDollarSign size={17} aria-hidden="true" />
            <span>
              <strong>응답 한도</strong>응답당 최대 300원 · 최대 8단계
            </span>
          </div>
          <Link href={`/documents?matter=${matter.id}`}>
            업무 자료 전체 보기 <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </footer>
      </aside>

      <Dialog
        open={attachmentOpen}
        title="현재 업무에 자료 추가"
        onClose={() => setAttachmentOpen(false)}
        closeDisabled={uploadBusy}
        closeLabel="자료 첨부 닫기"
      >
        <p className={styles.attachmentContext}>
          {matter.client} · {matter.taxType}
        </p>
        <UploadPanel matterId={matter.id} onBusyChange={setUploadBusy} />
      </Dialog>
    </div>
  );
}
