import { CORRELATION_ID_HEADER, resolveCorrelationId } from './correlation-id';

describe('correlation id', () => {
  it('uses a valid caller supplied correlation id', () => {
    expect(resolveCorrelationId(' request-1 ')).toBe('request-1');
  });

  it('generates a correlation id when the caller omits one', () => {
    expect(resolveCorrelationId(undefined)).toHaveLength(36);
  });

  it('exports the header name', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });
});
