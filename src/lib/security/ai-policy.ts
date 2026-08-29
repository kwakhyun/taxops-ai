import { containsPii, redactPii } from "./redaction.ts";
import { fetchWithoutRedirect } from "./safe-fetch.ts";
import { isPortfolioDemo } from "../runtime/portfolio-demo.ts";

export type OutboundPiiMode = "BLOCK" | "REDACT" | "ALLOW";

export interface TenantAiPolicy {
  enabled: boolean;
  outboundPiiMode: OutboundPiiMode;
  maxExcerptChars: number;
  tenantDataRegion: string;
  providerDataRegion: string;
  allowedProviderRegions: string[];
  monthlyBudgetKrw: number;
}

export class AiPolicyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly permanent: boolean;

  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = "AiPolicyError";
    this.code = code;
    this.status = status;
    this.permanent = status < 500;
  }
}

export function resolveTenantAiPolicy(
  enabled: boolean,
  rawPolicy: Record<string, unknown>,
  options: { tenantDataRegion?: string; providerDataRegion?: string } = {},
): TenantAiPolicy {
  const configuredMode = rawPolicy.outboundPiiMode;
  const outboundPiiMode: OutboundPiiMode =
    configuredMode === "REDACT" || configuredMode === "ALLOW"
      ? configuredMode
      : "BLOCK";
  const configuredLimit = rawPolicy.maxExcerptChars;
  const maxExcerptChars =
    typeof configuredLimit === "number" &&
    Number.isInteger(configuredLimit) &&
    configuredLimit >= 500 &&
    configuredLimit <= 4_000
      ? configuredLimit
      : 1_500;
  const tenantDataRegion = options.tenantDataRegion ?? "ap-northeast-2";
  const configuredRegions = rawPolicy.allowedProviderRegions;
  const allowedProviderRegions = Array.isArray(configuredRegions)
    ? configuredRegions.filter(
        (region): region is string =>
          typeof region === "string" && /^[a-z0-9-]{3,40}$/.test(region),
      )
    : [tenantDataRegion];
  const providerDataRegion =
    options.providerDataRegion ??
    process.env.AI_PROVIDER_DATA_REGION ??
    (process.env.NODE_ENV === "production" && !isPortfolioDemo()
      ? ""
      : tenantDataRegion);
  const configuredBudget = rawPolicy.monthlyBudgetKrw;
  const monthlyBudgetKrw =
    typeof configuredBudget === "number" &&
    Number.isFinite(configuredBudget) &&
    configuredBudget >= 10_000 &&
    configuredBudget <= 100_000_000
      ? configuredBudget
      : 1_000_000;
  return {
    enabled,
    outboundPiiMode,
    maxExcerptChars,
    tenantDataRegion,
    providerDataRegion,
    allowedProviderRegions,
    monthlyBudgetKrw,
  };
}

export function protectAiOutbound(
  value: string,
  policy: TenantAiPolicy,
  options?: { truncate?: boolean },
) {
  if (!policy.enabled) {
    throw new AiPolicyError(
      "AI_DISABLED_FOR_TENANT",
      "이 조직에서는 외부 AI 처리가 비활성화되어 있습니다.",
    );
  }
  if (
    !policy.providerDataRegion ||
    !policy.allowedProviderRegions.includes(policy.providerDataRegion)
  ) {
    throw new AiPolicyError(
      "AI_DATA_REGION_NOT_ALLOWED",
      "조직 정책에서 허용한 데이터 처리 지역과 AI 제공자의 처리 지역이 일치하지 않습니다.",
    );
  }
  if (policy.outboundPiiMode === "BLOCK" && containsPii(value)) {
    throw new AiPolicyError(
      "AI_PII_BLOCKED",
      "민감정보가 포함되어 외부 AI 처리를 차단했습니다.",
      422,
    );
  }
  const protectedValue =
    policy.outboundPiiMode === "REDACT" ? redactPii(value) : value;
  return options?.truncate === false
    ? protectedValue
    : protectedValue.slice(0, policy.maxExcerptChars);
}

export async function protectAiOutboundBatch(
  values: string[],
  policy: TenantAiPolicy,
  options?: { truncate?: boolean },
) {
  const locallyProtected = values.map((value) =>
    protectAiOutbound(value, policy, options),
  );
  if (process.env.NODE_ENV !== "production" || isPortfolioDemo()) {
    return locallyProtected;
  }

  const endpoint = process.env.PII_DLP_URL;
  const token = process.env.PII_DLP_TOKEN;
  const dlpRegion = process.env.PII_DLP_DATA_REGION;
  if (!endpoint || !token || !dlpRegion) {
    throw new AiPolicyError(
      "PII_DLP_NOT_CONFIGURED",
      "운영 환경의 민감정보 검사 서비스가 구성되지 않았습니다.",
      503,
    );
  }
  if (!policy.allowedProviderRegions.includes(dlpRegion)) {
    throw new AiPolicyError(
      "PII_DLP_REGION_DENIED",
      "민감정보 검사 서비스의 처리 지역이 조직 정책과 일치하지 않습니다.",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiPolicyError(
      "PII_DLP_INVALID_URL",
      "민감정보 검사 서비스 URL이 올바르지 않습니다.",
      503,
    );
  }
  if (url.protocol !== "https:") {
    throw new AiPolicyError(
      "PII_DLP_INSECURE_URL",
      "민감정보 검사 서비스는 HTTPS를 사용해야 합니다.",
      503,
    );
  }
  let response: Response;
  try {
    response = await fetchWithoutRedirect(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        texts: locallyProtected,
        mode: policy.outboundPiiMode,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AiPolicyError(
      "PII_DLP_UNAVAILABLE",
      "민감정보 검사 서비스를 호출하지 못했습니다.",
      503,
    );
  }
  if (!response.ok) {
    throw new AiPolicyError(
      "PII_DLP_UNAVAILABLE",
      "민감정보 검사 서비스가 요청을 거부했습니다.",
      503,
    );
  }
  const payload = (await response.json()) as {
    items?: Array<{ containsPii?: unknown; redactedText?: unknown }>;
  };
  if (!Array.isArray(payload.items) || payload.items.length !== values.length) {
    throw new AiPolicyError(
      "PII_DLP_INVALID_RESPONSE",
      "민감정보 검사 결과를 검증할 수 없습니다.",
      503,
    );
  }
  return payload.items.map((item, index) => {
    if (
      typeof item.containsPii !== "boolean" ||
      typeof item.redactedText !== "string"
    ) {
      throw new AiPolicyError(
        "PII_DLP_INVALID_RESPONSE",
        "민감정보 검사 결과를 검증할 수 없습니다.",
        503,
      );
    }
    if (policy.outboundPiiMode === "BLOCK" && item.containsPii) {
      throw new AiPolicyError(
        "AI_PII_BLOCKED",
        "민감정보가 포함된 텍스트는 외부 AI로 전송할 수 없습니다.",
        422,
      );
    }
    return policy.outboundPiiMode === "REDACT"
      ? protectAiOutbound(item.redactedText, policy, options)
      : locallyProtected[index]!;
  });
}

export async function protectAiOutboundWithDlp(
  value: string,
  policy: TenantAiPolicy,
  options?: { truncate?: boolean },
) {
  return (await protectAiOutboundBatch([value], policy, options))[0]!;
}
