"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  configureTreasury,
  getTreasuryPosition,
  listWorkspaceRecords,
  planLiquidityAction,
  projectInvoiceAccrual,
  projectPaymentSettlement,
  type LedgerEntryResponse,
  type LiquidityActionResponse,
  type TreasuryPositionResponse,
} from "@/lib/api";
import { formatAtomic, parseDecimalToAtomic } from "@/lib/money";
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
  const [liquidityAmountUsdc, setLiquidityAmountUsdc] = useState("1");
  const [actionType, setActionType] = useState<"GATEWAY_TRANSFER" | "CCTP_TRANSFER">("GATEWAY_TRANSFER");
  const [destination, setDestination] = useState("base-sepolia|84532|USDC");
  const [invoices, setInvoices] = useState<WorkspaceRecord[]>([]);
  const [executions, setExecutions] = useState<WorkspaceRecord[]>([]);
  const [pending, setPending] = useState(false);
  const [bufferUsdc, setBufferUsdc] = useState("");
  const [budgetUsdc, setBudgetUsdc] = useState("");

  const applyPosition = useCallback((nextPosition: TreasuryPositionResponse) => {
    setPosition(nextPosition);
    setBufferUsdc(formatAtomic(nextPosition.operatingBufferAtomic, 6));
    setBudgetUsdc(
      nextPosition.monthlyBudgetAtomic === null
        ? ""
        : formatAtomic(nextPosition.monthlyBudgetAtomic, 6),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getTreasuryPosition(token, organizationId),
      listWorkspaceRecords(token, organizationId, "invoice", { limit: 50 }),
      listWorkspaceRecords(token, organizationId, "execution", { limit: 50 }),
    ]).then(([nextPosition, invoicePage, executionPage]) => {
      if (cancelled) return;
      applyPosition(nextPosition);
      setInvoices(invoicePage.items);
      setExecutions(executionPage.items);
      setInvoiceVersionId(invoicePage.items[0]?.id ?? "");
      setExecutionId(executionPage.items[0]?.id ?? "");
    }).catch((reason: unknown) => {
      if (!cancelled) toast.error(reason instanceof Error ? reason.message : "Unable to load treasury options");
    });
    return () => { cancelled = true; };
  }, [applyPosition, organizationId, token]);

  const routeOptions = useMemo(() => {
    const networks = position?.supportedNetworks ?? [];
    return networks.filter((network) => {
      if (network.tier !== "testnet" || network.family === "arc") return false;
      return actionType === "GATEWAY_TRANSFER"
        ? network.gatewayExecutable
        : network.cctpExecutable;
    });
  }, [actionType, position]);

  async function refreshPosition() {
    await run("Treasury position refreshed", async () => {
      applyPosition(await getTreasuryPosition(token, organizationId));
    });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Treasury settings saved", async () => {
      applyPosition(
        await configureTreasury(token, organizationId, {
          operatingBufferAtomic: parseDecimalToAtomic(bufferUsdc, 6),
          monthlyBudgetAtomic:
            budgetUsdc === "" ? null : parseDecimalToAtomic(budgetUsdc, 6),
          maxSnapshotAgeSeconds: 300,
        }),
      );
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
          amountAtomic: parseDecimalToAtomic(liquidityAmountUsdc, 6),
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
    try {
      await work();
      toast.success(success);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Treasury action failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="font-semibold">Treasury</h3>
      <p className="mt-2 text-sm text-slate-600">
        Live balances, spending controls, liquidity routes and ledger activity for
        this workspace.
      </p>
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,.75fr)]">
        <div className="space-y-4 rounded-2xl bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold">Treasury position</h4>
              <p className="mt-1 text-sm text-slate-500">
                Confirmed Arc vault and escrow balances.
              </p>
            </div>
            <button disabled={pending} onClick={refreshPosition} className="btn-secondary">
              Refresh balances
            </button>
          </div>
          {position !== null ? (
            <>
              <SnapshotStatus position={position} />
              <div className="grid gap-3 sm:grid-cols-3">
                <BalanceMetric
                  label="Verified balance"
                  value={position.snapshotStatus === "FRESH" ? formatAtomic(position.verifiedBalanceAtomic, 6) : null}
                />
                <BalanceMetric
                  label="In escrow"
                  value={position.snapshotStatus === "FRESH" ? formatAtomic(position.restrictedBalanceAtomic, 6) : null}
                />
                <BalanceMetric
                  label="Available to spend"
                  value={position.snapshotStatus === "FRESH" ? formatAtomic(position.availableLiquidityAtomic, 6) : null}
                  emphasized
                />
              </div>
              <div className="border-t border-slate-200 pt-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Commitments and forecast</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Metric label="Reserved" value={formatAtomic(position.reservedAtomic, 6)} />
                  <Metric label="Approved, unsettled" value={formatAtomic(position.approvedUnsettledPaymentAtomic, 6)} />
                  <Metric label="Committed payables" value={formatAtomic(position.committedPayablesAtomic, 6)} />
                  <Metric label="Incoming" value={formatAtomic(position.plannedIncomingAtomic, 6)} />
                  <Metric label="In transit" value={formatAtomic(position.inTransitAtomic, 6)} />
                  <Metric label="30-day forecast" value={formatAtomic(position.forecast30DaysAtomic, 6)} />
                  <Metric label="90-day forecast" value={formatAtomic(position.forecast90DaysAtomic, 6)} />
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">Loading treasury position…</p>
          )}
        </div>

        <form onSubmit={saveSettings} className="space-y-4 rounded-2xl bg-white p-5">
          <div>
            <h4 className="font-semibold">Budget controls</h4>
            <p className="mt-1 text-sm leading-5 text-slate-500">
              Keep a cash reserve and cap total monthly spending. Enter normal
              USDC amounts; OPES handles atomic units.
            </p>
          </div>
          {position?.configured ? (
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-emerald-50 p-3 text-sm">
              <div><span className="block text-xs text-emerald-700">Current buffer</span><strong>{formatAtomic(position.operatingBufferAtomic, 6)} USDC</strong></div>
              <div><span className="block text-xs text-emerald-700">Current monthly budget</span><strong>{position.monthlyBudgetAtomic === null ? "No limit" : `${formatAtomic(position.monthlyBudgetAtomic, 6)} USDC`}</strong></div>
            </div>
          ) : null}
          <Input label="Operating buffer" suffix="USDC" value={bufferUsdc} onChange={setBufferUsdc} required />
          <p className="-mt-2 text-xs text-slate-500">OPES will not authorize spending that consumes this reserve.</p>
          <Input label="Monthly budget (optional)" suffix="USDC" value={budgetUsdc} onChange={setBudgetUsdc} />
          <button disabled={pending} className="btn w-full">Save budget controls</button>
        </form>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <form onSubmit={submitLiquidity} className="space-y-3 rounded-2xl bg-white p-5">
          <h4 className="font-semibold">Liquidity route</h4>
          <p className="text-sm text-slate-600">Arc testnet USDC is the source. Only backend-supported testnet routes are selectable.</p>
          <Select label="Transport" value={actionType} onChange={(value) => {
            const next = value as "GATEWAY_TRANSFER" | "CCTP_TRANSFER";
            setActionType(next);
            setDestination(next === "GATEWAY_TRANSFER" ? "base-sepolia|84532|USDC" : "arbitrum-sepolia|421614|USDC");
          }} options={[{ value: "GATEWAY_TRANSFER", label: "Circle Gateway" }, { value: "CCTP_TRANSFER", label: "Circle CCTP" }]} />
          <Select label="Destination" value={destination} onChange={setDestination} options={routeOptions.map((network) => ({ value: `${network.environment}|${network.chainId}|USDC`, label: `${network.environment} · USDC` }))} />
          <Input label="Amount" suffix="USDC" value={liquidityAmountUsdc} onChange={setLiquidityAmountUsdc} required />
          <button disabled={pending} className="btn">Plan route</button>
          {liquidity !== null ? <><ActionSummary status={liquidity.status} rows={[['Provider', liquidity.provider], ['Amount', `${formatAtomic(liquidity.amountAtomic, 6)} USDC`], ['Destination', `${liquidity.destination.environment} · ${liquidity.destination.assetSymbol}`]]} /><LiquidityLegs action={liquidity} /></> : null}
        </form>

        <div className="space-y-3 rounded-2xl bg-white p-5">
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
    <p className="flex justify-between gap-3 rounded-xl bg-slate-50 p-3">
      <span>{label}</span>
      <span className="font-semibold">{value} USDC</span>
    </p>
  );
}

