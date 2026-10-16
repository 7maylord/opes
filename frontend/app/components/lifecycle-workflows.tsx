"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSendTransaction } from "@privy-io/react-auth";
import { toast } from "sonner";
import {
  acceptMilestone,
  cancelEscrow,
  cancelSubscription,
  changeSubscriptionStatus,
  confirmLifecycleAction,
  createEscrowAgreement,
  createSubscription,
  createSubscriptionCycle,
  disputeMilestone,
  fundEscrow,
  listWorkspaceRecords,
  submitMilestoneEvidence,
  type ChainActionResponse,
  type EscrowAgreementResponse,
  type EscrowMilestoneResponse,
  type SubscriptionCycleResponse,
  type SubscriptionResponse,
} from "@/lib/api";
import { formatAtomic, parseDecimalToAtomic } from "@/lib/money";
import type { WorkspaceRecord } from "@/lib/workspace-api.generated";

type AgreementView = "recurring" | "escrow";
type Cadence = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL";

export function LifecycleWorkflows({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const { sendTransaction } = useSendTransaction();
  const today = new Date().toISOString().slice(0, 10);
  const [view, setView] = useState<AgreementView>("recurring");
  const [vendors, setVendors] = useState<WorkspaceRecord[]>([]);
  const [documents, setDocuments] = useState<WorkspaceRecord[]>([]);
  const [recent, setRecent] = useState<WorkspaceRecord[]>([]);
  const [pending, setPending] = useState(false);

  const [subscriptionVendorId, setSubscriptionVendorId] = useState("");
  const [subscriptionAddressId, setSubscriptionAddressId] = useState("");
  const [termsDocumentId, setTermsDocumentId] = useState("");
  const [subscriptionAmount, setSubscriptionAmount] = useState("100");
  const [cadence, setCadence] = useState<Cadence>("MONTHLY");
  const [anchorDate, setAnchorDate] = useState(today);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [cycle, setCycle] = useState<SubscriptionCycleResponse | null>(null);

  const [escrowVendorId, setEscrowVendorId] = useState("");
  const [escrowAddressId, setEscrowAddressId] = useState("");
  const [agreementDocumentId, setAgreementDocumentId] = useState("");
  const [milestones, setMilestones] = useState([
    { title: "Kickoff", amount: "50" },
    { title: "Delivery", amount: "50" },
  ]);
  const [agreement, setAgreement] = useState<EscrowAgreementResponse | null>(null);
  const [selectedMilestoneId, setSelectedMilestoneId] = useState("");
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("");
  const [disputeReason, setDisputeReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listWorkspaceRecords(token, organizationId, "vendor", { limit: 50 }),
      listWorkspaceRecords(token, organizationId, "evidence", { limit: 50 }),
      listWorkspaceRecords(token, organizationId, "subscription", { limit: 10 }),
      listWorkspaceRecords(token, organizationId, "escrow", { limit: 10 }),
    ])
      .then(([vendorPage, documentPage, subscriptionPage, escrowPage]) => {
        if (cancelled) return;
        setVendors(vendorPage.items);
        setDocuments(documentPage.items);
        setRecent(
          [...subscriptionPage.items, ...escrowPage.items]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 6),
        );
        const firstVendor = vendorPage.items[0];
        const firstAddress = readAddresses(firstVendor)[0]?.id ?? "";
        setSubscriptionVendorId(firstVendor?.id ?? "");
        setSubscriptionAddressId(firstAddress);
        setEscrowVendorId(firstVendor?.id ?? "");
        setEscrowAddressId(firstAddress);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          toast.error(
            reason instanceof Error
              ? reason.message
              : "Unable to load agreement options",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId, token]);

  const subscriptionAddresses = useMemo(
    () => readAddresses(vendors.find((vendor) => vendor.id === subscriptionVendorId)),
    [subscriptionVendorId, vendors],
  );
  const escrowAddresses = useMemo(
    () => readAddresses(vendors.find((vendor) => vendor.id === escrowVendorId)),
    [escrowVendorId, vendors],
  );
  const escrowTotal = useMemo(() => {
    try {
      const atomic = milestones.reduce(
        (sum, item) => sum + BigInt(parseDecimalToAtomic(item.amount, 6)),
        BigInt(0),
      );
      return formatAtomic(atomic.toString(), 6);
    } catch {
      return "—";
    }
  }, [milestones]);
  const selectedMilestone = agreement?.milestones.find(
    (item) => item.id === selectedMilestoneId,
  );

  function selectSubscriptionVendor(id: string) {
    setSubscriptionVendorId(id);
    setSubscriptionAddressId(
      readAddresses(vendors.find((vendor) => vendor.id === id))[0]?.id ?? "",
    );
  }

  function selectEscrowVendor(id: string) {
    setEscrowVendorId(id);
    setEscrowAddressId(
      readAddresses(vendors.find((vendor) => vendor.id === id))[0]?.id ?? "",
    );
  }

  async function submitSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Recurring agreement created", async () => {
      setCycle(null);
      setSubscription(
        await createSubscription(token, organizationId, {
          vendorId: subscriptionVendorId,
          vendorAddressId: subscriptionAddressId,
          cadence,
          anchorDate,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          amount: subscriptionAmount,
          termsDocumentId: termsDocumentId || undefined,
        }),
      );
    });
  }

  async function activateSubscription() {
    if (!subscription) return toast.error("Create a recurring agreement first");
    await run("Recurring agreement activated", async () => {
      for (const action of subscription.ownerActions) {
        if (action.status !== "CONFIRMED") await signAction(action);
      }
      setSubscription((current) =>
        current ? { ...current, status: "ACTIVE" } : current,
      );
    });
  }

  async function submitCycle() {
    if (!subscription) return toast.error("Create a recurring agreement first");
    await run("Current billing cycle created", async () => {
      setCycle(
        await createSubscriptionCycle(token, organizationId, subscription.id, {
          servicePeriodStart: today,
        }),
      );
    });
  }

  async function changeStatus(operation: "pause" | "resume") {
    if (!subscription) return toast.error("Create a recurring agreement first");
    await run(`Recurring agreement ${operation === "pause" ? "paused" : "resumed"}`, async () => {
      await signAction(
        await changeSubscriptionStatus(
          token,
          organizationId,
          subscription.id,
          operation,
        ),
      );
      setSubscription((current) =>
        current
          ? { ...current, status: operation === "pause" ? "PAUSED" : "ACTIVE" }
          : current,
      );
    });
  }

  async function submitSubscriptionCancel() {
    if (!subscription) return toast.error("Create a recurring agreement first");
    await run("Recurring agreement cancelled", async () => {
      await signAction(
        await cancelSubscription(token, organizationId, subscription.id),
      );
      setSubscription((current) =>
        current ? { ...current, status: "CANCELLED" } : current,
      );
    });
  }

  async function submitEscrow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (
        milestones.some(
          (item) =>
            !item.title.trim() ||
            BigInt(parseDecimalToAtomic(item.amount, 6)) <= BigInt(0),
        )
      )
        return toast.error("Every milestone needs a title and positive amount");
    } catch {
      return toast.error("Enter valid milestone amounts");
    }
    await run("Milestone agreement created", async () => {
      const created = await createEscrowAgreement(token, organizationId, {
        vendorId: escrowVendorId,
        vendorAddressId: escrowAddressId,
        agreementDocumentId: agreementDocumentId || undefined,
        totalAmount: escrowTotal,
        milestones,
      });
      setAgreement(created);
      setSelectedMilestoneId(created.milestones[0]?.id ?? "");
    });
  }

  async function activateEscrow() {
    if (!agreement) return toast.error("Create a milestone agreement first");
    await run("Escrow setup confirmed", async () => {
      for (const action of agreement.ownerActions) {
        if (action.status !== "CONFIRMED") await signAction(action);
      }
      setAgreement((current) =>
        current ? { ...current, status: "CREATED" } : current,
      );
    });
  }

  async function submitFunding() {
    if (!agreement) return toast.error("Create a milestone agreement first");
    await run("Escrow funding approved", async () => {
      await signAction(await fundEscrow(token, organizationId, agreement.id));
      setAgreement((current) =>
        current ? { ...current, status: "FUNDING_APPROVED" } : current,
      );
    });
  }

  async function submitEvidence() {
    if (!selectedMilestone) return toast.error("Select a milestone first");
    if (!evidenceDocumentId) return toast.error("Select an evidence document");
    await run("Milestone evidence submitted", async () => {
      updateMilestone(
        await submitMilestoneEvidence(
          token,
          organizationId,
          selectedMilestone.id,
          evidenceDocumentId,
        ),
      );
    });
  }

  async function submitAccept() {
    if (!selectedMilestone) return toast.error("Select a milestone first");
    await run("Milestone accepted", async () => {
      await signAction(
        await acceptMilestone(token, organizationId, selectedMilestone.id),
      );
      updateMilestone({ ...selectedMilestone, status: "ACCEPTED" });
    });
  }

  async function submitDispute() {
    if (!selectedMilestone) return toast.error("Select a milestone first");
    if (!disputeReason.trim()) return toast.error("Enter a dispute reason");
    await run("Milestone disputed", async () => {
      await signAction(
        await disputeMilestone(
          token,
          organizationId,
          selectedMilestone.id,
          disputeReason,
        ),
      );
      updateMilestone({ ...selectedMilestone, status: "DISPUTED" });
    });
  }

  async function submitEscrowCancel() {
    if (!agreement) return toast.error("Create a milestone agreement first");
    await run("Agreement cancelled; refund submitted", async () => {
      await signAction(
        await cancelEscrow(
          token,
          organizationId,
          agreement.id,
          "Cancelled by owner",
        ),
      );
      setAgreement((current) =>
        current ? { ...current, status: "CANCELLED" } : current,
      );
    });
  }

  function updateMilestone(updated: EscrowMilestoneResponse) {
    setAgreement((current) =>
      current
        ? {
            ...current,
            milestones: current.milestones.map((item) =>
              item.id === updated.id ? updated : item,
            ),
          }
        : current,
    );
  }

  async function signAction(action: ChainActionResponse) {
    const transaction = await sendTransaction({
      to: action.to,
      data: action.data,
      chainId: action.chainId,
      value: 0,
    });
    await confirmLifecycleAction(
      token,
      organizationId,
      action.id,
      transaction.hash,
    );
  }

  async function run(success: string, work: () => Promise<void>) {
    setPending(true);
    try {
      await work();
      toast.success(success);
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : "Agreement action failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-5 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Payment agreements</p>
        <h3 className="mt-2 text-2xl font-semibold">Commit once. Pay by the rules.</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Create recurring mandates for predictable bills or milestone escrow for
          work that must be reviewed before funds are released.
        </p>
      </div>

      <div className="inline-flex rounded-xl bg-slate-200/70 p-1" role="tablist" aria-label="Agreement type">
        <AgreementTab active={view === "recurring"} onClick={() => setView("recurring")}>Recurring payments</AgreementTab>
        <AgreementTab active={view === "escrow"} onClick={() => setView("escrow")}>Milestone escrow</AgreementTab>
      </div>

      {view === "recurring" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <form onSubmit={submitSubscription} className="space-y-5 rounded-2xl bg-white p-5">
            <div>
              <h4 className="text-lg font-semibold">Subscription</h4>
              <p className="mt-1 text-sm text-slate-500">Define the vendor, schedule and maximum recurring amount.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Select label="Vendor" value={subscriptionVendorId} onChange={selectSubscriptionVendor} options={vendors.map((item) => ({ value: item.id, label: item.title }))} />
              <Select label="Verified payout address" value={subscriptionAddressId} onChange={setSubscriptionAddressId} options={subscriptionAddresses.map(addressOption)} />
              <Select label="Frequency" value={cadence} onChange={(value) => setCadence(value as Cadence)} options={cadenceOptions} />
              <Input label="First billing date" type="date" value={anchorDate} onChange={setAnchorDate} required />
              <Input label="Amount per cycle" suffix="USDC" inputMode="decimal" value={subscriptionAmount} onChange={setSubscriptionAmount} required />
              <Select label="Terms document (optional)" value={termsDocumentId} onChange={setTermsDocumentId} optional options={documents.map((item) => ({ value: item.id, label: item.title }))} />
            </div>
            <button disabled={pending || subscription !== null} className="btn">Create recurring agreement</button>
          </form>

          <AgreementProgress title="Recurring agreement" status={subscription?.status} empty="Create the agreement to review and activate its owner mandate.">
            {subscription ? (
              <>
                <SummaryRow label="Amount" value={`${formatAtomic(subscription.amountAtomic, 6)} USDC`} />
                <SummaryRow label="Frequency" value={subscription.cadence.toLowerCase()} />
                <SummaryRow label="First billing date" value={subscription.anchorDate} />
                <div className="grid gap-2 pt-2">
                  {subscription.status === "SETUP_REQUIRED" ? <button type="button" disabled={pending} onClick={activateSubscription} className="btn">Sign and activate mandate</button> : null}
                  {subscription.status === "ACTIVE" ? <button type="button" disabled={pending} onClick={submitCycle} className="btn-secondary">Create current billing cycle</button> : null}
                  {subscription.status === "ACTIVE" ? <button type="button" disabled={pending} onClick={() => changeStatus("pause")} className="btn-secondary">Pause recurring payments</button> : null}
                  {subscription.status === "PAUSED" ? <button type="button" disabled={pending} onClick={() => changeStatus("resume")} className="btn">Resume recurring payments</button> : null}
                </div>
                {cycle ? <div className="rounded-xl bg-emerald-50 p-3 text-sm"><strong>Current cycle created</strong><p className="mt-1 text-emerald-800">Due {new Date(cycle.dueAt).toLocaleDateString()} · {formatAtomic(cycle.amountAtomic, 6)} USDC</p></div> : null}
                {subscription.status !== "CANCELLED" ? <details className="border-t border-slate-200 pt-3"><summary className="cursor-pointer text-sm font-medium">Cancel agreement</summary><button type="button" disabled={pending} onClick={submitSubscriptionCancel} className="btn-secondary mt-3">Cancel recurring agreement</button></details> : null}
              </>
            ) : null}
          </AgreementProgress>
        </div>
      ) : (
        <div className="space-y-4">
          <form onSubmit={submitEscrow} className="rounded-2xl bg-white p-5">
            <div>
              <h4 className="text-lg font-semibold">Escrow agreement</h4>
              <p className="mt-1 text-sm text-slate-500">Split the work into milestones. The total is calculated from the amounts below.</p>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Select label="Vendor" value={escrowVendorId} onChange={selectEscrowVendor} options={vendors.map((item) => ({ value: item.id, label: item.title }))} />
              <Select label="Verified payout address" value={escrowAddressId} onChange={setEscrowAddressId} options={escrowAddresses.map(addressOption)} />
              <Select label="Agreement document (optional)" value={agreementDocumentId} onChange={setAgreementDocumentId} optional options={documents.map((item) => ({ value: item.id, label: item.title }))} />
              <div className="rounded-xl bg-slate-950 px-4 py-3 text-white"><span className="text-xs text-slate-300">Agreement total</span><strong className="mt-1 block text-xl">{escrowTotal} USDC</strong></div>
            </div>
            <div className="mt-5 space-y-3">
              <p className="text-sm font-semibold">Milestones</p>
              {milestones.map((item, index) => (
                <div key={index} className="grid gap-3 rounded-xl border border-slate-200 p-4 md:grid-cols-[auto_1fr_14rem] md:items-end">
                  <div className="flex items-center gap-2 md:block">
                    <span className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold">{index + 1}</span>
                    {milestones.length > 1 ? <button type="button" onClick={() => setMilestones((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="mt-2 text-xs font-medium text-slate-500 hover:text-red-700">Remove</button> : null}
                  </div>
                  <Input label="Milestone title" value={item.title} onChange={(value) => setMilestones((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, title: value } : entry))} required />
                  <Input label="Amount" suffix="USDC" inputMode="decimal" value={item.amount} onChange={(value) => setMilestones((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, amount: value } : entry))} required />
                </div>
              ))}
              {milestones.length < 5 ? <button type="button" onClick={() => setMilestones((current) => [...current, { title: `Milestone ${current.length + 1}`, amount: "0" }])} className="btn-secondary">Add milestone</button> : null}
            </div>
            <button disabled={pending || agreement !== null} className="btn mt-5">Create milestone agreement</button>
          </form>

          <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
            <AgreementProgress title="Escrow setup" status={agreement?.status} empty="Create the agreement before funding escrow or reviewing milestones.">
              {agreement ? (
                <>
                  <SummaryRow label="Total" value={`${formatAtomic(agreement.totalAmountAtomic, 6)} USDC`} />
                  <SummaryRow label="Milestones" value={String(agreement.milestones.length)} />
                  {agreement.status === "SETUP_REQUIRED" ? <button type="button" disabled={pending} onClick={activateEscrow} className="btn w-full">Sign escrow setup</button> : null}
                  {agreement.status === "CREATED" ? <button type="button" disabled={pending} onClick={submitFunding} className="btn w-full">Approve escrow funding</button> : null}
                  {agreement.status === "FUNDING_APPROVED" ? <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Funding is approved. The worker will confirm settlement onchain.</div> : null}
                  {agreement.status !== "CANCELLED" ? <details className="border-t border-slate-200 pt-3"><summary className="cursor-pointer text-sm font-medium">Cancel and refund</summary><button type="button" disabled={pending} onClick={submitEscrowCancel} className="btn-secondary mt-3">Cancel agreement and refund</button></details> : null}
                </>
              ) : null}
            </AgreementProgress>

            <section className="rounded-2xl bg-white p-5">
              <h4 className="font-semibold">Milestone review</h4>
              <p className="mt-1 text-sm text-slate-500">Attach evidence, then accept the work or open a dispute.</p>
              {agreement ? (
                <>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {agreement.milestones.map((item) => (
                      <button key={item.id} type="button" onClick={() => setSelectedMilestoneId(item.id)} className={`rounded-xl border p-4 text-left ${selectedMilestoneId === item.id ? "border-cyan-500 bg-cyan-50" : "border-slate-200"}`}>
                        <span className="text-xs text-slate-500">Milestone {item.milestoneIndex + 1}</span>
                        <strong className="mt-1 block">{item.title}</strong>
                        <span className="mt-2 flex justify-between text-sm"><span>{formatAtomic(item.amountAtomic, 6)} USDC</span><Status value={item.status} /></span>
                      </button>
                    ))}
                  </div>
                  {selectedMilestone ? (
                    <div className="mt-4 space-y-4 rounded-xl border border-slate-200 p-4">
                      <Select label="Evidence document" value={evidenceDocumentId} onChange={setEvidenceDocumentId} optional options={documents.map((item) => ({ value: item.id, label: item.title }))} />
                      <button type="button" disabled={pending || !evidenceDocumentId || selectedMilestone.status === "ACCEPTED"} onClick={submitEvidence} className="btn-secondary">Submit milestone evidence</button>
                      {selectedMilestone.status === "SUBMITTED" ? <div className="grid gap-3 border-t border-slate-200 pt-4 md:grid-cols-[auto_1fr_auto]"><button type="button" disabled={pending} onClick={submitAccept} className="btn">Accept and release</button><Input label="Reason if disputing" value={disputeReason} onChange={setDisputeReason} placeholder="Describe what needs review" /><button type="button" disabled={pending || !disputeReason.trim()} onClick={submitDispute} className="btn-secondary self-end">Open dispute</button></div> : null}
                    </div>
                  ) : null}
                </>
              ) : <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Milestones appear here after the agreement is created.</p>}
            </section>
          </div>
        </div>
      )}

      {recent.length ? (
        <section className="rounded-2xl bg-white p-5">
          <h4 className="font-semibold">Recent agreements</h4>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {recent.map((item) => <div key={item.id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-start justify-between gap-2"><strong className="text-sm">{item.title}</strong><Status value={item.status} /></div><p className="mt-2 text-xs text-slate-500">{item.subtitle}{item.amountAtomic && item.assetSymbol ? ` · ${formatAtomic(item.amountAtomic, 6)} ${item.assetSymbol}` : ""}</p></div>)}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function AgreementTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${active ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950"}`}>{children}</button>;
}

function AgreementProgress({ title, status, empty, children }: { title: string; status?: string; empty: string; children: React.ReactNode }) {
  return <aside className="space-y-4 rounded-2xl bg-white p-5"><div className="flex items-center justify-between gap-3"><h4 className="font-semibold">{title}</h4>{status ? <Status value={status} /> : null}</div>{status ? children : <p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm leading-6 text-slate-500">{empty}</p>}</aside>;
}

function Status({ value }: { value: string }) {
  return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">{value.replaceAll("_", " ")}</span>;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <p className="flex justify-between gap-3 text-sm"><span className="text-slate-500">{label}</span><strong className="text-right capitalize">{value}</strong></p>;
}

function Input({ label, value, onChange, required = false, type = "text", inputMode, suffix, placeholder }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string; inputMode?: "decimal"; suffix?: string; placeholder?: string }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<span className="relative mt-2 block"><input type={type} inputMode={inputMode} value={value} required={required} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100 ${suffix ? "pr-16" : ""}`} />{suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-slate-500">{suffix}</span> : null}</span></label>;
}

function Select({ label, value, onChange, options, optional = false }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; optional?: boolean }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<select value={value} required={!optional} onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"><option value="">{optional ? "None" : options.length ? "Choose…" : "No records available"}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

const cadenceOptions = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "ANNUAL", label: "Annual" },
];

function addressOption(item: { id: string; environment: string; assetSymbol: string; payoutAddress: string }) {
  return { value: item.id, label: `${item.environment} · ${item.assetSymbol} · ${shortAddress(item.payoutAddress)}` };
}

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function readAddresses(vendor: WorkspaceRecord | undefined): Array<{ id: string; environment: string; assetSymbol: string; payoutAddress: string }> {
  const addresses = vendor?.details.addresses;
  if (!Array.isArray(addresses)) return [];
  return addresses.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const address = item as Record<string, unknown>;
    return typeof address.id === "string" && typeof address.environment === "string" && typeof address.assetSymbol === "string" && typeof address.payoutAddress === "string" && address.status === "VERIFIED_ACTIVE"
      ? [{ id: address.id, environment: address.environment, assetSymbol: address.assetSymbol, payoutAddress: address.payoutAddress }]
      : [];
  });
}
