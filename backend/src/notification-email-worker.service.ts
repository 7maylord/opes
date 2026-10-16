import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { recordNotification } from './notification.service';

interface DeliveryEvent {
  event_id: string;
  organization_id: string;
  delivery_id: string;
  attempts: number;
}
interface AdviceRow {
  recipient_email: string;
  organization_name: string;
  vendor_name: string;
  invoice_number: string;
  amount_atomic: string;
  asset_symbol: string;
  route_environment: string;
  route_chain_id: number;
  transaction_hash: string;
  confirmed_at: Date;
}

@Injectable()
export class NotificationEmailWorkerService {
  private readonly logger = new Logger(NotificationEmailWorkerService.name);
  constructor(private readonly database: DatabaseService) {}

  async processDue(limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const event = await this.claim();
      if (!event) return processed;
      try {
        const advice = await this.load(event);
        const providerId = await sendPaymentAdvice(advice);
        await this.sent(event, advice, providerId);
      } catch (error) {
        await this.failed(
          event,
          error instanceof Error
            ? error.message
            : 'Payment advice delivery failed',
        );
      }
      processed += 1;
    }
    return processed;
  }

  private claim() {
    return this.database.withWorker(async (database) => {
      const result = await database.query<DeliveryEvent>(
        `WITH candidate AS (
           SELECT event.id,event.organization_id,event.aggregate_id,delivery.attempts
             FROM opes.outbox_events event
             JOIN opes.outbound_email_deliveries delivery
               ON delivery.organization_id=event.organization_id AND delivery.id=event.aggregate_id
            WHERE event.event_type='PAYMENT_ADVICE_EMAIL' AND event.status='PENDING'
              AND event.available_at<=now() AND delivery.status IN ('PENDING','FAILED')
            ORDER BY event.created_at FOR UPDATE OF event SKIP LOCKED LIMIT 1
         )
         UPDATE opes.outbox_events event SET status='PROCESSING',updated_at=now()
          FROM candidate WHERE event.id=candidate.id
         RETURNING event.id AS event_id,event.organization_id,candidate.aggregate_id AS delivery_id,candidate.attempts`,
      );
      const event = result.rows[0];
      if (event)
        await database.query(
          `UPDATE opes.outbound_email_deliveries SET status='SENDING',attempts=attempts+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [event.organization_id, event.delivery_id],
        );
      return event;
    });
  }

  private load(event: DeliveryEvent): Promise<AdviceRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<AdviceRow>(
        `SELECT delivery.recipient_email,organization.display_name AS organization_name,
                vendor.display_name AS vendor_name,version.invoice_number,
                execution.amount_atomic::text AS amount_atomic,execution.route_asset_symbol AS asset_symbol,
                execution.route_environment,execution.route_chain_id,execution.transaction_hash,execution.confirmed_at
           FROM opes.outbound_email_deliveries delivery
           JOIN opes.payment_executions execution
             ON execution.organization_id=delivery.organization_id AND execution.id=delivery.aggregate_id
           JOIN opes.payable_obligation_versions version
             ON version.organization_id=execution.organization_id AND version.id=execution.source_version_id
           JOIN opes.vendors vendor
             ON vendor.organization_id=version.organization_id AND vendor.id=version.vendor_id
           JOIN opes.organizations organization ON organization.id=delivery.organization_id
          WHERE delivery.organization_id=$1 AND delivery.id=$2 AND execution.status='CONFIRMED'`,
        [event.organization_id, event.delivery_id],
      );
      if (!result.rows[0])
        throw new Error('Confirmed payment advice source is unavailable');
      return result.rows[0];
    });
  }

  private sent(event: DeliveryEvent, advice: AdviceRow, providerId: string) {
    return this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.outbound_email_deliveries SET status='SENT',provider_message_id=$3,failure_reason=NULL,sent_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [event.organization_id, event.delivery_id, providerId],
      );
      await database.query(
        `UPDATE opes.outbox_events SET status='PROCESSED',processed_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [event.organization_id, event.event_id],
      );
      await recordNotification(database, {
        organizationId: event.organization_id,
        type: 'PAYMENT_ADVICE_SENT',
        priority: 'INFO',
        title: `Payment advice sent to ${advice.vendor_name}`,
        body: `Delivery confirmation was sent to ${advice.recipient_email}.`,
        subjectType: 'outbound_email_delivery',
        subjectId: event.delivery_id,
        actionView: 'notifications',
        dedupeKey: `payment-advice-sent:${event.delivery_id}`,
      });
    });
  }

  private failed(event: DeliveryEvent, reason: string) {
    this.logger.warn(`payment advice ${event.delivery_id} failed: ${reason}`);
    return this.database.withWorker(async (database) => {
      const terminal = event.attempts + 1 >= 3;
      await database.query(
        `UPDATE opes.outbound_email_deliveries SET status='FAILED',failure_reason=$3,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [event.organization_id, event.delivery_id, reason.slice(0, 1000)],
      );
      await database.query(
        `UPDATE opes.outbox_events SET status=$3,available_at=CASE WHEN $3='PENDING' THEN now()+interval '1 minute' ELSE available_at END,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [
          event.organization_id,
          event.event_id,
          terminal ? 'FAILED' : 'PENDING',
        ],
      );
      if (terminal)
        await recordNotification(database, {
          organizationId: event.organization_id,
          type: 'PAYMENT_ADVICE_FAILED',
          priority: 'WARNING',
          title: 'Supplier payment advice could not be delivered',
          body: reason.slice(0, 500),
          subjectType: 'outbound_email_delivery',
          subjectId: event.delivery_id,
          actionView: 'notifications',
          dedupeKey: `payment-advice-failed:${event.delivery_id}`,
        });
    });
  }
}

async function sendPaymentAdvice(advice: AdviceRow): Promise<string> {
  const apiKey = process.env.OPES_RESEND_API_KEY?.trim();
  const from = process.env.OPES_RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from)
    throw new Error('Resend outbound email is not configured');
  const amount = formatAtomic(advice.amount_atomic);
  const explorer = explorerUrl(advice.route_chain_id, advice.transaction_hash);
  const text = [
    `Payment advice from ${advice.organization_name}`,
    '',
    `Supplier: ${advice.vendor_name}`,
    `Invoice: ${advice.invoice_number}`,
    `Amount: ${amount} ${advice.asset_symbol}`,
    `Network: ${advice.route_environment}`,
    `Settled: ${advice.confirmed_at.toISOString()}`,
    `Transaction: ${advice.transaction_hash}`,
    explorer ? `Explorer: ${explorer}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [advice.recipient_email],
      subject: `Payment advice: invoice ${advice.invoice_number} settled`,
      text,
    }),
  });
  if (!response.ok)
    throw new Error(`Resend payment advice failed (${response.status})`);
  const body = (await response.json()) as { id?: string };
  if (!body.id)
    throw new Error('Resend payment advice response is missing an id');
  return body.id;
}
function formatAtomic(value: string) {
  const padded = value.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function explorerUrl(chainId: number, hash: string) {
  return chainId === 5042002
    ? `https://testnet.arcscan.app/tx/${hash}`
    : chainId === 84532
      ? `https://sepolia.basescan.org/tx/${hash}`
      : null;
}
