import { z } from "zod";
import { detectUntrustedSourceInstruction } from "../ai/guardrails.ts";
import {
  protectAiOutbound,
  protectAiOutboundBatch,
  type TenantAiPolicy,
} from "./ai-policy.ts";
import { validateRegionalServiceEndpoint } from "./regional-service.ts";
import { fetchWithoutRedirect } from "./safe-fetch.ts";
import { productionLocalStackOverrideIsDisabled } from "./runtime-mode.ts";
import { isPortfolioDemo } from "../runtime/portfolio-demo.ts";

export const SOURCE_INJECTION_POLICY_VERSION = "source-instruction.v1";
const DEFAULT_THRESHOLD = 0.5;
const MAX_BATCH_SIZE = 32;
const MAX_RESPONSE_BYTES = 256 * 1024;

const classifierResponseSchema = z.strictObject({
  policyVersion: z.literal(SOURCE_INJECTION_POLICY_VERSION),
  modelVersion: z.string().min(1).max(120),
  threshold: z.number().min(0).max(1),
  items: z
    .array(
      z.strictObject({
        riskScore: z.number().min(0).max(1),
        label: z.enum(["SAFE", "SUSPICIOUS"]),
      }),
    )
    .max(MAX_BATCH_SIZE),
});

export type InjectionClassification = z.infer<typeof classifierResponseSchema>;

export class InjectionClassifierError extends Error {
  readonly code: string;
  readonly status = 503;
  readonly permanent: boolean;

  constructor(code: string, message: string, permanent = false) {
    super(message);
    this.name = "InjectionClassifierError";
    this.code = code;
    this.permanent = permanent;
  }
}

function configuredThreshold() {
  const configured = Number(
    process.env.PROMPT_INJECTION_CLASSIFIER_THRESHOLD ?? DEFAULT_THRESHOLD,
  );
  if (!Number.isFinite(configured) || configured < 0.1 || configured > 0.99) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INVALID_THRESHOLD",
      "프롬프트 인젝션 분류 임계값이 올바르지 않습니다.",
      true,
    );
  }
  return configured;
}

function localClassification(
  texts: string[],
  threshold: number,
): InjectionClassification {
  return {
    policyVersion: SOURCE_INJECTION_POLICY_VERSION,
    modelVersion: "deterministic-source-instruction.v1",
    threshold,
    items: texts.map((text) => {
      const suspicious = detectUntrustedSourceInstruction(text);
      return {
        riskScore: suspicious ? 1 : 0,
        label: suspicious ? ("SUSPICIOUS" as const) : ("SAFE" as const),
      };
    }),
  };
}

async function readBoundedJson(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INVALID_RESPONSE",
      "프롬프트 인젝션 분류 응답이 허용 크기를 초과했습니다.",
    );
  }
  if (!response.body) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INVALID_RESPONSE",
      "프롬프트 인젝션 분류 응답이 비어 있습니다.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new InjectionClassifierError(
        "INJECTION_CLASSIFIER_INVALID_RESPONSE",
        "프롬프트 인젝션 분류 응답이 허용 크기를 초과했습니다.",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INVALID_RESPONSE",
      "프롬프트 인젝션 분류 응답을 검증할 수 없습니다.",
    );
  }
}

async function classifyExternalBatch(
  texts: string[],
  policy: TenantAiPolicy,
  threshold: number,
) {
  const endpoint = process.env.PROMPT_INJECTION_CLASSIFIER_URL;
  const token = process.env.PROMPT_INJECTION_CLASSIFIER_TOKEN;
  const dataRegion = process.env.PROMPT_INJECTION_CLASSIFIER_DATA_REGION;
  if (!endpoint) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_NOT_CONFIGURED",
      "프로덕션 프롬프트 인젝션 분류 서비스가 구성되지 않았습니다.",
      true,
    );
  }

  let url: URL;
  try {
    url = validateRegionalServiceEndpoint({
      serviceName: "Prompt injection classifier",
      url: endpoint,
      token,
      dataRegion,
      allowedHosts: process.env.PROMPT_INJECTION_CLASSIFIER_ALLOWED_HOSTS,
      policy,
      production: true,
    });
  } catch {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INVALID_ENDPOINT",
      "프롬프트 인젝션 분류 서비스의 보안 구성이 올바르지 않습니다.",
      true,
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
        policyVersion: SOURCE_INJECTION_POLICY_VERSION,
        threshold,
        texts,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_UNAVAILABLE",
      "프롬프트 인젝션 분류 서비스를 호출하지 못했습니다.",
    );
  }
  if (!response.ok) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_UNAVAILABLE",
      "프롬프트 인젝션 분류 서비스가 요청을 거부했습니다.",
    );
  }

  const parsed = classifierResponseSchema.safeParse(
    await readBoundedJson(response),
  );
  if (!parsed.success || parsed.data.items.length !== texts.length) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INVALID_RESPONSE",
      "프롬프트 인젝션 분류 결과를 검증할 수 없습니다.",
    );
  }
  if (Math.abs(parsed.data.threshold - threshold) > Number.EPSILON) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_POLICY_MISMATCH",
      "프롬프트 인젝션 분류 서비스의 임계값이 요청과 다릅니다.",
    );
  }
  for (const item of parsed.data.items) {
    const expectedLabel = item.riskScore >= threshold ? "SUSPICIOUS" : "SAFE";
    if (item.label !== expectedLabel) {
      throw new InjectionClassifierError(
        "INJECTION_CLASSIFIER_INVALID_RESPONSE",
        "프롬프트 인젝션 분류 점수와 판정이 일치하지 않습니다.",
      );
    }
  }
  return parsed.data;
}

