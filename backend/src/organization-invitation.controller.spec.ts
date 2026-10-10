import { UnauthorizedException } from '@nestjs/common';
import { OrganizationInvitationController } from './organization-invitation.controller';
import { OrganizationService } from './organization.service';
import { SessionService } from './session.service';

describe('OrganizationInvitationController', () => {
  it('accepts an invitation only as the bearer session user', async () => {
    const acceptInvitation = jest.fn().mockResolvedValue({});
    const controller = new OrganizationInvitationController(
      { acceptInvitation } as unknown as OrganizationService,
      {
        resolveUser: jest.fn().mockResolvedValue({ id: 'user-2' }),
      } as unknown as SessionService,
    );
    await controller.acceptInvitation('invite-token', 'Bearer session-1');
    expect(acceptInvitation).toHaveBeenCalledWith('invite-token', 'user-2');
  });

  it('rejects invitation acceptance without a session', async () => {
    const controller = new OrganizationInvitationController(
      {} as OrganizationService,
      {} as SessionService,
    );
    await expect(
      controller.acceptInvitation('invite-token', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
