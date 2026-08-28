const redactionPatterns = [
  // 1-4: resident registration, 5-8: foreign resident registration.
  { name: "resident-number", pattern: /\b\d{6}-?[1-8]\d{6}\b/g },
  { name: "passport-number", pattern: /\b[A-Z]{1,2}\d{7,8}\b/gi },
  { name: "business-number", pattern: /\b\d{3}-?\d{2}-?\d{5}\b/g },
  { name: "corporate-number", pattern: /\b\d{6}-?\d{7}\b/g },
  {
    name: "payment-card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
  },
  { name: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    name: "phone",
    pattern: /\b(?:01[016789]|02|0[3-6][1-5])-?\d{3,4}-?\d{4}\b/g,
  },
  { name: "bank-account", pattern: /\b\d{2,6}-\d{2,6}-\d{2,8}\b/g },
  {
    name: "labeled-bank-account",
    pattern:
      /(?:계좌|은행|신한|국민|우리|하나|농협|기업|카카오뱅크|토스뱅크)\s*[:：]?\s*\d{10,14}(?!\d)/g,
  },
  {
    name: "labeled-name",
    pattern:
      /(?:성명|이름|대표자|담당자|예금주)\s*[:：]?\s*[가-힣]{2,4}(?![가-힣])/g,
  },
  {
    name: "name-before-address",
    pattern:
      /(?<![가-힣])[가-힣]{2,4}\s+(?=(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별자치도|특별자치시|특별시|광역시|도|시))/g,
  },
  {
    name: "address",
    pattern:
      /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별자치도|특별자치시|특별시|광역시|도|시)?\s+[가-힣0-9-]+(?:시|군|구)\s+(?:[가-힣0-9-]+(?:시|군|구)\s+)?[가-힣0-9-]+(?:로|길|동|읍|면)(?:\s+\d+(?:-\d+)?)?/g,
  },
] as const;

export function redactPii(value: string) {
  return redactionPatterns.reduce(
    (redacted, item) =>
      redacted.replace(item.pattern, `[REDACTED:${item.name}]`),
    value,
  );
}

export function containsPii(value: string) {
  return redactionPatterns.some((item) => {
    item.pattern.lastIndex = 0;
    return item.pattern.test(value);
  });
}

export function safeMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (typeof value === "string")
        return [key, redactPii(value).slice(0, 200)];
      if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value == null
      ) {
        return [key, value];
      }
      return [key, "[NON_SCALAR_REDACTED]"];
    }),
  );
}
