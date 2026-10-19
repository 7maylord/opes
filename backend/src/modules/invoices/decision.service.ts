import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import factoryManifest from '../../deployments/arc-testnet-factory.json';
import {
  buildDirectPaymentDecisionHash,
  isEvmAddress,
  organizationDomain,
} from '../../infrastructure/evm/evm-decision-hash';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { evaluatePaymentRoute } from '../treasury/liquidity-policy';
import {
  readTreasuryAvailability,
  TreasuryAvailability,
} from '../treasury/liquidity.service';
import { TenantContext } from '../../core/database/tenant-context';
import { PaymentRouteQuote, planPayment } from './payment-planner';
import { recordNotification } from '../notifications/notification.service';

type DecisionAction = 'PAY' | 'DELAY' | 'ESCALATE' | 'REJECT';
type CheckStatus = 'PASS' | 'BLOCK' | 'REQUIRES_APPROVAL';

const ARC_TESTNET_USDC = factoryManifest.token;

export interface EvaluateInvoiceDecisionRequest {
  invoiceVersionId: string;
  modelAction: DecisionAction;
  modelName: string;
  modelRationale: string;
  promptVersion: string;
  route: {
    liquidityRoute: 'OPERATING' | 'GATEWAY' | 'CCTP' | 'NONE';
    environment: string;
    chainId: number;
    assetSymbol: string;
  };
  expiresAt: string;
  proposedExecutionAt?: string | null;
}

export interface PlanInvoicePaymentRequest {
  invoiceVersionId: string;
  routeQuotes?: PaymentRouteQuote[];
  verifiedDiscountAtomic?: string;
  verifiedDiscountDeadline?: string;
}

export interface OverrideDecisionRequest {
  action: 'PAY' | 'DELAY' | 'REJECT';
  reason: string;
  proposedExecutionAt?: string | null;
}

export interface DecisionCheckResponse {
  code: string;
  status: CheckStatus;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface DecisionApprovalResponse {
  id: string;
  decisionId: string;
  decisionVersion: number;
  sourceVersionId: string;
  amountAtomic: string;
  destinationAddress: string;
  contextHash: string;
  policySnapshotHash: string;
  status: string;
  expiresAt: string;
}

export interface PaymentDecisionResponse {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceVersionId: string;
  decisionVersion: number;
  paymentMode: string;
  modelAction: DecisionAction;
  derivedAction: DecisionAction;
  liquidityRoute: string;
  routeEnvironment: string;
  routeChainId: number;
  routeAssetSymbol: string;
  amountAtomic: string;
  destinationAddress: string;
  evidenceBundleHash: string;
  policySnapshotHash: string;
  contextHash: string;
  decisionHash: string | null;
  checks: DecisionCheckResponse[];
  proposedExecutionAt: string | null;
  expiresAt: string;
}

interface InvoiceVersionRow {
  id: string;
  obligation_id: string;
  vendor_id: string;
  vendor_address_id: string;
  evidence_document_id: string;
  extraction_id: string | null;
  invoice_number: string;
  currency: string;
  amount_atomic: string;
  amount_decimals: number;
  content_hash: string;
  obligation_key: string;
  vendor_status: string;
  vendor_version: number;
  address_status: string;
  payout_address: string;
  address_version: number;
  evidence_match_id: string;
  governing_evidence_version_id: string;
  delivery_evidence_version_id: string;
  governing_total_atomic: string;
  governing_used_atomic: string;
}

interface PolicyRow {
  id: string;
  version: number;
  autonomous_limit_atomic: string;
  single_payment_limit_atomic: string;
  vendor_daily_limit_atomic: string;
  organization_daily_limit_atomic: string;
  monthly_budget_atomic: string | null;
  operating_buffer_atomic: string;
  allowed_routes: string[];
  allowed_assets: string[];
  organization_status: string;
  agent_status: string;
  vendor_daily_committed_atomic: string;
  organization_daily_committed_atomic: string;
}

interface BindingRow {
  id: string;
  address: string | null;
  status: string;
  metadata: unknown;
}

interface ApprovalRow {
  id: string;
  decision_id: string;
  decision_version: number;
  source_version_id: string;
  amount_atomic: string;
  destination_address: string;
  context_hash: string;
  policy_snapshot_hash: string;
  status: string;
  expires_at: Date;
}

interface DecisionRow {
  id: string;
  source_type: string;
  source_id: string;
  source_version_id: string;
  decision_version: number;
  payment_mode: string;
  model_action: DecisionAction;
  derived_action: DecisionAction;
  liquidity_route: string;
  route_environment: string;
  route_chain_id: number;
  route_asset_symbol: string;
  amount_atomic: string;
  destination_address: string;
  evidence_bundle_hash: string;
  policy_snapshot_hash: string;
  context_hash: string;
  decision_hash: string | null;
  checks: DecisionCheckResponse[];
  proposed_execution_at: Date | null;
  policy_version_id: string | null;
  policy_is_active: boolean;
  expires_at: Date;
}

@Injectable()
export class DecisionService {
  constructor(private readonly database: DatabaseService) {}

