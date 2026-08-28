import type { Metadata } from "next";
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

export const metadata: Metadata = { title: "AI 평가" };

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

export default async function EvaluationsPage() {
  const user = await getSessionUser();
  if (!can(user, "audit:read")) notFound();
  return (
    <>
      <PageHeading
        eyebrow="AI 품질 관리"
        title="AI 평가"
        description="버전 관리된 골든셋과 재현 가능한 에이전트 실행으로 검색, 생성 인용, 답변 보류, 공격 차단, PII 유출을 회귀 검증합니다."
        actions={
          <span className="button button-secondary">
            <FlaskConical size={15} /> npm run eval
          </span>
        }
      />

      <section className="eval-gate card">
        <div className="eval-gate-main">
          <span className="eval-gate-icon">
            <ShieldCheck size={23} />
          </span>
          <div>
            <span className="card-kicker">재현 가능한 배포 품질 게이트</span>
            <h2>
              {report.passed
                ? "현재 코드가 배포 품질 게이트를 통과했습니다."
                : "품질 게이트를 통과하지 못했습니다."}
            </h2>
            <p>
              커밋된 평가 사례 {report.datasetSize}개 중 {report.passedCases}개
              통과. 결과는 CI 산출물과 로컬 JSON으로 보존됩니다.
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
            <small>검색 재현율@5</small>
            <strong>{report.metrics.retrievalRecallAt5}%</strong>
            <em>기준 ≥ {report.thresholds.retrievalRecallAt5}%</em>
          </div>
        </article>
        <article className="eval-score card">
          <span>
            <Check size={17} />
          </span>
          <div>
            <small>생성 답변 인용 지원</small>
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
            <small>생성 경로 PII 유출</small>
            <strong>{report.metrics.generatedPiiLeakageCount}건</strong>
            <em>기준 = {report.thresholds.generatedPiiLeakageCount}건</em>
          </div>
        </article>
      </section>

      <section className="eval-main-grid">
        <article className="card eval-trend-card">
          <div className="card-header">
            <div>
              <h2>현재 품질 게이트</h2>
              <p>실행 시점의 코드와 버전 관리 데이터로 계산</p>
            </div>
            <span
              className={`status-pill ${report.passed ? "status-success" : "status-danger"}`}
            >
              {report.passed ? "통과" : "실패"}
            </span>
          </div>
          <div className="eval-bars">
            {[
              ["검색", report.metrics.retrievalRecallAt5],
              ["생성 인용", report.metrics.generatedCitationSupport],
              ["적대 주장", report.metrics.claimIntegrityAdversarialPassRate],
              ["보류", report.metrics.abstentionAccuracy],
              ["차단", report.metrics.injectionBlockRate],
            ].map(([label, value]) => (
              <div key={label}>
                <span style={{ height: `${Number(value) - 40}%` }}>
                  <em>{value}</em>
                </span>
                <small>{label}</small>
              </div>
            ))}
            <i className="eval-threshold">최소 통과 기준 90</i>
          </div>
        </article>

        <article className="card version-card">
          <div className="card-header">
            <div>
              <h2>평가 자산 버전</h2>
              <p>결과 JSON에 이력 정보로 저장</p>
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
              <span>검색기</span>
              <code>{report.retrieverVersion}</code>
              <em>검증됨</em>
            </div>
            <div>
              <span>데이터셋</span>
              <code>{report.datasetSize}개 사례</code>
              <em>추적 중</em>
            </div>
            <div>
              <span>스키마</span>
              <code>{report.schemaVersion}</code>
              <em>보고서</em>
            </div>
            <div>
              <span>판정 방식</span>
              <code>deterministic</code>
              <em>CI 게이트</em>
            </div>
          </div>
        </article>
      </section>

      <section className="card eval-cases-card">
        <div className="card-header">
          <div>
            <h2>대표 골든셋 결과</h2>
            <p>답 있음, 답 없음, 공격 질의를 분리해 검증</p>
          </div>
          <span className="result-count">
            {report.datasetSize}개 사례 / {report.passedCases}개 통과
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>유형</th>
                <th>질의</th>
                <th>검색 결과</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {representativeCases.map((item) => (
                <tr key={item.id}>
                  <td>
                    <code className="trace-id">{item.id}</code>
                  </td>
                  <td>{categoryLabel[item.category]}</td>
                  <td>{item.query}</td>
                  <td>
                    {item.retrievedIds.length
                      ? item.retrievedIds.join(", ")
                      : "답변 보류"}
                  </td>
                  <td>
                    <span className="eval-pass">
                      <Check size={11} /> {item.pass ? "통과" : "실패"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="eval-method-note">
          <ShieldCheck size={13} />
          <span>
            현재 30개 사례는 회귀 게이트의 시작점입니다. 실제 세무 전문가 검수
            데이터로 확대하기 전에는 일반화 성능을 주장하지 않습니다.
          </span>
        </div>
      </section>
    </>
  );
}
