import { Controller, Param, Post } from '@nestjs/common';
import type { AcceptOrganizationInvitationResult } from './organization.service';
import { OrganizationService } from './organization.service';

@Controller('organization-invitations')
export class OrganizationInvitationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Post(':token/accept')
  async acceptInvitation(
    @Param('token') token: string,
  ): Promise<AcceptOrganizationInvitationResult> {
    return this.organizations.acceptInvitation(token);
  }
}
