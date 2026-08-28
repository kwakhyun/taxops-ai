import { z } from "zod";
import { taxPeriodReferenceDate } from "@/lib/tax/period";

export const createMatterSchema = z.strictObject({
  client: z.string().trim().min(2).max(120),
  taxType: z.enum(["부가가치세", "법인세", "원천세", "소득세", "국제조세"]),
  period: z
    .string()
    .trim()
    .min(4)
    .max(80)
    .refine((value) => Boolean(taxPeriodReferenceDate(value)), {
      message:
        "기간은 ‘2026년 1기 예정’, ‘2025 사업연도’, ‘2026년 1월’처럼 입력해 주세요.",
    }),
  summary: z.string().trim().min(8).max(400),
  dueDate: z.string().regex(/^\d{4}\. \d{2}\. \d{2}$/),
  reviewerId: z.uuid(),
});

export type CreateMatterInput = z.infer<typeof createMatterSchema>;
