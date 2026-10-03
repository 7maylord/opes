import { OrganizationInvitationController } from './organization-invitation.controller';
import { OrganizationService } from './organization.service';

describe('OrganizationInvitationController', () => {
  it('accepts an invitation token', async () => {
    const result = {
      user: {
        id: 'user-2',
        email: 'ops@example.com',
        displayName: 'Ops',
      },
      organization: {
        id: 'organization-1',
        slug: 'acme',
        displayName: 'Acme',
        lifecycleStatus: 'PROVISIONING',
      },
      membership: {
        id: 'membership-2',
        userId: 'user-2',
        email: 'ops@example.com',
        displayName: 'Ops',
        role: 'APPROVER',
        status: 'ACTIVE',
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      },
      sessionToken: 'session-token',
    };
    const acceptInvitation = jest.fn(() => Promise.resolve(result));
    const controller = new OrganizationInvitationController({
      acceptInvitation,
    } as unknown as OrganizationService);

    await expect(controller.acceptInvitation('invite-token')).resolves.toEqual(
      result,
    );
    expect(acceptInvitation).toHaveBeenCalledWith('invite-token');
  });
});
