import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { PaymentCorrectionService } from './payment-correction.service';
import type { CreateCorrectionRequest } from './payment-correction.service';
@Controller('organizations/:organizationId/payment-corrections')
export class PaymentCorrectionController {
  constructor(
    private readonly corrections: PaymentCorrectionService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}
  @Get() async list(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.corrections.list(
      await this.context(organizationId, authorization, correlationId),
    );
  }
  @Post() async create(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateCorrectionRequest,
  ) {
    return this.corrections.create(
      await this.context(organizationId, authorization, correlationId),
      body,
      idempotencyKey,
    );
  }
  private async context(
    organizationId: string,
    authorization?: string,
    correlationId?: string,
  ) {
    const token = parseBearerToken(authorization);
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    return this.contexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}
