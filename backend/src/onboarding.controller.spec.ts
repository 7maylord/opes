import { UnauthorizedException } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { SessionService } from './session.service';

describe('OnboardingController', () => {
  it('uses the bearer session identity instead of caller-supplied identity', async () => {
    const user = {
      id: 'user-1',
      email: 'owner@example.com',
      displayName: 'Owner',
    };
    const onboard = jest.fn().mockResolvedValue({ user });
    const controller = new OnboardingController(
      { onboard } as unknown as OnboardingService,
      {
        resolveUser: jest.fn().mockResolvedValue(user),
      } as unknown as SessionService,
    );
    await controller.onboard(
      { organizationName: 'Acme' },
      'key-1',
      'Bearer session-1',
    );
    expect(onboard).toHaveBeenCalledWith(
      user,
      { organizationName: 'Acme' },
      'key-1',
    );
  });

  it('rejects unauthenticated onboarding', async () => {
    const controller = new OnboardingController(
      {} as OnboardingService,
      { resolveUser: jest.fn() } as unknown as SessionService,
    );
    await expect(
      controller.onboard({ organizationName: 'Acme' }, undefined, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
