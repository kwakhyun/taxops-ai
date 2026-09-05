import { z } from "zod";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().startsWith(value)
    );
  }, "존재하는 날짜를 입력해 주세요.")
  .optional();
export const listingSchema = z.object({
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const matterQuerySchema = listingSchema.extend({
  risk: z.enum(["ALL", "HIGH", "MEDIUM", "LOW"]).default("ALL"),
});
export const auditQuerySchema = listingSchema
  .extend({
    outcome: z.enum(["ALL", "SUCCESS", "DENIED", "FAILED"]).default("ALL"),
    from: date,
    to: date,
  })
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    "시작일은 종료일보다 늦을 수 없습니다.",
  );
export type MatterQuery = z.infer<typeof matterQuerySchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export type MatterSearchItem = Pick<
  import("@/lib/domain/types").Matter,
  "id" | "client" | "taxType" | "period" | "summary"
>;
export function pageResult<T>(
  items: T[],
  query: { page: number; pageSize: number },
): PageResult<T> {
  return {
    items: items.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    ),
    total: items.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}
export function matchesMatter(
  matter: MatterSearchItem & { risk: string },
  query: MatterQuery,
) {
  return (
    (query.risk === "ALL" || query.risk === matter.risk) &&
    `${matter.client} ${matter.taxType} ${matter.period} ${matter.summary}`
      .toLocaleLowerCase("ko-KR")
      .includes(query.q.toLocaleLowerCase("ko-KR"))
  );
}
export function auditDateBounds(query: Pick<AuditQuery, "from" | "to">) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00+09:00`) : null,
    to: query.to
      ? new Date(new Date(`${query.to}T00:00:00+09:00`).getTime() + 86400000)
      : null,
  };
}
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
