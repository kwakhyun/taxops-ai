import Link from "next/link";
import {
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  FileSearch,
  Plus,
  ShieldCheck,
  Sparkles,
  TimerReset,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeading } from "@/components/page-heading";
import { StatusPill } from "@/components/status-pill";
import { getSessionUser } from "@/lib/auth/session";
import { listMatters } from "@/lib/repository";

export const dynamic = "force-dynamic";

const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

export default async function DashboardPage() {
  const user = await getSessionUser();
  const matters = await listMatters(user);
  const active = matters.filter((matter) => matter.status !== "CLOSED");
  const priority = matters
    .toSorted((left, right) => riskOrder[left.risk] - riskOrder[right.risk])
    .slice(0, 4);
  const reviewCount = matters.filter(
    (matter) => matter.status === "IN_REVIEW",
  ).length;
  const findings = active.reduce(
    (total, matter) => total + matter.openFindings,
    0,
  );
  const coverage = active.length
    ? Math.round(
        active.reduce((total, matter) => total + matter.evidenceCoverage, 0) /
          active.length,
      )
    : 0;
  const progress = active.length
    ? Math.round(
        active.reduce((total, matter) => total + matter.progress, 0) /
          active.length,
      )
    : 0;
  const focus = priority[0];
  const today = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "full",
    timeZone: "Asia/Seoul",
  }).format(new Date());

  return (
    <>
      <PageHeading
        eyebrow={today}
        title="오늘의 세무 업무"
        description={`${user.name}님, 마감과 검토 대기 항목부터 확인하세요. AI 결과는 근거와 승인 상태를 함께 관리합니다.`}
        actions={
          <>
            <Link className="button button-secondary" href="/documents">
              <FileSearch size={16} /> 자료 업로드
            </Link>
            <Link className="button button-primary" href="/cases/new">
              <Plus size={16} /> 새 케이스
            </Link>
          </>
        }
      />

      <section className="metric-grid" aria-label="핵심 업무 지표">
        <MetricCard
          label="진행 중 케이스"
          value={String(active.length)}
          helper={"전체 " + matters.length + "건"}
          icon={BriefcaseBusiness}
          tone="ink"
          footer={
            <div
              className="progress-track"
              aria-label={"평균 진행률 " + progress + "%"}
            >
              <div className="progress-bar" style={{ width: progress + "%" }} />
            </div>
          }
        />
        <MetricCard
          label="검토 중"
          value={String(reviewCount)}
          helper="현재 케이스 상태 기준"
          icon={FileCheck2}
          tone="amber"
        />
        <MetricCard
          label="평균 근거 커버리지"
          value={active.length ? coverage + "%" : "—"}
          helper="진행 중 케이스 기준"
          icon={ShieldCheck}
          tone="green"
        />
        <MetricCard
          label="미해결 쟁점"
          value={String(findings)}
          helper="진행 중 케이스 합계"
          icon={TimerReset}
          tone="violet"
        />
      </section>

      <section className="dashboard-grid">
        <article className="card">
          <div className="card-header">
            <div>
              <h2>우선 처리 케이스</h2>
              <p>현재 테넌트의 리스크 수준을 기준으로 정렬했습니다.</p>
            </div>
            <Link className="section-link" href="/cases">
              전체 보기 <ArrowRight size={13} />
            </Link>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>거래처 / 세목</th>
                  <th>상태</th>
                  <th>리스크</th>
                  <th>진행률</th>
                  <th>마감</th>
                </tr>
              </thead>
              <tbody>
                {priority.map((matter) => (
                  <tr key={matter.id}>
                    <td>
                      <Link
                        className="table-primary"
                        href={"/cases/" + matter.id}
                      >
                        <strong>{matter.client}</strong>
                        <span>
                          {matter.taxType} / {matter.period}
                        </span>
                      </Link>
                    </td>
                    <td>
                      <StatusPill status={matter.status} />
                    </td>
                    <td>
                      <StatusPill status={matter.risk} />
                    </td>
                    <td>
                      <div className="table-progress">
                        <div className="progress-track">
                          <div
                            className="progress-bar"
                            style={{ width: matter.progress + "%" }}
                          />
                        </div>
                        <span>{matter.progress}%</span>
                      </div>
                    </td>
                    <td>{matter.dueDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!priority.length ? (
              <div className="empty-state">등록된 케이스가 없습니다.</div>
            ) : null}
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <div>
              <h2>검토 담당 현황</h2>
              <p>검토자와 남은 쟁점을 케이스별로 확인합니다.</p>
            </div>
            <span className="status-pill status-info">{priority.length}건</span>
          </div>
          <div className="card-body today-list">
            {priority.map((matter) => (
              <div className="today-item" key={matter.id}>
                <span className="today-time">{matter.dueDate}</span>
                <div className="today-copy">
                  <strong>{matter.client}</strong>
                  <span>
                    검토자 {matter.reviewer} / 미해결 {matter.openFindings}건
                  </span>
                </div>
                <span
                  className={
                    "today-marker " +
                    (matter.risk === "HIGH"
                      ? "today-marker-danger"
                      : matter.risk === "MEDIUM"
                        ? "today-marker-warning"
                        : "")
                  }
                />
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="ai-insight-card" aria-labelledby="ai-insight-title">
        <div className="ai-insight-header">
          <Sparkles size={14} /> 근거 기반 AI 분석
        </div>
        <h2 className="ai-insight-title" id="ai-insight-title">
          {focus
            ? focus.client + " 케이스에서 근거 기반 분석을 시작할 수 있습니다."
            : "첫 세무 케이스를 만들고 근거 기반 분석을 시작하세요."}
        </h2>
        <p className="ai-insight-copy">
          문서를 검색한 뒤 인용 가능한 근거와 계산 결과를 분리해 제시합니다. AI
          초안은 세무 검토자의 승인 전에는 확정 결과로 취급되지 않습니다.
        </p>
        <div className="ai-insight-footer">
          <div className="source-stack" aria-label="AI 안전 통제">
            <span className="source-chip">검</span>
            <span className="source-chip">승</span>
            <span className="source-label">근거 검증 / 사람 승인</span>
          </div>
          <Link
            className="button button-primary button-compact"
            href={focus ? "/assistant?matter=" + focus.id : "/cases/new"}
          >
            {focus ? "분석 열기" : "케이스 만들기"} <ArrowRight size={14} />
          </Link>
        </div>
      </section>

      <section className="mini-grid" aria-label="현재 업무 요약">
        {[
          [matters.length + "건", "현재 테넌트 전체 케이스"],
          [
            matters.filter((matter) => matter.risk === "HIGH").length + "건",
            "고위험 케이스",
          ],
          [findings + "건", "미해결 쟁점"],
        ].map(([value, label], index) => (
          <div className="mini-stat" key={label}>
            <span className="mini-stat-icon">
              {index === 0 ? (
                <BriefcaseBusiness size={18} />
              ) : index === 1 ? (
                <CircleAlert size={18} />
              ) : (
                <ShieldCheck size={18} />
              )}
            </span>
            <div>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          </div>
        ))}
      </section>

      <div className="sr-only" aria-live="polite">
        <CheckCircle2 /> 현재 워크스페이스의 업무 현황을 불러왔습니다.
      </div>
    </>
  );
}
