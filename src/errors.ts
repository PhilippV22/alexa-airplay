import { ErrorCode } from "./types";

export class AppError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode | "BAD_REQUEST" | "UNAUTHORIZED" | "NOT_FOUND";
  public readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode | "BAD_REQUEST" | "UNAUTHORIZED" | "NOT_FOUND",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