function shouldUseExternalClassifier() {
  if (process.env.NODE_ENV !== "production" || isPortfolioDemo()) return false;
  if (!productionLocalStackOverrideIsDisabled()) {
    throw new InjectionClassifierError(
      "PRODUCTION_LOCAL_STACK_OVERRIDE_FORBIDDEN",
      "프로덕션에서 로컬 보안 제어 우회를 활성화할 수 없습니다.",
      true,
    );
  }
  return true;
}

export async function classifyUntrustedSourceBatch(
  texts: string[],
  policy: TenantAiPolicy,
): Promise<InjectionClassification> {
  if (texts.length === 0) {
    const threshold = configuredThreshold();
    return {
      policyVersion: SOURCE_INJECTION_POLICY_VERSION,
      modelVersion: shouldUseExternalClassifier()
        ? "not-invoked"
        : "deterministic-source-instruction.v1",
      threshold,
      items: [],
    };
  }
  if (
    texts.length > 1_100 ||
    texts.some((text) => typeof text !== "string" || text.length > 12_000)
  ) {
    throw new InjectionClassifierError(
      "INJECTION_CLASSIFIER_INPUT_INVALID",
      "프롬프트 인젝션 분류 입력이 허용 범위를 벗어났습니다.",
      true,
    );
  }

  const threshold = configuredThreshold();
  const local = localClassification(texts, threshold);
  if (!shouldUseExternalClassifier()) return local;

  const batches: string[][] = [];
  for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
    batches.push(texts.slice(offset, offset + MAX_BATCH_SIZE));
  }
  const batchResults = new Array<InjectionClassification>(batches.length);
  let nextBatch = 0;
  const concurrency = Math.min(4, batches.length);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextBatch < batches.length) {
        const index = nextBatch++;
        batchResults[index] = await classifyExternalBatch(
          batches[index]!,
          policy,
          threshold,
        );
      }
    }),
  );

  const combinedItems: InjectionClassification["items"] = [];
  let modelVersion: string | undefined;
  for (const [batchIndex, external] of batchResults.entries()) {
    if (modelVersion && external.modelVersion !== modelVersion) {
      throw new InjectionClassifierError(
        "INJECTION_CLASSIFIER_MODEL_CHANGED",
        "문서 검사 중 프롬프트 인젝션 분류기 버전이 변경되었습니다.",
      );
    }
    modelVersion = external.modelVersion;
    external.items.forEach((item, index) => {
      const localItem = local.items[batchIndex * MAX_BATCH_SIZE + index]!;
      const riskScore = Math.max(item.riskScore, localItem.riskScore);
      combinedItems.push({
        riskScore,
        label: riskScore >= threshold ? "SUSPICIOUS" : "SAFE",
      });
    });
  }

  return {
    policyVersion: SOURCE_INJECTION_POLICY_VERSION,
    modelVersion: `${modelVersion}+deterministic-source-instruction.v1`,
    threshold,
    items: combinedItems,
  };
}

/**
 * Ingestion uses this boundary so source text is never sent to the semantic
 * classifier before the tenant's BLOCK/REDACT egress policy is applied.
 */
export async function classifyProtectedUntrustedSourceBatch(
  texts: string[],
  policy: TenantAiPolicy,
) {
  shouldUseExternalClassifier();
  const protectedTexts =
    process.env.TAXOPS_LOCAL_STACK === "true"
      ? texts.map((text) =>
          protectAiOutbound(text, policy, { truncate: false }),
        )
      : await protectAiOutboundBatch(texts, policy, {
          truncate: false,
        });
  return classifyUntrustedSourceBatch(protectedTexts, policy);
}
