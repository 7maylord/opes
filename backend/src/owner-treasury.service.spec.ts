import { BadRequestException } from '@nestjs/common';
import { controlCall } from './owner-treasury.service';

describe('owner treasury controls', () => {
  it('encodes only validated monetary controls', () => {
    expect(
      controlCall({
        action: 'SET_LIMITS',
        autonomousAtomic: '1',
        singleAtomic: '2',
        dailyAtomic: '3',
      }),
    ).toEqual(['setLimits', [1n, 2n, 3n]]);
    expect(() =>
      controlCall({ action: 'RECOVER_USDC', amountAtomic: '0' }),
    ).toThrow(BadRequestException);
    expect(() =>
      controlCall({ action: 'HANDOVER_VAULT', newAdmin: '0x1234' }),
    ).toThrow(BadRequestException);
  });
});
