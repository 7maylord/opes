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
import { LifecycleService } from './lifecycle.service';
import type {
  CreateEscrowAgreementRequest,
  CreateSubscriptionCycleRequest,
  CreateSubscriptionRequest,
  EscrowAgreementResponse,
  EscrowMilestoneResponse,
  SubscriptionCycleResponse,
  SubscriptionResponse,
} from './lifecycle.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';
import { RecurringExecutionService } from './recurring-execution.service';

interface SubmitMilestoneEvidenceRequest {
  evidenceDocumentId: string;
}

interface DisputeMilestoneRequest {
  reason: string;
}

@Controller('organizations/:organizationId')
export class LifecycleController {
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly recurring: RecurringExecutionService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post('subscriptions')
  async createSubscription(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CreateSubscriptionRequest,
  ): Promise<SubscriptionResponse & { ownerActions: unknown[] }> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    const subscription = await this.lifecycle.createSubscription(context, body);
    return {
      ...subscription,
      ownerActions: await this.recurring.prepare(context, subscription.id),
    };
  }

  @Post('lifecycle-actions/:actionId/confirm')
  async confirmOwnerAction(
    @Param('organizationId') organizationId: string,
    @Param('actionId') actionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: { transactionHash: string },
  ) {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.recurring.confirmOwnerAction(
      context,
      actionId,
      body.transactionHash,
    );
  }

  @Post('subscriptions/:subscriptionId/cycles')
  async createSubscriptionCycle(
    @Param('organizationId') organizationId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CreateSubscriptionCycleRequest,
  ): Promise<SubscriptionCycleResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.lifecycle.createSubscriptionCycle(
      context,
      subscriptionId,
      body,
    );
  }

  @Post('subscriptions/:subscriptionId/cancel')
  async cancelSubscription(
    @Param('organizationId') organizationId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.recurring.prepareStatusChange(
      context,
      subscriptionId,
      'cancel',
    );
  }

  @Post('subscriptions/:subscriptionId/pause')
  async pauseSubscription(
    @Param('organizationId') organizationId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.recurring.prepareStatusChange(context, subscriptionId, 'pause');
  }

  @Post('subscriptions/:subscriptionId/resume')
  async resumeSubscription(
    @Param('organizationId') organizationId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.recurring.prepareStatusChange(
      context,
      subscriptionId,
      'resume',
    );
  }

  @Post('escrow-agreements')
  async createEscrowAgreement(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CreateEscrowAgreementRequest,
  ): Promise<EscrowAgreementResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.lifecycle.createEscrowAgreement(context, body);
  }

  @Post('escrow-milestones/:milestoneId/submissions')
  async submitMilestoneEvidence(
    @Param('organizationId') organizationId: string,
    @Param('milestoneId') milestoneId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: SubmitMilestoneEvidenceRequest,
  ): Promise<EscrowMilestoneResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.lifecycle.submitMilestoneEvidence(
      context,
      milestoneId,
      body.evidenceDocumentId,
    );
  }

  @Post('escrow-milestones/:milestoneId/accept')
  async acceptMilestone(
    @Param('organizationId') organizationId: string,
    @Param('milestoneId') milestoneId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<EscrowMilestoneResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.lifecycle.acceptMilestone(context, milestoneId);
  }

  @Post('escrow-milestones/:milestoneId/dispute')
  async disputeMilestone(
    @Param('organizationId') organizationId: string,
    @Param('milestoneId') milestoneId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: DisputeMilestoneRequest,
  ): Promise<EscrowMilestoneResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.lifecycle.disputeMilestone(context, milestoneId, body.reason);
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
