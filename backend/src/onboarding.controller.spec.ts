import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

describe('OnboardingController', () => {
  it('delegates onboarding requests to the service', async () => {
    const result = {
      user: { id: 'user-1', email: 'owner@example.com', displayName: 'Owner' },
      organization: {
        id: 'organization-1',
        slug: 'acme',
        displayName: 'Acme',
        lifecycleStatus: 'PROVISIONING',
      },
      membership: { id: 'membership-1', role: 'OWNER' as const },
      agent: { id: 'agent-1', lifecycleStatus: 'PROVISIONING' },
      sessionToken: 'token',
    };
    const onboard = jest.fn(() => Promise.resolve(result));
    const controller = new OnboardingController({
      onboard,
    } as unknown as OnboardingService);

    await expect(
      controller.onboard({
        email: 'owner@example.com',
        displayName: 'Owner',
        organizationName: 'Acme',
      }),
    ).resolves.toEqual(result);
    expect(onboard).toHaveBeenCalledWith({
      email: 'owner@example.com',
      displayName: 'Owner',
      organizationName: 'Acme',
    });
  });
});
