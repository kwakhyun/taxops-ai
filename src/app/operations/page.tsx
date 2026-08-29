import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  CloudCog,
  Database,
  Gauge,
  HardDrive,
  ServerCog,
  TimerReset,
  TriangleAlert,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeading } from "@/components/page-heading";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "운영 현황" };

const traces = [
  {
    id: "tr_7a81f4c2",
    route: "POST /api/v1/assistant",
    status: 200,
    latency: "8.42s",
    model: "gpt-5.6-sol",
    cost: "₩42",
    time: "10:21:03",
  },
  {
    id: "tr_f4293d1b",
    route: "POST /api/v1/assistant",
    status: 200,
    latency: "6.18s",
    model: "gpt-5.6-sol",
    cost: "₩29",
    time: "09:54:16",
  },
  {
    id: "tr_4c9b28e0",
    route: "POST /api/v1/uploads",
    status: 202,
    latency: "184ms",
    model: "—",
    cost: "—",
    time: "09:42:51",
  },
  {
    id: "tr_13dace90",
    route: "GET /api/v1/cases/cit-2025",
    status: 403,
    latency: "18ms",
    model: "—",
    cost: "—",
    time: "09:31:05",
  },
];

export default async function OperationsPage() {
  const user = await getSessionUser();
  if (!can(user, "audit:read")) notFound();
  return (
    <>
      <PageHeading
        eyebrow="운영 환경 상태"
        title="운영 현황"
        description="아래 수치는 운영 구성을 설명하기 위한 예시입니다. 실제 환경에서는 HTTP 요청, 인증, 검색, LLM 호출, 도구 실행, 비동기 작업을 하나의 추적 ID로 연결하며 원문과 개인정보는 로그에 저장하지 않습니다."
        actions={
          <span className="live-indicator">
            <span /> 시연 데이터
          </span>
        }
      />

      <section className="metric-grid">
        <MetricCard
          label="일반 API 응답 시간(p95)"
          value="184ms"
          helper="서비스 목표 500ms 이하"
          trend="12%"
          trendDirection="down"
          icon={Gauge}
          tone="green"
        />
        <MetricCard
          label="AI 응답 시간(p95)"
          value="11.8s"
          helper="첫 토큰 응답 시간(p95) 2.4초"
          trend="4%"
          trendDirection="down"
          icon={Bot}
          tone="violet"
        />
        <MetricCard
          label="최대 작업 대기 시간"
          value="48s"
          helper="서비스 목표 5분 이하"
          trend="8s"
          trendDirection="down"
          icon={TimerReset}
          tone="amber"
        />
        <MetricCard
          label="오류율"
          value="0.12%"
          helper="최근 24시간 요청 8,420건"
          trend="0.04%"
          trendDirection="down"
          icon={Activity}
          tone="ink"
        />
      </section>

      <section className="operations-grid">
        <article className="card latency-card">
          <div className="card-header">
            <div>
              <h2>요청 지연 시간</h2>
              <p>최근 12시간 p50 / p95</p>
            </div>
            <div className="chart-legend">
              <span className="legend-green">p50</span>
              <span className="legend-amber">p95</span>
            </div>
          </div>
          <div
            className="latency-chart"
            aria-label="시간별 요청 지연 시간 차트"
          >
            {[42, 55, 48, 62, 44, 51, 68, 64, 58, 76, 62, 49].map(
              (value, index) => (
                <div className="latency-column" key={index}>
                  <span
                    className="latency-p95"
                    style={{ height: `${value}%` }}
                  />
                  <span
                    className="latency-p50"
                    style={{ height: `${Math.max(18, value - 28)}%` }}
                  />
                  <small>{String(index * 2).padStart(2, "0")}</small>
                </div>
              ),
            )}
          </div>
        </article>

        <article className="card service-card">
          <div className="card-header">
            <div>
              <h2>서비스 상태</h2>
              <p>서비스 가동 상태와 외부 연동</p>
            </div>
            <CheckCircle2 size={18} className="service-ok" />
          </div>
          <div className="service-list">
            <div>
              <span className="service-icon">
                <ServerCog size={16} />
              </span>
              <span>
                <strong>Next.js 웹</strong>
                <small>인스턴스 3개 · v0.1.0</small>
              </span>
              <em>정상</em>
            </div>
            <div>
              <span className="service-icon">
                <Database size={16} />
              </span>
              <span>
                <strong>PostgreSQL + pgvector</strong>
                <small>연결 12/100</small>
              </span>
              <em>정상</em>
            </div>
            <div>
              <span className="service-icon">
                <HardDrive size={16} />
              </span>
              <span>
                <strong>객체 저장소</strong>
                <small>비공개 저장 · SSE-KMS</small>
              </span>
              <em>정상</em>
            </div>
            <div>
              <span className="service-icon">
                <CloudCog size={16} />
              </span>
              <span>
                <strong>AI Gateway</strong>
                <small>서킷 브레이커 정상</small>
              </span>
              <em>정상</em>
            </div>
          </div>
        </article>
      </section>

      <section className="operations-grid operations-grid-bottom">
        <article className="card queue-card">
          <div className="card-header">
            <div>
              <h2>비동기 작업</h2>
              <p>작업 잠금, 자동 재시도, 최종 실패 작업 보관</p>
            </div>
            <span className="status-pill status-success">워커 2/2</span>
          </div>
          <div className="queue-lanes">
            <div>
              <span>대기</span>
              <strong>4</strong>
              <div className="queue-track">
                <span style={{ width: "22%" }} />
              </div>
            </div>
            <div>
              <span>처리 중</span>
              <strong>2</strong>
              <div className="queue-track">
                <span style={{ width: "38%" }} />
              </div>
            </div>
            <div>
              <span>재시도</span>
              <strong>1</strong>
              <div className="queue-track queue-track-warning">
                <span style={{ width: "12%" }} />
              </div>
            </div>
            <div>
              <span>최종 실패</span>
              <strong>0</strong>
              <div className="queue-track">
                <span style={{ width: "0%" }} />
              </div>
            </div>
          </div>
          <div className="queue-note">
            <Clock3 size={14} />
            <span>
              가장 오래된 작업은 48초 전에 등록됐습니다. 작업 잠금 상태는
              정상입니다.
            </span>
          </div>
        </article>

        <article className="card budget-card">
          <div className="card-header">
            <div>
              <h2>AI 비용 예산</h2>
              <p>8월 누적 · 조직 한도</p>
            </div>
            <span className="budget-amount">₩184,200</span>
          </div>
          <div className="card-body">
            <div className="budget-bar">
              <span style={{ width: "61%" }} />
            </div>
            <div className="budget-labels">
              <span>61% 사용</span>
              <span>₩300,000</span>
            </div>
            <div className="budget-split">
              <div>
                <span>응답 생성</span>
                <strong>72%</strong>
              </div>
              <div>
                <span>임베딩</span>
                <strong>18%</strong>
              </div>
              <div>
                <span>평가</span>
                <strong>10%</strong>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section className="card trace-card">
        <div className="card-header">
          <div>
            <h2>최근 요청 추적</h2>
            <p>본문 없이 식별자, 지연, 비용, 결과만 저장합니다.</p>
          </div>
          <Link
            className="button button-secondary button-compact"
            href="/audit"
          >
            감사 로그에서 보기
          </Link>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>추적 ID</th>
                <th>경로</th>
                <th>상태</th>
                <th>지연 시간</th>
                <th>모델</th>
                <th>비용</th>
                <th>시각</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((trace) => (
                <tr key={trace.id}>
                  <td>
                    <code className="trace-id">{trace.id}</code>
                  </td>
                  <td>{trace.route}</td>
                  <td>
                    <span
                      className={`http-status http-status-${trace.status >= 400 ? "error" : "ok"}`}
                    >
                      {trace.status}
                    </span>
                  </td>
                  <td>{trace.latency}</td>
                  <td>{trace.model}</td>
                  <td>{trace.cost}</td>
                  <td>{trace.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="observability-note">
          <TriangleAlert size={13} />
          <span>
            개인정보 노출 점검: 최근 24시간 로그와 실행 추적에서 노출 0건
          </span>
        </div>
      </section>
    </>
  );
}
