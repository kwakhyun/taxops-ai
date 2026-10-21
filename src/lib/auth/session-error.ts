export class AuthenticationError extends Error {
  readonly status = 401;
  readonly code: "AUTH_REQUIRED" | "INVALID_TOKEN" | "REVIEW_REAUTH_REQUIRED";

  constructor(
    message = "로그인이 필요합니다. 다시 로그인해 주세요.",
    code:
      | "AUTH_REQUIRED"
      | "INVALID_TOKEN"
      | "REVIEW_REAUTH_REQUIRED" = "AUTH_REQUIRED",
  ) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export class AuthenticationServiceError extends Error {
  readonly status = 503;
  readonly code = "AUTH_SERVICE_UNAVAILABLE";

  constructor() {
    super("인증 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    this.name = "AuthenticationServiceError";
  }
}

export function reviewerReauthenticationRequired() {
  return new AuthenticationError(
    "검토자 인증이 만료되었거나 유효하지 않습니다. 다시 인증한 뒤 처리해 주세요.",
    "REVIEW_REAUTH_REQUIRED",
  );
}
