type PortfolioDemoEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "NODE_ENV"
    | "PORTFOLIO_DEMO"
    | "AUTH_MODE"
    | "DATABASE_URL"
    | "OBJECT_BUCKET"
    | "AI_GATEWAY_API_KEY"
    | "REVIEW_SERVICE_URL"
  >
>;

/**
 * A deliberately constrained hosted preview. It can never be enabled alongside
 * production data, storage, AI, or reviewer-service dependencies.
 */
export function isPortfolioDemo(
  environment: PortfolioDemoEnvironment = process.env,
) {
  return (
    environment.NODE_ENV === "production" &&
    environment.PORTFOLIO_DEMO === "true" &&
    environment.AUTH_MODE === "demo" &&
    !environment.DATABASE_URL &&
    !environment.OBJECT_BUCKET &&
    !environment.AI_GATEWAY_API_KEY &&
    !environment.REVIEW_SERVICE_URL
  );
}
