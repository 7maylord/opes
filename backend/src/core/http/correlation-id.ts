import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export function resolveCorrelationId(
  value: string | string[] | undefined,
): string {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (text !== undefined && text !== '' && text.length <= 200) {
    return text;
  }

  return randomUUID();
}

export function useCorrelationIds(app: INestApplication): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_ID_HEADER],
    );
    request.headers[CORRELATION_ID_HEADER] = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  });
}
