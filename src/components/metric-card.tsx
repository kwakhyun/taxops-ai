import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

export function MetricCard({
  label,
  value,
  helper,
  trend,
  trendDirection = "up",
  icon: Icon,
  tone = "ink",
  footer,
}: {
  label: string;
  value: string;
  helper?: string;
  trend?: string;
  trendDirection?: "up" | "down";
  icon: LucideIcon;
  tone?: "ink" | "green" | "violet" | "amber";
  footer?: ReactNode;
}) {
  const TrendIcon = trendDirection === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <article className="metric-card">
      <div className="metric-card-top">
        <span className={`metric-icon metric-icon-${tone}`}>
          <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
        </span>
        {trend ? (
          <span className={`metric-trend metric-trend-${trendDirection}`}>
            <TrendIcon size={13} aria-hidden="true" /> {trend}
          </span>
        ) : null}
      </div>
      <div>
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
        {helper ? <p className="metric-helper">{helper}</p> : null}
      </div>
      {footer ? <div className="metric-footer">{footer}</div> : null}
    </article>
  );
}
