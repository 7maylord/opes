import { BadRequestException } from '@nestjs/common';
import { policyTemplateRequest } from './liquidity.service';

describe('payment policy templates', () => {
  it('compiles a reviewed preset into the existing policy request', () => {
    const policy = policyTemplateRequest('conservative');
    expect(policy.allowedRoutes).toEqual([
      {
        liquidityRoute: 'OPERATING',
        environment: 'arc-testnet',
        chainId: 5042002,
        assetSymbol: 'USDC',
      },
    ]);
    expect(BigInt(policy.autonomousLimitAtomic)).toBeLessThanOrEqual(
      BigInt(policy.singlePaymentLimitAtomic),
    );
  });

  it('rejects unknown presets', () => {
    expect(() => policyTemplateRequest('unknown')).toThrow(BadRequestException);
  });
});
