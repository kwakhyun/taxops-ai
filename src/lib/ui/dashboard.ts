import type { Matter } from "@/lib/domain/types";

const riskScore = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
export function dashboardWorklists(matters: Matter[]) {
  const active = matters.filter((matter) => matter.status !== "CLOSED");
  return {
    priority: active
      .toSorted(
        (a, b) =>
          riskScore[b.risk] - riskScore[a.risk] ||
          a.dueDate.localeCompare(b.dueDate) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 3),
    schedule: active
      .toSorted(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
      )
      .slice(0, 5),
  };
}
export function deadlineLabel(dueDate: string, today: string) {
  const date = dueDate.replaceAll(". ", "-");
  return date < today ? "마감 지남" : date === today ? "오늘 마감" : "예정";
}
