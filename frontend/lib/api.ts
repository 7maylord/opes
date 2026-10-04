const apiBaseUrl = (
  process.env.NEXT_PUBLIC_OPES_API_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
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
  organization: {
    id: string;
    slug: string;
    displayName: string;
    lifecycleStatus: string;
  };
  sessionToken: string;
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

export async function onboardOrganization(input: {
  email: string;
  displayName: string;
  organizationName: string;
  organizationSlug?: string;
}) {
  return publicRequest<AuthSessionResult>("/onboarding", {
    method: "POST",
    headers: idempotencyHeaders(),
    body: JSON.stringify(input),
  });
}

export async function acceptInvitation(token: string) {
  return publicRequest<AuthSessionResult>(
    `/organization-invitations/${encodeURIComponent(token)}/accept`,
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

async function publicRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return fetchJson<T>(path, init);
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
}

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
  vaultAddress: string;
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

export async function recordEvidenceDocument(
  token: string,
  organizationId: string,
  input: {
    documentType: "INVOICE" | "CONTRACT" | "RECEIPT" | "MILESTONE" | "OTHER";
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256Hex: string;
    storageKey: string;
    metadata?: unknown;
  },
) {
  return request<EvidenceDocumentResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/evidence-documents`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function recordDocumentExtraction(
  token: string,
  organizationId: string,
  documentId: string,
  input: {
    schemaName: string;
    schemaVersion: string;
    modelProvider: string;
    modelName: string;
    sourceSha256Hex: string;
    output: unknown;
  },
) {
  return request<DocumentExtractionResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/evidence-documents/${encodeURIComponent(documentId)}/extractions`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function verifyInvoice(
  token: string,
  organizationId: string,
  input: {
    vendorId: string;
    vendorAddressId: string;
    evidenceDocumentId: string;
    extractionId?: string;
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

export async function cancelSubscription(
  token: string,
  organizationId: string,
  subscriptionId: string,
) {
  return request<{ id: string; status: string }>(
    `/organizations/${encodeURIComponent(organizationId)}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    token,
    { method: "POST" },
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
  return request<EscrowMilestoneResponse>(
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
  return request<EscrowMilestoneResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/escrow-milestones/${encodeURIComponent(milestoneId)}/dispute`,
    token,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}
