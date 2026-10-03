import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import type {
  InviteOrganizationMemberRequest,
  InvitedOrganizationMember,
  OrganizationMember,
  UpdateOrganizationMemberRequest,
  UserOrganization,
} from './organization.service';
import { OrganizationService } from './organization.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations')
export class OrganizationController {
  constructor(
    private readonly organizations: OrganizationService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
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

  @Get(':organizationId')
  async getOrganization(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<UserOrganization> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    const context = await this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: 'http-request',
    });

    return this.organizations.getForTenant(context);
  }

  @Get(':organizationId/members')
  async listOrganizationMembers(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<OrganizationMember[]> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    const context = await this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: 'http-request',
    });

    return this.organizations.listMembers(context);
  }

  @Post(':organizationId/members')
  async inviteOrganizationMember(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: InviteOrganizationMemberRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<InvitedOrganizationMember> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    const context = await this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: 'http-request',
    });

    return this.organizations.inviteMember(context, body, idempotencyKey);
  }

  @Patch(':organizationId/members/:membershipId')
  async updateOrganizationMember(
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateOrganizationMemberRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<OrganizationMember> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    const context = await this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: 'http-request',
    });

    return this.organizations.updateMember(
      context,
      membershipId,
      body,
      idempotencyKey,
    );
  }
}
