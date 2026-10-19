import type {
  WorkspaceDetail,
  WorkspaceKind,
  WorkspacePage,
} from "./workspace-api.generated";

const apiBaseUrl = (
  process.env.NEXT_PUBLIC_OPES_API_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  ownerWalletAddress: string | null;
}

export interface UserOrganization {
  id: string;
  slug: string;
  displayName: string;
  lifecycleStatus: string;
  membershipId: string;
  role: MembershipRole;
  agentId: string;
  agentLifecycleStatus: string;
}

export type MembershipRole =
  | "OWNER"
  | "ADMIN"
  | "APPROVER"
  | "OPERATOR_VIEWER"
  | "AUDITOR";

export interface OrganizationMember {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  status: string;
  createdAt: string;
}

export interface InvitedOrganizationMember extends OrganizationMember {
  invitationToken: string;
}

export interface AuthSessionResult {
  user: SessionUser;
  sessionToken: string;
}

export interface OrganizationAccessResult {
  user: SessionUser;
  organization: {
    id: string;
    slug: string;
    displayName: string;
    lifecycleStatus: string;
  };
}

export interface AgentResourceBinding {
  id: string;
  environment: string;
  chainId: number | null;
  provider: string;
  resourceType: string;
  resourceId: string;
  address: string | null;
  status: string;
  metadata: unknown;
}

export interface VerifiedFactoryManifest {
  environment: string;
  chainId: number;
  factoryAddress: string;
  vaultDeployerAddress: string;
  verification: string;
  explorerUrl: string;
  checkedAt: string;
}

