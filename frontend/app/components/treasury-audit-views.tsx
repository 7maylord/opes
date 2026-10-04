"use client";

import { FormEvent, useState } from "react";
import {
  getTreasuryPosition,
  planLiquidityAction,
  projectInvoiceAccrual,
  projectPaymentSettlement,
  type LedgerEntryResponse,
  type LiquidityActionResponse,
  type TreasuryPositionResponse,
} from "@/lib/api";
import { formatAtomic } from "@/lib/money";

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
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function refreshPosition() {
    await run("Treasury position refreshed", async () => {
      setPosition(await getTreasuryPosition(token, organizationId));
    });
  }

  async function submitLiquidity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Liquidity action planned", async () => {
      setLiquidity(
        await planLiquidityAction(token, organizationId, {
          actionType: "GATEWAY_TRANSFER",
          idempotencyKey: crypto.randomUUID(),
          source: { environment: "arc-testnet", chainId: 5042002, assetSymbol: "USDC" },
          destination: { environment: "base-sepolia", chainId: 84532, assetSymbol: "USDC" },
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
          <p className="text-sm text-slate-600">Arc testnet USDC → Base Sepolia USDC via Gateway.</p>
          <Input label="Amount atomic" value={amountAtomic} onChange={setAmountAtomic} required />
          <button disabled={pending} className="btn">Plan route</button>
          {liquidity !== null ? <StatusResult value={liquidity} /> : null}
        </form>

        <div className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Ledger projection</h4>
          <form onSubmit={submitInvoiceAccrual} className="space-y-2">
            <Input label="Invoice version ID" value={invoiceVersionId} onChange={setInvoiceVersionId} required />
            <button disabled={pending} className="btn-secondary">Accrue invoice</button>
          </form>
          <form onSubmit={submitPaymentSettlement} className="space-y-2">
            <Input label="Payment execution ID" value={executionId} onChange={setExecutionId} required />
            <button disabled={pending} className="btn-secondary">Settle payment</button>
          </form>
          {ledger.length > 0 ? <StatusResult value={ledger} /> : null}
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

function StatusResult({ value }: { value: unknown }) {
  return <pre className="max-h-52 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(value, null, 2)}</pre>;
}

function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  return <p className={tone === "error" ? "mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" : "mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"}>{text}</p>;
}
