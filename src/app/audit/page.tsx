import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CheckCircle2,
  Download,
  Fingerprint,
  Link2,
  Search,
  ShieldCheck,
} from "lucide-react";
import { PageHeading } from "@/components/page-heading";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import { getAuditIntegrity, listAuditEvents } from "@/lib/repository";
import { auditActionLabel, auditOutcomeLabel } from "@/lib/ui/labels";

export const metadata: Metadata = { title: "감사 로그" };

function formatAuditTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Date(timestamp).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
      });
}

function auditIpLabel(value: string) {
  if (value === "system") return "시스템";
  if (value === "not-recorded") return "미기록";
  return value;
}

export default async function AuditPage() {
  const user = await getSessionUser();
  if (!can(user, "audit:read")) notFound();
  const [auditEvents, integrity] = await Promise.all([
    listAuditEvents(user),
    getAuditIntegrity(user),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="변경 방지 감사 추적"
        title="감사 로그"
        description="세무 업무 등록, 자료 처리, AI 실행 전 과정, 검색 근거 승인과 검토조서 결정을 수정하거나 삭제할 수 없는 해시 체인으로 보존합니다. 검색과 도구 실행 이력은 별도의 AI 실행 이력에 기록합니다."
        actions={
          <button
            className="button button-secondary"
            type="button"
            disabled
            title="저장소 연동이 완료되면 사용할 수 있습니다."
          >
            <Download size={15} /> 감사 자료 내보내기
          </button>
        }
      />

      <section className="audit-summary-grid">
        <article className="audit-chain-card card">
          <span className="audit-chain-icon">
            <Link2 size={20} />
          </span>
          <div>
            <span className="card-kicker">해시 체인 무결성</span>
            <strong>
              {integrity.valid ? "해시 체인 정상" : "해시 체인 검증 필요"}
            </strong>
            <p>
              이벤트 {integrity.count}건 ·{" "}
              {new Date(integrity.verifiedAt).toLocaleTimeString("ko-KR")}에
              검증
            </p>
          </div>
          <span
            className={
              "status-pill " +
              (integrity.valid ? "status-success" : "status-danger")
            }
          >
            {integrity.valid ? "검증됨" : "확인 필요"}
          </span>
        </article>
        <article className="audit-chain-card card">
          <span className="audit-chain-icon audit-chain-icon-violet">
            <Fingerprint size={20} />
          </span>
          <div>
            <span className="card-kicker">개인정보 보호</span>
            <strong>기록 항목 최소화</strong>
            <p>허용된 항목만 기록하고 개인정보와 비정형 값은 제거합니다.</p>
          </div>
          <span className="status-pill status-success">정상</span>
        </article>
      </section>

      <section className="card audit-table-card">
        <div className="cases-toolbar">
          <label className="field-search">
            <Search size={16} />
            <input placeholder="검색 기능은 준비 중입니다." disabled />
          </label>
          <div className="filter-group">
            <button
              className="filter-chip filter-chip-active"
              type="button"
              disabled
            >
              전체
            </button>
            <button className="filter-chip" type="button" disabled>
              성공
            </button>
            <button className="filter-chip" type="button" disabled>
              차단
            </button>
            <button className="filter-chip" type="button" disabled>
              실패
            </button>
          </div>
          <span className="result-count">최근 {auditEvents.length}건</span>
        </div>
        <div className="table-wrap">
          <table className="data-table audit-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>행위자</th>
                <th>작업</th>
                <th>대상</th>
                <th>결과</th>
                <th>추적 ID</th>
                <th>IP</th>
                <th>해시</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map((event) => (
                <tr key={event.id}>
                  <td>{formatAuditTime(event.occurredAt)}</td>
                  <td>
                    <span className="audit-actor">
                      <span>{event.actor.slice(0, 1)}</span>
                      {event.actor}
                    </span>
                  </td>
                  <td>
                    <code className="action-code">
                      {auditActionLabel(event.action)}
                    </code>
                  </td>
                  <td>{event.target}</td>
                  <td>
                    <span
                      className={`audit-outcome audit-outcome-${event.outcome.toLocaleLowerCase()}`}
                    >
                      {event.outcome === "SUCCESS" ? (
                        <CheckCircle2 size={11} />
                      ) : (
                        <ShieldCheck size={11} />
                      )}
                      {auditOutcomeLabel(event.outcome)}
                    </span>
                  </td>
                  <td>
                    <code className="trace-id">{event.traceId}</code>
                  </td>
                  <td>{auditIpLabel(event.ipMasked)}</td>
                  <td>
                    <code className="hash-code">
                      {event.prevHash} → {event.hash}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="audit-footer">
          <ShieldCheck size={13} />
          <span>
            변경 및 삭제 작업은 데이터베이스 트리거로 차단됩니다. 감사 기록에는
            허용 목록과 개인정보 비식별 처리가 적용됩니다.
          </span>
        </div>
      </section>
    </>
  );
}
