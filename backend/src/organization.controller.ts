import {
  Controller,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { OrganizationService, UserOrganization } from './organization.service';
import { SessionService } from './session.service';

@Controller('organizations')
export class OrganizationController {
  constructor(
    private readonly organizations: OrganizationService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  async listOrganizations(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<UserOrganization[]> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    return this.organizations.listForUser(user.id);
  }
}
