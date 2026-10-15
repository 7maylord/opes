import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { EmailInboxService } from './email-inbox.service';
import type {
  ConfigureEmailInboxRequest,
  EmailInboxResponse,
} from './email-inbox.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations/:organizationId/email-inbox')
export class EmailInboxController {
  constructor(
    private readonly inboxes: EmailInboxService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Put()
  async configure(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: ConfigureEmailInboxRequest,
  ): Promise<EmailInboxResponse> {
    return this.inboxes.configureInbox(
      await this.context(organizationId, authorization, correlationId),
      body,
    );
  }

  @Get()
  async get(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<EmailInboxResponse | null> {
    return this.inboxes.getInbox(
      await this.context(organizationId, authorization, correlationId),
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

@Controller('webhooks/resend')
export class ResendInboundController {
  constructor(private readonly inboxes: EmailInboxService) {}

  @Post('inbound')
  @HttpCode(200)
  ingest(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') id: string | undefined,
    @Headers('svix-timestamp') timestamp: string | undefined,
    @Headers('svix-signature') signature: string | undefined,
  ) {
    if (!request.rawBody)
      throw new UnauthorizedException('Raw webhook body is required');
    return this.inboxes.ingestWebhook(request.rawBody, {
      id,
      timestamp,
      signature,
    });
  }
}
