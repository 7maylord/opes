import {
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { LedgerEntryResponse, LedgerService } from './ledger.service';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';

@Controller('organizations/:organizationId/ledger')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post('invoice-versions/:invoiceVersionId/accrue')
  async projectInvoiceAccrual(
    @Param('organizationId') organizationId: string,
    @Param('invoiceVersionId') invoiceVersionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<LedgerEntryResponse[]> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.ledger.projectInvoiceAccrual(context, invoiceVersionId);
  }

  @Post('payment-executions/:executionId/settle')
  async projectPaymentSettlement(
    @Param('organizationId') organizationId: string,
    @Param('executionId') executionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<LedgerEntryResponse[]> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.ledger.projectPaymentSettlement(context, executionId);
  }

  private async resolveContext(
    organizationId: string,
    authorization: string | undefined,
    correlationId: string | undefined,
  ) {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    return this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}
