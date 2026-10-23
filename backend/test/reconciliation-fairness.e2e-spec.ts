import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/core/database/database.service';
import { TreasuryReconciliationService } from '../src/modules/treasury/treasury-reconciliation.service';

it('advances beyond the first 25 workspaces even when their providers are unavailable', async () => {
  const db = new DatabaseService(),
    ids = Array.from({ length: 26 }, () => randomUUID());
  try {
    for (const id of ids)
      await db.withOrganizationScope(id, async (sql) => {
        await sql.query(
          `INSERT INTO opes.organizations(id,slug,display_name) VALUES($1,$2,'Fairness test')`,
          [id, id],
        );
        await sql.query(
          `INSERT INTO opes.tenant_resource_bindings(organization_id,environment,chain_id,provider,resource_type,resource_id,address,status) VALUES($1,'arc-testnet',5042002,'arc','business_policy_vault_contract',$3,$2,'ACTIVE')`,
          [id, `0x${id.replaceAll('-', '').padStart(40, '0')}`, id],
        );
      });
    const service = new TreasuryReconciliationService(db);
    const scanned = new Set<string>();
    jest
      .spyOn(
        service as unknown as { scanTenant(id: string): Promise<void> },
        'scanTenant',
      )
      .mockImplementation((id) => {
        scanned.add(id);
        return Promise.reject(new Error('simulated provider outage'));
      });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const total = await db.withWorker((sql) =>
      sql.query<{ count: string }>(
        `SELECT count(DISTINCT (organization_id,environment,chain_id))::text AS count FROM opes.tenant_resource_bindings WHERE status='ACTIVE' AND address IS NOT NULL`,
      ),
    );
    for (
      let batch = 0;
      batch <= Math.ceil(Number(total.rows[0].count) / 25);
      batch++
    )
      await service.process();
    expect(ids.every((id) => scanned.has(id))).toBe(true);
  } finally {
    jest.restoreAllMocks();
    for (const id of ids)
      await db.withOrganizationScope(id, async (sql) => {
        await sql.query(
          'DELETE FROM opes.treasury_balance_reads WHERE organization_id=$1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.tenant_resource_bindings WHERE organization_id=$1',
          [id],
        );
        await sql.query('DELETE FROM opes.organizations WHERE id=$1', [id]);
      });
    await db.onModuleDestroy();
  }
});
