import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { LiquidityService } from './liquidity.service';
import type {
  CctpSourceMessageRequest,
  LiquidityActionRequest,
  LiquidityActionResponse,
  TreasuryPositionResponse,
  TreasurySettingsRequest,
} from './liquidity.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations/:organizationId')
export class LiquidityController {
  constructor(
    private readonly liquidity: LiquidityService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post('liquidity-actions')
  async planLiquidityAction(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: LiquidityActionRequest,
  ): Promise<LiquidityActionResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.liquidity.planLiquidityAction(context, body);
  }

  @Post('liquidity-actions/:actionId/cctp-source-message')
  async recordCctpSourceMessage(
    @Param('organizationId') organizationId: string,
    @Param('actionId') actionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CctpSourceMessageRequest,
  ): Promise<LiquidityActionResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.liquidity.recordCctpSourceMessage(context, actionId, body);
  }

  @Get('treasury/position')
  async getTreasuryPosition(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<TreasuryPositionResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.liquidity.getTreasuryPosition(context);
  }

  @Put('treasury/settings')
  async configureTreasury(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: TreasurySettingsRequest,
  ): Promise<TreasuryPositionResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.liquidity.configureTreasury(context, body);
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
