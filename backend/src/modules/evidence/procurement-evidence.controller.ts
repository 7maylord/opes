import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { ProcurementEvidenceService } from './procurement-evidence.service';
import type { RecordProcurementEvidenceRequest } from './procurement-evidence.service';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';

@Controller('organizations/:organizationId')
export class ProcurementEvidenceController {
  constructor(
    private readonly evidence: ProcurementEvidenceService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post('procurement-evidence')
  async record(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: RecordProcurementEvidenceRequest,
  ) {
    return this.evidence.record(
      await this.context(organizationId, authorization, correlationId),
      body,
    );
  }

  @Post('procurement-evidence/:sourceId/revoke')
  async revoke(
    @Param('organizationId') organizationId: string,
    @Param('sourceId') sourceId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.evidence.revoke(
      await this.context(organizationId, authorization, correlationId),
      sourceId,
    );
  }

  @Post('invoices/:invoiceVersionId/match')
  async match(
    @Param('organizationId') organizationId: string,
    @Param('invoiceVersionId') invoiceVersionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: { governingSourceId: string; deliverySourceId: string },
  ) {
    return this.evidence.matchInvoice(
      await this.context(organizationId, authorization, correlationId),
      invoiceVersionId,
      body.governingSourceId,
      body.deliverySourceId,
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
    return this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}
