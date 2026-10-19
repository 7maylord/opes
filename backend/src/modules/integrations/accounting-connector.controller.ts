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
import { AccountingConnectorService } from './accounting-connector.service';
import type {
  CreateAccountingConnectorRequest,
  RequestSettlementWritebackRequest,
} from './accounting-connector.service';
import { parseBearerToken } from '../../core/auth/auth-header';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';

@Controller('organizations/:organizationId/accounting-connectors')
export class AccountingConnectorController {
  constructor(
    private readonly connectors: AccountingConnectorService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post()
  async create(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CreateAccountingConnectorRequest,
  ) {
    return this.connectors.create(
      await this.context(organizationId, authorization, correlationId),
      body,
    );
  }

  @Get()
  async list(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.connectors.list(
      await this.context(organizationId, authorization, correlationId),
    );
  }

  @Get(':connectorId/records')
  async records(
    @Param('organizationId') organizationId: string,
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.connectors.listRecords(
      await this.context(organizationId, authorization, correlationId),
      connectorId,
    );
  }

  @Post(':connectorId/sync')
  async sync(
    @Param('organizationId') organizationId: string,
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.connectors.requestSync(
      await this.context(organizationId, authorization, correlationId),
      connectorId,
    );
  }

  @Post(':connectorId/test')
  async test(
    @Param('organizationId') organizationId: string,
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.connectors.testConnection(
      await this.context(organizationId, authorization, correlationId),
      connectorId,
    );
  }

  @Delete(':connectorId')
  async disconnect(
    @Param('organizationId') organizationId: string,
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.connectors.disconnect(
      await this.context(organizationId, authorization, correlationId),
      connectorId,
    );
  }

  @Post(':connectorId/settlement-writebacks')
  async writeback(
    @Param('organizationId') organizationId: string,
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: RequestSettlementWritebackRequest,
  ) {
    return this.connectors.requestSettlementWriteback(
      await this.context(organizationId, authorization, correlationId),
      connectorId,
      body,
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
