export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}
