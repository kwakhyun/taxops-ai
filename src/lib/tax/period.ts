function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0, 12)).toISOString();
}

/**
 * Converts the user-facing Korean tax period into the point-in-time used for
 * legal-source retrieval. Unknown formats fail closed instead of silently
 * mixing today's law into a historical filing review.
 */
export function taxPeriodReferenceDate(period: string) {
  const normalized = period.normalize("NFKC").replace(/\s+/g, " ").trim();
  const yearMatch = /^(\d{4})년?/.exec(normalized);
  if (!yearMatch) return undefined;
  const year = Number(yearMatch[1]);

  const halfMatch = /([12])기\s*(예정|확정)/.exec(normalized);
  if (halfMatch) {
    const half = Number(halfMatch[1]);
    const preliminary = halfMatch[2] === "예정";
    const month = half === 1 ? (preliminary ? 3 : 6) : preliminary ? 9 : 12;
    return endOfMonth(year, month);
  }

  const quarterMatch = /(?:제?\s*)?([1-4])(?:분기|Q)/i.exec(normalized);
  if (quarterMatch) return endOfMonth(year, Number(quarterMatch[1]) * 3);

  const monthMatch = /년\s*(1[0-2]|[1-9])월/.exec(normalized);
  if (monthMatch) return endOfMonth(year, Number(monthMatch[1]));

  if (/사업연도|귀속|연간/.test(normalized)) return endOfMonth(year, 12);
  return undefined;
}

const calculationIntentPattern =
  /(계산|금액|차이|세액|세율|합계|얼마|공급가액|과세표준|부가세|부가가치세|\bVAT\b)/i;

export function requiresTaxCalculation(question: string) {
  return calculationIntentPattern.test(question.normalize("NFKC"));
}