export interface BusinessAgentDetail {
  id: string;
  lifecycleStatus: string;
  arcTestnetFactory: VerifiedFactoryManifest;
  resourceBindings: AgentResourceBinding[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export async function exchangePrivySession(accessToken: string) {
  return request<AuthSessionResult>("/auth/privy/session", accessToken, {
    method: "POST",
  });
}

export async function onboardOrganization(token: string, input: {
  organizationName: string;
  organizationSlug?: string;
}) {
  return request<OrganizationAccessResult>("/onboarding", token, {
    method: "POST",
    headers: idempotencyHeaders(),
    body: JSON.stringify(input),
  });
}

export async function acceptInvitation(sessionToken: string, invitationToken: string) {
  return request<OrganizationAccessResult>(
    `/organization-invitations/${encodeURIComponent(invitationToken)}/accept`,
    sessionToken,
    { method: "POST" },
  );
}

export async function getSession(token: string) {
  return request<SessionUser>("/session", token);
}

export async function listOrganizations(token: string) {
  return request<UserOrganization[]>("/organizations", token);
}

export async function getAgent(token: string, organizationId: string) {
  return request<BusinessAgentDetail>(
    `/organizations/${encodeURIComponent(organizationId)}/agent`,
    token,
  );
}

export async function requestArcTestnetProvisioning(
  token: string,
  organizationId: string,
) {
  return request<AgentResourceBinding>(
    `/organizations/${encodeURIComponent(organizationId)}/agent/provisioning/arc-testnet`,
    token,
    { method: "POST" },
  );
}

export async function listOrganizationMembers(
  token: string,
  organizationId: string,
) {
  return request<OrganizationMember[]>(
    `/organizations/${encodeURIComponent(organizationId)}/members`,
    token,
  );
}

export async function inviteOrganizationMember(
  token: string,
  organizationId: string,
  input: { email: string; displayName?: string; role: MembershipRole },
) {
  return request<InvitedOrganizationMember>(
    `/organizations/${encodeURIComponent(organizationId)}/members`,
    token,
    {
      method: "POST",
      headers: idempotencyHeaders(),
      body: JSON.stringify(input),
    },
  );
}

export async function revokeSession(token: string) {
  await request<{ revoked: true }>("/session", token, { method: "DELETE" });
}

export interface EmailInboxResponse {
  id: string;
  address: string;
  status: string;
}

export interface InboundEmailEventResponse {
  id: string;
  providerEmailId: string;
  senderAddress: string;
  subject: string | null;
  previewText: string | null;
  status: string;
  quarantineReason: string | null;
  failureReason: string | null;
  documentCount: number;
  receivedAt: string;
  processedAt: string | null;
  documents: Array<{ id: string; filename: string; status: string }>;
}

export function getEmailInbox(token: string, organizationId: string) {
  return request<EmailInboxResponse | null>(
    `/organizations/${encodeURIComponent(organizationId)}/email-inbox`,
    token,
  );
}

export function configureEmailInbox(token: string, organizationId: string, address: string) {
  return request<EmailInboxResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/email-inbox`,
    token,
    { method: "PUT", body: JSON.stringify({ address }) },
  );
}

export function listInboundEmailEvents(token: string, organizationId: string) {
  return request<InboundEmailEventResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/email-inbox/events`,
    token,
  );
}

export type NotificationView = "overview" | "setup" | "invoices" | "agreements" | "calendar" | "approvals" | "treasury" | "inbox" | "integrations" | "team" | "notifications" | "exceptions";
export interface WorkspaceNotificationResponse {
  id: string;
  type: string;
  priority: "INFO" | "ACTION" | "WARNING" | "SUCCESS";
  title: string;
  body: string;
  subjectType: string;
  subjectId: string | null;
  actionView: NotificationView | null;
  metadata: unknown;
  readAt: string | null;
  createdAt: string;
}
export function listNotifications(token: string, organizationId: string) {
  return request<WorkspaceNotificationResponse[]>(`/organizations/${encodeURIComponent(organizationId)}/notifications`, token);
}
export function getUnreadNotificationCount(token: string, organizationId: string) {
  return request<{ unread: number }>(`/organizations/${encodeURIComponent(organizationId)}/notifications/unread-count`, token);
}
export function markNotificationRead(token: string, organizationId: string, notificationId: string) {
  return request<{ read: true }>(`/organizations/${encodeURIComponent(organizationId)}/notifications/${encodeURIComponent(notificationId)}/read`, token, { method: "POST" });
}
export function markAllNotificationsRead(token: string, organizationId: string) {
  return request<{ read: true }>(`/organizations/${encodeURIComponent(organizationId)}/notifications/read-all`, token, { method: "POST" });
}

export interface OperationalExceptionResponse {
  id: string;
  category: "PAYMENT" | "LIQUIDITY" | "AGREEMENT" | "TREASURY" | "INTEGRATION" | "INBOX" | "PROVISIONING" | "SYSTEM";
  severity: "WARNING" | "CRITICAL";
  status: string;
  title: string;
  reason: string;
  recommendation: string;
  recoveryMode: "USER_ACTION" | "AUTO_RECOVERING" | "PLATFORM_ACTION";
  actionView: NotificationView;
  actionLabel: string;
  subjectType: string;
  subjectId: string;
  relatedRecordId: string | null;
  updatedAt: string;
}

export interface ExceptionCenterResponse {
  items: OperationalExceptionResponse[];
  summary: {
    total: number;
    critical: number;
    userAction: number;
    autoRecovering: number;
  };
}

export function listOperationalExceptions(token: string, organizationId: string) {
  return request<ExceptionCenterResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/exceptions`,
    token,
  );
}

export interface PaymentCalendarItemResponse {
  id: string;
  kind: "INVOICE" | "SUBSCRIPTION" | "MILESTONE";
  title: string;
  counterparty: string;
  amountAtomic: string;
  assetSymbol: string;
  scheduledFor: string | null;
  status: string;
  explanation: string;
  actionView: "invoices" | "agreements";
  relatedRecordId: string;
  affectsOperatingBalance: boolean;
  projectedOperatingAvailableAtomic: string | null;
}

export interface PaymentCalendarResponse {
  from: string;
  to: string;
  snapshotStatus: string;
  startingOperatingAvailableAtomic: string;
  projectedOperatingAvailableAtomic: string;
  scheduledOperatingSpendAtomic: string;
  uncoveredAtomic: string;
  items: PaymentCalendarItemResponse[];
}

export function getPaymentCalendar(token: string, organizationId: string) {
  return request<PaymentCalendarResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/payment-calendar`,
    token,
  );
}

