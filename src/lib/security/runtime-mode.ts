export function productionLocalStackOverrideIsDisabled(
  environment: Partial<
    Pick<NodeJS.ProcessEnv, "NODE_ENV" | "TAXOPS_LOCAL_STACK">
  > = process.env,
) {
  return !(
    environment.NODE_ENV === "production" &&
    environment.TAXOPS_LOCAL_STACK === "true"
  );
}

function secureUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.port === "" || url.port === "443")
    );
  } catch {
    return false;
  }
}

function hostIsAllowed(
  value: string | undefined,
  allowlist: string | undefined,
) {
  if (!secureUrl(value)) return false;
  const host = new URL(value!).hostname.toLocaleLowerCase("en-US");
  return (allowlist ?? "")
    .split(",")
    .map((item) => item.trim().toLocaleLowerCase("en-US"))
    .includes(host);
}

export function workerProductionConfigurationErrors(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  if (!productionLocalStackOverrideIsDisabled(environment)) {
    errors.push("TAXOPS_LOCAL_STACK");
  }
  for (const key of [
    "DATABASE_URL",
    "OBJECT_BUCKET",
    "AWS_REGION",
    "CLAMAV_HOST",
    "AI_GATEWAY_API_KEY",
    "AI_PROVIDER_DATA_REGION",
    "PII_DLP_TOKEN",
    "PII_DLP_DATA_REGION",
    "PROMPT_INJECTION_CLASSIFIER_TOKEN",
    "PROMPT_INJECTION_CLASSIFIER_DATA_REGION",
    "DOCUMENT_PROCESSOR_TOKEN",
    "DOCUMENT_PROCESSOR_DATA_REGION",
  ]) {
    if (!environment[key]) errors.push(key);
  }
  const clamAvPort = Number(environment.CLAMAV_PORT ?? 3310);
  if (!Number.isInteger(clamAvPort) || clamAvPort < 1 || clamAvPort > 65_535) {
    errors.push("CLAMAV_PORT");
  }
  if (!secureUrl(environment.PII_DLP_URL)) errors.push("PII_DLP_URL");
  if (
    !hostIsAllowed(
      environment.PROMPT_INJECTION_CLASSIFIER_URL,
      environment.PROMPT_INJECTION_CLASSIFIER_ALLOWED_HOSTS,
    )
  ) {
    errors.push("PROMPT_INJECTION_CLASSIFIER_URL");
  }
  const classifierThreshold = Number(
    environment.PROMPT_INJECTION_CLASSIFIER_THRESHOLD,
  );
  if (
    !Number.isFinite(classifierThreshold) ||
    classifierThreshold < 0.1 ||
    classifierThreshold > 0.99
  ) {
    errors.push("PROMPT_INJECTION_CLASSIFIER_THRESHOLD");
  }
  if (
    !hostIsAllowed(
      environment.DOCUMENT_PROCESSOR_URL,
      environment.DOCUMENT_PROCESSOR_ALLOWED_HOSTS,
    )
  ) {
    errors.push("DOCUMENT_PROCESSOR_URL");
  }
  if (environment.S3_ENDPOINT && !secureUrl(environment.S3_ENDPOINT)) {
    errors.push("S3_ENDPOINT");
  }
  if (
    environment.REQUIRE_NOTIFICATION_WEBHOOK === "true" &&
    (!secureUrl(environment.NOTIFICATION_WEBHOOK_URL) ||
      !environment.NOTIFICATION_WEBHOOK_SECRET)
  ) {
    errors.push("NOTIFICATION_WEBHOOK");
  }
  return [...new Set(errors)];
}
