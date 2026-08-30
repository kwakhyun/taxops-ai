import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fingerprint, Link2 } from "lucide-react";
import { AuditTable } from "@/components/audit-table";
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
        eyebrow="업무 이력과 무결성 검증"
        title="감사 로그"
        description="업무 등록, 자료 처리, AI 분석, 근거 사용 승인과 검토 결과를 기록합니다. 기록은 해시 체인으로 연결해 변경 여부를 검증하며, 검색과 도구 실행의 상세 내역은 별도의 AI 실행 이력에서 관리합니다."
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

      <AuditTable events={auditEvents} />
    </>
  );
}
