import { z } from "zod";
import { taxPeriodReferenceDate } from "@/lib/tax/period";

export const createMatterSchema = z.strictObject({
  client: z
    .string()
    .trim()
    .min(2, "고객사명은 2자 이상 입력해 주세요.")
    .max(120, "고객사명은 120자 이내로 입력해 주세요."),
  taxType: z.enum(["부가가치세", "법인세", "원천세", "소득세", "국제조세"]),
  period: z
    .string()
    .trim()
    .min(4, "신고 대상 기간은 4자 이상 입력해 주세요.")
    .max(80, "신고 대상 기간은 80자 이내로 입력해 주세요.")
    .refine((value) => Boolean(taxPeriodReferenceDate(value)), {
      message:
        "기간은 ‘2026년 1기 예정’, ‘2025 사업연도’, ‘2026년 1월’처럼 입력해 주세요.",
    }),
  summary: z
    .string()
    .trim()
    .min(8, "핵심 검토 범위는 8자 이상 입력해 주세요.")
    .max(400, "핵심 검토 범위는 400자 이내로 입력해 주세요."),
  dueDate: z
    .string()
    .regex(/^\d{4}\. \d{2}\. \d{2}$/, "업무 마감일을 입력해 주세요."),
  reviewerId: z.uuid("검토자를 선택해 주세요."),
});

export type CreateMatterInput = z.infer<typeof createMatterSchema>;
