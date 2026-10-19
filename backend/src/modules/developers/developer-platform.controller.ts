import {
  Body,
  Controller,
  Delete,
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
import { DeveloperPlatformService } from './developer-platform.service';
@Controller('organizations/:organizationId/developer')
export class DeveloperPlatformController {
  constructor(
    private readonly platform: DeveloperPlatformService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}
  @Get('credentials') async credentials(
    @Param('organizationId') id: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.platform.listCredentials(
      await this.context(id, auth, correlation),
    );
  }
  @Post('credentials') async createCredential(
    @Param('organizationId') id: string,
    @Headers('authorization') auth: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Body() body: { name: string; scopes: string[] },
  ) {
    return this.platform.createCredential(
      await this.context(id, auth, correlation),
      body,
    );
  }
  @Delete('credentials/:credentialId') async revokeCredential(
    @Param('organizationId') id: string,
    @Param('credentialId') credentialId: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.platform.revokeCredential(
      await this.context(id, auth, correlation),
      credentialId,
    );
  }
  @Get('webhooks') async webhooks(
    @Param('organizationId') id: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.platform.listEndpoints(
      await this.context(id, auth, correlation),
    );
  }
  @Post('webhooks') async createWebhook(
    @Param('organizationId') id: string,
    @Headers('authorization') auth: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Body() body: { url: string; description: string; eventTypes: string[] },
  ) {
    return this.platform.createEndpoint(
      await this.context(id, auth, correlation),
      body,
    );
  }
  @Delete('webhooks/:endpointId') async disableWebhook(
    @Param('organizationId') id: string,
    @Param('endpointId') endpointId: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.platform.disableEndpoint(
      await this.context(id, auth, correlation),
      endpointId,
    );
  }
  @Post('webhooks/:endpointId/test') async testWebhook(
    @Param('organizationId') id: string,
    @Param('endpointId') endpointId: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.platform.testEndpoint(
      await this.context(id, auth, correlation),
      endpointId,
    );
  }
  @Get('webhook-deliveries') async deliveries(
    @Param('organizationId') id: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.platform.listDeliveries(
      await this.context(id, auth, correlation),
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
