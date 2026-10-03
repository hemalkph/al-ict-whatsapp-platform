export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 500,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
  }
}
