"use client";

import { useState } from "react";
import { useSendTransaction } from "@privy-io/react-auth";
import { toast } from "sonner";
import { confirmLifecycleAction, prepareTreasuryAction } from "@/lib/api";
import { parseDecimalToAtomic } from "@/lib/money";

export function OwnerTreasuryControls({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const { sendTransaction } = useSendTransaction();
  const [autonomousLimit, setAutonomousLimit] = useState("10");
  const [singleLimit, setSingleLimit] = useState("100");
  const [dailyLimit, setDailyLimit] = useState("500");
  const [vendorAddress, setVendorAddress] = useState("");
  const [vendorDailyLimit, setVendorDailyLimit] = useState("100");
  const [recoveryAmount, setRecoveryAmount] = useState("");
  const [successorAddress, setSuccessorAddress] = useState("");
  const [pending, setPending] = useState(false);

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
          onResume={() => submit("RESUME_VAULT", "Treasury vault resumed")}
          onPause={() => submit("PAUSE_VAULT", "Treasury vault paused")}
        />
        <ContractState
          title="Milestone escrow"
          detail="Pause milestone funding and releases without stopping direct payments."
          pending={pending}
          onResume={() => submit("RESUME_ESCROW", "Milestone escrow resumed")}
          onPause={() => submit("PAUSE_ESCROW", "Milestone escrow paused")}
        />
      </div>

      <section className="rounded-2xl border border-slate-200 p-5">
        <h4 className="font-semibold">Vendor authorization</h4>
        <p className="mt-1 text-slate-600">
          Approve a vendor payout wallet and cap how much it may receive each
          day.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_16rem]">
          <TextInput
            label="Vendor payout address"
            detail="The verified 0x wallet belonging to this vendor."
            value={vendorAddress}
            onChange={setVendorAddress}
            placeholder="0x…"
          />
          <AmountInput
            label="Vendor daily limit"
            detail="Amount in USDC."
            value={vendorDailyLimit}
            onChange={setVendorDailyLimit}
          />
        </div>
        <button
          disabled={pending}
          onClick={() =>
            submit("SET_VENDOR", "Vendor authorized", () => ({
              vendor: vendorAddress,
              allowed: true,
              dailyAtomic: atomic(vendorDailyLimit),
            }))
          }
          className="btn-secondary mt-4"
        >
          Allow vendor
        </button>
      </section>

      <details className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
        <summary className="cursor-pointer font-semibold text-slate-900">
          Recovery and ownership
        </summary>
        <p className="mt-2 text-slate-600">
          Use these controls only to recover vault funds or transfer contract
          ownership.
        </p>
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div>
            <AmountInput
              label="Recovery amount"
              detail="USDC returned to the configured recovery wallet."
              value={recoveryAmount}
              onChange={setRecoveryAmount}
            />
            <button
              disabled={pending}
              onClick={() =>
                submit("RECOVER_USDC", "USDC recovered", () => ({
                  amountAtomic: atomic(recoveryAmount),
                }))
              }
              className="btn-secondary mt-3"
            >
              Recover USDC
            </button>
          </div>
          <div>
            <TextInput
              label="New owner address"
              detail="The 0x wallet that will receive contract ownership."
              value={successorAddress}
              onChange={setSuccessorAddress}
              placeholder="0x…"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                disabled={pending}
                onClick={() =>
                  submit("HANDOVER_VAULT", "Vault handover submitted", () => ({
                    newAdmin: successorAddress,
                  }))
                }
                className="btn-secondary"
              >
                Handover vault
              </button>
              <button
                disabled={pending}
                onClick={() =>
                  submit("HANDOVER_ESCROW", "Escrow handover submitted", () => ({
                    newAdmin: successorAddress,
                  }))
                }
                className="btn-secondary"
              >
                Handover escrow
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

function ContractState({
  title,
  detail,
  pending,
  onResume,
  onPause,
}: {
  title: string;
  detail: string;
  pending: boolean;
  onResume: () => void;
  onPause: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 p-5">
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1 min-h-10 text-slate-600">{detail}</p>
      <div className="mt-4 flex gap-2">
        <button disabled={pending} onClick={onResume} className="btn">
          Resume
        </button>
        <button disabled={pending} onClick={onPause} className="btn-secondary">
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
  placeholder,
  inputMode,
  suffix,
}: {
  label: string;
  detail: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
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
          placeholder={placeholder}
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
