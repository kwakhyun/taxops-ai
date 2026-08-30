import type { Metadata } from "next";
import { TableViewport } from "@/components/table-viewport";
import { notFound } from "next/navigation";
import {
  Check,
  FlaskConical,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Target,
} from "lucide-react";
import { PageHeading } from "@/components/page-heading";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import report from "../../../artifacts/evaluation-report.json";

export const metadata: Metadata = { title: "AI 품질 평가" };

const categoryLabel: Record<string, string> = {
  retrieval: "근거 검색",
  abstention: "답변 보류",
  security: "보안",
};

const representativeCases = [
  ...report.results.filter((item) => item.category === "retrieval").slice(0, 2),
  ...report.results
    .filter((item) => item.category === "abstention")
    .slice(0, 2),
  ...report.results.filter((item) => item.category === "security").slice(0, 2),
];

const qualityScore = Number(
  (
    (report.metrics.retrievalRecallAt5 +
      report.metrics.generatedCitationSupport +
      report.metrics.claimIntegrityAdversarialPassRate +
      report.metrics.abstentionAccuracy +
      report.metrics.injectionBlockRate) /
    5
  ).toFixed(1),
);

const qualityMetrics = [
  { key: "retrievalRecallAt5", label: "검색 재현율" },
  { key: "generatedCitationSupport", label: "답변 근거 일치율" },
  { key: "claimIntegrityAdversarialPassRate", label: "주장 무결성" },
  { key: "abstentionAccuracy", label: "답변 보류 정확도" },
  { key: "injectionBlockRate", label: "공격 차단률" },
] as const;

