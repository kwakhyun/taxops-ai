import type { JWTVerifyOptions } from "jose";

export function providerJwtValidationOptions(
  issuer: string,
  audience: string,
): JWTVerifyOptions {
  return {
    issuer,
    audience,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["sub", "iat", "exp"],
    clockTolerance: "30s",
    maxTokenAge: "2h",
  };
}

export const webSessionValidationOptions: JWTVerifyOptions = {
  issuer: "taxops-ai",
  audience: "taxops-web",
  algorithms: ["HS256"],
  requiredClaims: ["sub", "iat", "exp", "jti", "tenant_id"],
  clockTolerance: "15s",
  maxTokenAge: "8h",
};
