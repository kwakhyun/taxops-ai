import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  FileClock,
  ShieldAlert,
} from "lucide-react";
import type { Matter } from "@/lib/domain/types";
import { getEngagementNextAction } from "@/lib/ui/engagement";

const riskLabel = { HIGH: "고위험", MEDIUM: "주의", LOW: "일반" } as const;
const riskScore = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

export function DashboardControlRoom({ matters }: { matters: Matter[] }) {
  const active = matters.filter((matter) => matter.status !== "CLOSED");
  const ranked = active
    .toSorted((left, right) => {
      return (
        riskScore[right.risk] - riskScore[left.risk] ||
        right.openFindings - left.openFindings
      );
    })
    .slice(0, 3);
  const reviewCount = active.filter(
    (matter) => matter.status === "IN_REVIEW",
  ).length;
  const missingCount = active.filter(
    (matter) => matter.status === "NEEDS_INFO",
  ).length;
  const highRiskCount = active.filter(
    (matter) => matter.risk === "HIGH",
  ).length;

  return (
    <section
      className="control-room-grid"
      aria-label="전체 업무 현황과 예정 일정"
    >
      <article className="portfolio-briefing">
        <div className="portfolio-briefing-heading">
          <div>
            <span>PORTFOLIO BRIEFING</span>
            <h2>우선 확인할 업무</h2>
          </div>
          <ShieldAlert size={22} aria-hidden="true" />
        </div>

        <div className="portfolio-signal-grid" aria-label="업무 상태 요약">
          <div>
            <CircleAlert size={15} aria-hidden="true" />
            <strong>{highRiskCount}</strong>
            <span>고위험</span>
          </div>
          <div>
            <FileClock size={15} aria-hidden="true" />
            <strong>{missingCount}</strong>
            <span>자료 보완</span>
          </div>
          <div>
            <ShieldAlert size={15} aria-hidden="true" />
            <strong>{reviewCount}</strong>
            <span>검토 중</span>
          </div>
        </div>

        <ol className="portfolio-priority-list">
          {ranked.map((matter, index) => (
            <li key={matter.id}>
              <span className="portfolio-rank">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{matter.client}</strong>
                <span>{matter.summary}</span>
              </div>
              <Link href={`/cases/${matter.id}`}>
                {getEngagementNextAction(matter)}
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
      </article>

      <article className="card upcoming-schedule-card">
        <div className="card-header">
          <div>
            <span className="card-kicker">Upcoming schedule</span>
            <h2>예정 일정</h2>
            <p>마감일과 다음 조치를 함께 확인합니다.</p>
          </div>
          <CalendarClock size={20} aria-hidden="true" />
        </div>
        <div className="upcoming-schedule-list">
          {ranked.map((matter) => (
            <Link href={`/cases/${matter.id}`} key={matter.id}>
              <time>{matter.dueDate}</time>
              <span>
                <strong>{matter.client}</strong>
                <small>
                  {matter.taxType} · {getEngagementNextAction(matter)}
                </small>
              </span>
              <em>{riskLabel[matter.risk]}</em>
            </Link>
          ))}
        </div>
        <Link className="upcoming-schedule-footer" href="/cases">
          전체 업무 일정 보기 <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </article>
    </section>
  );
}
