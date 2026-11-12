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
import { InvoiceService } from './invoice.service';
import type {
  PayableObligationResponse,
  VerifyInvoiceRequest,
} from './invoice.service';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';

@Controller('organizations/:organizationId/invoices')
export class InvoiceController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post('verify')
  async verifyInvoice(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: VerifyInvoiceRequest,
  ): Promise<PayableObligationResponse> {
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

    return this.invoices.verifyInvoice(context, body);
  }
}
