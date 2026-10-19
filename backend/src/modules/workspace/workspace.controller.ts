import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';
import { WorkspaceService } from './workspace.service';
import type {
  WorkspaceDetail,
  WorkspaceListQuery,
  WorkspacePage,
} from './workspace.service';

@Controller('organizations/:organizationId/workspace')
export class WorkspaceController {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Get(':kind')
  async list(
    @Param('organizationId') organizationId: string,
    @Param('kind') kind: string,
    @Query() query: WorkspaceListQuery,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WorkspacePage> {
    return this.workspace.list(
      await this.resolveContext(organizationId, authorization, correlationId),
      kind,
      query,
    );
  }

  @Get(':kind/:recordId')
  async detail(
    @Param('organizationId') organizationId: string,
    @Param('kind') kind: string,
    @Param('recordId') recordId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WorkspaceDetail> {
    return this.workspace.detail(
      await this.resolveContext(organizationId, authorization, correlationId),
      kind,
      recordId,
    );
  }

  private async resolveContext(
    organizationId: string,
    authorization: string | undefined,
    correlationId: string | undefined,
  ) {
    const token = parseBearerToken(authorization);
    if (token === undefined)
      throw new UnauthorizedException('Bearer session token is required');
    const user = await this.sessions.resolveUser(token);
    if (user === null)
      throw new UnauthorizedException('Session is invalid or expired');
    return this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}