export default async function EvaluationsPage() {
  const user = await getSessionUser();
  if (!can(user, "audit:read")) notFound();
  return (
    <>
      <PageHeading
        eyebrow="AI 품질 관리"
        title="AI 품질 평가"
        description="버전 관리된 기준 평가 데이터셋과 재현 가능한 AI 실행으로 근거 검색, 답변의 근거 일치, 답변 보류, 공격 차단, 개인정보 노출을 회귀 검증합니다."
        actions={
          <span className="evaluation-command">
            <FlaskConical size={15} aria-hidden="true" /> 평가 실행:{" "}
            <code>npm run eval</code>
          </span>
        }
      />

      <section className="eval-gate card">
        <div className="eval-gate-main">
          <span className="eval-gate-icon">
            <ShieldCheck size={23} />
          </span>
          <div>
            <span className="card-kicker">재현 가능한 배포 품질 기준</span>
            <h2>
              {report.passed
                ? "이번 AI 평가가 통과 기준을 충족했습니다."
                : "이번 AI 평가가 통과 기준을 충족하지 못했습니다."}
            </h2>
            <p>
              버전 관리 중인 평가 사례 {report.datasetSize}개 중{" "}
              {report.passedCases}개 통과했습니다. 결과는 CI 결과물과 JSON
              보고서로 보존됩니다.
            </p>
          </div>
        </div>
        <div className="eval-gate-score">
          <strong>{qualityScore}</strong>
          <span>/ 100</span>
          <small>
            {new Date(report.generatedAt).toLocaleString("ko-KR")} 실행
          </small>
        </div>
      </section>

      <section className="eval-score-grid">
        <article className="eval-score card">
          <span>
            <Target size={17} />
          </span>
          <div>
            <small>검색 재현율(Recall@5)</small>
            <strong>{report.metrics.retrievalRecallAt5}%</strong>
            <em>기준 ≥ {report.thresholds.retrievalRecallAt5}%</em>
          </div>
        </article>
        <article className="eval-score card">
          <span>
            <Check size={17} />
          </span>
          <div>
            <small>생성 답변 근거 일치율</small>
            <strong>{report.metrics.generatedCitationSupport}%</strong>
            <em>기준 = {report.thresholds.generatedCitationSupport}%</em>
          </div>
        </article>
        <article className="eval-score card">
          <span>
            <ShieldCheck size={17} />
          </span>
          <div>
            <small>답변 보류 정확도</small>
            <strong>{report.metrics.abstentionAccuracy}%</strong>
            <em>기준 ≥ {report.thresholds.abstentionAccuracy}%</em>
          </div>
        </article>
        <article className="eval-score card">
          <span>
            <LockKeyhole size={17} />
          </span>
          <div>
            <small>생성 답변 내 개인정보 노출</small>
            <strong>{report.metrics.generatedPiiLeakageCount}건</strong>
            <em>기준 = {report.thresholds.generatedPiiLeakageCount}건</em>
          </div>
        </article>
      </section>

      <section className="eval-main-grid">
        <article className="card eval-trend-card">
          <div className="card-header">
            <div>
              <h2>지표별 평가 결과</h2>
              <p>0~100% · 저장된 평가 보고서의 측정값과 통과 기준입니다.</p>
            </div>
            <span
              className={`status-pill ${report.passed ? "status-success" : "status-danger"}`}
            >
              {report.passed ? "통과" : "실패"}
            </span>
          </div>
          <ul className="quality-metrics">
            {qualityMetrics.map(({ key, label }) => (
              <li key={key}>
                <div>
                  <strong>{label}</strong>
                  <b>{report.metrics[key]}%</b>
                </div>
                <meter
                  aria-label={label}
                  min={0}
                  max={100}
                  low={report.thresholds[key]}
                  high={100}
                  optimum={100}
                  value={report.metrics[key]}
                />
                <small>통과 기준 {report.thresholds[key]}% 이상</small>
              </li>
            ))}
          </ul>
        </article>

        <article className="card version-card">
          <div className="card-header">
            <div>
              <h2>평가 구성 버전</h2>
              <p>JSON 보고서에 이력 정보로 저장합니다.</p>
            </div>
            <RotateCcw size={17} className="muted-icon" />
          </div>
          <div className="version-list">
            <div>
              <span>프롬프트</span>
              <code>{report.promptVersion}</code>
              <em>검증됨</em>
            </div>
            <div>
              <span>검색 파이프라인</span>
              <code>{report.retrieverVersion}</code>
              <em>검증됨</em>
            </div>
            <div>
              <span>데이터셋</span>
              <code>{report.datasetSize}개 사례</code>
              <em>버전 관리</em>
            </div>
            <div>
              <span>스키마</span>
              <code>{report.schemaVersion}</code>
              <em>보고서</em>
            </div>
            <div>
              <span>판정 방식</span>
              <code>결정론적</code>
              <em>CI 기준</em>
            </div>
          </div>
        </article>
      </section>

      <section className="card eval-cases-card">
        <div className="card-header">
          <div>
            <h2>대표 평가 결과</h2>
            <p>
              근거가 충분한 질의, 근거가 부족한 질의, 보안 정책 우회를 시도하는
              질의를 구분해 검증합니다.
            </p>
          </div>
          <span className="result-count">
            {report.datasetSize}개 사례 중 {report.passedCases}개 통과
          </span>
        </div>
        <TableViewport label="대표 평가 결과">
          <table className="data-table responsive-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>유형</th>
                <th>질의</th>
                <th>검색된 근거</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {representativeCases.map((item) => (
                <tr key={item.id}>
                  <td data-label="ID">
                    <code className="trace-id">{item.id}</code>
                  </td>
                  <td data-label="유형">{categoryLabel[item.category]}</td>
                  <td data-label="질의">{item.query}</td>
                  <td data-label="검색된 근거">
                    {item.retrievedIds.length
                      ? item.retrievedIds.join(", ")
                      : "검색 근거 없음"}
                  </td>
                  <td data-label="결과">
                    <span className="eval-pass">
                      <Check size={11} /> {item.pass ? "통과" : "실패"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
        <div className="eval-method-note">
          <ShieldCheck size={13} />
          <span>
            현재 {report.datasetSize}개 사례는 초기 회귀 검증용입니다. 세무
            전문가가 검수한 사례를 충분히 확대하기 전에는 일반화 성능을 보장하지
            않습니다.
          </span>
        </div>
      </section>
    </>
  );
}
