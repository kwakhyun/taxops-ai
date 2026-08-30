import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  MessageSquareText,
  MoreHorizontal,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRoundCheck,
} from "lucide-react";
import { EngagementJourney } from "@/components/engagement-journey";
import { StatusPill } from "@/components/status-pill";
import { getSessionUser } from "@/lib/auth/session";
import { workflowSteps } from "@/lib/domain/fixtures";
import { formatMilliseconds, formatWon } from "@/lib/format";
import { findMatter, getMatterAnalysis, listDocuments } from "@/lib/repository";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

const loadMatter = cache(async (id: string) => {
  const user = await getSessionUser();
  const matter = await findMatter(user, id);
  return { matter, user };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { matter } = await loadMatter(id);
  return { title: matter?.client ?? "세무 업무" };
}

export default async function CaseDetailPage({ params }: Props) {
  const { id } = await params;
  const { matter, user } = await loadMatter(id);
  if (!matter) notFound();

  const [matterDocuments, analysis] = await Promise.all([
    listDocuments(user, matter.id),
    getMatterAnalysis(user, matter.id),
  ]);
  const latestRun = analysis?.latestRun;
  const workpaper = analysis?.workpaper;
  const hasAnalysis = Boolean(latestRun || workpaper);
  const displayWorkflowSteps =
    analysis?.workflowSteps ??
    workflowSteps.map((step) => ({
      ...step,
      status: "WAITING" as const,
      latencyMs: undefined,
    }));
  const documentsHref = `/documents?matter=${encodeURIComponent(matter.id)}`;
  const assistantHref = `/assistant?matter=${encodeURIComponent(matter.id)}`;
  const engagementReference = `ENG-${matter.id
    .replaceAll(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toLocaleUpperCase()}`;
  const filingChecklist = [
    {
      label: "필수 자료 수집",
      helper: matterDocuments.length
        ? `${matterDocuments.length}건 연결됨`
        : "자료 등록 필요",
      complete: matterDocuments.length > 0,
    },
    {
      label: "근거 기반 분석",
      helper: latestRun
        ? `근거 충족률 ${latestRun.evidenceCoverage}%`
        : "분석 실행 필요",
      complete: Boolean(latestRun),
    },
    {
      label: "전문가 검토·승인",
      helper:
        workpaper?.reviewStatus === "APPROVED"
          ? "승인 완료"
          : workpaper
            ? "검토 대기"
            : "검토조서 필요",
      complete: workpaper?.reviewStatus === "APPROVED",
    },
    {
      label: "실행 이력·감사 추적",
      helper: latestRun?.traceId
        ? `추적 ID ${latestRun.traceId}`
        : "실행 이력 대기",
      complete: Boolean(latestRun?.traceId),
    },
  ];
  const completedFilingChecks = filingChecklist.filter(
    (item) => item.complete,
  ).length;

  return (
    <>
      <Link className="back-link" href="/cases">
        <ArrowLeft size={14} /> 세무 업무 목록
      </Link>

      <section className="case-hero">
        <div className="case-hero-main">
          <span className="case-logo case-logo-large">
            {matter.client.slice(0, 1)}
          </span>
          <div>
            <span className="engagement-reference">{engagementReference}</span>
            <div className="case-title-row">
              <h1>{matter.client}</h1>
              <StatusPill status={matter.status} />
              <StatusPill status={matter.risk} />
            </div>
            <p>
              {matter.taxType} · {matter.period} · {matter.summary}
            </p>
            <div className="case-meta-row">
              <span>
                <CalendarDays size={13} /> 마감 {matter.dueDate}
              </span>
              <span>
                <UserRoundCheck size={13} /> {matter.owner} → {matter.reviewer}
              </span>
              <span>
                <Clock3 size={13} /> {matter.updatedAt} 업데이트
              </span>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <details className="case-actions-menu">
            <summary
              className="icon-button"
              role="button"
              aria-label="추가 작업 열기"
            >
              <MoreHorizontal size={18} />
            </summary>
            <div className="case-actions-popover">
              <Link href={documentsHref}>업무 자료 보기</Link>
              <Link href="/audit">감사 로그 보기</Link>
            </div>
          </details>
          <Link className="button button-secondary" href={documentsHref}>
            <Upload size={15} /> 자료 추가
          </Link>
          <Link className="button button-primary" href={assistantHref}>
            <Sparkles size={15} /> AI 분석
          </Link>
        </div>
      </section>

      <EngagementJourney matter={matter} />

      <nav className="tabs case-tabs" aria-label="세무 업무 세부 메뉴">
        <Link className="tab tab-active" href={`/cases/${matter.id}`}>
          업무 개요
        </Link>
        <Link className="tab" href={documentsHref}>
          자료 수집 <span className="tab-count">{matterDocuments.length}</span>
        </Link>
        <Link className="tab" href={assistantHref}>
          근거 검토 <span className="tab-count">{latestRun ? 1 : 0}</span>
        </Link>
        <Link className="tab" href={`${assistantHref}#analysis-workspace`}>
          계산 및 초안
        </Link>
        <Link className="tab" href="/reviews">
          검토 및 승인
        </Link>
        <Link className="tab" href="#filing">
          신고 및 사후 관리
        </Link>
      </nav>

      <section className="case-layout" id="engagement-overview">
        <div className="case-main-column">
          {hasAnalysis && workpaper ? (
            <article className="card finding-card">
              <div className="card-header">
                <div>
                  <span className="card-kicker">우선 검토 쟁점</span>
                  <h2>{workpaper.title}</h2>
                  <p>저장된 AI 분석과 당시의 근거를 함께 표시합니다.</p>
                </div>
                {workpaper.amountKrw !== undefined ? (
                  <span className="finding-amount">
                    {formatWon(workpaper.amountKrw)}
                  </span>
                ) : (
                  <span className="status-pill status-neutral">
                    {workpaper.reviewStatus === "PENDING"
                      ? "검토 대기"
                      : workpaper.reviewStatus === "APPROVED"
                        ? "승인 완료"
                        : "반려"}
                  </span>
                )}
              </div>
              <div className="card-body">
                <div className="finding-summary">
                  <span className="finding-icon">
                    <CircleAlert size={20} />
                  </span>
                  <div>
                    <strong>{workpaper.conclusion}</strong>
                    <p>
                      아래 근거는 분석 시점의 원문과 파일 해시에 연결되며, 승인
                      직전에 현재 문서와 다시 대조됩니다.
                    </p>
                  </div>
                </div>

                <div className="evidence-grid">
                  {workpaper.evidence.map((item, index) => (
                    <Link
                      className="evidence-card"
                      href={documentsHref}
                      key={item.id}
                    >
                      <span className="evidence-index">0{index + 1}</span>
                      <span className="evidence-content">
                        <strong>{item.documentName}</strong>
                        <small>
                          {item.page ? `${item.page}쪽 · ` : ""}
                          {item.section ?? "문서 본문"}
                        </small>
                        <span>{item.excerpt}</span>
                      </span>
                      <ChevronRight size={15} />
                    </Link>
                  ))}
                </div>
              </div>
              <div className="finding-footer">
                <span>
                  <ShieldCheck size={14} /> 저장된 근거{" "}
                  {workpaper.evidence.length}건
                  {latestRun
                    ? ` · 근거 충족률 ${latestRun.evidenceCoverage}%`
                    : ""}
                </span>
                <Link className="section-link" href={assistantHref}>
                  전체 분석 보기 <ArrowRight size={13} />
                </Link>
              </div>
            </article>
          ) : (
            <article className="card finding-card">
              <div className="card-header">
                <div>
                  <span className="card-kicker">근거 기반 분석</span>
                  <h2>아직 AI 분석 결과가 없습니다.</h2>
                  <p>이 업무에는 아직 검증된 AI 분석 결과가 없습니다.</p>
                </div>
                <span className="status-pill status-neutral">자료 대기</span>
              </div>
              <div className="empty-state">
                <div>
                  <span className="empty-state-icon">
                    <Bot size={21} />
                  </span>
                  <h3>자료를 올린 뒤 AI 분석을 실행하세요.</h3>
                  <p>보안 검사와 검색 등록을 마친 자료만 근거로 사용됩니다.</p>
                  <Link
                    className="button button-primary button-compact"
                    href={documentsHref}
                  >
                    <Upload size={14} /> 자료 추가
                  </Link>
                </div>
              </div>
            </article>
          )}

          <article className="card document-list-card">
            <div className="card-header">
              <div>
                <h2>업무 자료</h2>
                <p>보안 검사를 통과한 자료만 AI 검색 근거로 사용됩니다.</p>
              </div>
              <Link className="section-link" href={documentsHref}>
                전체 보기 <ArrowRight size={13} />
              </Link>
            </div>
            <div className="document-list">
              {matterDocuments.map((document) => {
                const Icon = document.name.endsWith(".xlsx")
                  ? FileSpreadsheet
                  : FileText;
                return (
                  <div className="document-row" key={document.id}>
                    <span className="file-icon">
                      <Icon size={18} />
                    </span>
                    <div className="document-name">
                      <strong>{document.name}</strong>
                      <span>
                        {document.kind} · {document.size} · {document.updatedAt}
                      </span>
                    </div>
                    <StatusPill status={document.status} />
                    <span className="document-chunks">
                      {document.chunks
                        ? `문서 구간 ${document.chunks.toLocaleString("ko-KR")}개`
                        : "처리 중"}
                    </span>
                    {document.status === "INDEXED" ? (
                      <Link
                        className="row-open"
                        href={`/api/v1/documents/${document.id}/download`}
                        prefetch={false}
                        aria-label={`${document.name} 다운로드`}
                      >
                        <Download size={15} />
                      </Link>
                    ) : (
                      <span
                        className="row-open row-open-disabled"
                        title="내용 처리가 완료되면 다운로드할 수 있습니다."
                      >
                        <Download size={15} aria-hidden="true" />
                        <span className="sr-only">
                          {document.name} 다운로드 준비 중
                        </span>
                      </span>
                    )}
                  </div>
                );
              })}
              {!matterDocuments.length ? (
                <div className="empty-state">
                  <div>
                    <h3>연결된 자료가 없습니다.</h3>
                    <p>첫 자료를 등록하면 보안 검사가 자동으로 시작됩니다.</p>
                  </div>
                </div>
              ) : null}
            </div>
          </article>

          <article className="card filing-readiness-card" id="filing">
            <div className="card-header">
              <div>
                <span className="card-kicker">Filing readiness</span>
                <h2>신고 전 최종 점검</h2>
                <p>
                  신고 전에 자료 준비, 근거 확인, 검토 승인과 이력 기록 상태를
                  확인합니다.
                </p>
              </div>
              <span className="filing-readiness-score">
                {completedFilingChecks}/{filingChecklist.length}
              </span>
            </div>
            <div className="filing-checklist">
              {filingChecklist.map((item) => (
                <div
                  className={
                    item.complete
                      ? "filing-check filing-check-complete"
                      : "filing-check"
                  }
                  key={item.label}
                >
                  <span aria-hidden="true">
                    {item.complete ? (
                      <Check size={14} />
                    ) : (
                      <FileCheck2 size={14} />
                    )}
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.helper}</small>
                  </div>
                  <em>{item.complete ? "완료" : "확인 필요"}</em>
                </div>
              ))}
            </div>
            <div className="filing-readiness-footer">
              <span>
                AI 초안은 전문가 승인 후에만 신고 자료로 확정할 수 있습니다.
              </span>
              <Link
                className="button button-primary button-compact"
                href="/reviews"
              >
                검토 및 승인 확인 <ArrowRight size={14} />
              </Link>
            </div>
          </article>
        </div>

        <aside className="case-side-column">
          <article className="card workflow-card">
            <div className="card-header">
              <div>
                <span className="card-kicker">통제된 실행 흐름</span>
                <h2>분석 실행 흐름</h2>
              </div>
              <Bot size={18} className="muted-icon" />
            </div>
            <div className="card-body workflow-list">
              {displayWorkflowSteps.map((step, index) => (
                <div className="workflow-step" key={step.key}>
                  <div className="workflow-rail">
                    <span
                      className={`workflow-dot workflow-dot-${step.status.toLocaleLowerCase()}`}
                    >
                      {step.status === "COMPLETE" ? (
                        <Check size={11} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    {index < workflowSteps.length - 1 ? (
                      <span className="workflow-line" />
                    ) : null}
                  </div>
                  <div className="workflow-copy">
                    <strong>{step.label}</strong>
                    <p>{step.description}</p>
                    {step.latencyMs ? (
                      <small>{formatMilliseconds(step.latencyMs)}</small>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </article>

          {latestRun ? (
            <article className="card run-summary-card">
              <div className="card-header">
                <div>
                  <h2>최근 AI 실행</h2>
                  <p>{latestRun.id}</p>
                </div>
                <span
                  className={
                    "status-pill " +
                    (latestRun.status === "FAILED"
                      ? "status-danger"
                      : latestRun.status === "RUNNING"
                        ? "status-warning"
                        : "status-success")
                  }
                >
                  {latestRun.status === "COMPLETED"
                    ? "실행 완료"
                    : latestRun.status === "NEEDS_REVIEW"
                      ? "전문가 검토"
                      : latestRun.status === "FAILED"
                        ? "실행 실패"
                        : "실행 중"}
                </span>
              </div>
              <div className="card-body run-stat-list">
                <div>
                  <span>응답 시간</span>
                  <strong>{formatMilliseconds(latestRun.latencyMs)}</strong>
                </div>
                <div>
                  <span>입출력 토큰</span>
                  <strong>{latestRun.tokens.toLocaleString("ko-KR")}</strong>
                </div>
                <div>
                  <span>추정 비용</span>
                  <strong>{formatWon(latestRun.estimatedCostKrw)}</strong>
                </div>
                <div>
                  <span>근거 충족률</span>
                  <strong>{latestRun.evidenceCoverage}%</strong>
                </div>
              </div>
              <div className="run-meta">
                <span>{latestRun.model}</span>
                <span>{latestRun.promptVersion}</span>
                <span>추적 ID {latestRun.traceId}</span>
              </div>
            </article>
          ) : null}

          <article className="card reviewer-card">
            <span className="reviewer-avatar">
              {matter.reviewer.slice(0, 1)}
            </span>
            <div>
              <span className="card-kicker">담당 검토자</span>
              <strong>{matter.reviewer}</strong>
              <p>
                {hasAnalysis
                  ? "검토자가 결론과 근거를 확인한 결과를 조회합니다."
                  : "분석 초안이 생성되면 검토를 요청합니다."}
              </p>
            </div>
            <Link
              className="button button-secondary button-compact"
              href="/reviews"
            >
              <MessageSquareText size={14} /> 검토 요청 보기
            </Link>
          </article>
        </aside>
      </section>
    </>
  );
}
