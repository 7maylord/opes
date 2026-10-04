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
  role: string;
  agentId: string;
  agentLifecycleStatus: string;
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

export async function getSession(token: string) {
  return request<SessionUser>("/session", token);
}

export async function listOrganizations(token: string) {
  return request<UserOrganization[]>("/organizations", token);
}

export async function revokeSession(token: string) {
  await request<{ revoked: true }>("/session", token, { method: "DELETE" });
}

async function request<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }

  return (await response.json()) as T;
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
