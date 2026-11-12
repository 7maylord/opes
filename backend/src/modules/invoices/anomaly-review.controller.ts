import {
  Controller,
  Get,
  Headers,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { AnomalyReviewService } from './anomaly-review.service';

@Controller('organizations/:organizationId/anomalies')
export class AnomalyReviewController {
  constructor(
    private readonly anomalies: AnomalyReviewService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}
  @Get() async list(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const token = parseBearerToken(authorization);
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    return this.anomalies.list(
      await this.contexts.resolve({
        organizationId,
        userId: user.id,
        requestId: resolveCorrelationId(correlationId),
      }),
    );
  }
}
