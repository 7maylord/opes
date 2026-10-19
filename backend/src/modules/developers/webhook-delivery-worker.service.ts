import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  decryptWebhookSecret,
  signWebhook,
} from './developer-platform.service';
interface Work {
  id: string;
  organization_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
  url: string;
  signing_secret_encrypted: string;
  description: string;
  event_types: string[];
  status: string;
  created_at: Date;
}
@Injectable()
export class WebhookDeliveryWorkerService {
  private readonly logger = new Logger(WebhookDeliveryWorkerService.name);
  constructor(private readonly database: DatabaseService) {}
  async processDue(limit = 10) {
    let count = 0;
    while (count < limit) {
      const work = await this.claim();
      if (!work) break;
      try {
        await this.deliver(work);
      } catch (error) {
        await this.fail(
          work,
          error instanceof Error ? error.message : 'Webhook delivery failed',
        );
      }
      count++;
    }
    return count;
  }
  private claim() {
    return this.database.withWorker(
      async (db) =>
        (
          await db.query<Work>(
            `WITH candidate AS (SELECT delivery.id FROM opes.webhook_deliveries delivery JOIN opes.webhook_endpoints endpoint ON endpoint.organization_id=delivery.organization_id AND endpoint.id=delivery.endpoint_id AND endpoint.status='ACTIVE' WHERE delivery.status='PENDING' AND delivery.next_attempt_at<=now() ORDER BY delivery.created_at FOR UPDATE OF delivery SKIP LOCKED LIMIT 1) UPDATE opes.webhook_deliveries delivery SET status='PROCESSING',attempt_count=attempt_count+1,updated_at=now() FROM candidate,opes.webhook_endpoints endpoint WHERE delivery.id=candidate.id AND endpoint.organization_id=delivery.organization_id AND endpoint.id=delivery.endpoint_id RETURNING delivery.id,delivery.organization_id,delivery.endpoint_id,delivery.event_id,delivery.event_type,delivery.payload,delivery.attempt_count,delivery.created_at,endpoint.url,endpoint.signing_secret_encrypted,endpoint.description,endpoint.event_types,endpoint.status`,
          )
        ).rows[0],
    );
  }
  private async deliver(work: Work) {
    await assertPublicDestination(work.url);
    const body = JSON.stringify({
      id: work.event_id,
      type: work.event_type,
      createdAt: work.created_at,
      payload: work.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = decryptWebhookSecret(work.organization_id, work);
    const response = await fetch(work.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opes-event-id': work.event_id,
        'x-opes-timestamp': timestamp,
        'x-opes-signature': `v1=${signWebhook(secret, timestamp, body)}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const responseBody = (await response.text()).slice(0, 1000);
    if (!response.ok)
      throw new Error(
        `Webhook returned HTTP ${response.status}: ${responseBody}`,
      );
    await this.database.withWorker((db) =>
      db.query(
        `UPDATE opes.webhook_deliveries SET status='DELIVERED',response_status=$2,response_body=$3,delivered_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`,
        [work.id, response.status, responseBody],
      ),
    );
  }
  private fail(work: Work, reason: string) {
    this.logger.warn(`webhook ${work.id} failed: ${reason}`);
    const terminal = work.attempt_count >= 5;
    return this.database.withWorker((db) =>
      db.query(
        `UPDATE opes.webhook_deliveries SET status=$2,last_error=$3,next_attempt_at=CASE WHEN $2='PENDING' THEN now()+(interval '1 minute'*power(2,LEAST(attempt_count,5))) ELSE next_attempt_at END,updated_at=now() WHERE id=$1`,
        [work.id, terminal ? 'FAILED' : 'PENDING', reason.slice(0, 1000)],
      ),
    );
  }
}

async function assertPublicDestination(value: string) {
  const addresses = await lookup(new URL(value).hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => isPrivateAddress(item.address))
  )
    throw new Error('Webhook destination resolves to a private network');
}
function isPrivateAddress(address: string) {
  if (!isIP(address)) return true;
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:'))
      return isPrivateAddress(normalized.slice(7));
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  const [first, second] = address.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