export interface ApprovalInboxResponse {
  items: Array<{ id: string; kind: "PAYMENT_LIMIT" | "PAYOUT_ADDRESS" | "MILESTONE"; title: string; reason: string; amountAtomic: string | null; assetSymbol: string | null; expiresAt: string | null; requestedAt: string; requiredRoles: string[]; canAct: boolean; status: string; actionView: "invoices" | "agreements"; relatedRecordId: string }>;
  summary: { total: number; actionable: number; expiring: number };
}
export function getApprovalInbox(token: string, organizationId: string) {
  return request<ApprovalInboxResponse>(`/organizations/${encodeURIComponent(organizationId)}/approvals`, token);
}

export type AccountingProvider = "ODOO" | "ERPNEXT";

export interface AccountingConnectorResponse {
  id: string;
  provider: AccountingProvider;
  label: string;
  baseUrl: string;
  databaseName: string | null;
  status: string;
  syncCursor: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface AccountingRecordResponse {
  id: string;
  connectorId: string;
  recordType: "VENDOR" | "PURCHASE_ORDER" | "PURCHASE_RECEIPT" | "VENDOR_BILL";
  externalId: string;
  providerUpdatedAt: string | null;
  normalizedData: unknown;
  fetchedAt: string;
}

export function listAccountingConnectors(token: string, organizationId: string) {
  return request<AccountingConnectorResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/accounting-connectors`,
    token,
  );
}

export function createAccountingConnector(
  token: string,
  organizationId: string,
  input: {
    provider: AccountingProvider;
    label: string;
    baseUrl: string;
    databaseName?: string;
    credentials: { apiKey: string; apiSecret?: string };
  },
) {
  return request<AccountingConnectorResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/accounting-connectors`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function requestAccountingSync(token: string, organizationId: string, connectorId: string) {
  return request<{ queued: true }>(
    `/organizations/${encodeURIComponent(organizationId)}/accounting-connectors/${encodeURIComponent(connectorId)}/sync`,
    token,
    { method: "POST" },
  );
}

export function listAccountingRecords(token: string, organizationId: string, connectorId: string) {
  return request<AccountingRecordResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/accounting-connectors/${encodeURIComponent(connectorId)}/records`,
    token,
  );
}

async function request<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  return fetchJson<T>(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }

  return (await response.json()) as T;
}

function idempotencyHeaders() {
  return { "Idempotency-Key": crypto.randomUUID() };
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") {
      return body.message;
    }
  } catch {}

  return `Request failed with status ${response.status}`;
}

export interface VendorResponse {
  id: string;
  displayName: string;
  status: string;
  version: number;
  metadata: unknown;
}

export interface VendorAddressResponse {
  id: string;
  vendorId: string;
  environment: string;
  chainId: number;
  assetSymbol: string;
  assetAddress: string;
  payoutAddress: string;
  status: string;
  version: number;
  replacesAddressId: string | null;
}

export interface VendorPortalAccessResponse {
  id: string;
  vendorId: string;
  contactEmail: string;
  expiresAt: string;
  token: string;
}

export interface VendorPortalSubmission {
  id: string;
  documentId: string;
  rootSubmissionId: string;
  version: number;
  status: string;
  vendorNote: string | null;
  documentType: string;
  filename: string;
  createdAt: string;
  submittedAt: string | null;
}

export async function createVendorPortalAccess(token: string, organizationId: string, vendorId: string, contactEmail: string) {
  return request<VendorPortalAccessResponse>(`/organizations/${encodeURIComponent(organizationId)}/vendors/${encodeURIComponent(vendorId)}/portal-access`, token, {
    method: "POST",
    body: JSON.stringify({ contactEmail, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }),
  });
}

export async function getVendorPortal(token: string) {
  return fetchJson<{ organizationName: string; vendorName: string; contactEmail: string; expiresAt: string }>(`/vendor-portal/${encodeURIComponent(token)}`, {});
}

export async function listVendorPortalSubmissions(token: string) {
  return fetchJson<VendorPortalSubmission[]>(`/vendor-portal/${encodeURIComponent(token)}/submissions`, {});
}

export async function submitVendorPortalDocument(token: string, file: File, vendorNote: string, replacesSubmissionId?: string) {
  if (!file.type) throw new Error("Document file type is missing");
  const bytes = await file.arrayBuffer();
  const sha256Hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((value) => value.toString(16).padStart(2, "0")).join("");
  const initiated = await fetchJson<{ submission: VendorPortalSubmission; upload: { document: EvidenceDocumentResponse; uploadUrl: string; uploadHeaders: Record<string, string> } }>(`/vendor-portal/${encodeURIComponent(token)}/submissions/uploads`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ documentType: "INVOICE", filename: file.name, contentType: file.type, sizeBytes: file.size, sha256Hex, vendorNote, replacesSubmissionId }),
  });
  if (initiated.upload.document.status !== "VERIFIED") {
    const uploaded = await fetch(initiated.upload.uploadUrl, { method: "PUT", headers: initiated.upload.uploadHeaders, body: file });
    if (!uploaded.ok) throw new Error(`Document upload failed (${uploaded.status})`);
  }
  return fetchJson<VendorPortalSubmission>(`/vendor-portal/${encodeURIComponent(token)}/submissions/${encodeURIComponent(initiated.submission.id)}/finalize`, { method: "POST" });
}

export interface EvidenceDocumentResponse {
  id: string;
  documentType: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex: string;
  storageKey: string;
  status: string;
  metadata: unknown;
}

export interface DocumentExtractionResponse {
  id: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  modelProvider: string;
  modelName: string;
  sourceSha256Hex: string;
  output: unknown;
  status: string;
  claimVersionId: string;
  reviewStatus: string;
}

export interface DocumentClaimResponse {
  id: string;
  documentId: string;
  extractionId: string;
  version: number;
  claims: unknown;
  provenance: unknown;
  status: string;
}

export interface PayableObligationResponse {
  id: string;
  versionId: string;
  version: number;
  vendorId: string;
  vendorAddressId: string;
  evidenceDocumentId: string;
  extractionId: string | null;
  invoiceNumber: string;
  currency: string;
  amountAtomic: string;
  amountDecimals: number;
  obligationKey: string;
  contentHash: string;
  status: string;
}

export interface ProcurementEvidenceResponse {
  sourceId: string;
  versionId: string;
  version: number;
  evidenceType: string;
  status: string;
  totalAmountAtomic: string;
}

export interface PayableMatchResponse {
  id: string;
  invoiceVersionId: string;
  status: "PASS" | "BLOCKED";
  reasons: string[];
}

export interface PaymentDecisionResponse {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceVersionId: string;
  decisionVersion: number;
  paymentMode: string;
  modelAction: string;
  derivedAction: string;
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
  checks: Array<{ code: string; status: string; message: string }>;
  proposedExecutionAt: string | null;
  expiresAt: string;
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
  ownerAction: ChainActionResponse;
}

export async function prepareTreasuryAction(token:string,organizationId:string,input:Record<string,unknown>){return request<ChainActionResponse>(`/organizations/${encodeURIComponent(organizationId)}/treasury-actions`,token,{method:'POST',body:JSON.stringify(input)});}

export interface PaymentExecutionResponse {
  id: string;
  decisionId: string;
  approvalId: string;
  sourceVersionId: string;
  decisionHash: string;
  idempotencyKey: string;
  contextHash: string;
  amountAtomic: string;
  destinationAddress: string;
  routeEnvironment: string;
  routeChainId: number;
  routeAssetSymbol: string;
  vaultAddress: string | null;
  executionMode: "DIRECT_VAULT" | "CROSSCHAIN_WALLET";
  liquidityActionId: string | null;
  tokenAddress: string | null;
  maxSourceDebitAtomic: string | null;
  refundAddress: string | null;
  status: string;
  failureReason: string | null;
  transactionHash?: string | null;
}

export async function createVendor(
  token: string,
  organizationId: string,
  input: { displayName: string; metadata?: unknown },
) {
  return request<VendorResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/vendors`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function addVendorAddress(
  token: string,
  organizationId: string,
  vendorId: string,
  input: {
    environment: string;
    chainId: number;
    assetSymbol: string;
    assetAddress: string;
    payoutAddress: string;
    metadata?: unknown;
  },
) {
  return request<VendorAddressResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/vendors/${encodeURIComponent(vendorId)}/addresses`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function verifyVendorAddress(
  token: string,
  organizationId: string,
  addressId: string,
) {
  return request<VendorAddressResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/vendor-addresses/${encodeURIComponent(addressId)}/verify`,
    token,
    { method: "POST" },
  );
}

export async function uploadEvidenceDocument(
  token: string,
  organizationId: string,
  input: {
    documentType: "INVOICE" | "CONTRACT" | "RECEIPT" | "MILESTONE" | "OTHER";
    file: File;
    metadata?: unknown;
  },
) {
  if (!input.file.type) throw new Error("Invoice file type is missing");
  const sha256Hex = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await input.file.arrayBuffer())),
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const initiated = await request<{
    document: EvidenceDocumentResponse;
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
  }>(
    `/organizations/${encodeURIComponent(organizationId)}/evidence-documents/uploads`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        documentType: input.documentType,
        filename: input.file.name,
        contentType: input.file.type,
        sizeBytes: input.file.size,
        sha256Hex,
        sourceEventId: sha256Hex,
        metadata: input.metadata,
      }),
    },
  );
  if (initiated.document.status === "VERIFIED") return initiated.document;
  const uploaded = await fetch(initiated.uploadUrl, {
    method: "PUT",
    headers: initiated.uploadHeaders,
    body: input.file,
  });
  if (!uploaded.ok) throw new Error(`Document upload failed (${uploaded.status})`);
  return request<EvidenceDocumentResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/evidence-documents/${encodeURIComponent(initiated.document.id)}/finalize`,
    token,
    { method: "POST" },
  );
}

export async function extractInvoiceDocument(
  token: string,
  organizationId: string,
  documentId: string,
) {
  return request<DocumentExtractionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/evidence-documents/${encodeURIComponent(documentId)}/extract`,
    token,
    { method: "POST" },
  );
}

