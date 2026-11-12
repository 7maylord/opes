import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import {
  PaymentReconciliationResponse,
  PaymentReconciliationService,
} from './payment-reconciliation.service';

@Controller('organizations/:organizationId/payment-webhooks/:provider')
export class PaymentWebhookController {
  constructor(private readonly reconciliation: PaymentReconciliationService) {}

  @Post()
  async recordWebhook(
    @Param('organizationId') organizationId: string,
    @Param('provider') provider: string,
    @Headers('x-opes-webhook-id') eventId: string | undefined,
    @Headers('x-opes-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentReconciliationResponse> {
    return this.reconciliation.recordWebhook({
      organizationId,
      provider,
      externalEventId: eventId ?? '',
      signature: signature ?? '',
      payload: body as {
        executionId?: string;
        transactionHash?: string;
        status?: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
        chainId?: number;
        to?: string;
        callData?: string;
      },
    });
  }
}
