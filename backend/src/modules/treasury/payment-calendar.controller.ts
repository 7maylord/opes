import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { PaymentCalendarService } from './payment-calendar.service';

@Controller('organizations/:organizationId/payment-calendar')
export class PaymentCalendarController {
  constructor(
    private readonly calendar: PaymentCalendarService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}
  @Get() async get(
    @Param('organizationId') organizationId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const token = parseBearerToken(authorization);
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    const context = await this.contexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
    return this.calendar.get(context, from, to);
  }

  @Get('scenarios') async scenarios(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const token = parseBearerToken(authorization);
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    const context = await this.contexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
    return this.calendar.getScenarios(context);
  }
}
