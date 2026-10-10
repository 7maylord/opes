import {
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { SessionService } from './session.service';
import type { AcceptOrganizationInvitationResult } from './organization.service';
import { OrganizationService } from './organization.service';

@Controller('organization-invitations')
export class OrganizationInvitationController {
  constructor(
    private readonly organizations: OrganizationService,
    private readonly sessions: SessionService,
  ) {}

  @Post(':token/accept')
  async acceptInvitation(
    @Param('token') token: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<AcceptOrganizationInvitationResult> {
    const sessionToken = parseBearerToken(authorization);
    const user = sessionToken
      ? await this.sessions.resolveUser(sessionToken)
      : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    return this.organizations.acceptInvitation(token, user.id);
  }
}