  async planInvoicePayment(
    context: TenantContext,
    input: PlanInvoicePaymentRequest,
  ) {
    const invoiceVersionId = requireUuid(
      input.invoiceVersionId,
      'invoiceVersionId',
    );
    return this.database.withTenant(context, async (database) => {
      const invoice = await database.query<{
        amount_atomic: string;
        due_at: Date | null;
      }>(
        `SELECT amount_atomic::text,due_at
         FROM opes.payable_obligation_versions
         WHERE organization_id=$1 AND id=$2 AND status='ACCEPTED'`,
        [context.organizationId, invoiceVersionId],
      );
      const row = requireRow(invoice.rows[0], 'accepted invoice version');
      const treasury = await readTreasuryAvailability(
        database,
        context.organizationId,
        false,
      );
      const deadline = input.verifiedDiscountDeadline
        ? new Date(input.verifiedDiscountDeadline)
        : null;
      if (deadline && Number.isNaN(deadline.getTime()))
        throw new BadRequestException(
          'verifiedDiscountDeadline must be an ISO timestamp',
        );
      if (input.routeQuotes !== undefined && !Array.isArray(input.routeQuotes))
        throw new BadRequestException('routeQuotes must be an array');
      return planPayment({
        amountAtomic: row.amount_atomic,
        dueAt: row.due_at,
        now: new Date(),
        discountAtomic: input.verifiedDiscountAtomic,
        discountDeadline: deadline,
        quotes: [
          {
            liquidityRoute: 'OPERATING',
            environment: 'arc-testnet',
            chainId: 5042002,
            assetSymbol: 'USDC',
            feeAtomic: '0',
            availableAtomic: treasury.availableAtomic.toString(),
            finalitySeconds: 12,
            providerAvailable: treasury.ready,
          },
          ...(input.routeQuotes ?? []),
        ],
      });
    });
  }

  async approveDecision(
    context: TenantContext,
    decisionId: string,
  ): Promise<DecisionApprovalResponse> {
    requireApprovalRole(context);
    const targetDecisionId = requireUuid(decisionId, 'decisionId');

    return this.database.withTenant(context, async (database) => {
      await database.query(
        `SELECT organization_id FROM opes.treasury_settings
         WHERE organization_id=$1 FOR UPDATE`,
        [context.organizationId],
      );
      const decision = await getDecision(
        database,
        context.organizationId,
        targetDecisionId,
      );
      if (decision.derived_action === 'REJECT') {
        throw new ConflictException('Rejected decisions cannot be approved');
      }
      if (decision.expires_at.getTime() <= Date.now()) {
        throw new ConflictException('Expired decisions cannot be approved');
      }
      if (decision.checks.some((item) => item.status === 'BLOCK')) {
        throw new ConflictException('Blocked decisions cannot be approved');
      }
      if (!decision.policy_is_active)
        throw new ConflictException('Decision policy is no longer active');

      const treasury = await readTreasuryAvailability(
        database,
        context.organizationId,
        false,
      );
      if (
        !treasury.ready ||
        BigInt(decision.amount_atomic) > treasury.availableAtomic
      )
        throw new ConflictException(
          'Available liquidity no longer covers the payment',
        );

      const inserted = await database.query<ApprovalRow>(
        `
          INSERT INTO opes.payment_decision_approvals (
            organization_id,
            decision_id,
            decision_version,
            source_version_id,
            amount_atomic,
            destination_address,
            context_hash,
            policy_snapshot_hash,
            approved_by_membership_id,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (organization_id, decision_id, status)
          DO UPDATE SET approved_at = opes.payment_decision_approvals.approved_at
          RETURNING
            id,
            decision_id,
            decision_version,
            source_version_id,
            amount_atomic::text AS amount_atomic,
            destination_address,
            context_hash,
            policy_snapshot_hash,
            status,
            expires_at
        `,
        [
          context.organizationId,
          decision.id,
          decision.decision_version,
          decision.source_version_id,
          decision.amount_atomic,
          decision.destination_address,
          decision.context_hash,
          decision.policy_snapshot_hash,
          context.membershipId,
          decision.expires_at.toISOString(),
        ],
      );

      await database.query(
        `INSERT INTO opes.treasury_reservations
          (organization_id,decision_id,source_version_id,amount_atomic,expires_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id,decision_id) DO UPDATE SET
           status='ACTIVE',expires_at=EXCLUDED.expires_at,updated_at=now()
         WHERE opes.treasury_reservations.status IN ('RELEASED','EXPIRED')`,
        [
          context.organizationId,
          decision.id,
          decision.source_version_id,
          decision.amount_atomic,
          decision.expires_at.toISOString(),
        ],
      );

      return mapApproval(requireRow(inserted.rows[0], 'decision approval'));
    });
  }