export async function confirmDocumentClaims(
  token: string,
  organizationId: string,
  documentId: string,
  extractionId: string,
  claims: unknown,
) {
  return request<DocumentClaimResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/evidence-documents/${encodeURIComponent(documentId)}/extractions/${encodeURIComponent(extractionId)}/confirm`,
    token,
    { method: "POST", body: JSON.stringify({ claims }) },
  );
}

export async function verifyInvoice(
  token: string,
  organizationId: string,
  input: {
    vendorId: string;
    vendorAddressId: string;
    evidenceDocumentId: string;
    extractionId: string;
    invoiceNumber: string;
    currency: "USDC";
    amount: string;
    lineItems: Array<{ description: string; amount: string }>;
  },
) {
  return request<PayableObligationResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/invoices/verify`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function recordProcurementEvidence(
  token: string,
  organizationId: string,
  input: {
    evidenceType: "PURCHASE_ORDER" | "PURCHASE_RECEIPT";
    vendorId: string;
    sourceReference: string;
    currency: "USDC";
    totalAmount: string;
    governingSourceId?: string;
    evidenceDocumentId: string;
    lineItems: Array<{ description: string; quantity: string; amount: string }>;
  },
) {
  return request<ProcurementEvidenceResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/procurement-evidence`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function matchInvoiceEvidence(
  token: string,
  organizationId: string,
  invoiceVersionId: string,
  governingSourceId: string,
  deliverySourceId: string,
) {
  return request<PayableMatchResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/invoices/${encodeURIComponent(invoiceVersionId)}/match`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ governingSourceId, deliverySourceId }),
    },
  );
}

