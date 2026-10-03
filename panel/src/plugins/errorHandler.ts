import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from '@fastify/type-provider-zod';
import { AppError } from '../lib/errors.js';
import { ServerUnreachableError } from '../servers/sshConnection.js';

/**
 * Uniform error envelope: { error: { code, message, details? } } on every non-2xx.
 *
 * Each branch also stamps the code onto the request, which is where the API activity log
 * reads it from: by `onResponse` the body is gone and a status alone cannot tell a
 * validation error from a job conflict.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      req.apiErrorCode = err.code;
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
    }
    if (err instanceof ServerUnreachableError) {
      req.apiErrorCode = 'bad_gateway';
      return reply.status(502).send({ error: { code: 'bad_gateway', message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      req.apiErrorCode = 'validation_error';
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: err.validation.map((v) => ({
            path: v.instancePath || (v.params as { issue?: { path?: (string | number)[] } }).issue?.path?.join('.'),
            message: v.message,
          })),
        },
      });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) {
      req.apiErrorCode = 'rate_limited';
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many requests; slow down' },
      });
    }
    if (e.statusCode === 413) {
      req.apiErrorCode = 'validation_error';
      return reply.status(413).send({
        error: { code: 'validation_error', message: 'Payload too large' },
      });
    }
    if (e.statusCode && e.statusCode < 500) {
      req.apiErrorCode = 'validation_error';
      return reply.status(e.statusCode).send({
        error: { code: 'validation_error', message: e.message ?? 'Bad request' },
      });
    }
    req.apiErrorCode = 'internal';
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });
}
