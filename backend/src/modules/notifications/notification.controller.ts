import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { NotificationService } from './notification.service';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';

@Controller('organizations/:organizationId/notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}

  @Get()
  async list(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.list(
      await this.context(organizationId, authorization, correlationId),
      limit ? Number(limit) : 50,
    );
  }

  @Get('unread-count')
  async unreadCount(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.notifications.unreadCount(
      await this.context(organizationId, authorization, correlationId),
    );
  }

  @Post(':notificationId/read')
  async markRead(
    @Param('organizationId') organizationId: string,
    @Param('notificationId') notificationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.notifications.markRead(
      await this.context(organizationId, authorization, correlationId),
      notificationId,
    );
  }

  @Post('read-all')
  async markAllRead(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.notifications.markAllRead(
      await this.context(organizationId, authorization, correlationId),
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
