import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { providerJwtValidationOptions } from "../lib/auth/token-policy.ts";
import {
  isInvalidIdentityToken,
  providerVerificationError,
} from "../lib/auth/provider-error.ts";
import { reviewerReauthenticationRequired } from "../lib/auth/session-error.ts";

export class ReviewerAuthorizationError extends Error {
  readonly status = 403;
  readonly code = "REVIEW_FORBIDDEN";
  constructor() {
    super("Reviewer identity is not authorized");
    this.name = "ReviewerAuthorizationError";
  }
}

export async function verifyReviewerIdentity(
  token: string,
  tenantId: string,
  key: JWTVerifyGetKey,
  config: {
    issuer: string;
    audience: string;
    scope: string;
    acr: string;
    clientId: string;
  },
) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      ...providerJwtValidationOptions(config.issuer, config.audience),
      requiredClaims: [
        "sub",
        "iat",
        "exp",
        "tenant_id",
        "scope",
        "auth_time",
        "acr",
      ],
      maxTokenAge: "15m",
    }));
  } catch (error) {
    if (isInvalidIdentityToken(error)) throw reviewerReauthenticationRequired();
    throw providerVerificationError(error);
  }
  const authenticationTime =
    typeof payload.auth_time === "number" ? payload.auth_time * 1_000 : NaN;
  if (
    !Number.isFinite(authenticationTime) ||
    authenticationTime > Date.now() + 30_000 ||
    Date.now() - authenticationTime > 15 * 60_000
  ) {
    throw reviewerReauthenticationRequired();
  }
  if (
    typeof payload.sub !== "string" ||
    payload.tenant_id !== tenantId ||
    typeof payload.scope !== "string" ||
    !payload.scope.split(/\s+/).includes(config.scope) ||
    !(
      payload.azp === config.clientId || payload.client_id === config.clientId
    ) ||
    payload.acr !== config.acr
  ) {
    throw new ReviewerAuthorizationError();
  }
  return { subject: payload.sub, tenantId };
}
