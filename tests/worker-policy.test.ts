import { describe, expect, it } from "vitest";
import { failureDisposition } from "@/lib/jobs/retry-policy";
import { workerProductionConfigurationErrors } from "@/lib/security/runtime-mode";

describe("worker retry policy", () => {
  it("retries a transient failure with bounded backoff", () => {
    expect(
      failureDisposition({
        attempts: 2,
        maxAttempts: 4,
        permanent: false,
        jitter: 1,
      }),
    ).toEqual({ status: "RETRYING", delaySeconds: 5 });
  });

  it("dead-letters permanent and exhausted jobs", () => {
    expect(
      failureDisposition({
        attempts: 1,
        maxAttempts: 4,
        permanent: true,
        jitter: 0,
      }).status,
    ).toBe("DEAD");
    expect(
      failureDisposition({
        attempts: 4,
        maxAttempts: 4,
        permanent: false,
        jitter: 0,
      }).status,
    ).toBe("DEAD");
  });
});

describe("worker production configuration", () => {
  const configuredEnvironment = {
    NODE_ENV: "production",
    TAXOPS_LOCAL_STACK: "false",
    DATABASE_URL: "postgres://worker@db/taxops",
    OBJECT_BUCKET: "taxops-private",
    AWS_REGION: "ap-northeast-2",
    CLAMAV_HOST: "clamav.internal",
    CLAMAV_PORT: "3310",
    AI_GATEWAY_API_KEY: "runtime-secret",
    AI_PROVIDER_DATA_REGION: "ap-northeast-2",
    PII_DLP_URL: "https://dlp.internal/v1/redact",
    PII_DLP_TOKEN: "runtime-secret",
    PII_DLP_DATA_REGION: "ap-northeast-2",
    PROMPT_INJECTION_CLASSIFIER_URL: "https://classifier.internal/v1/classify",
    PROMPT_INJECTION_CLASSIFIER_TOKEN: "runtime-secret",
    PROMPT_INJECTION_CLASSIFIER_DATA_REGION: "ap-northeast-2",
    PROMPT_INJECTION_CLASSIFIER_ALLOWED_HOSTS: "classifier.internal",
    PROMPT_INJECTION_CLASSIFIER_THRESHOLD: "0.5",
    DOCUMENT_PROCESSOR_URL: "https://processor.internal/v1/extract",
    DOCUMENT_PROCESSOR_TOKEN: "runtime-secret",
    DOCUMENT_PROCESSOR_DATA_REGION: "ap-northeast-2",
    DOCUMENT_PROCESSOR_ALLOWED_HOSTS: "processor.internal",
  } as NodeJS.ProcessEnv;

  it("accepts the complete authenticated production dependency contract", () => {
    expect(workerProductionConfigurationErrors(configuredEnvironment)).toEqual(
      [],
    );
  });

  it("rejects local bypasses and incomplete or insecure dependencies", () => {
    expect(
      workerProductionConfigurationErrors({
        ...configuredEnvironment,
        TAXOPS_LOCAL_STACK: "true",
        PII_DLP_URL: "http://dlp.internal/v1/redact",
        DOCUMENT_PROCESSOR_TOKEN: "",
      }),
    ).toEqual(
      expect.arrayContaining([
        "TAXOPS_LOCAL_STACK",
        "PII_DLP_URL",
        "DOCUMENT_PROCESSOR_TOKEN",
      ]),
    );
  });
});