export async function evaluateInvoicePayment(
  token: string,
  organizationId: string,
  input: {
    invoiceVersionId: string;
    modelAction: "PAY" | "DELAY" | "ESCALATE" | "REJECT";
    modelName: string;
    modelRationale: string;
    promptVersion: string;
    route: {
      liquidityRoute: "OPERATING" | "GATEWAY" | "CCTP" | "NONE";
      environment: string;
      chainId: number;
      assetSymbol: string;
    };
    expiresAt: string;
  },
) {
  return request<PaymentDecisionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/decisions/invoice-payment`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function evaluateInvoicePaymentWithAgent(
  token: string,
  organizationId: string,
  input: {
    invoiceVersionId: string;
    route: {
      liquidityRoute: "OPERATING" | "GATEWAY" | "CCTP" | "NONE";
      environment: string;
      chainId: number;
      assetSymbol: string;
    };
    expiresAt: string;
  },
) {
  return request<PaymentDecisionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/decisions/invoice-payment/agent`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function approveDecision(
  token: string,
  organizationId: string,
  decisionId: string,
) {
  return request<DecisionApprovalResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/decisions/${encodeURIComponent(decisionId)}/authorize`,
    token,
    { method: "POST" },
  );
}

export async function overrideDecision(
  token: string,
  organizationId: string,
  decisionId: string,
  input: {
    action: "PAY" | "DELAY" | "REJECT";
    reason: string;
    proposedExecutionAt?: string | null;
  },
) {
  return request<PaymentDecisionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/decisions/${encodeURIComponent(decisionId)}/override`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function executeDecision(
  token: string,
  organizationId: string,
  decisionId: string,
) {
  return request<PaymentExecutionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/decisions/${encodeURIComponent(decisionId)}/execute`,
    token,
    { method: "POST" },
  );
}

export interface SubscriptionResponse {
  id: string;
  versionId: string;
  version: number;
  status: string;
  cadence: string;
  anchorDate: string;
  timezone: string;
  amountAtomic: string;
  ownerActions: ChainActionResponse[];
}

export interface ChainActionResponse {
  id: string;
  actionType: string;
  actor: "OWNER" | "OPERATOR";
  to: string;
  data: string;
  chainId: number;
  status: string;
}

export interface SubscriptionCycleResponse {
  id: string;
  subscriptionId: string;
  subscriptionVersionId: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  dueAt: string;
  amountAtomic: string;
  status: string;
}

export interface EscrowMilestoneResponse {
  id: string;
  agreementId: string;
  milestoneIndex: number;
  title: string;
  amountAtomic: string;
  status: string;
  evidenceDocumentId: string | null;
}

export interface EscrowAgreementResponse {
  id: string;
  status: string;
  totalAmountAtomic: string;
  milestones: EscrowMilestoneResponse[];
  ownerActions: ChainActionResponse[];
}

export async function createSubscription(
  token: string,
  organizationId: string,
  input: {
    vendorId: string;
    vendorAddressId: string;
    cadence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL";
    anchorDate: string;
    timezone: string;
    amount: string;
    termsDocumentId?: string;
  },
) {
  return request<SubscriptionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/subscriptions`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function createSubscriptionCycle(
  token: string,
  organizationId: string,
  subscriptionId: string,
  input: { servicePeriodStart: string },
) {
  return request<SubscriptionCycleResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/subscriptions/${encodeURIComponent(subscriptionId)}/cycles`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function getSubscriptionActions(
  token: string,
  organizationId: string,
  subscriptionId: string,
) {
  return request<ChainActionResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/subscriptions/${encodeURIComponent(subscriptionId)}/actions`,
    token,
  );
}

export async function removeSubscriptionDraft(
  token: string,
  organizationId: string,
  subscriptionId: string,
) {
  return request<{ id: string }>(
    `/organizations/${encodeURIComponent(organizationId)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    token,
    { method: "DELETE" },
  );
}

export async function cancelSubscription(
  token: string,
  organizationId: string,
  subscriptionId: string,
) {
  return request<ChainActionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    token,
    { method: "POST" },
  );
}

export async function changeSubscriptionStatus(token: string, organizationId: string, subscriptionId: string, operation: 'pause' | 'resume') {
  return request<ChainActionResponse>(`/organizations/${encodeURIComponent(organizationId)}/subscriptions/${encodeURIComponent(subscriptionId)}/${operation}`, token, { method: 'POST' });
}

export async function confirmLifecycleAction(
  token: string,
  organizationId: string,
  actionId: string,
  transactionHash: string,
) {
  return request<ChainActionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/lifecycle-actions/${encodeURIComponent(actionId)}/confirm`,
    token,
    { method: "POST", body: JSON.stringify({ transactionHash }) },
  );
}

export async function createEscrowAgreement(
  token: string,
  organizationId: string,
  input: {
    vendorId: string;
    vendorAddressId: string;
    agreementDocumentId?: string;
    totalAmount: string;
    milestones: Array<{ title: string; amount: string }>;
  },
) {
  return request<EscrowAgreementResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-agreements`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function getEscrowAgreementActions(
  token: string,
  organizationId: string,
  agreementId: string,
) {
  return request<ChainActionResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-agreements/${encodeURIComponent(agreementId)}/actions`,
    token,
  );
}

export async function removeEscrowDraft(
  token: string,
  organizationId: string,
  agreementId: string,
) {
  return request<{ id: string }>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-agreements/${encodeURIComponent(agreementId)}`,
    token,
    { method: "DELETE" },
  );
}

export async function submitMilestoneEvidence(
  token: string,
  organizationId: string,
  milestoneId: string,
  evidenceDocumentId: string,
) {
  return request<EscrowMilestoneResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-milestones/${encodeURIComponent(milestoneId)}/submissions`,
    token,
    { method: "POST", body: JSON.stringify({ evidenceDocumentId }) },
  );
}

