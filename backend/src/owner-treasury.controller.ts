import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { OwnerTreasuryService } from './owner-treasury.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations/:organizationId/treasury-actions')
export class OwnerTreasuryController {
  constructor(
    private readonly treasury: OwnerTreasuryService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}
  @Post() async prepare(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: Parameters<OwnerTreasuryService['prepare']>[1],
  ) {
    return this.treasury.prepare(
      await this.context(organizationId, authorization, correlationId),
      body,
    );
  }
  @Post('decisions/:decisionId') async approveDecision(
    @Param('organizationId') organizationId: string,
    @Param('decisionId') decisionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.treasury.prepareDecisionApproval(
      await this.context(organizationId, authorization, correlationId),
      decisionId,
    );
  }
  private async context(
    organizationId: string,
    authorization: string | undefined,
    correlationId: string | undefined,
  ) {
    const token = parseBearerToken(authorization);
    if (!token)
      throw new UnauthorizedException('Bearer session token is required');
    const user = await this.sessions.resolveUser(token);
    if (!user) throw new UnauthorizedException('Session is invalid or expired');
    return this.contexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}
