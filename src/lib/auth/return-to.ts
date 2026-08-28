const validationOrigin = "https://taxops.invalid";

export function safeReturnTo(value: string | null) {
  if (!value || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  let decoded = value;
  for (let index = 0; index < 2; index++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return "/";
    }
    if (/[\\\u0000-\u001f\u007f]/.test(decoded)) return "/";
  }
  try {
    const target = new URL(value, validationOrigin);
    if (target.origin !== validationOrigin) return "/";
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}
