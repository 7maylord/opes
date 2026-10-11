import { escrowDecisionHash } from './escrow-execution.service';

describe('escrowDecisionHash', () => {
  it('binds funding approval to its tenant, escrow and agreement', () => {
    const args = [
      '11111111-1111-1111-1111-111111111111',
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      `0x${'33'.repeat(32)}`,
      `0x${'44'.repeat(32)}`,
      '0x5555555555555555555555555555555555555555',
      `0x${'66'.repeat(32)}`,
      '1000000',
      2_000_000_000,
    ] as const;
    const hash = escrowDecisionHash(...args);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(escrowDecisionHash(...args)).toBe(hash);
    expect(
      escrowDecisionHash(
        ...args.slice(0, 6),
        `0x${'77'.repeat(32)}`,
        ...args.slice(7),
      ),
    ).not.toBe(hash);
  });
});
