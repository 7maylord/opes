"use client";

import { FormEvent, useState } from "react";
import { useSendTransaction } from "@privy-io/react-auth";
import {
  acceptMilestone,
  cancelSubscription,
  changeSubscriptionStatus,
  createEscrowAgreement,
  fundEscrow,
  cancelEscrow,
  createSubscription,
  createSubscriptionCycle,
  confirmLifecycleAction,
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
  const { sendTransaction } = useSendTransaction();
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

  async function activateSubscription() {
    if (subscription === null) return setError("Create a subscription first.");
    await run("Recurring mandate activated", async () => {
      for (const action of subscription.ownerActions) {
        if (action.status === "CONFIRMED") continue;
        const transaction = await sendTransaction({
          to: action.to,
          data: action.data,
          chainId: action.chainId,
          value: 0,
        });
        await confirmLifecycleAction(token, organizationId, action.id, transaction.hash);
      }
      setSubscription((current) => current === null ? current : { ...current, status: "ACTIVE" });
    });
  }

  async function submitCancel() {
    if (subscription === null) return setError("Create a subscription first.");
    await run("Subscription cancelled", async () => {
      const result = await cancelSubscription(token, organizationId, subscription.id);
      await signAction(result);
      setSubscription((current) => current === null ? current : { ...current, status: "CANCELLED" });
    });
  }

  async function changeStatus(operation: 'pause' | 'resume') {
    if (subscription === null) return setError("Create a subscription first.");
    await run(`Subscription ${operation}d`, async () => {
      await signAction(await changeSubscriptionStatus(token, organizationId, subscription.id, operation));
      setSubscription((current) => current === null ? current : { ...current, status: operation === 'pause' ? 'PAUSED' : 'ACTIVE' });
    });
  }

  async function signAction(action: import('@/lib/api').ChainActionResponse) {
    const transaction = await sendTransaction({ to: action.to, data: action.data, chainId: action.chainId, value: 0 });
    await confirmLifecycleAction(token, organizationId, action.id, transaction.hash);
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

  async function activateEscrow() {
    if (!agreement) return setError("Create an escrow agreement first.");
    await run("Escrow agreement activated", async () => { for (const action of agreement.ownerActions) if (action.status !== 'CONFIRMED') await signAction(action); setAgreement(current => current ? {...current,status:'CREATED'} : current); });
  }

  async function submitFunding() {
    if (!agreement) return setError("Create an escrow agreement first.");
    await run("Escrow funding approved", async () => { await signAction(await fundEscrow(token, organizationId, agreement.id)); setAgreement(current => current ? {...current,status:'FUNDING_APPROVED'} : current); });
  }

  async function submitEscrowCancel() {
    if (!agreement) return setError("Create an escrow agreement first.");
    await run("Escrow cancelled; refund queued", async () => { await signAction(await cancelEscrow(token, organizationId, agreement.id, 'Cancelled by owner')); setAgreement(current => current ? {...current,status:'CANCELLED'} : current); });
  }

  async function submitAccept() {
    const target = milestone ?? agreement?.milestones[0];
    if (target === undefined) return setError("Create an escrow agreement first.");
    await run("Milestone accepted", async () => {
      await signAction(await acceptMilestone(token, organizationId, target.id));
      setMilestone({ ...target, status: 'ACCEPTED' });
    });
  }

  async function submitDispute() {
    const target = milestone ?? agreement?.milestones[0];
    if (target === undefined) return setError("Create an escrow agreement first.");
    await run("Milestone disputed", async () => {
      await signAction(await disputeMilestone(token, organizationId, target.id, "Needs review"));
      setMilestone({ ...target, status: 'DISPUTED' });
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
          <button type="button" disabled={pending || subscription === null || subscription.status === "ACTIVE"} onClick={activateSubscription} className="btn-secondary">Sign and activate mandate</button>
          <button type="button" disabled={pending || subscription === null} onClick={submitCycle} className="btn-secondary">Create current cycle</button>
          <button type="button" disabled={pending || subscription === null} onClick={submitCancel} className="btn-secondary">Cancel</button>
          <button type="button" disabled={pending || subscription?.status !== "ACTIVE"} onClick={() => changeStatus('pause')} className="btn-secondary">Pause</button>
          <button type="button" disabled={pending || subscription?.status !== "PAUSED"} onClick={() => changeStatus('resume')} className="btn-secondary">Resume</button>
          {subscription !== null ? (
            <p className="rounded-xl border border-slate-200 p-3 text-sm">
              Subscription status: <span className="font-semibold">{subscription.status}</span>
            </p>
          ) : null}
          <Result value={cycle ?? subscription} />
        </form>

        <form onSubmit={submitEscrow} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">Escrow agreement</h4>
          <Input label="Vendor ID" value={vendorId} onChange={setVendorId} required />
          <Input label="Vendor address ID" value={vendorAddressId} onChange={setVendorAddressId} required />
          <Input label="Agreement/evidence document ID" value={documentId} onChange={setDocumentId} />
          <Input label="Total amount USDC" value={amount} onChange={setAmount} required />
          <button disabled={pending} className="btn">Create escrow</button>
          <button type="button" disabled={pending || agreement === null} onClick={activateEscrow} className="btn-secondary">Sign escrow setup</button>
          <button type="button" disabled={pending || agreement?.status !== 'CREATED'} onClick={submitFunding} className="btn-secondary">Approve funding</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitEvidence} className="btn-secondary">Submit first milestone evidence</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitAccept} className="btn-secondary">Accept milestone</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitDispute} className="btn-secondary">Dispute milestone</button>
          <button type="button" disabled={pending || agreement === null} onClick={submitEscrowCancel} className="btn-secondary">Cancel and refund</button>
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
