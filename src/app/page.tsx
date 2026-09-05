import Link from "next/link";
import {
  BriefcaseBusiness,
  FileCheck2,
  FileSearch,
  Plus,
  ShieldCheck,
  CircleAlert,
} from "lucide-react";
import { DashboardControlRoom } from "@/components/dashboard-control-room";
import { MetricCard } from "@/components/metric-card";
import { PageHeading } from "@/components/page-heading";
import { getSessionUser } from "@/lib/auth/session";
import { listMatters } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getSessionUser();
  const matters = await listMatters(user);
  const active = matters.filter((matter) => matter.status !== "CLOSED");
  const coverage = active.length
    ? Math.round(
        active.reduce((total, matter) => total + matter.evidenceCoverage, 0) /
          active.length,
      )
    : 0;
  const now = process.env.E2E_FIXED_NOW
    ? new Date(process.env.E2E_FIXED_NOW)
    : new Date();
  const today = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "full",
    timeZone: "Asia/Seoul",
  }).format(now);
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(now);
  return (
    <>
      <PageHeading
        eyebrow={today}
        title="오늘 처리할 세무 업무"
        description={`${user.name}님, 필요한 조치와 마감 일정을 확인하세요.`}
        actions={
          <>
            <Link className="button button-secondary" href="/documents">
              <FileSearch size={16} /> 자료 업로드
            </Link>
            <Link className="button button-primary" href="/cases/new">
              <Plus size={16} /> 새 업무
            </Link>
          </>
        }
      />
      <section className="metric-grid" aria-label="핵심 업무 지표">
        <MetricCard
          label="진행 중인 업무"
          value={String(active.length)}
          helper={`전체 ${matters.length}건`}
          icon={BriefcaseBusiness}
          tone="ink"
        />
        <MetricCard
          label="검토 중"
          value={String(
            active.filter((matter) => matter.status === "IN_REVIEW").length,
          )}
          helper="현재 업무 상태 기준"
          icon={FileCheck2}
          tone="amber"
        />
        <MetricCard
          label="평균 근거 사용 승인율"
          value={active.length ? `${coverage}%` : "—"}
          helper="업무별 등록 자료 승인율의 평균"
          icon={ShieldCheck}
          tone="green"
        />
        <MetricCard
          label="고위험 업무"
          value={String(
            active.filter((matter) => matter.risk === "HIGH").length,
          )}
          helper="진행 중인 업무 기준"
          icon={CircleAlert}
          tone="violet"
        />
      </section>
      <DashboardControlRoom matters={matters} today={dateKey} />
    </>
  );
}
