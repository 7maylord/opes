"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  getTreasuryPosition,
  listWorkspaceRecords,
  planLiquidityAction,
  projectInvoiceAccrual,
  projectPaymentSettlement,
  type LedgerEntryResponse,
  type LiquidityActionResponse,
  type TreasuryPositionResponse,
} from "@/lib/api";
import { formatAtomic } from "@/lib/money";
import type { WorkspaceRecord } from "@/lib/workspace-api.generated";

export function TreasuryAuditViews({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const [position, setPosition] = useState<TreasuryPositionResponse | null>(null);
  const [liquidity, setLiquidity] = useState<LiquidityActionResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerEntryResponse[]>([]);
  const [invoiceVersionId, setInvoiceVersionId] = useState("");
  const [executionId, setExecutionId] = useState("");
  const [amountAtomic, setAmountAtomic] = useState("1000000");
  const [actionType, setActionType] = useState<"GATEWAY_TRANSFER" | "CCTP_TRANSFER">("GATEWAY_TRANSFER");
  const [destination, setDestination] = useState("base-sepolia|84532|USDC");
  const [invoices, setInvoices] = useState<WorkspaceRecord[]>([]);
  const [executions, setExecutions] = useState<WorkspaceRecord[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getTreasuryPosition(token, organizationId),
      listWorkspaceRecords(token, organizationId, "invoice", { limit: 50 }),
      listWorkspaceRecords(token, organizationId, "execution", { limit: 50 }),
    ]).then(([nextPosition, invoicePage, executionPage]) => {
      if (cancelled) return;
      setPosition(nextPosition);
      setInvoices(invoicePage.items);
      setExecutions(executionPage.items);
      setInvoiceVersionId(invoicePage.items[0]?.id ?? "");
      setExecutionId(executionPage.items[0]?.id ?? "");
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load treasury options");
    });
    return () => { cancelled = true; };
  }, [organizationId, token]);

  const routeOptions = useMemo(() => {
    const networks = position?.supportedNetworks ?? [];
    return networks.filter((network) => {
      if (network.tier !== "testnet" || network.family === "arc") return false;
      return actionType === "GATEWAY_TRANSFER"
        ? network.family === "base" && network.gateway
        : network.cctpContracts !== null;
    });
  }, [actionType, position]);

  async function refreshPosition() {
    await run("Treasury position refreshed", async () => {
      setPosition(await getTreasuryPosition(token, organizationId));
    });
  }

  async function submitLiquidity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Liquidity action planned", async () => {
      const [environment, chainId, assetSymbol] = destination.split("|");
      setLiquidity(
        await planLiquidityAction(token, organizationId, {
          actionType,
          idempotencyKey: crypto.randomUUID(),
          source: { environment: "arc-testnet", chainId: 5042002, assetSymbol: "USDC" },
          destination: { environment, chainId: Number(chainId), assetSymbol },
          amountAtomic,
          quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }),
      );
    });
  }

  async function submitInvoiceAccrual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Invoice accrual projected", async () => {
      setLedger(await projectInvoiceAccrual(token, organizationId, invoiceVersionId));
    });
  }

  async function submitPaymentSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Payment settlement projected", async () => {
      setLedger(await projectPaymentSettlement(token, organizationId, executionId));
    });
  }

  async function run(success: string, work: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await work();
      setMessage(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Treasury action failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="font-semibold">Treasury ledger and audit views</h3>
      <p className="mt-2 text-sm text-slate-600">
        Testnet/mainnet capabilities come from backend policy. Planned liquidity,
        unsettled approvals and ledger postings are shown separately from paid status.
      </p>
      {error !== "" ? <Notice tone="error" text={error} /> : null}
      {message !== "" ? <Notice tone="success" text={message} /> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Treasury position</h4>
          <button disabled={pending} onClick={refreshPosition} className="btn">Refresh</button>
          {position !== null ? (
            <div className="space-y-2 text-sm">
              <Metric label="Committed payables" value={formatAtomic(position.committedPayablesAtomic, 6)} />
              <Metric label="Approved unsettled" value={formatAtomic(position.approvedUnsettledPaymentAtomic, 6)} />
              <Metric label="Planned liquidity" value={formatAtomic(position.plannedLiquidityAtomic, 6)} />
              <p className="text-slate-600">Networks listed: {position.supportedNetworks.length}</p>
            </div>
          ) : null}
        </div>

        <form onSubmit={submitLiquidity} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Liquidity route</h4>
          <p className="text-sm text-slate-600">Arc testnet USDC is the source. Only backend-supported testnet routes are selectable.</p>
          <Select label="Transport" value={actionType} onChange={(value) => {
            const next = value as "GATEWAY_TRANSFER" | "CCTP_TRANSFER";
            setActionType(next);
            setDestination(next === "GATEWAY_TRANSFER" ? "base-sepolia|84532|USDC" : "arbitrum-sepolia|421614|USDC");
          }} options={[{ value: "GATEWAY_TRANSFER", label: "Circle Gateway" }, { value: "CCTP_TRANSFER", label: "Circle CCTP" }]} />
          <Select label="Destination" value={destination} onChange={setDestination} options={routeOptions.map((network) => ({ value: `${network.environment}|${network.chainId}|USDC`, label: `${network.environment} · USDC` }))} />
          <Input label="Amount atomic" value={amountAtomic} onChange={setAmountAtomic} required />
          <button disabled={pending} className="btn">Plan route</button>
          {liquidity !== null ? <><ActionSummary status={liquidity.status} rows={[['Provider', liquidity.provider], ['Amount', `${formatAtomic(liquidity.amountAtomic, 6)} USDC`], ['Destination', `${liquidity.destination.environment} · ${liquidity.destination.assetSymbol}`]]} /><LiquidityLegs action={liquidity} /></> : null}
        </form>

        <div className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Ledger projection</h4>
          <form onSubmit={submitInvoiceAccrual} className="space-y-2">
            <Select label="Invoice" value={invoiceVersionId} onChange={setInvoiceVersionId} options={invoices.map((item) => ({ value: item.id, label: `${item.title} · ${item.subtitle}` }))} />
            <button disabled={pending} className="btn-secondary">Accrue invoice</button>
          </form>
          <form onSubmit={submitPaymentSettlement} className="space-y-2">
            <Select label="Payment execution" value={executionId} onChange={setExecutionId} options={executions.map((item) => ({ value: item.id, label: `${item.title} · ${item.status}` }))} />
            <button disabled={pending} className="btn-secondary">Settle payment</button>
          </form>
          {ledger.length > 0 ? <div className="space-y-2">{ledger.map((entry) => <p key={entry.id} className="flex justify-between rounded-xl border border-slate-200 p-3 text-sm"><span>{entry.direction} · {entry.account}</span><strong>{formatAtomic(entry.amountAtomic, 6)} {entry.assetSymbol}</strong></p>)}</div> : null}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-3 rounded-xl border border-slate-200 p-3">
      <span>{label}</span>
      <span className="font-semibold">{value} USDC</span>
    </p>
  );
}

function Input({ label, value, onChange, required = false }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input value={value} required={required} onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2" />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<select value={value} required onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500"><option value="" disabled>{options.length ? "Choose…" : "No records available"}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function ActionSummary({ status, rows }: { status: string; rows: Array<[string, string]> }) {
  return <div className="rounded-xl border border-slate-200 p-3 text-sm"><p className="font-semibold">{status}</p>{rows.map(([label, value]) => <p key={label} className="mt-2 flex justify-between gap-3"><span className="text-slate-500">{label}</span><span>{value}</span></p>)}</div>;
}

function LiquidityLegs({ action }: { action: LiquidityActionResponse }) {
  const sourceConfirmed = ["SUBMITTED", "ATTESTED", "MINTED", "SWAP_SUBMITTED", "SWAPPED", "CONFIRMED"].includes(action.status);
  const destinationConfirmed = ["MINTED", "SWAP_SUBMITTED", "SWAPPED", "CONFIRMED"].includes(action.status);
  const failed = action.status === "FAILED";
  const legs = [
    ["Arc source", failed ? "failed" : sourceConfirmed ? "confirmed" : "pending"],
    [`${action.destination.environment} receipt`, failed ? "failed" : destinationConfirmed ? "confirmed" : "pending"],
    [`${action.destination.assetSymbol} settlement`, failed ? "failed" : action.status === "CONFIRMED" ? "confirmed" : "pending"],
  ];
  return <ol className="grid gap-2 text-sm">{legs.map(([label, state]) => <li key={label} className="flex items-center justify-between rounded-xl bg-slate-100 px-3 py-2"><span>{label}</span><span className={state === "confirmed" ? "font-semibold text-emerald-700" : state === "failed" ? "font-semibold text-red-700" : "font-semibold text-amber-700"}>{state}</span></li>)}</ol>;
}

function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  return <p className={tone === "error" ? "mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" : "mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"}>{text}</p>;
}
