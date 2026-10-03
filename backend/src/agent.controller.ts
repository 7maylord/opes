import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AgentResourceBinding,
  BusinessAgentDetail,
} from './agent.service';
import { AgentService } from './agent.service';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations/:organizationId/agent')
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Get()
  async getAgent(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<BusinessAgentDetail> {
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
      requestId: resolveCorrelationId(correlationId),
    });

    return this.agents.getPrimaryAgent(context);
  }

  @Post('provisioning/arc-testnet')
  async requestArcTestnetProvisioning(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<AgentResourceBinding> {
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
      requestId: resolveCorrelationId(correlationId),
    });

    return this.agents.requestArcTestnetProvisioning(context);
  }
}
