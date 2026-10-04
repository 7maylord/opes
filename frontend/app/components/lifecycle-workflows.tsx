"use client";

import { FormEvent, useState } from "react";
import {
  acceptMilestone,
  cancelSubscription,
  createEscrowAgreement,
  createSubscription,
  createSubscriptionCycle,
  disputeMilestone,
  submitMilestoneEvidence,
  type EscrowAgreementResponse,
  type EscrowMilestoneResponse,
  type SubscriptionCycleResponse,
  type SubscriptionResponse,
} from "@/lib/api";

export function LifecycleWorkflows({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const [vendorId, setVendorId] = useState("");
  const [vendorAddressId, setVendorAddressId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [amount, setAmount] = useState("100.00");
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [cycle, setCycle] = useState<SubscriptionCycleResponse | null>(null);
  const [agreement, setAgreement] = useState<EscrowAgreementResponse | null>(null);
  const [milestone, setMilestone] = useState<EscrowMilestoneResponse | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submitSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Subscription created", async () => {
      setSubscription(
        await createSubscription(token, organizationId, {
          vendorId,
          vendorAddressId,
          cadence: "MONTHLY",
          anchorDate: new Date().toISOString().slice(0, 10),
          timezone: "UTC",
          amount,
          termsDocumentId: documentId || undefined,
        }),
      );
    });
  }

  async function submitCycle() {
    if (subscription === null) return setError("Create a subscription first.");
    await run("Subscription cycle created", async () => {
      setCycle(
        await createSubscriptionCycle(token, organizationId, subscription.id, {
          servicePeriodStart: new Date().toISOString().slice(0, 10),
        }),
      );
    });
  }

  async function submitCancel() {
    if (subscription === null) return setError("Create a subscription first.");
    await run("Subscription cancelled", async () => {
      const result = await cancelSubscription(token, organizationId, subscription.id);
      setSubscription((current) => current === null ? current : { ...current, status: result.status });
    });
  }

  async function submitEscrow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Escrow agreement created", async () => {
      const first = (Number(amount) / 2).toFixed(2);
      const second = (Number(amount) - Number(first)).toFixed(2);
      setAgreement(
        await createEscrowAgreement(token, organizationId, {
          vendorId,
          vendorAddressId,
          agreementDocumentId: documentId || undefined,
          totalAmount: amount,
          milestones: [
            { title: "Kickoff", amount: first },
            { title: "Delivery", amount: second },
          ],
        }),
      );
    });
  }

  async function submitEvidence() {
    const target = agreement?.milestones[0];
    if (target === undefined) return setError("Create an escrow agreement first.");
    if (documentId === "") return setError("Enter a milestone evidence document ID.");
    await run("Milestone evidence submitted", async () => {
      setMilestone(await submitMilestoneEvidence(token, organizationId, target.id, documentId));
    });
  }

  async function submitAccept() {
    const target = milestone ?? agreement?.milestones[0];
    if (target === undefined) return setError("Create an escrow agreement first.");
    await run("Milestone accepted", async () => {
      setMilestone(await acceptMilestone(token, organizationId, target.id));
    });
  }

  async function submitDispute() {
    const target = milestone ?? agreement?.milestones[0];
    if (target === undefined) return setError("Create an escrow agreement first.");
    await run("Milestone disputed", async () => {
      setMilestone(await disputeMilestone(token, organizationId, target.id, "Needs review"));
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
      setError(reason instanceof Error ? reason.message : "Lifecycle action failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="font-semibold">Recurring and escrow workflows</h3>
      <p className="mt-2 text-sm text-slate-600">
        Uses verified vendor/address IDs and document IDs from the invoice workflow.
        Returned backend states are shown before any next action.
      </p>
      {error !== "" ? <Notice tone="error" text={error} /> : null}
      {message !== "" ? <Notice tone="success" text={message} /> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <form onSubmit={submitSubscription} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Subscription</h4>
          <Input label="Vendor ID" value={vendorId} onChange={setVendorId} required />
          <Input label="Vendor address ID" value={vendorAddressId} onChange={setVendorAddressId} required />
          <Input label="Terms/evidence document ID optional" value={documentId} onChange={setDocumentId} />
          <Input label="Monthly amount USDC" value={amount} onChange={setAmount} required />
          <button disabled={pending} className="btn">Create subscription</button>
          <button type="button" disabled={pending || subscription === null} onClick={submitCycle} className="btn-secondary">Create current cycle</button>
          <button type="button" disabled={pending || subscription === null} onClick={submitCancel} className="btn-secondary">Cancel</button>
          <Result value={cycle ?? subscription} />
        </form>

        <form onSubmit={submitEscrow} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Escrow agreement</h4>
          <Input label="Vendor ID" value={vendorId} onChange={setVendorId} required />
          <Input label="Vendor address ID" value={vendorAddressId} onChange={setVendorAddressId} required />
          <Input label="Agreement/evidence document ID" value={documentId} onChange={setDocumentId} />
          <Input label="Total amount USDC" value={amount} onChange={setAmount} required />
          <button disabled={pending} className="btn">Create escrow</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitEvidence} className="btn-secondary">Submit first milestone evidence</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitAccept} className="btn-secondary">Accept milestone</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitDispute} className="btn-secondary">Dispute milestone</button>
          <Result value={milestone ?? agreement} />
        </form>
      </div>
    </section>
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

function Result({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  return <pre className="max-h-52 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(value, null, 2)}</pre>;
}

function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  return <p className={tone === "error" ? "mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" : "mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"}>{text}</p>;
}