function BalanceMetric({ label, value, emphasized = false }: { label: string; value: string | null; emphasized?: boolean }) {
  return <div className={`rounded-xl border p-4 ${emphasized ? "border-cyan-200 bg-cyan-50" : "border-slate-200"}`}><span className="text-xs text-slate-500">{label}</span><strong className="mt-2 block text-xl">{value === null ? "—" : `${value} USDC`}</strong></div>;
}

function SnapshotStatus({ position }: { position: TreasuryPositionResponse }) {
  if (position.snapshotStatus === "FRESH") {
    return <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><strong>Balances verified</strong>{position.snapshotObservedAt ? ` · ${new Date(position.snapshotObservedAt).toLocaleString()}` : ""}</div>;
  }
  const message = position.snapshotStatus === "FAILED"
    ? "The latest chain read failed. OPES will not treat the zero values as confirmed balances."
    : position.snapshotStatus === "STALE"
      ? "The last verified balance is too old to authorize a payment."
      : "OPES is waiting for its first complete balance read.";
  return <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><strong>Balances unavailable</strong><p className="mt-1">{message}</p></div>;
}

function Input({ label, value, onChange, required = false, suffix }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; suffix?: string }) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <span className="relative mt-2 block"><input inputMode={suffix ? "decimal" : undefined} value={value} required={required} onChange={(event) => onChange(event.target.value)} className={`min-h-11 w-full rounded-xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2 ${suffix ? "pr-16" : ""}`} />{suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-slate-500">{suffix}</span> : null}</span>
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