export async function acceptMilestone(
  token: string,
  organizationId: string,
  milestoneId: string,
) {
  return request<ChainActionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-milestones/${encodeURIComponent(milestoneId)}/accept`,
    token,
    { method: "POST" },
  );
}

export async function disputeMilestone(
  token: string,
  organizationId: string,
  milestoneId: string,
  reason: string,
) {
  return request<ChainActionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-milestones/${encodeURIComponent(milestoneId)}/dispute`,
    token,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

export async function fundEscrow(token:string, organizationId:string, agreementId:string) {
  return request<ChainActionResponse>(`/organizations/${encodeURIComponent(organizationId)}/escrow-agreements/${encodeURIComponent(agreementId)}/fund`, token, { method: 'POST' });
}

export async function cancelEscrow(token:string, organizationId:string, agreementId:string, reason:string) {
  return request<ChainActionResponse>(`/organizations/${encodeURIComponent(organizationId)}/escrow-agreements/${encodeURIComponent(agreementId)}/cancel`, token, { method: 'POST', body: JSON.stringify({ reason }) });
}

export interface LiquidityActionResponse {
  id: string;
  actionType: string;
  idempotencyKey: string;
  provider: string;
  simulated: boolean;
  status: string;
  source: { environment: string; chainId: number; assetSymbol: string };
  destination: { environment: string; chainId: number; assetSymbol: string };
  amountAtomic: string;
  feeAtomic: string;
  quoteExpiresAt: string;
  providerReference: string | null;
  providerPayload: Record<string, unknown>;
  failureReason: string | null;
}

export interface TreasuryPositionResponse {
  assetSymbol: "USDC";
  configured: boolean;
  snapshotStatus: "FRESH" | "STALE" | "FAILED" | "MISSING";
  snapshotObservedAt: string | null;
  authorizationReady: boolean;
  verifiedBalanceAtomic: string;
  restrictedBalanceAtomic: string;
  operatingBalanceAtomic: string;
  reservedAtomic: string;
  committedPayablesAtomic: string;
  approvedUnsettledPaymentAtomic: string;
  plannedIncomingAtomic: string;
  inTransitAtomic: string;
  operatingBufferAtomic: string;
  monthlyBudgetAtomic: string | null;
  monthlyBudgetRemainingAtomic: string | null;
  forecast30DaysAtomic: string;
  forecast90DaysAtomic: string;
  availableLiquidityAtomic: string;
  supportedNetworks: Array<{
    environment: string;
    chainId: number;
    family: string;
    tier: "mainnet" | "testnet";
    usdc: string;
    cctpDomain: number | null;
    cctpContracts: Record<string, string> | null;
    gatewayContracts: Record<string, string> | null;
    gateway: boolean;
    cctpExecutable: boolean;
    gatewayExecutable: boolean;
  }>;
}

export async function configureTreasury(
  token: string,
  organizationId: string,
  input: {
    operatingBufferAtomic: string;
    monthlyBudgetAtomic: string | null;
    maxSnapshotAgeSeconds: number;
  },
) {
  return request<TreasuryPositionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/treasury/settings`,
    token,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export interface LedgerEntryResponse {
  id: string;
  ledgerEventType: string;
  ledgerEventId: string;
  lineNumber: number;
  account: string;
  direction: string;
  assetSymbol: string;
  amountAtomic: string;
  sourceType: string;
  sourceId: string;
  sourceVersionId: string | null;
  counterpartyId: string | null;
  transactionHash: string | null;
}

export async function getTreasuryPosition(token: string, organizationId: string) {
  return request<TreasuryPositionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/treasury/position`,
    token,
  );
}

