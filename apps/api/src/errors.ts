export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const forbidden = (msg = "Insufficient role") => new AppError(403, "FORBIDDEN", msg);
export const paymentFailed = (msg: string, details?: unknown) => new AppError(402, "PAYMENT_DECLINED", msg, details);
