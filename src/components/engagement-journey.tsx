import Link from "next/link";
import {
  BadgeCheck,
  BookOpenText,
  Calculator,
  ClipboardList,
  Files,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { Matter } from "@/lib/domain/types";
import {
  engagementSections,
  getEngagementSectionHref,
  getEngagementStageIndex,
} from "@/lib/ui/engagement";

const icons: Record<(typeof engagementSections)[number]["key"], LucideIcon> = {
  overview: ClipboardList,
  documents: Files,
  research: BookOpenText,
  calculation: Calculator,
  review: BadgeCheck,
  filing: Send,
};

export function EngagementJourney({
  matter,
  compact = false,
  canReview = false,
}: {
  matter: Matter;
  compact?: boolean;
  canReview?: boolean;
}) {
  const activeIndex = getEngagementStageIndex(matter);
  const current = engagementSections[activeIndex] ?? engagementSections[0];

  return (
    <section
      className={
        compact
          ? "engagement-journey engagement-journey-compact"
          : "engagement-journey"
      }
      aria-labelledby={`engagement-journey-${matter.id}`}
    >
      <div className="engagement-journey-header">
        <div>
          <span className="card-kicker">Engagement workflow</span>
          <h2 id={`engagement-journey-${matter.id}`}>세무 업무 진행 단계</h2>
        </div>
        <span className="engagement-current-stage">
          현재 단계 <strong>{current.label}</strong>
        </span>
      </div>

      <ol className="engagement-stage-list">
        {engagementSections.map((section, index) => {
          const Icon = icons[section.key];
          const state =
            index < activeIndex
              ? "complete"
              : index === activeIndex
                ? "active"
                : "upcoming";
          return (
            <li
              className={`engagement-stage engagement-stage-${state}`}
              key={section.key}
            >
              <Link
                href={getEngagementSectionHref(
                  section.key,
                  matter.id,
                  canReview,
                )}
                aria-current={state === "active" ? "step" : undefined}
              >
                <span className="engagement-stage-index" aria-hidden="true">
                  <Icon size={15} strokeWidth={2} />
                </span>
                <span className="engagement-stage-copy">
                  <strong>{section.label}</strong>
                  <small>{section.description}</small>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      <div
        className="engagement-progress"
        role="progressbar"
        aria-label={`${matter.client} 세무 업무 진행률`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={matter.progress}
      >
        <span style={{ width: `${matter.progress}%` }} />
      </div>
    </section>
  );
}
