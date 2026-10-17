import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DecisionService,
  EvaluateInvoiceDecisionRequest,
  PaymentDecisionResponse,
} from './decision.service';
import { DatabaseService } from './database.service';
import { InvoiceModelService } from './invoice-model.service';
import { TenantContext } from './tenant-context';

export type AgentInvoiceDecisionRequest = Pick<
  EvaluateInvoiceDecisionRequest,
  'invoiceVersionId' | 'route' | 'expiresAt'
>;

@Injectable()
export class AgentDecisionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly model: InvoiceModelService,
    private readonly decisions: DecisionService,
  ) {}

  async evaluateInvoicePayment(
    context: TenantContext,
    input: AgentInvoiceDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
    const evidence = await this.database.withTenant(context, (database) =>
      database.query<{
        invoice_number: string;
        amount_atomic: string;
        currency: string;
        vendor_status: string;
        address_status: string;
        payout_address: string;
        document_status: string;
        extraction_output: unknown;
        due_at: Date | null;
      }>(
        `SELECT version.invoice_number, version.amount_atomic::text AS amount_atomic,
            version.currency, vendor.status AS vendor_status,
            address.status AS address_status, address.payout_address,
            document.status AS document_status, claim.claims AS extraction_output,
            version.due_at
           FROM opes.payable_obligation_versions AS version
           JOIN opes.payable_obligations AS obligation
             ON obligation.organization_id = version.organization_id
            AND obligation.id = version.obligation_id
           JOIN opes.vendors AS vendor
             ON vendor.organization_id = version.organization_id AND vendor.id = version.vendor_id
           JOIN opes.vendor_payout_addresses AS address
             ON address.organization_id = version.organization_id AND address.id = version.vendor_address_id
           JOIN opes.evidence_documents AS document
             ON document.organization_id = version.organization_id AND document.id = version.evidence_document_id
           JOIN opes.document_extractions AS extraction
             ON extraction.organization_id = version.organization_id AND extraction.id = version.extraction_id
           JOIN opes.document_claim_versions AS claim
             ON claim.organization_id = extraction.organization_id
            AND claim.extraction_id = extraction.id
            AND claim.status = 'CONFIRMED'
          WHERE version.organization_id = $1 AND version.id = $2
            AND version.status = 'ACCEPTED'
            AND obligation.status = 'ACCEPTED'
            AND EXISTS (
              SELECT 1 FROM opes.payable_evidence_matches evidence_match
              WHERE evidence_match.organization_id = version.organization_id
                AND evidence_match.invoice_version_id = version.id
                AND evidence_match.status = 'PASS'
            )
          LIMIT 1`,
        [context.organizationId, input.invoiceVersionId],
      ),
    );
    const row = evidence.rows[0];
    if (!row) throw new NotFoundException('Verified invoice version not found');
    if (row.document_status !== 'VERIFIED')
      throw new ConflictException('Invoice evidence is not verified');

    const proposal = await this.model.proposePayment({
      invoice: {
        invoiceNumber: row.invoice_number,
        amountAtomic: row.amount_atomic,
        currency: row.currency,
        vendorStatus: row.vendor_status,
        addressStatus: row.address_status,
        verifiedPayoutAddress: row.payout_address,
        extraction: row.extraction_output,
      },
      requestedRoute: input.route,
      decisionExpiresAt: input.expiresAt,
    });
    const proposedExecutionAt =
      proposal.output.action === 'DELAY' && row.due_at
        ? new Date(row.due_at.getTime() - 24 * 60 * 60 * 1000)
        : null;
    return this.decisions.evaluateInvoicePayment(context, {
      ...input,
      modelAction: proposal.output.action,
      modelName: proposal.model,
      modelRationale: proposal.output.rationale,
      promptVersion: proposal.promptVersion,
      proposedExecutionAt:
        proposedExecutionAt && proposedExecutionAt.getTime() > Date.now()
          ? proposedExecutionAt.toISOString()
          : null,
    });
  }
}
