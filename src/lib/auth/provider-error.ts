import { errors } from "jose";
import {
  AuthenticationError,
  AuthenticationServiceError,
} from "./session-error.ts";

// Invalid credentials are 401; JWKS/network/configuration failures are not.
export function isInvalidIdentityToken(error: unknown) {
  return (
    error instanceof errors.JOSEError &&
    new Set([
      "ERR_JWT_EXPIRED",
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
      "ERR_JWT_INVALID",
      "ERR_JWS_INVALID",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      "ERR_JOSE_ALG_NOT_ALLOWED",
      "ERR_JWKS_NO_MATCHING_KEY",
    ]).has(error.code)
  );
}

export function providerVerificationError(error: unknown) {
  return isInvalidIdentityToken(error)
    ? new AuthenticationError(
        "인증 정보가 유효하지 않거나 만료되었습니다. 다시 로그인해 주세요.",
        "INVALID_TOKEN",
      )
    : new AuthenticationServiceError();
}
