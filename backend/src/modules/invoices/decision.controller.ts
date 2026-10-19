import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { AgentDecisionService } from './agent-decision.service';
import type { AgentInvoiceDecisionRequest } from './agent-decision.service';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { DecisionService } from './decision.service';
import type { PaymentExecutionResponse } from '../payments/payment-execution.service';
import { PaymentExecutionService } from '../payments/payment-execution.service';
import type {
  EvaluateInvoiceDecisionRequest,
  OverrideDecisionRequest,
  PlanInvoicePaymentRequest,
  PaymentDecisionResponse,
} from './decision.service';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';
import { OwnerTreasuryService } from '../treasury/owner-treasury.service';

@Controller('organizations/:organizationId/decisions')
export class DecisionController {
  constructor(
    private readonly decisions: DecisionService,
    private readonly agentDecisions: AgentDecisionService,
    private readonly executions: PaymentExecutionService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
    private readonly ownerTreasury: OwnerTreasuryService,
  ) {}

  @Post(':decisionId/override')
  async overrideDecision(
    @Param('organizationId') organizationId: string,
    @Param('decisionId') decisionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: OverrideDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
    const token = parseBearerToken(authorization);
    if (token === undefined)
      throw new UnauthorizedException('Bearer session token is required');
    const user = await this.sessions.resolveUser(token);
    if (user === null)
      throw new UnauthorizedException('Session is invalid or expired');
    return this.decisions.overrideDecision(
      await this.tenantContexts.resolve({
        organizationId,
        userId: user.id,
        requestId: resolveCorrelationId(correlationId),
      }),
      decisionId,
      body,
    );
  }

  @Post(':decisionId/authorize')
  async approveDecision(
    @Param('organizationId') organizationId: string,
    @Param('decisionId') decisionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
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

    const approval = await this.decisions.approveDecision(context, decisionId);
    return {
      ...approval,
      ownerAction: await this.ownerTreasury.prepareDecisionApproval(
        context,
        decisionId,
      ),
    };
  }

  @Post(':decisionId/execute')
  async requestDecisionExecution(
    @Param('organizationId') organizationId: string,
    @Param('decisionId') decisionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<PaymentExecutionResponse> {
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

    return this.executions.requestDecisionExecution(context, decisionId);
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

  @Post('invoice-payment/plan')
  async planInvoicePayment(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: PlanInvoicePaymentRequest,
  ) {
    const token = parseBearerToken(authorization);
    if (token === undefined)
      throw new UnauthorizedException('Bearer session token is required');
    const user = await this.sessions.resolveUser(token);
    if (user === null)
      throw new UnauthorizedException('Session is invalid or expired');
    return this.decisions.planInvoicePayment(
      await this.tenantContexts.resolve({
        organizationId,
        userId: user.id,
        requestId: resolveCorrelationId(correlationId),
      }),
      body,
    );
  }

  @Post('invoice-payment/agent')
  async evaluateInvoicePaymentWithAgent(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: AgentInvoiceDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
    const token = parseBearerToken(authorization);
    if (token === undefined)
      throw new UnauthorizedException('Bearer session token is required');
    const user = await this.sessions.resolveUser(token);
    if (user === null)
      throw new UnauthorizedException('Session is invalid or expired');
    const context = await this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
    return this.agentDecisions.evaluateInvoicePayment(context, body);
  }
}
