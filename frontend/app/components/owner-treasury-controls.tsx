"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { applyPaymentPolicyTemplate, confirmLifecycleAction, listPaymentPolicyTemplates, prepareTreasuryAction, type PaymentPolicyTemplate } from "@/lib/api";
import { parseDecimalToAtomic } from "@/lib/money";
import { readArcPaused, useArcTransaction } from "@/lib/use-arc-transaction";

export function OwnerTreasuryControls({
  token,
  organizationId,
  vaultAddress,
  escrowAddress,
}: {
  token: string;
  organizationId: string;
  vaultAddress: string;
  escrowAddress: string;
}) {
  const sendTransaction = useArcTransaction();
  const [autonomousLimit, setAutonomousLimit] = useState("10");
  const [singleLimit, setSingleLimit] = useState("100");
  const [dailyLimit, setDailyLimit] = useState("500");
  const [recoveryAmount, setRecoveryAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [vaultPaused, setVaultPaused] = useState<boolean | null>(null);
  const [escrowPaused, setEscrowPaused] = useState<boolean | null>(null);
  const [templates, setTemplates] = useState<PaymentPolicyTemplate[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      readArcPaused(vaultAddress),
      readArcPaused(escrowAddress),
    ])
      .then(([vault, escrow]) => {
        if (!cancelled) {
          setVaultPaused(vault);
          setEscrowPaused(escrow);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVaultPaused(null);
          setEscrowPaused(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [escrowAddress, vaultAddress]);

  useEffect(() => { void listPaymentPolicyTemplates(token, organizationId).then(setTemplates).catch(() => undefined); }, [organizationId, token]);

  async function applyTemplate(id: string) {
    setPending(true);
    try { await applyPaymentPolicyTemplate(token, organizationId, id); toast.success("Payment policy template applied"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to apply policy template"); }
    finally { setPending(false); }
  }

  async function run(
    action: string,
    label: string,
    input: Record<string, unknown> = {},
  ) {
    setPending(true);
    try {
      const prepared = await prepareTreasuryAction(token, organizationId, {
        action,
        ...input,
      });
      const transaction = await sendTransaction({
        to: prepared.to,
        data: prepared.data,
        chainId: prepared.chainId,
        value: 0,
      });
      await confirmLifecycleAction(
        token,
        organizationId,
        prepared.id,
        transaction.hash,
      );
      if (action === "PAUSE_VAULT") setVaultPaused(true);
      if (action === "RESUME_VAULT") setVaultPaused(false);
      if (action === "PAUSE_ESCROW") setEscrowPaused(true);
      if (action === "RESUME_ESCROW") setEscrowPaused(false);
      toast.success(label);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Treasury action failed",
      );
    } finally {
      setPending(false);
    }
  }

  function atomic(value: string) {
    return parseDecimalToAtomic(value, 6);
  }

  function submit(
    action: string,
    label: string,
    input: () => Record<string, unknown> = () => ({}),
  ) {
    try {
      void run(action, label, input());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid amount");
    }
  }

  return (
    <div className="space-y-6 text-sm">
      <p className="max-w-3xl leading-6 text-slate-600">
        These controls change your Arc contracts. Privy will ask the workspace
        owner to sign each change before OPES records it.
      </p>

      <section className="rounded-2xl border border-slate-200 p-5">
        <h4 className="font-semibold">Policy templates</h4>
        <p className="mt-1 text-slate-600">Choose a reviewed starting policy. This creates a new policy version; contract limits remain under the signed controls below.</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">{templates.map((template) => <article key={template.id} className="rounded-xl bg-slate-50 p-4"><strong>{template.name}</strong><p className="mt-1 min-h-10 text-xs text-slate-500">{template.description}</p><button type="button" disabled={pending} onClick={() => void applyTemplate(template.id)} className="btn-secondary mt-3">Apply template</button></article>)}</div>
      </section>

      <section
        className="rounded-2xl border border-slate-200 p-5"
        title="Limits define which payments the agent can make and which require owner approval."
      >
        <div className="mb-4">
          <h4 className="font-semibold">Payment limits</h4>
          <p className="mt-1 text-slate-600">
            Set how much the agent may pay automatically, per payment, and per
            day. Amounts are entered in USDC.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <AmountInput
            label="Automatic payment limit"
            detail="Payments above this need owner approval."
            value={autonomousLimit}
            onChange={setAutonomousLimit}
          />
          <AmountInput
            label="Single payment limit"
            detail="No payment may exceed this amount."
            value={singleLimit}
            onChange={setSingleLimit}
          />
          <AmountInput
            label="Daily organization limit"
            detail="Maximum total payments in one day."
            value={dailyLimit}
            onChange={setDailyLimit}
          />
        </div>
        <button
          disabled={pending}
          onClick={() =>
            submit("SET_LIMITS", "Payment limits saved", () => ({
              autonomousAtomic: atomic(autonomousLimit),
              singleAtomic: atomic(singleLimit),
              dailyAtomic: atomic(dailyLimit),
            }))
          }
          className="btn mt-4"
        >
          Save payment limits
        </button>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ContractState
          title="Treasury vault"
          detail="Pause outgoing invoice and recurring payments in an emergency."
          pending={pending}
          paused={vaultPaused}
          onResume={() => submit("RESUME_VAULT", "Treasury vault resumed")}
          onPause={() => submit("PAUSE_VAULT", "Treasury vault paused")}
        />
        <ContractState
          title="Milestone escrow"
          detail="Pause milestone funding and releases without stopping direct payments."
          pending={pending}
          paused={escrowPaused}
          onResume={() => submit("RESUME_ESCROW", "Milestone escrow resumed")}
          onPause={() => submit("PAUSE_ESCROW", "Milestone escrow paused")}
        />
      </div>

      <details className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
        <summary
          className="cursor-pointer font-semibold text-slate-900"
          title="Recover vault USDC to the recovery wallet after pausing the vault."
        >
          Emergency recovery
        </summary>
        <p className="mt-2 text-slate-600">
          Pause the treasury vault first. Recovery sends USDC to the recovery
          wallet configured when the vault was deployed.
        </p>
        <div className="mt-5 max-w-md">
          <AmountInput
            label="Recovery amount"
            detail="USDC returned to the configured recovery wallet."
            value={recoveryAmount}
            onChange={setRecoveryAmount}
          />
          <button
            disabled={pending || vaultPaused !== true}
            onClick={() =>
              submit("RECOVER_USDC", "USDC recovered", () => ({
                amountAtomic: atomic(recoveryAmount),
              }))
            }
            className="btn-secondary mt-3"
          >
            {vaultPaused === true ? "Recover USDC" : "Pause vault to recover"}
          </button>
        </div>
      </details>
    </div>
  );
}

function ContractState({
  title,
  detail,
  pending,
  paused,
  onResume,
  onPause,
}: {
  title: string;
  detail: string;
  pending: boolean;
  paused: boolean | null;
  onResume: () => void;
  onPause: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 p-5" title={detail}>
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        {paused === null ? "Checking status" : paused ? "Paused" : "Active"}
      </p>
      <p className="mt-1 min-h-10 text-slate-600">{detail}</p>
      <div className="mt-4 flex gap-2">
        <button disabled={pending || paused !== true} onClick={onResume} className="btn">
          Resume
        </button>
        <button disabled={pending || paused !== false} onClick={onPause} className="btn-secondary">
          Pause
        </button>
      </div>
    </section>
  );
}

function AmountInput({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextInput
      label={label}
      detail={detail}
      value={value}
      onChange={onChange}
      inputMode="decimal"
      suffix="USDC"
    />
  );
}

function TextInput({
  label,
  detail,
  value,
  onChange,
  inputMode,
  suffix,
}: {
  label: string;
  detail: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "decimal";
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="font-medium text-slate-800">{label}</span>
      <span className="mt-1 block min-h-5 text-xs text-slate-500">{detail}</span>
      <span className="relative mt-2 block">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode={inputMode}
          className={`min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100 ${suffix ? "pr-16" : ""}`}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-slate-500">
            {suffix}
          </span>
        ) : null}
      </span>
    </label>
  );
}
