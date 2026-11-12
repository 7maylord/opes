export type MembershipRole =
  'OWNER' | 'ADMIN' | 'APPROVER' | 'OPERATOR_VIEWER' | 'AUDITOR';

export interface TenantContext {
  organizationId: string;
  userId: string;
  membershipId: string;
  role: MembershipRole;
  agentId: string;
  requestId: string;
}

export function assertTenantContext(context: TenantContext): void {
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`TenantContext.${key} is required`);
    }
  }
}
