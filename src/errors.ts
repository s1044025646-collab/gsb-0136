export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "INCOMPARABLE_GROUPS"
  | "EMPTY_DATA"
  | "ZERO_VARIANCE"
  | "MISSING_GROUP"
  | "DUPLICATE_SUBJECT"
  | "BAD_REQUEST";
