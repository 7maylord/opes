import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { DecisionService } from './decision.service';
import type {
  DecisionApprovalResponse,
  EvaluateInvoiceDecisionRequest,
  PaymentDecisionResponse,
} from './decision.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations/:organizationId/decisions')
export class DecisionController {
  constructor(
    private readonly decisions: DecisionService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post(':decisionId/authorize')
  async approveDecision(
    @Param('organizationId') organizationId: string,
    @Param('decisionId') decisionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<DecisionApprovalResponse> {
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

    return this.decisions.approveDecision(context, decisionId);
  }

  @Post('invoice-payment')
  async evaluateInvoicePayment(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: EvaluateInvoiceDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
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

    return this.decisions.evaluateInvoicePayment(context, body);
  }
}