export async function planLiquidityAction(
  token: string,
  organizationId: string,
  input: {
    actionType: "GATEWAY_TRANSFER" | "CCTP_TRANSFER";
    idempotencyKey: string;
    source: { environment: string; chainId: number; assetSymbol: string };
    destination: { environment: string; chainId: number; assetSymbol: string };
    amountAtomic: string;
    quoteExpiresAt: string;
  },
) {
  return request<LiquidityActionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/liquidity-actions`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function projectInvoiceAccrual(
  token: string,
  organizationId: string,
  invoiceVersionId: string,
) {
  return request<LedgerEntryResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/ledger/invoice-versions/${encodeURIComponent(invoiceVersionId)}/accrue`,
    token,
    { method: "POST" },
  );
}

export async function projectPaymentSettlement(
  token: string,
  organizationId: string,
  executionId: string,
) {
  return request<LedgerEntryResponse[]>(
    `/organizations/${encodeURIComponent(organizationId)}/ledger/payment-executions/${encodeURIComponent(executionId)}/settle`,
    token,
    { method: "POST" },
  );
}

export async function listWorkspaceRecords(
  token: string,
  organizationId: string,
  kind: WorkspaceKind,
  filters: { cursor?: string; status?: string; search?: string; limit?: number } = {},
) {
  const query = new URLSearchParams();
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.status) query.set("status", filters.status);
  if (filters.search) query.set("search", filters.search);
  if (filters.limit) query.set("limit", String(filters.limit));
  const suffix = query.size === 0 ? "" : `?${query}`;
  return request<WorkspacePage>(
    `/organizations/${encodeURIComponent(organizationId)}/workspace/${kind}${suffix}`,
    token,
  );
}

export async function getWorkspaceRecord(
  token: string,
  organizationId: string,
  kind: WorkspaceKind,
  recordId: string,
) {
  return request<WorkspaceDetail>(
    `/organizations/${encodeURIComponent(organizationId)}/workspace/${kind}/${encodeURIComponent(recordId)}`,
    token,
  );
}
