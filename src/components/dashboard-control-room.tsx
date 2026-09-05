import Link from "next/link";
import { ArrowRight, CalendarClock, ShieldAlert } from "lucide-react";
import type { Matter } from "@/lib/domain/types";
import { getEngagementNextAction } from "@/lib/ui/engagement";
import { dashboardWorklists, deadlineLabel } from "@/lib/ui/dashboard";
import styles from "./dashboard-control-room.module.css";

export function DashboardControlRoom({
  matters,
  today,
}: {
  matters: Matter[];
  today: string;
}) {
  const { priority, schedule } = dashboardWorklists(matters);
  return (
    <section className={styles.layout} aria-label="전체 업무 현황과 예정 일정">
      <article className={styles.priorities}>
        <header className={styles.heading}>
          <div>
            <span>오늘의 조치</span>
            <h2>우선 확인할 업무</h2>
            <p>위험도가 높은 업무부터 확인합니다.</p>
          </div>
          <ShieldAlert size={22} aria-hidden="true" />
        </header>
        <ol className={styles.worklist}>
          {priority.map((matter, index) => (
            <li key={matter.id}>
              <span className={styles.rank}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className={styles.copy}>
                <Link href={`/cases/${matter.id}`}>
                  <strong>{matter.client}</strong>
                </Link>
                <p>{matter.summary}</p>
                <small>
                  담당 {matter.owner} · 검토 {matter.reviewer}
                </small>
                <Link
                  className={styles.action}
                  href={
                    matter.status === "NEEDS_INFO"
                      ? `/documents?matter=${matter.id}`
                      : `/cases/${matter.id}${matter.status === "IN_REVIEW" ? "#review-status" : "#filing"}`
                  }
                >
                  {getEngagementNextAction(matter)} <ArrowRight size={14} />
                </Link>
              </div>
            </li>
          ))}
        </ol>
        {!priority.length ? (
          <p className={styles.empty}>현재 진행 중인 업무가 없습니다.</p>
        ) : null}
        <Link className={styles.footer} href="/cases">
          전체 업무 보기 <ArrowRight size={14} />
        </Link>
      </article>
      <article className={`card ${styles.schedule}`}>
        <header className="card-header">
          <div>
            <h2>예정 일정</h2>
            <p>마감일이 빠른 순서입니다.</p>
          </div>
          <CalendarClock size={20} aria-hidden="true" />
        </header>
        <div className={styles.dates}>
          {schedule.map((matter) => (
            <Link href={`/cases/${matter.id}`} key={matter.id}>
              <time dateTime={matter.dueDate.replaceAll(". ", "-")}>
                {matter.dueDate}
              </time>
              <strong>{matter.client}</strong>
              <span
                data-overdue={
                  deadlineLabel(matter.dueDate, today) === "마감 지남"
                }
              >
                {deadlineLabel(matter.dueDate, today)}
              </span>
            </Link>
          ))}
        </div>
        {!schedule.length ? (
          <p className={styles.empty}>확인할 마감 일정이 없습니다.</p>
        ) : null}
        <Link className={styles.footer} href="/cases">
          전체 업무 일정 보기 <ArrowRight size={14} />
        </Link>
      </article>
    </section>
  );
}
