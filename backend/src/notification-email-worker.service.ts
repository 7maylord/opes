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
  const network = networkName(advice.route_environment);
  const settledAt = formatSettledAt(advice.confirmed_at);
  const text = [
    `Payment confirmed by ${advice.organization_name}`,
    '',
    `Supplier: ${advice.vendor_name}`,
    `Invoice: ${advice.invoice_number}`,
    `Amount: ${amount} ${advice.asset_symbol}`,
    `Network: ${network}`,
    `Settled: ${settledAt}`,
    `Transaction: ${advice.transaction_hash}`,
    explorer ? `View transaction: ${explorer}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const html = paymentAdviceHtml(advice, amount, network, settledAt, explorer);
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
      subject: `Payment confirmed — invoice ${advice.invoice_number}`,
      text,
      html,
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

function networkName(environment: string) {
  return environment === 'arc-testnet'
    ? 'Arc Testnet'
    : environment === 'base-sepolia'
      ? 'Base Sepolia'
      : environment;
}

function formatSettledAt(value: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(value);
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character]!,
  );
}

function paymentAdviceHtml(
  advice: AdviceRow,
  amount: string,
  network: string,
  settledAt: string,
  explorer: string | null,
) {
  const organization = escapeHtml(advice.organization_name);
  const vendor = escapeHtml(advice.vendor_name);
  const invoice = escapeHtml(advice.invoice_number);
  const asset = escapeHtml(advice.asset_symbol);
  const transaction = escapeHtml(advice.transaction_hash);
  const shortTransaction = escapeHtml(
    `${advice.transaction_hash.slice(0, 10)}…${advice.transaction_hash.slice(-8)}`,
  );
  const action = explorer
    ? `<tr><td style="padding:28px 40px 8px"><a href="${escapeHtml(explorer)}" style="display:block;background:#2448ed;border-radius:14px;color:#ffffff;font-size:15px;font-weight:700;padding:16px 24px;text-align:center;text-decoration:none">View transaction on Arcscan&nbsp;&nbsp;↗</a></td></tr>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment confirmed</title></head>
<body style="margin:0;background:#f4f3ed;color:#20251f;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${organization} paid invoice ${invoice} in full.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ed"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #d8dbd0;border-radius:24px;overflow:hidden">
<tr><td style="background:#20251f;padding:28px 40px;color:#ffffff"><table role="presentation" width="100%"><tr><td style="font-size:22px;font-weight:800;letter-spacing:-.5px">OPES</td><td align="right" style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#dce8c6">Payment advice</td></tr></table></td></tr>
<tr><td style="padding:40px 40px 20px"><div style="display:inline-block;background:#d7f46c;border-radius:999px;color:#20251f;font-size:11px;font-weight:800;letter-spacing:1px;padding:8px 12px;text-transform:uppercase">✓ Payment confirmed</div><h1 style="font-size:30px;line-height:1.15;letter-spacing:-1px;margin:20px 0 10px">${invoice} has been settled.</h1><p style="color:#68705f;font-size:15px;line-height:1.7;margin:0">${organization} has sent payment to ${vendor}. The transaction is confirmed onchain.</p></td></tr>
<tr><td style="padding:10px 40px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#edf1e5;border-radius:18px"><tr><td style="padding:24px"><div style="color:#68705f;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">Amount paid</div><div style="font-size:34px;font-weight:800;letter-spacing:-1px;margin-top:8px">${escapeHtml(amount)} <span style="font-size:16px;color:#4d6a3b">${asset}</span></div></td></tr></table></td></tr>
<tr><td style="padding:22px 40px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px"><tr><td style="border-bottom:1px solid #e5e7df;color:#68705f;padding:13px 0">Supplier</td><td align="right" style="border-bottom:1px solid #e5e7df;font-weight:700;padding:13px 0">${vendor}</td></tr><tr><td style="border-bottom:1px solid #e5e7df;color:#68705f;padding:13px 0">Network</td><td align="right" style="border-bottom:1px solid #e5e7df;font-weight:700;padding:13px 0">${escapeHtml(network)}</td></tr><tr><td style="border-bottom:1px solid #e5e7df;color:#68705f;padding:13px 0">Settled</td><td align="right" style="border-bottom:1px solid #e5e7df;font-weight:700;padding:13px 0">${escapeHtml(settledAt)}</td></tr><tr><td style="color:#68705f;padding:13px 0">Transaction</td><td align="right" title="${transaction}" style="font-family:Consolas,monospace;font-size:12px;font-weight:700;padding:13px 0">${shortTransaction}</td></tr></table></td></tr>
${action}
<tr><td style="padding:26px 40px 36px;color:#78816d;font-size:12px;line-height:1.6">This receipt was generated automatically by OPES from a confirmed onchain settlement. Keep it with your invoice records.</td></tr>
</table>
<div style="color:#8a9480;font-size:11px;padding:20px;text-align:center">Evidence verified. Treasury authorized. Payment settled.</div>
</td></tr></table></body></html>`;
}