  async overrideDecision(
    context: TenantContext,
    decisionId: string,
    input: OverrideDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
    if (context.role !== 'OWNER' && context.role !== 'ADMIN')
      throw new ForbiddenException('Owner or admin role is required');
    const targetDecisionId = requireUuid(decisionId, 'decisionId');
    const action = input.action;
    if (!['PAY', 'DELAY', 'REJECT'].includes(action))
      throw new BadRequestException('override action is invalid');
    const reason = requireText(input.reason, 'reason');
    const proposedExecutionAt =
      action === 'DELAY'
        ? validateOptionalTimestamp(
            input.proposedExecutionAt,
            'proposedExecutionAt',
          )
        : null;
    if (
      action === 'DELAY' &&
      (proposedExecutionAt === null ||
        Date.parse(proposedExecutionAt) <= Date.now())
    )
      throw new BadRequestException(
        'proposedExecutionAt must be in the future',
      );
    const original = await this.database.withTenant(context, (database) =>
      getDecision(database, context.organizationId, targetDecisionId),
    );
    if (original.source_type !== 'INVOICE')
      throw new BadRequestException('Only invoice decisions can be overridden');
    const overridden = await this.evaluateInvoicePayment(context, {
      invoiceVersionId: original.source_version_id,
      modelAction: action,
      modelName: 'owner-override',
      modelRationale: reason,
      promptVersion: 'owner-override-v1',
      route: {
        liquidityRoute:
          original.liquidity_route as EvaluateInvoiceDecisionRequest['route']['liquidityRoute'],
        environment: original.route_environment,
        chainId: original.route_chain_id,
        assetSymbol: original.route_asset_symbol,
      },
      proposedExecutionAt,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await this.database.withTenant(context, (database) =>
      database.query(
        `INSERT INTO opes.audit_events (
           organization_id,actor_user_id,actor_membership_id,event_type,
           subject_type,subject_id,payload
         ) VALUES ($1,$2,$3,'decision.overridden','PAYMENT_DECISION',$4,$5::jsonb)`,
        [
          context.organizationId,
          context.userId,
          context.membershipId,
          overridden.id,
          JSON.stringify({
            originalDecisionId: original.id,
            requestedAction: action,
            derivedAction: overridden.derivedAction,
            reason,
            proposedExecutionAt,
          }),
        ],
      ),
    );
    return overridden;
  }

  async evaluateInvoicePayment(
    context: TenantContext,
    input: EvaluateInvoiceDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
    const invoiceVersionId = requireUuid(
      input.invoiceVersionId,
      'invoiceVersionId',
    );
    const modelAction = validateAction(input.modelAction);
    const modelName = requireText(input.modelName, 'modelName');
    const modelRationale = requireText(input.modelRationale, 'modelRationale');
    const promptVersion = requireText(input.promptVersion, 'promptVersion');
    const route = validateRoute(input.route);
    const expiresAt = validateFutureTimestamp(input.expiresAt);
    const proposedExecutionAt = validateOptionalTimestamp(
      input.proposedExecutionAt,
      'proposedExecutionAt',
    );

    return this.database.withTenant(context, async (database) => {
      const invoice = await getInvoiceVersion(
        database,
        context.organizationId,
        invoiceVersionId,
      );
      const vaultBinding = await getActiveVaultBinding(
        database,
        context.organizationId,
      );
      await database.query(
        `UPDATE opes.treasury_reservations SET status='RELEASED',updated_at=now()
         WHERE organization_id=$1 AND source_version_id=$2 AND status='ACTIVE'`,
        [context.organizationId, invoice.id],
      );
      const treasury = await readTreasuryAvailability(
        database,
        context.organizationId,
        true,
      );
      const policy = await getActivePolicy(
        database,
        context.organizationId,
        invoice.vendor_id,
      );
      const checks = buildChecks(
        invoice,
        vaultBinding,
        route,
        modelAction,
        treasury,
        policy,
      );
      const derivedAction = deriveAction(modelAction, checks);
      const evidenceBundleHash = hashStable({
        invoiceVersionId: invoice.id,
        contentHash: invoice.content_hash,
        evidenceDocumentId: invoice.evidence_document_id,
        extractionId: invoice.extraction_id,
      });
      const policySnapshot = policySnapshotOf(policy);
      const policySnapshotHash = hashStable(policySnapshot);
      const decisionVersion = await nextDecisionVersion(
        database,
        context.organizationId,
        invoice.id,
      );
      const contextPayload = {
        schemaVersion: 'opes.payment-decision.v1',
        organizationId: context.organizationId,
        source: {
          kind: 'INVOICE',
          obligationId: invoice.obligation_id,
          invoiceVersionId: invoice.id,
          obligationKey: invoice.obligation_key,
        },
        vendor: {
          id: invoice.vendor_id,
          version: invoice.vendor_version,
          addressId: invoice.vendor_address_id,
          addressVersion: invoice.address_version,
        },
        destination: invoice.payout_address,
        amountAtomic: invoice.amount_atomic,
        asset: invoice.currency,
        route,
        evidenceBundleHash,
        policySnapshotHash,
        expiresAt,
      };
      const contextHash = hashStable(contextPayload);
      const decisionHash = routeSupported(route)
        ? canHashDirectPayment(route, vaultBinding, invoice)
          ? buildDirectPaymentDecisionHash({
              chainId: route.chainId,
              vault: vaultBinding.address,
              organizationDomain: bindingOrganizationDomain(
                context.organizationId,
                route.environment,
                vaultBinding,
              ),
              token: ARC_TESTNET_USDC,
              obligationKey: invoice.obligation_key,
              vendor: invoice.payout_address,
              amount: invoice.amount_atomic,
              expiresAt,
              contextHash,
            })
          : `0x${contextHash}`
        : null;

      const inserted = await database.query<DecisionRow>(
        `
          INSERT INTO opes.payment_decisions (
            organization_id,
            source_type,
            source_id,
            source_version_id,
            decision_version,
            payment_mode,
            model_action,
            derived_action,
            liquidity_route,
            route_environment,
            route_chain_id,
            route_asset_symbol,
            amount_atomic,
            destination_address,
            vendor_id,
            vendor_address_id,
            evidence_bundle_hash,
            policy_snapshot_hash,
            context_hash,
            decision_hash,
            checks,
            model_name,
            model_rationale,
            prompt_version,
            evidence_check_version,
            policy_version_id,
            bound_vendor_version,
            bound_address_version,
            proposed_execution_at,
            expires_at,
            created_by_membership_id
          )
          VALUES (
            $1, 'INVOICE', $2, $3, $4, 'DIRECT', $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21,
            $22, 'f6-versioned-v1', $23, $24, $25, $26, $27, $28
          )
          RETURNING
            id,
            source_type,
            source_id,
            source_version_id,
            decision_version,
            payment_mode,
            model_action,
            derived_action,
            liquidity_route,
            route_environment,
            route_chain_id,
            route_asset_symbol,
            amount_atomic,
            destination_address,
            evidence_bundle_hash,
            policy_snapshot_hash,
            context_hash,
            decision_hash,
            checks,
            proposed_execution_at,
            expires_at
        `,
        [
          context.organizationId,
          invoice.obligation_id,
          invoice.id,
          decisionVersion,
          modelAction,
          derivedAction,
          route.liquidityRoute,
          route.environment,
          route.chainId,
          route.assetSymbol,
          invoice.amount_atomic,
          invoice.payout_address,
          invoice.vendor_id,
          invoice.vendor_address_id,
          evidenceBundleHash,
          policySnapshotHash,
          contextHash,
          decisionHash,
          JSON.stringify(checks),
          modelName,
          modelRationale,
          promptVersion,
          policy.id,
          invoice.vendor_version,
          invoice.address_version,
          proposedExecutionAt,
          expiresAt,
          context.membershipId,
        ],
      );
      const decision = requireRow(inserted.rows[0], 'payment decision');
      if (decision.derived_action === 'PAY') {
        await database.query(
          `INSERT INTO opes.treasury_reservations
            (organization_id,decision_id,source_version_id,amount_atomic,expires_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            context.organizationId,
            decision.id,
            invoice.id,
            invoice.amount_atomic,
            expiresAt,
          ],
        );
      }
      const approvalCheck = checks.find(
        (item) => item.status === 'REQUIRES_APPROVAL',
      );
      const blockedChecks = checks.filter((item) => item.status === 'BLOCK');
      if (approvalCheck) {
        await recordNotification(database, {
          organizationId: context.organizationId,
          type: 'PAYMENT_APPROVAL_REQUIRED',
          priority: 'ACTION',
          title: `Invoice payment needs approval`,
          body: `${invoice.invoice_number} is above the autonomous payment limit and is waiting for an owner, admin or approver.`,
          subjectType: 'payment_decision',
          subjectId: decision.id,
          actionView: 'invoices',
          dedupeKey: `approval-required:${decision.id}`,
          metadata: {
            invoiceVersionId: invoice.id,
            amountAtomic: invoice.amount_atomic,
            checkCode: approvalCheck.code,
          },
        });
      } else if (
        decision.derived_action === 'DELAY' &&
        decision.proposed_execution_at
      ) {
        await recordNotification(database, {
          organizationId: context.organizationId,
          type: 'PAYMENT_SCHEDULED',
          priority: 'INFO',
          title: `Payment scheduled for invoice ${invoice.invoice_number}`,
          body: `The agent scheduled this payment for ${decision.proposed_execution_at.toISOString()} based on its due date and treasury plan.`,
          subjectType: 'payment_decision',
          subjectId: decision.id,
          actionView: 'invoices',
          dedupeKey: `payment-scheduled:${decision.id}`,
          metadata: {
            invoiceVersionId: invoice.id,
            proposedExecutionAt: decision.proposed_execution_at.toISOString(),
          },
        });
      } else if (blockedChecks.length) {
        await recordNotification(database, {
          organizationId: context.organizationId,
          type: 'PAYMENT_BLOCKED',
          priority: 'WARNING',
          title: `Payment blocked for invoice ${invoice.invoice_number}`,
          body: blockedChecks.map((item) => item.message).join('; '),
          subjectType: 'payment_decision',
          subjectId: decision.id,
          actionView: 'treasury',
          dedupeKey: `payment-blocked:${decision.id}`,
          metadata: {
            invoiceVersionId: invoice.id,
            checks: blockedChecks.map((item) => item.code),
          },
        });
      }
      return mapDecision(decision);
    });
  }
}

async function getDecision(
  database: TenantDatabase,
  organizationId: string,
  decisionId: string,
): Promise<DecisionRow> {
  const result = await database.query<DecisionRow>(
    `
      SELECT
        id,
        source_type,
        source_id,
        source_version_id,
        decision_version,
        payment_mode,
        model_action,
        derived_action,
        liquidity_route,
        route_environment,
        route_chain_id,
        route_asset_symbol,
        amount_atomic::text AS amount_atomic,
        destination_address,
        evidence_bundle_hash,
        policy_snapshot_hash,
        context_hash,
        decision_hash,
        checks,
        policy_version_id,
        EXISTS (
          SELECT 1 FROM opes.payment_policy_versions policy
          WHERE policy.organization_id=payment_decisions.organization_id
            AND policy.id=payment_decisions.policy_version_id
            AND policy.status='ACTIVE'
        ) AS policy_is_active,
        proposed_execution_at,
        expires_at
      FROM opes.payment_decisions
      WHERE organization_id = $1
        AND id = $2
      LIMIT 1
    `,
    [organizationId, decisionId],
  );
  return requireRow(result.rows[0], 'payment decision');
}

async function getActivePolicy(
  database: TenantDatabase,
  organizationId: string,
  vendorId: string,
): Promise<PolicyRow> {
  const result = await database.query<PolicyRow>(
    `SELECT policy.id,policy.version,
            policy.autonomous_limit_atomic::text,
            policy.single_payment_limit_atomic::text,
            policy.vendor_daily_limit_atomic::text,
            policy.organization_daily_limit_atomic::text,
            policy.monthly_budget_atomic::text,
            policy.operating_buffer_atomic::text,
            policy.allowed_routes,policy.allowed_assets,
            organization.lifecycle_status AS organization_status,
            agent.lifecycle_status AS agent_status,
            (COALESCE((SELECT sum(execution.amount_atomic)
               FROM opes.payment_executions execution
               JOIN opes.payment_decisions decision
                 ON decision.organization_id=execution.organization_id
                AND decision.id=execution.decision_id
              WHERE execution.organization_id=$1
                AND decision.vendor_id=$2
                AND execution.status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN','CONFIRMED')
                AND execution.requested_at>=date_trunc('day',now())),0)
             + COALESCE((SELECT sum(reservation.amount_atomic)
               FROM opes.treasury_reservations reservation
               JOIN opes.payment_decisions decision
                 ON decision.organization_id=reservation.organization_id
                AND decision.id=reservation.decision_id
              WHERE reservation.organization_id=$1
                AND decision.vendor_id=$2 AND reservation.status='ACTIVE'
                AND reservation.expires_at>now()),0))::text
              AS vendor_daily_committed_atomic,
            (COALESCE((SELECT sum(amount_atomic)
               FROM opes.payment_executions
              WHERE organization_id=$1
                AND status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN','CONFIRMED')
                AND requested_at>=date_trunc('day',now())),0)
             + COALESCE((SELECT sum(amount_atomic)
               FROM opes.treasury_reservations
              WHERE organization_id=$1 AND status='ACTIVE'
                AND expires_at>now()),0))::text
              AS organization_daily_committed_atomic
       FROM opes.payment_policy_versions policy
       JOIN opes.organizations organization ON organization.id=policy.organization_id
       JOIN opes.business_agents agent
         ON agent.organization_id=policy.organization_id AND agent.is_primary
      WHERE policy.organization_id=$1 AND policy.status='ACTIVE'
      LIMIT 1`,
    [organizationId, vendorId],
  );
  return requireRow(result.rows[0], 'active payment policy');
}

function policySnapshotOf(policy: PolicyRow) {
  return {
    id: policy.id,
    version: policy.version,
    autonomousLimitAtomic: policy.autonomous_limit_atomic,
    singlePaymentLimitAtomic: policy.single_payment_limit_atomic,
    vendorDailyLimitAtomic: policy.vendor_daily_limit_atomic,
    organizationDailyLimitAtomic: policy.organization_daily_limit_atomic,
    monthlyBudgetAtomic: policy.monthly_budget_atomic,
    operatingBufferAtomic: policy.operating_buffer_atomic,
    allowedRoutes: policy.allowed_routes,
    allowedAssets: policy.allowed_assets,
  };
}

async function getInvoiceVersion(
  database: TenantDatabase,
  organizationId: string,
  invoiceVersionId: string,
): Promise<InvoiceVersionRow> {
  const result = await database.query<InvoiceVersionRow>(
    `
      SELECT
        version.id,
        version.obligation_id,
        version.vendor_id,
        version.vendor_address_id,
        version.evidence_document_id,
        version.extraction_id,
        version.invoice_number,
        version.currency,
        version.amount_atomic::text AS amount_atomic,
        version.amount_decimals,
        version.content_hash,
        obligation.obligation_key,
        vendor.status AS vendor_status,
        vendor.version AS vendor_version,
        address.status AS address_status,
        address.payout_address,
        address.version AS address_version
        , evidence_match.id AS evidence_match_id
        , evidence_match.governing_evidence_version_id
        , evidence_match.delivery_evidence_version_id
        , COALESCE(governing.total_amount_atomic,0)::text AS governing_total_atomic
        , COALESCE(evidence_match.calculation_snapshot->>'governingUsedAtomic','0') AS governing_used_atomic
      FROM opes.payable_obligation_versions AS version
      JOIN opes.payable_obligations AS obligation
        ON obligation.organization_id = version.organization_id
       AND obligation.id = version.obligation_id
      JOIN opes.vendors AS vendor
        ON vendor.organization_id = version.organization_id
       AND vendor.id = version.vendor_id
      JOIN opes.vendor_payout_addresses AS address
        ON address.organization_id = version.organization_id
       AND address.id = version.vendor_address_id
      JOIN opes.payable_evidence_matches evidence_match
        ON evidence_match.organization_id=version.organization_id
       AND evidence_match.invoice_version_id=version.id
       AND evidence_match.status='PASS'
      JOIN opes.procurement_evidence_versions governing
        ON governing.organization_id=evidence_match.organization_id
       AND governing.id=evidence_match.governing_evidence_version_id
      WHERE version.organization_id = $1
        AND version.id = $2
        AND version.status = 'ACCEPTED'
        AND obligation.status = 'ACCEPTED'
      LIMIT 1
    `,
    [organizationId, invoiceVersionId],
  );
  return requireRow(result.rows[0], 'invoice version');
}

async function getActiveVaultBinding(
  database: TenantDatabase,
  organizationId: string,
): Promise<BindingRow | null> {
  const result = await database.query<BindingRow>(
    `
      SELECT id, address, status, metadata
        FROM opes.tenant_resource_bindings
       WHERE organization_id = $1
         AND provider = 'arc'
         AND environment = 'arc-testnet'
         AND resource_type = 'business_policy_vault_contract'
         AND status = 'ACTIVE'
       LIMIT 1
    `,
    [organizationId],
  );
  return result.rows[0] ?? null;
}

async function nextDecisionVersion(
  database: TenantDatabase,
  organizationId: string,
  sourceVersionId: string,
): Promise<number> {
  const result = await database.query<{ next_version: number }>(
    `
      SELECT COALESCE(MAX(decision_version), 0) + 1 AS next_version
        FROM opes.payment_decisions
       WHERE organization_id = $1
         AND source_type = 'INVOICE'
         AND source_version_id = $2
    `,
    [organizationId, sourceVersionId],
  );
  return requireRow(result.rows[0], 'next decision version').next_version;
}

function canHashDirectPayment(
  route: EvaluateInvoiceDecisionRequest['route'],
  vaultBinding: BindingRow | null,
  invoice: InvoiceVersionRow,
): vaultBinding is BindingRow & { address: string } {
  return (
    route.liquidityRoute === 'OPERATING' &&
    route.environment === 'arc-testnet' &&
    route.chainId === 5042002 &&
    route.assetSymbol === 'USDC' &&
    isEvmAddress(vaultBinding?.address) &&
    isEvmAddress(invoice.payout_address) &&
    /^[0-9a-f]{64}$/.test(invoice.obligation_key)
  );
}

function bindingOrganizationDomain(
  organizationId: string,
  environment: string,
  vaultBinding: BindingRow,
): string {
  const metadata = vaultBinding.metadata;
  if (metadata !== null && typeof metadata === 'object') {
    const value = (metadata as Record<string, unknown>).organizationDomain;
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) {
      return value;
    }
  }

  return organizationDomain(organizationId, environment);
}

function buildChecks(
  invoice: InvoiceVersionRow,
  vaultBinding: BindingRow | null,
  route: EvaluateInvoiceDecisionRequest['route'],
  modelAction: DecisionAction,
  treasury: TreasuryAvailability,
  policy: PolicyRow,
): DecisionCheckResponse[] {
  const amount = BigInt(invoice.amount_atomic);
  const routeKey = `${route.liquidityRoute}:${route.environment}:${route.chainId}:${route.assetSymbol}`;
  const poRemaining =
    BigInt(invoice.governing_total_atomic) -
    BigInt(invoice.governing_used_atomic) -
    amount;
  return [
    check(
      'decision_advisory_only',
      'PASS',
      `requested action ${modelAction}; deterministic checks derive executable action`,
      { modelAction },
    ),
    check(
      'organization_and_agent_active',
      policy.organization_status === 'ACTIVE' &&
        policy.agent_status === 'ACTIVE'
        ? 'PASS'
        : 'BLOCK',
      policy.organization_status === 'ACTIVE' &&
        policy.agent_status === 'ACTIVE'
        ? 'organization and agent are active'
        : 'organization or agent is paused or inactive',
      {
        organizationStatus: policy.organization_status,
        agentStatus: policy.agent_status,
      },
    ),
    check(
      'approved_arrangement',
      'PASS',
      'invoice is bound to an approved purchase arrangement and delivery record',
      {
        evidenceMatchId: invoice.evidence_match_id,
        governingEvidenceVersionId: invoice.governing_evidence_version_id,
        deliveryEvidenceVersionId: invoice.delivery_evidence_version_id,
      },
    ),
    check(
      'purchase_order_remaining',
      poRemaining >= 0n ? 'PASS' : 'BLOCK',
      poRemaining >= 0n
        ? 'purchase order remaining value covers the invoice'
        : 'invoice exceeds purchase order remaining value',
      { remainingAfterPaymentAtomic: poRemaining.toString() },
    ),
    check(
      'vendor_verified',
      invoice.vendor_status === 'VERIFIED' ? 'PASS' : 'BLOCK',
      invoice.vendor_status === 'VERIFIED'
        ? 'vendor is verified'
        : 'vendor is not verified',
      {
        vendorStatus: invoice.vendor_status,
        vendorVersion: invoice.vendor_version,
      },
    ),
    check(
      'payout_address_active',
      invoice.address_status === 'VERIFIED_ACTIVE' &&
        isEvmAddress(invoice.payout_address)
        ? 'PASS'
        : 'BLOCK',
      invoice.address_status === 'VERIFIED_ACTIVE' &&
        isEvmAddress(invoice.payout_address)
        ? 'payout address is active'
        : 'payout address is not active or invalid',
      {
        addressStatus: invoice.address_status,
        addressVersion: invoice.address_version,
      },
    ),
    check(
      'route_supported',
      routeSupported(route) ? 'PASS' : 'BLOCK',
      evaluatePaymentRoute(route).reason,
      { routeKey },
    ),
    check(
      'policy_route_allowed',
      policy.allowed_routes.includes(routeKey) ? 'PASS' : 'BLOCK',
      policy.allowed_routes.includes(routeKey)
        ? 'route is allowed by tenant policy'
        : 'route is not allowed by tenant policy',
      { routeKey, policyVersion: policy.version },
    ),
    check(
      'policy_token_allowed',
      policy.allowed_assets.includes(route.assetSymbol) ? 'PASS' : 'BLOCK',
      policy.allowed_assets.includes(route.assetSymbol)
        ? 'token is allowed by tenant policy'
        : 'token is not allowed by tenant policy',
      { assetSymbol: route.assetSymbol, policyVersion: policy.version },
    ),
    check(
      'vault_binding_active',
      isEvmAddress(vaultBinding?.address) ? 'PASS' : 'BLOCK',
      isEvmAddress(vaultBinding?.address)
        ? 'verified vault binding is active'
        : 'verified vault binding is missing or invalid',
      { vaultBindingId: vaultBinding?.id ?? null },
    ),
    check(
      'treasury_snapshot_fresh',
      treasury.ready ? 'PASS' : 'BLOCK',
      treasury.ready
        ? 'treasury balance snapshot is fresh'
        : `treasury authorization is blocked: ${treasury.snapshotStatus.toLowerCase()} balance snapshot`,
      { snapshotStatus: treasury.snapshotStatus },
    ),
    check(
      'available_liquidity',
      treasury.ready &&
        BigInt(invoice.amount_atomic) <= treasury.availableAtomic
        ? 'PASS'
        : 'BLOCK',
      treasury.ready &&
        BigInt(invoice.amount_atomic) <= treasury.availableAtomic
        ? 'available liquidity covers the payment and reservation'
        : 'available liquidity does not cover the payment',
      {
        amountAtomic: invoice.amount_atomic,
        availableAtomic: treasury.availableAtomic.toString(),
      },
    ),
    check(
      'operating_buffer',
      treasury.ready && amount <= treasury.operatingAvailableAtomic
        ? 'PASS'
        : 'BLOCK',
      treasury.ready && amount <= treasury.operatingAvailableAtomic
        ? 'operating buffer remains protected'
        : 'payment would breach the operating buffer',
      {
        operatingAvailableAtomic: treasury.operatingAvailableAtomic.toString(),
        operatingBufferAtomic: treasury.operatingBufferAtomic.toString(),
      },
    ),
    limitCheck(
      'single_payment_limit',
      amount,
      0n,
      BigInt(policy.single_payment_limit_atomic),
      'BLOCK',
    ),
    limitCheck(
      'vendor_daily_limit',
      amount,
      BigInt(policy.vendor_daily_committed_atomic),
      BigInt(policy.vendor_daily_limit_atomic),
      'BLOCK',
    ),
    limitCheck(
      'organization_daily_limit',
      amount,
      BigInt(policy.organization_daily_committed_atomic),
      BigInt(policy.organization_daily_limit_atomic),
      'BLOCK',
    ),
    limitCheck(
      'monthly_budget',
      amount,
      0n,
      treasury.monthlyBudgetRemainingAtomic,
      'BLOCK',
    ),
    limitCheck(
      'human_approval',
      amount,
      0n,
      BigInt(policy.autonomous_limit_atomic),
      'REQUIRES_APPROVAL',
    ),
  ];
}

function limitCheck(
  code: string,
  amount: bigint,
  committed: bigint,
  limit: bigint | null,
  exceeded: CheckStatus,
): DecisionCheckResponse {
  const passes = limit === null || amount + committed <= limit;
  return check(
    code,
    passes ? 'PASS' : exceeded,
    passes ? `${code} permits the payment` : `${code} is exceeded`,
    {
      amountAtomic: amount.toString(),
      committedAtomic: committed.toString(),
      limitAtomic: limit?.toString() ?? null,
    },
  );
}

function check(
  code: string,
  status: CheckStatus,
  message: string,
  evidence: Record<string, string | number | boolean | null>,
): DecisionCheckResponse {
  return { code, status, message, evidence };
}

function deriveAction(
  modelAction: DecisionAction,
  checks: DecisionCheckResponse[],
): DecisionAction {
  if (checks.some((item) => item.status === 'BLOCK')) {
    return 'REJECT';
  }
  if (checks.some((item) => item.status === 'REQUIRES_APPROVAL')) {
    return 'ESCALATE';
  }
  return modelAction === 'PAY' ? 'PAY' : modelAction;
}

function routeSupported(
  route: EvaluateInvoiceDecisionRequest['route'],
): boolean {
  return evaluatePaymentRoute(route).executable;
}

function requireApprovalRole(context: TenantContext): void {
  if (
    context.role !== 'OWNER' &&
    context.role !== 'ADMIN' &&
    context.role !== 'APPROVER'
  ) {
    throw new ForbiddenException(
      'Only owners, admins and approvers can approve decisions',
    );
  }
}

function validateRoute(
  route: EvaluateInvoiceDecisionRequest['route'],
): EvaluateInvoiceDecisionRequest['route'] {
  if (route === null || typeof route !== 'object') {
    throw new BadRequestException('route is required');
  }
  const liquidityRoute = requireText(
    route.liquidityRoute,
    'route.liquidityRoute',
  );
  if (!['OPERATING', 'GATEWAY', 'CCTP', 'NONE'].includes(liquidityRoute)) {
    throw new BadRequestException('route.liquidityRoute is invalid');
  }
  const environment = requireText(route.environment, 'route.environment');
  const chainId = route.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new BadRequestException('route.chainId must be a positive integer');
  }
  const assetSymbol = requireText(
    route.assetSymbol,
    'route.assetSymbol',
  ).toUpperCase();
  return {
    liquidityRoute,
    environment,
    chainId,
    assetSymbol,
  } as EvaluateInvoiceDecisionRequest['route'];
}

function validateAction(value: string): DecisionAction {
  if (!['PAY', 'DELAY', 'ESCALATE', 'REJECT'].includes(value)) {
    throw new BadRequestException('modelAction is invalid');
  }
  return value as DecisionAction;
}

function validateFutureTimestamp(value: string): string {
  const text = requireText(value, 'expiresAt');
  const time = Date.parse(text);
  if (!Number.isFinite(time)) {
    throw new BadRequestException('expiresAt must be an ISO timestamp');
  }
  if (time <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  return new Date(time).toISOString();
}

function validateOptionalTimestamp(
  value: string | null | undefined,
  name: string,
): string | null {
  if (value === null || value === undefined) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time))
    throw new BadRequestException(`${name} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (text === undefined || text === '') {
    throw new BadRequestException(`${name} is required`);
  }
  return text;
}

function requireUuid(value: string, name: string): string {
  const text = requireText(value, name);
  if (!/^[0-9a-fA-F-]{36}$/.test(text)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return text;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function mapApproval(row: ApprovalRow): DecisionApprovalResponse {
  return {
    id: row.id,
    decisionId: row.decision_id,
    decisionVersion: row.decision_version,
    sourceVersionId: row.source_version_id,
    amountAtomic: row.amount_atomic,
    destinationAddress: row.destination_address,
    contextHash: row.context_hash,
    policySnapshotHash: row.policy_snapshot_hash,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
  };
}

function mapDecision(row: DecisionRow): PaymentDecisionResponse {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    decisionVersion: row.decision_version,
    paymentMode: row.payment_mode,
    modelAction: row.model_action,
    derivedAction: row.derived_action,
    liquidityRoute: row.liquidity_route,
    routeEnvironment: row.route_environment,
    routeChainId: row.route_chain_id,
    routeAssetSymbol: row.route_asset_symbol,
    amountAtomic: row.amount_atomic,
    destinationAddress: row.destination_address,
    evidenceBundleHash: row.evidence_bundle_hash,
    policySnapshotHash: row.policy_snapshot_hash,
    contextHash: row.context_hash,
    decisionHash: row.decision_hash,
    checks: row.checks,
    proposedExecutionAt: row.proposed_execution_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
  };
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new NotFoundException(`${name} not found`);
  }
  return row;
}
