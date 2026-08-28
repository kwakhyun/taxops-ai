import { detectPromptInjection } from "@/lib/ai/guardrails";

const defaultAllowedHosts = [
  "law.go.kr",
  "nts.go.kr",
  "moef.go.kr",
  "korea.kr",
  "elaw.klri.re.kr",
] as const;

function allowedHosts() {
  const configured = (process.env.SOURCE_URI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean);
  return new Set([...defaultAllowedHosts, ...configured]);
}

function isAllowedHost(hostname: string) {
  const normalized = hostname.toLocaleLowerCase("en-US");
  return [...allowedHosts()].some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`),
  );
}

export function decodeSourceUriForInspection(value: string) {
  let decoded = value.normalize("NFKC");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next.normalize("NFKC");
    } catch {
      break;
    }
  }
  return decoded;
}

export function normalizeTrustedSourceUri(value: string) {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !isAllowedHost(url.hostname)
  ) {
    throw new Error("Source URI is outside the HTTPS host allowlist");
  }
  url.hash = "";
  const normalized = url.toString();
  if (detectPromptInjection(decodeSourceUriForInspection(normalized))) {
    throw new Error("Source URI contains an unsafe instruction pattern");
  }
  return normalized;
}
