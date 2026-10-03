import type { ErrorCode } from '../../shared/schemas.js';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError('validation_error', 400, msg, details);
export const unauthorized = (msg = 'Authentication required', details?: unknown) =>
  new AppError('unauthorized', 401, msg, details);
export const forbidden = (msg = 'Forbidden') => new AppError('forbidden', 403, msg);
export const notFound = (msg = 'Not found') => new AppError('not_found', 404, msg);
export const conflict = (msg: string, details?: unknown) => new AppError('conflict', 409, msg, details);
export const tooManyRequests = (msg: string) => new AppError('rate_limited', 429, msg);
export const jobConflict = (msg: string) => new AppError('job_conflict', 409, msg);
/** A conditional request (`If-Match`, `If-None-Match: *`) whose condition no longer holds. */
export const preconditionFailed = (msg: string, details?: unknown) =>
  new AppError('precondition_failed', 412, msg, details);
/** Well-formed, but the content itself is refused - a PHP file that does not parse. */
export const syntaxError = (msg: string, details?: unknown) => new AppError('syntax_error', 422, msg, details);
export const badGateway = (msg: string, details?: unknown) =>
  new AppError('bad_gateway', 502, msg, details);
/** A command that ran past its time limit and was stopped - or, the message says, may still be running. */
export const timedOut = (msg: string, details?: unknown) => new AppError('timeout', 504, msg, details);
export const maintenance = (msg: string) => new AppError('maintenance', 503, msg);
export const internal = (msg = 'Internal error') => new AppError('internal', 500, msg);

/** Thrown by job handlers when ctx.checkCanceled() sees a cancellation request. */
export class JobCanceledError extends Error {
  constructor() {
    super('Job canceled');
    this.name = 'JobCanceledError';
  }
}
