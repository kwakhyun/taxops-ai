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

export const metadata: Metadata = { title: "감사 로그" };

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
        eyebrow="변조 방지 감사 추적"
        title="감사 로그"
        description="케이스 생성, 파일 등록, AI 실행 수명주기, 근거 승인과 워크페이퍼 결정을 추가 전용 해시 체인으로 보존합니다. 검색과 도구 호출의 해시는 에이전트 계보 테이블에 별도로 기록합니다."
        actions={
          <button
            className="button button-secondary"
            type="button"
            disabled
            title="내보내기 저장소 연동 후 사용할 수 있습니다."
          >
            <Download size={15} /> 증적 내보내기
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
              전체 체인 {integrity.count}개 이벤트 /{" "}
              {new Date(integrity.verifiedAt).toLocaleTimeString("ko-KR")} 검증
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
            <strong>허용 목록 기반 메타데이터</strong>
            <p>패턴 기반 PII redaction과 비정형 값 제거 적용</p>
          </div>
          <span className="status-pill status-success">정상</span>
        </article>
      </section>

      <section className="card audit-table-card">
        <div className="cases-toolbar">
          <label className="field-search">
            <Search size={16} />
            <input placeholder="검색 기능 준비 중" disabled />
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
              거부
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
                  <td>{event.occurredAt}</td>
                  <td>
                    <span className="audit-actor">
                      <span>{event.actor.slice(0, 1)}</span>
                      {event.actor}
                    </span>
                  </td>
                  <td>
                    <code className="action-code">{event.action}</code>
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
                      {event.outcome}
                    </span>
                  </td>
                  <td>
                    <code className="trace-id">{event.traceId}</code>
                  </td>
                  <td>{event.ipMasked}</td>
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
            UPDATE와 DELETE는 데이터베이스 trigger로 차단됩니다. 감사
            메타데이터는 allowlist와 PII redaction을 통과합니다.
          </span>
        </div>
      </section>
    </>
  );
}
