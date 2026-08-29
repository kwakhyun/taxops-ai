export class RepositoryInputError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code = "INVALID_INPUT",
  ) {
    super(message);
    this.name = "RepositoryInputError";
  }
}
