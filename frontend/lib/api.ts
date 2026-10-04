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
