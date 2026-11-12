"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createAccountingConnector,
  disconnectAccountingConnector,
  listAccountingConnectors,
  listAccountingRecords,
  requestAccountingSync,
  testAccountingConnector,
  type AccountingConnectorResponse,
  type AccountingProvider,
  type AccountingRecordResponse,
} from "@/lib/api";

export function AccountingIntegrations({ token, organizationId, canManage }: { token: string; organizationId: string; canManage: boolean }) {
  const [connectors, setConnectors] = useState<AccountingConnectorResponse[]>([]);
  const [records, setRecords] = useState<Record<string, AccountingRecordResponse[]>>({});
  const [provider, setProvider] = useState<AccountingProvider>("ERPNEXT");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [databaseName, setDatabaseName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listAccountingConnectors(token, organizationId)
      .then((items) => { if (!cancelled) setConnectors(items); })
      .catch((error: unknown) => { if (!cancelled) toast.error(error instanceof Error ? error.message : "Unable to load integrations"); });
    return () => { cancelled = true; };
  }, [organizationId, token]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const connector = await createAccountingConnector(token, organizationId, {
        provider,
        label,
        baseUrl,
        databaseName: provider === "ODOO" ? databaseName : undefined,
        credentials: { apiKey, apiSecret: provider === "ERPNEXT" ? apiSecret : undefined },
      });
      setConnectors((current) => [...current, connector]);
      setLabel(""); setBaseUrl(""); setDatabaseName(""); setApiKey(""); setApiSecret("");
      toast.success("Integration saved and first sync queued");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save integration");
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    setPending(true);
    try {
      setConnectors(await listAccountingConnectors(token, organizationId));
      toast.success("Integration status refreshed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh integrations");
    } finally {
      setPending(false);
    }
  }

  async function sync(connector: AccountingConnectorResponse) {
    setPending(true);
    try {
      await requestAccountingSync(token, organizationId, connector.id);
      toast.success(`${connector.label} sync queued`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to queue sync");
    } finally {
      setPending(false);
    }
  }

  async function test(connector: AccountingConnectorResponse) {
    setPending(true);
    try {
      const result = await testAccountingConnector(token, organizationId, connector.id);
      const total = Object.values(result.recordsByType).reduce((sum, count) => sum + count, 0);
      toast.success(`${connector.label} connected · ${total} records readable`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Connection test failed"); }
    finally { setPending(false); }
  }

  function confirmDisconnect(connector: AccountingConnectorResponse) {
    toast(`Disconnect ${connector.label}?`, { description: "Future syncs and writebacks will stop.", action: { label: "Disconnect", onClick: () => void disconnect(connector) } });
  }

  async function disconnect(connector: AccountingConnectorResponse) {
    setPending(true);
    try {
      await disconnectAccountingConnector(token, organizationId, connector.id);
      setConnectors((current) => current.map((item) => item.id === connector.id ? { ...item, status: "DISABLED", lastError: null } : item));
      toast.success(`${connector.label} disconnected`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to disconnect integration"); }
    finally { setPending(false); }
  }

  async function inspect(connector: AccountingConnectorResponse) {
    try {
      setRecords((current) => ({ ...current, [connector.id]: [] }));
      const items = await listAccountingRecords(token, organizationId, connector.id);
      setRecords((current) => ({ ...current, [connector.id]: items }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load imported records");
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="integrations-title">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Workspace settings</p><h3 id="integrations-title" className="mt-2 text-3xl font-semibold">Accounting integrations</h3><p className="mt-2 max-w-2xl text-sm text-slate-600">Connect Odoo 19 or ERPNext with dedicated least-privilege API credentials. Secrets are encrypted and never returned.</p></div>
        <button type="button" onClick={() => void refresh()} disabled={pending} className="btn-secondary">Refresh status</button>
      </div>

      {canManage ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]"><form onSubmit={create} className="grid gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:grid-cols-2">
        <div className="md:col-span-2"><h4 className="font-semibold">Add a connection</h4><p className="mt-1 text-sm text-slate-500">Credentials are encrypted when saved and never displayed again.</p></div>
        <Select label="Provider" value={provider} onChange={(value) => setProvider(value as AccountingProvider)} options={[{ value: "ERPNEXT", label: "ERPNext" }, { value: "ODOO", label: "Odoo 19" }]} />
        <Input label="Connection label" value={label} onChange={setLabel} placeholder="Finance production" />
        <Input label="Base URL" type="url" value={baseUrl} onChange={setBaseUrl} placeholder={provider === "ODOO" ? "https://company.odoo.com" : "https://erp.company.com"} />
        {provider === "ODOO" ? <Input label="Odoo database" value={databaseName} onChange={setDatabaseName} /> : null}
        <Input label="API key" type="password" value={apiKey} onChange={setApiKey} autoComplete="new-password" />
        {provider === "ERPNEXT" ? <Input label="API secret" type="password" value={apiSecret} onChange={setApiSecret} autoComplete="new-password" /> : null}
        <button disabled={pending} className="btn md:col-span-2">Save and start first sync</button>
      </form><aside className="rounded-3xl bg-slate-950 p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">{provider === "ODOO" ? "Odoo 19" : "ERPNext"}</p><h4 className="mt-3 text-xl font-semibold">Bring purchasing evidence into context</h4><p className="mt-3 text-sm leading-6 text-slate-300">{provider === "ODOO" ? "OPES reads vendors, purchase orders, receipts and vendor bills through JSON-2." : "OPES reads suppliers, purchase orders, purchase receipts and purchase invoices through the Frappe REST API."}</p><ul className="mt-5 space-y-3 text-sm text-slate-300"><li>✓ Tenant-scoped records</li><li>✓ Sync status and failures</li><li>✓ No credentials in browser storage</li></ul></aside></div> : <p className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">Only workspace owners and admins can add or sync integrations.</p>}

      <div className="rounded-3xl border border-blue-100 bg-blue-50 p-5"><h4 className="font-semibold text-blue-950">Standard evidence mapping</h4><p className="mt-2 text-sm leading-6 text-blue-900">OPES maps each provider into vendor, purchase order, purchase receipt, and vendor bill records while preserving provider IDs for reconciliation.</p></div>
      <div className="rounded-3xl border border-dashed border-slate-300 p-5"><h4 className="font-semibold">Gmail connector</h4><p className="mt-2 text-sm text-slate-600">Direct Gmail OAuth is planned after Google restricted-scope verification. Workspace inbox forwarding remains the supported Gmail intake path today.</p></div>
      <div className="grid gap-4"><div><h4 className="text-lg font-semibold">Connected systems</h4><p className="mt-1 text-sm text-slate-500">Test credentials, sync on demand, inspect mapped records, or disconnect access.</p></div>
        {connectors.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">No accounting integration configured.</p> : null}
        {connectors.map((connector) => {
          const imported = records[connector.id];
          return <article key={connector.id} className="rounded-2xl border border-slate-200 p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><div className="flex items-center gap-2"><h4 className="font-semibold">{connector.label}</h4><Status value={!connector.lastSyncedAt && connector.status === "ACTIVE" ? "SYNC_QUEUED" : connector.status} /></div><p className="mt-1 break-all text-sm text-slate-600">{connector.provider === "ODOO" ? "Odoo 19" : "ERPNext"} · {connector.baseUrl}</p><p className="mt-1 text-xs text-slate-500">Last synced: {connector.lastSyncedAt ? new Date(connector.lastSyncedAt).toLocaleString() : "Not yet"}</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={!canManage || pending || connector.status === "DISABLED"} onClick={() => void test(connector)} className="btn-secondary">Test</button><button type="button" disabled={!canManage || pending || connector.status === "DISABLED"} onClick={() => void sync(connector)} className="btn-secondary">Sync now</button><button type="button" onClick={() => void inspect(connector)} className="btn-secondary">Mapped records</button><button type="button" disabled={!canManage || pending || connector.status === "DISABLED"} onClick={() => confirmDisconnect(connector)} className="btn-secondary text-red-700">Disconnect</button></div></div>
            {connector.lastError ? <p className="mt-3 text-sm text-red-700">{connector.lastError}</p> : null}
            {imported ? <p className="mt-3 text-sm text-slate-600">{imported.length} current records · {summarize(imported)}</p> : null}
          </article>;
        })}
      </div>
    </section>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, autoComplete }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; autoComplete?: string }) {
  return <label className="text-sm font-medium text-slate-700">{label}<input required type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete={autoComplete} className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500" /></label>;
}
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) { return <label className="text-sm font-medium text-slate-700">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 bg-white px-4">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>; }
function Status({ value }: { value: string }) { const tone = value === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : value === "FAILED" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"; return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{value.replaceAll("_", " ").toLowerCase()}</span>; }
function summarize(records: AccountingRecordResponse[]) { const counts = new Map<string, number>(); for (const record of records) counts.set(record.recordType, (counts.get(record.recordType) ?? 0) + 1); return [...counts].map(([type, count]) => `${count} ${type.replaceAll("_", " ").toLowerCase()}`).join(" · ") || "No imported records"; }
