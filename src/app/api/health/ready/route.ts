import { aiPricing } from "@/lib/ai/budget";
import {
  reviewServiceIsConfigured,
  reviewServiceIsReachable,
} from "@/lib/review/service-client";
import { productionLocalStackOverrideIsDisabled } from "@/lib/security/runtime-mode";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";

export const runtime = "nodejs";

function isProductionHttpsUrl(name: string) {
  const value = process.env[name];
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isAllowlistedHttpsUrl(urlName: string, allowlistName: string) {
  const value = process.env[urlName];
  if (!value) return false;
  try {
    const url = new URL(value);
    const allowedHosts = new Set(
      (process.env[allowlistName] ?? "")
        .split(",")
        .map((host) => host.trim().toLocaleLowerCase("en-US"))
        .filter(Boolean),
    );
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.port === "" || url.port === "443") &&
      allowedHosts.has(url.hostname.toLocaleLowerCase("en-US"))
    );
  } catch {
    return false;
  }
}

export async function GET() {
  const portfolioDemo = isPortfolioDemo();
  let aiPricingConfigured = true;
  try {
    aiPricing();
  } catch {
    aiPricingConfigured = false;
  }
  let databaseReachable = !process.env.DATABASE_URL;
  let reviewerReachable = !reviewServiceIsConfigured();
  if (process.env.DATABASE_URL) {
    try {
      const { getSqlClient } = await import("@/lib/db/client");
      await getSqlClient()`SELECT 1`;
      databaseReachable = true;
    } catch {
      databaseReachable = false;
    }
  }
  if (reviewServiceIsConfigured()) {
    reviewerReachable = await reviewServiceIsReachable();
  }
  const oidcValuesConfigured = [
    "APP_BASE_URL",
    "OIDC_ISSUER",
    "OIDC_AUDIENCE",
    "OIDC_JWKS_URL",
    "OIDC_AUTHORIZATION_URL",
    "OIDC_TOKEN_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REVIEW_AUDIENCE",
    "OIDC_REVIEW_SCOPE",
    "OIDC_REVIEW_REQUIRED_ACR",
  ].every((name) => Boolean(process.env[name]));
  const oidcUrlsValid = [
    "APP_BASE_URL",
    "OIDC_ISSUER",
    "OIDC_JWKS_URL",
    "OIDC_AUTHORIZATION_URL",
    "OIDC_TOKEN_URL",
  ].every(isProductionHttpsUrl);
  const oidcConfigured =
    oidcValuesConfigured &&
    (process.env.NODE_ENV !== "production" || oidcUrlsValid);
  const sessionSecretConfigured =
    (process.env.SESSION_SECRET?.length ?? 0) >= 32;
  const injectionThreshold = Number(
    process.env.PROMPT_INJECTION_CLASSIFIER_THRESHOLD,
  );
  const injectionClassifierConfigured =
    isAllowlistedHttpsUrl(
      "PROMPT_INJECTION_CLASSIFIER_URL",
      "PROMPT_INJECTION_CLASSIFIER_ALLOWED_HOSTS",
    ) &&
    Boolean(process.env.PROMPT_INJECTION_CLASSIFIER_TOKEN) &&
    Boolean(process.env.PROMPT_INJECTION_CLASSIFIER_DATA_REGION) &&
    Number.isFinite(injectionThreshold) &&
    injectionThreshold >= 0.1 &&
    injectionThreshold <= 0.99;
  const dependencies = {
    database: process.env.DATABASE_URL
      ? databaseReachable
        ? "reachable"
        : "unreachable"
      : "demo-mode",
    reviewerService: reviewServiceIsConfigured()
      ? reviewerReachable
        ? "reachable"
        : "unreachable"
      : "demo-mode",
    aiGateway: process.env.AI_GATEWAY_API_KEY ? "configured" : "demo-mode",
    aiDataRegion: process.env.AI_PROVIDER_DATA_REGION
      ? "configured"
      : "demo-mode",
    aiPricing: aiPricingConfigured ? "configured" : "invalid",
    authentication:
      process.env.AUTH_MODE === "oidc" &&
      oidcConfigured &&
      sessionSecretConfigured
        ? "configured"
        : (process.env.AUTH_MODE ?? "demo"),
    objectStorage: process.env.OBJECT_BUCKET ? "configured" : "demo-mode",
    reviewerCredentialIsolation:
      reviewServiceIsConfigured() &&
      !process.env.REVIEW_DATABASE_URL &&
      !process.env.APPROVAL_TOKEN_SECRET
        ? "configured"
        : "not-isolated",
    mcpAllowlists:
      process.env.MCP_ALLOWED_HOSTS && process.env.MCP_ALLOWED_ORIGINS
        ? "configured"
        : "demo-mode",
    piiDlp:
      isProductionHttpsUrl("PII_DLP_URL") &&
      Boolean(process.env.PII_DLP_TOKEN) &&
      Boolean(process.env.PII_DLP_DATA_REGION)
        ? "configured"
        : "demo-mode",
    promptInjectionClassifier: injectionClassifierConfigured
      ? "configured"
      : "not-configured",
    localStackOverride: productionLocalStackOverrideIsDisabled()
      ? "disabled"
      : "forbidden",
  };
  const productionMisconfigured =
    process.env.NODE_ENV === "production" &&
    !portfolioDemo &&
    (dependencies.database !== "reachable" ||
      dependencies.reviewerService !== "reachable" ||
      dependencies.aiGateway !== "configured" ||
      dependencies.aiDataRegion !== "configured" ||
      dependencies.aiPricing !== "configured" ||
      dependencies.authentication !== "configured" ||
      dependencies.objectStorage !== "configured" ||
      dependencies.reviewerCredentialIsolation !== "configured" ||
      dependencies.mcpAllowlists !== "configured" ||
      dependencies.piiDlp !== "configured" ||
      dependencies.promptInjectionClassifier !== "configured" ||
      dependencies.localStackOverride !== "disabled");

  return Response.json(
    {
      status: portfolioDemo
        ? "demo-ready"
        : productionMisconfigured
          ? "not-ready"
          : "ready",
      deploymentProfile: portfolioDemo ? "portfolio-demo" : "standard",
      dependencies,
    },
    { status: productionMisconfigured ? 503 : 200 },
  );
}
