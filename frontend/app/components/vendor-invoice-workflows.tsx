"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { useArcTransaction } from "@/lib/use-arc-transaction";
import { formatAtomic, parseDecimalToAtomic } from "@/lib/money";
import {
  addVendorAddress,
  approveDecision,
  createVendor,
  createVendorPortalAccess,
  evaluateInvoicePaymentWithAgent,
  executeDecision,
  extractInvoiceDocument,
  listWorkspaceRecords,
  matchInvoiceEvidence,
  overrideDecision,
  recordProcurementEvidence,
  uploadEvidenceDocument,
  verifyInvoice,
  verifyVendorAddress,
  prepareTreasuryAction,
  confirmLifecycleAction,
  confirmDocumentClaims,
  type DecisionApprovalResponse,
  type DocumentExtractionResponse,
  type EvidenceDocumentResponse,
  type PayableObligationResponse,
  type PaymentDecisionResponse,
  type PaymentExecutionResponse,
  type VendorAddressResponse,
  type VendorResponse,
  type VendorPortalAccessResponse,
} from "@/lib/api";
import type { WorkspaceRecord } from "@/lib/workspace-api.generated";

const arcUsdc = "0x3600000000000000000000000000000000000000";
const paymentRoutes = [
  { value: "OPERATING|arc-testnet|5042002|USDC", label: "Arc testnet · operating USDC" },
  { value: "GATEWAY|base-sepolia|84532|USDC", label: "Base Sepolia · Gateway USDC" },
  { value: "CCTP|base-sepolia|84532|USDC", label: "Base Sepolia · CCTP USDC" },
] as const;

export function VendorInvoiceWorkflows({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const sendTransaction = useArcTransaction();
  const [vendorName, setVendorName] = useState("");
  const [vendors, setVendors] = useState<WorkspaceRecord[]>([]);
  const [invoices, setInvoices] = useState<WorkspaceRecord[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState("");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [vendorDailyLimit, setVendorDailyLimit] = useState("100");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("100.00");
  const [invoiceDueDate, setInvoiceDueDate] = useState("");
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [purchaseOrderFile, setPurchaseOrderFile] = useState<File | null>(null);
  const [deliveryFile, setDeliveryFile] = useState<File | null>(null);
  const [paymentRoute, setPaymentRoute] = useState(paymentRoutes[0].value);
  const [vendor, setVendor] = useState<VendorResponse | null>(null);
  const [vendorEmail, setVendorEmail] = useState("");
  const [portalAccess, setPortalAccess] = useState<VendorPortalAccessResponse | null>(null);
  const [vendorAddress, setVendorAddress] = useState<VendorAddressResponse | null>(null);
  const [vendorAuthorized, setVendorAuthorized] = useState(false);
  const [document, setDocument] = useState<EvidenceDocumentResponse | null>(null);
  const [extraction, setExtraction] = useState<DocumentExtractionResponse | null>(null);
  const [claimsReviewed, setClaimsReviewed] = useState(false);
  const [obligation, setObligation] = useState<PayableObligationResponse | null>(null);
  const [decision, setDecision] = useState<PaymentDecisionResponse | null>(null);
  const [approval, setApproval] = useState<DecisionApprovalResponse | null>(null);
  const [execution, setExecution] = useState<PaymentExecutionResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<"vendor" | "invoice" | "decision">("vendor");
  const vendorReady = vendor !== null && vendorAddress?.status === "VERIFIED_ACTIVE";
  const unpaidInvoices = invoices.filter((item, index, all) => {
    const details = item.details as { obligationId?: string; vendorId?: string };
    return (
      details.vendorId === vendor?.id &&
      !["PAID", "CANCELLED"].includes(item.status) &&
      all.findIndex((candidate) => candidate.details.obligationId === details.obligationId) === index
    );
  });

  useEffect(() => {
    let cancelled = false;
    listWorkspaceRecords(token, organizationId, "vendor", { limit: 50 })
      .then((page) => { if (!cancelled) setVendors(page.items); })
      .catch((reason: unknown) => { if (!cancelled) toast.error(reason instanceof Error ? reason.message : "Unable to load vendors"); });
    listWorkspaceRecords(token, organizationId, "invoice", { limit: 50 })
      .then((page) => { if (!cancelled) setInvoices(page.items); })
      .catch((reason: unknown) => { if (!cancelled) toast.error(reason instanceof Error ? reason.message : "Unable to load invoices"); });
    return () => { cancelled = true; };
  }, [organizationId, token]);

  function selectVendor(id: string) {
    setSelectedVendorId(id);
    const record = vendors.find((item) => item.id === id);
    if (!record) {
      setVendor(null);
      setVendorAddress(null);
      return;
    }
    const details = record.details as { version?: number };
    setVendor({ id: record.id, displayName: record.title, status: record.status, version: details.version ?? 1, metadata: details });
    const address = readVendorAddresses(record).find((item) => item.status === "VERIFIED_ACTIVE") ?? readVendorAddresses(record)[0] ?? null;
    setVendorAddress(address);
    setVendorAuthorized(false);
    setPortalAccess(null);
    if (address?.status === "VERIFIED_ACTIVE") setStage("invoice");
  }

  async function submitVendor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Vendor recorded", async () => {
      const created = await createVendor(token, organizationId, { displayName: vendorName });
      setVendor(created);
      setSelectedVendorId(created.id);
    });
  }

  async function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (vendor === null) return toast.error("Create a vendor first.");
    await run("Vendor payout address recorded", async () => {
      setVendorAddress(
        await addVendorAddress(token, organizationId, vendor.id, {
          environment: "arc-testnet",
          chainId: 5042002,
          assetSymbol: "USDC",
          assetAddress: arcUsdc,
          payoutAddress,
        }),
      );
    });
  }

  async function createPortalAccess() {
    if (vendor === null) return toast.error("Create a vendor first.");
    await run("Vendor portal access created", async () => {
      setPortalAccess(await createVendorPortalAccess(token, organizationId, vendor.id, vendorEmail));
    });
  }

  async function submitAddressVerification() {
    if (vendorAddress === null) return toast.error("Add a payout address first.");
    await run("Vendor address verified", async () => {
      setVendorAddress(await verifyVendorAddress(token, organizationId, vendorAddress.id));
    });
  }

  async function submitVendorAuthorization() {
    if (vendorAddress?.status !== "VERIFIED_ACTIVE")
      return toast.error("Verify the payout address first.");
    await run("Vendor authorized for payment", async () => {
      const prepared = await prepareTreasuryAction(token, organizationId, {
        action: "SET_VENDOR",
        vendor: vendorAddress.payoutAddress,
        allowed: true,
        dailyAtomic: parseDecimalToAtomic(vendorDailyLimit, 6),
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
      setVendorAuthorized(true);
      setStage("invoice");
    });
  }

  async function submitDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invoiceFile === null) return toast.error("Choose an invoice file first.");
    await run("Invoice evidence recorded", async () => {
      setDocument(
        await uploadEvidenceDocument(token, organizationId, {
          documentType: "INVOICE",
          file: invoiceFile,
        }),
      );
    });
  }

  async function submitExtraction() {
    if (document === null) return toast.error("Record invoice evidence first.");
    await run("Invoice extracted for review", async () => {
      const extracted = await extractInvoiceDocument(token, organizationId, document.id);
      setExtraction(extracted);
      const output = extracted.output as {
        invoiceNumber?: string | null;
        amount?: string | null;
        dueDate?: string | null;
        payoutAddress?: string | null;
      };
      if (output.invoiceNumber) setInvoiceNumber(output.invoiceNumber);
      if (output.amount) setInvoiceAmount(output.amount);
      setInvoiceDueDate(/^\d{4}-\d{2}-\d{2}$/.test(output.dueDate ?? "") ? output.dueDate! : "");
      if (output.payoutAddress) setPayoutAddress(output.payoutAddress);
      setClaimsReviewed(false);
    });
  }

  async function submitInvoiceVerification() {
    if (vendor === null || vendorAddress === null || document === null || extraction === null) {
      return toast.error("Vendor, address and reviewed extraction are required.");
    }
    await run("Invoice staged for evidence matching", async () => {
      setObligation(
        await verifyInvoice(token, organizationId, {
          vendorId: vendor.id,
          vendorAddressId: vendorAddress.id,
          evidenceDocumentId: document.id,
          extractionId: extraction.id,
          invoiceNumber,
          currency: "USDC",
          amount: invoiceAmount,
          lineItems: [{ description: "Invoice total", amount: invoiceAmount }],
        }),
      );
      setStage("decision");
    });
  }

  function continueInvoice(record: WorkspaceRecord) {
    const details = record.details as {
      obligationId?: string;
      vendorAddressId?: string;
      evidenceDocumentId?: string;
      invoiceNumber?: string;
      version?: number;
    };
    const amount = formatAtomic(record.amountAtomic ?? "0", 6);
    setInvoiceNumber(details.invoiceNumber ?? record.title.replace(/^Invoice\s+/, ""));
    setInvoiceAmount(amount);
    setObligation({
      id: details.obligationId ?? record.id,
      versionId: record.id,
      version: details.version ?? 1,
      vendorId: vendor?.id ?? "",
      vendorAddressId: details.vendorAddressId ?? "",
      evidenceDocumentId: details.evidenceDocumentId ?? "",
      extractionId: null,
      invoiceNumber: details.invoiceNumber ?? record.title,
      currency: record.assetSymbol ?? "USDC",
      amountAtomic: record.amountAtomic ?? "0",
      amountDecimals: 6,
      obligationKey: "",
      contentHash: "",
      status: record.status,
    });
    setStage("decision");
  }

  async function submitClaimConfirmation() {
    if (document === null || extraction === null)
      return toast.error("Extract an invoice first.");
    await run("Invoice claims confirmed", async () => {
      const output = extraction.output as Record<string, unknown>;
      await confirmDocumentClaims(
        token,
        organizationId,
        document.id,
        extraction.id,
        {
          ...output,
          invoiceNumber,
          amount: invoiceAmount,
          dueDate: invoiceDueDate || null,
          payoutAddress,
          currency: "USDC",
        },
      );
      setExtraction({ ...extraction, reviewStatus: "CONFIRMED" });
      setClaimsReviewed(true);
    });
  }

  async function submitDecision() {
    if (obligation === null) return toast.error("Verify an invoice first.");
    if (obligation.status !== "ACCEPTED")
      return toast.error("Complete the purchase and delivery evidence match first.");
    await run("Decision dry run completed", async () => {
      const [liquidityRoute, environment, chainId, assetSymbol] = paymentRoute.split("|");
      setDecision(
        await evaluateInvoicePaymentWithAgent(token, organizationId, {
          invoiceVersionId: obligation.versionId,
          route: {
            liquidityRoute: liquidityRoute as "OPERATING" | "GATEWAY" | "CCTP",
            environment,
            chainId: Number(chainId),
            assetSymbol,
          },
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      );
    });
  }

  async function submitEvidenceMatch() {
    if (vendor === null || obligation === null)
      return toast.error("Verify an invoice first.");
    if (purchaseOrderFile === null || deliveryFile === null)
      return toast.error("Choose the purchase order and delivery receipt.");
    await run("Purchase and delivery evidence matched", async () => {
      const purchaseOrderDocument = await uploadEvidenceDocument(token, organizationId, {
        documentType: "OTHER",
        file: purchaseOrderFile,
      });
      const purchaseOrder = await recordProcurementEvidence(token, organizationId, {
        evidenceType: "PURCHASE_ORDER",
        vendorId: vendor.id,
        sourceReference: `PO-${invoiceNumber}`,
        currency: "USDC",
        totalAmount: invoiceAmount,
        evidenceDocumentId: purchaseOrderDocument.id,
        lineItems: [{ description: "Invoice total", quantity: "1", amount: invoiceAmount }],
      });
      const deliveryDocument = await uploadEvidenceDocument(token, organizationId, {
        documentType: "RECEIPT",
        file: deliveryFile,
      });
      const delivery = await recordProcurementEvidence(token, organizationId, {
        evidenceType: "PURCHASE_RECEIPT",
        vendorId: vendor.id,
        sourceReference: `RECEIPT-${invoiceNumber}`,
        currency: "USDC",
        totalAmount: invoiceAmount,
        governingSourceId: purchaseOrder.sourceId,
        evidenceDocumentId: deliveryDocument.id,
        lineItems: [{ description: "Invoice total", quantity: "1", amount: invoiceAmount }],
      });
      const match = await matchInvoiceEvidence(
        token,
        organizationId,
        obligation.versionId,
        purchaseOrder.sourceId,
        delivery.sourceId,
      );
      if (match.status !== "PASS")
        throw new Error(match.reasons.join(". ") || "Evidence did not match");
      setObligation({ ...obligation, status: "ACCEPTED" });
    });
  }

  async function submitApproval() {
    if (decision === null) return toast.error("Run a decision first.");
    await run("Decision approved", async () => {
      const result = await approveDecision(token, organizationId, decision.id);
      const transaction = await sendTransaction({to:result.ownerAction.to,data:result.ownerAction.data,chainId:result.ownerAction.chainId,value:0});
      await confirmLifecycleAction(token,organizationId,result.ownerAction.id,transaction.hash);
      setApproval(result);
    });
  }

  async function submitOverride(
    action: "PAY" | "DELAY" | "REJECT",
    reason: string,
    proposedExecutionAt: string | null,
  ) {
    if (decision === null) {
      toast.error("Generate a decision first.");
      return;
    }
    await run("Decision override recorded", async () => {
      setDecision(
        await overrideDecision(token, organizationId, decision.id, {
          action,
          reason,
          proposedExecutionAt,
        }),
      );
      setApproval(null);
      setExecution(null);
    });
  }

  async function submitExecution() {
    if (decision === null) return toast.error("Run a decision first.");
    await run("Execution requested", async () => {
      setExecution(await executeDecision(token, organizationId, decision.id));
    });
  }

  async function run(success: string, work: () => Promise<void>) {
    setPending(true);
    try {
      await work();
      toast.success(success);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Workflow failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-5 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Payables workspace</p><h3 className="mt-2 text-2xl font-semibold">From invoice to authorized payment</h3><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Establish the vendor, verify the invoice evidence, then review the agent’s decision before any funds move.</p></div>
      <div className="grid gap-2 sm:grid-cols-3" role="tablist" aria-label="Invoice workflow stage">
        <StageButton number="1" label="Vendor" active={stage === "vendor"} complete={vendorAuthorized} onClick={() => setStage("vendor")} />
        <StageButton number="2" label="Invoice evidence" active={stage === "invoice"} complete={obligation !== null} disabled={!vendorReady} onClick={() => setStage("invoice")} />
        <StageButton number="3" label="Decision & payment" active={stage === "decision"} complete={execution !== null} disabled={obligation === null} onClick={() => setStage("decision")} />
      </div>

      {stage === "vendor" ? <div className="grid gap-4 xl:grid-cols-2">
        <form onSubmit={submitVendor} className="space-y-4 rounded-2xl bg-white p-5"><div><h4 className="font-semibold">Vendor identity</h4><p className="mt-1 text-sm text-slate-500">Select an existing vendor or create a new counterparty.</p></div>{vendors.length > 0 ? <label className="block text-sm font-medium text-slate-700">Existing vendor<select value={selectedVendorId} onChange={(event) => selectVendor(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500"><option value="">Choose a vendor</option>{vendors.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : null}<div className="flex items-center gap-3 text-xs uppercase tracking-widest text-slate-400"><span className="h-px flex-1 bg-slate-200" />or create new<span className="h-px flex-1 bg-slate-200" /></div><Input label="Vendor name" value={vendorName} onChange={setVendorName} required={vendor === null} /><button disabled={pending || vendor !== null || !vendorName.trim()} className="btn">Create vendor</button>{vendor ? <StateCard label={vendor.displayName} status={vendor.status} /> : null}<div className="border-t border-slate-200 pt-4"><Input label="Vendor portal email" value={vendorEmail} onChange={setVendorEmail} /><p className="mt-2 text-xs text-slate-500">Creates a secure submission link for this vendor only.</p><button type="button" disabled={pending || vendor === null || !vendorEmail} onClick={createPortalAccess} className="btn-secondary mt-3">Generate portal link</button>{portalAccess ? <a className="mt-3 block break-all rounded-xl bg-cyan-50 p-3 text-sm font-semibold text-cyan-800" href={`/vendor/${portalAccess.token}`}>Open vendor portal ↗</a> : null}</div></form>
        <form onSubmit={submitAddress} className="space-y-4 rounded-2xl bg-white p-5" title="Verify a vendor wallet, then authorize its Arc USDC payment limit onchain."><div><h4 className="font-semibold">Payout destination</h4><p className="mt-1 text-sm text-slate-500">A verified existing payout address is enough to record invoice evidence. Onchain authorization is checked again only before payment.</p></div><Input label="Arc USDC payout address" value={payoutAddress} onChange={setPayoutAddress} required /><Input label="Vendor daily limit" suffix="USDC" value={vendorDailyLimit} onChange={setVendorDailyLimit} required /><div className="flex flex-wrap gap-2"><button disabled={pending || vendor === null || vendorAddress !== null} className="btn">Add address</button><button type="button" disabled={pending || vendorAddress === null || vendorAddress.status === "VERIFIED_ACTIVE"} onClick={submitAddressVerification} className="btn-secondary">Verify address</button><button type="button" disabled={pending || vendorAddress?.status !== "VERIFIED_ACTIVE" || vendorAuthorized} onClick={submitVendorAuthorization} className="btn-secondary">Authorize for payment</button></div>{vendorAddress ? <StateCard label={shortAddress(vendorAddress.payoutAddress)} status={vendorAuthorized ? "AUTHORIZED" : vendorAddress.status} /> : <EmptyState>Complete the vendor identity first, then add its payout wallet.</EmptyState>}</form>
      </div> : null}

      {stage === "invoice" ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4"><div className="rounded-2xl bg-white p-5"><div><h4 className="font-semibold">Unpaid invoices</h4><p className="mt-1 text-sm text-slate-500">Continue an existing invoice for this vendor.</p></div>{unpaidInvoices.length ? <div className="mt-4 space-y-2">{unpaidInvoices.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{item.title}</p><p className="mt-1 text-xs text-slate-500">{item.amountAtomic ? formatAtomic(item.amountAtomic, 6) : "0"} {item.assetSymbol ?? "USDC"}</p></div><div className="flex items-center gap-2"><Status value={item.status} /><button type="button" onClick={() => continueInvoice(item)} className="btn-secondary">Continue</button></div></div>)}</div> : <EmptyState>No unpaid invoices for this vendor.</EmptyState>}</div><form onSubmit={submitDocument} className="space-y-5 rounded-2xl bg-white p-5"><div><h4 className="font-semibold">New invoice evidence</h4><p className="mt-1 text-sm text-slate-500">Complete each step in order. Nothing becomes payable until you review the extracted details.</p></div><div><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-blue-700">1 · Upload source</p><label className="block rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm font-medium text-slate-700">Invoice file<input type="file" accept=".pdf,.json,.jpg,.jpeg,.png,.csv,.txt" required onChange={(event) => setInvoiceFile(event.target.files?.[0] ?? null)} className="mt-3 block w-full text-sm" /></label><button disabled={pending || document !== null} className="btn mt-3">Upload evidence</button></div><div className="border-t border-slate-200 pt-5"><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-blue-700">2 · Extract details</p><button type="button" disabled={pending || document === null || extraction !== null} onClick={submitExtraction} className="btn-secondary">Extract invoice</button></div>{extraction ? <div className="space-y-4 border-t border-slate-200 pt-5"><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">3 · Review claims</p><div className="grid gap-4 md:grid-cols-2"><Input label="Invoice number" value={invoiceNumber} onChange={setInvoiceNumber} required /><Input label="Invoice amount" suffix="USDC" value={invoiceAmount} onChange={setInvoiceAmount} required /><label className="block w-full text-sm font-medium text-slate-700">Due date <span className="font-normal text-slate-400">(optional)</span><input type="date" value={invoiceDueDate} onChange={(event) => setInvoiceDueDate(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2" /></label></div><button type="button" disabled={pending || !invoiceNumber || !invoiceAmount} onClick={submitClaimConfirmation} className="btn-secondary">Save reviewed claims</button></div> : null}<div className="border-t border-slate-200 pt-5"><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-blue-700">4 · Create invoice record</p><button type="button" disabled={pending || extraction === null || !claimsReviewed} onClick={submitInvoiceVerification} className="btn">Verify invoice</button>{extraction && !claimsReviewed ? <p className="mt-2 text-xs text-slate-500">Save the reviewed claims before verification.</p> : null}</div></form></div>
        <aside className="space-y-3 rounded-2xl bg-white p-5"><h4 className="font-semibold">Evidence status</h4>{document ? <StateCard label={document.filename} status={document.status} /> : <EmptyState>Your uploaded file and extraction status will appear here.</EmptyState>}{extraction ? <><StateCard label="Extracted claims" status={extraction.reviewStatus} /><SummaryRow label="Invoice" value={invoiceNumber || "—"} /><SummaryRow label="Amount" value={`${invoiceAmount} USDC`} /><SummaryRow label="Payout" value={payoutAddress ? shortAddress(payoutAddress) : "—"} /></> : null}{obligation ? <StateCard label="Payable obligation" status={obligation.status} /> : null}</aside>
      </div> : null}

      {stage === "decision" ? <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5 rounded-2xl bg-white p-5">{obligation?.status !== "ACCEPTED" ? <div className="space-y-4"><div><h4 className="font-semibold">Match purchase and delivery evidence</h4><p className="mt-1 text-sm text-slate-500">Upload the purchase order and the receipt proving that the goods or service were delivered. OPES checks both against the invoice before payment.</p></div><div className="grid gap-4 md:grid-cols-2"><EvidenceFile label="Purchase order" onChange={setPurchaseOrderFile} /><EvidenceFile label="Delivery receipt" onChange={setDeliveryFile} /></div><button type="button" disabled={pending || purchaseOrderFile === null || deliveryFile === null} onClick={submitEvidenceMatch} className="btn">Match evidence</button></div> : <><div><h4 className="font-semibold">Agent decision</h4><p className="mt-1 text-sm text-slate-500">Choose the payment route, then let OPES evaluate the invoice against treasury policy.</p></div><label className="block text-sm font-medium text-slate-700">Payment route<select value={paymentRoute} onChange={(event) => setPaymentRoute(event.target.value as typeof paymentRoute)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500">{paymentRoutes.map((route) => <option key={route.value} value={route.value}>{route.label}</option>)}</select></label><button disabled={pending} onClick={submitDecision} className="btn">Generate agent decision</button>{decision ? <DecisionSummary decision={decision} dueDate={invoiceDueDate} approval={approval} execution={execution} pending={pending} onApprove={submitApproval} onExecute={submitExecution} onOverride={submitOverride} /> : <EmptyState>No decision has been generated for this invoice.</EmptyState>}</>}</div>
        <aside className="space-y-3 rounded-2xl bg-slate-950 p-5 text-white"><h4 className="font-semibold">Payment state</h4><SummaryRow label="Invoice" value={invoiceNumber} dark /><SummaryRow label="Amount" value={`${invoiceAmount} USDC`} dark /><SummaryRow label="Decision" value={decision?.derivedAction ?? "Not generated"} dark /><SummaryRow label="Approval" value={approval?.status ?? "Waiting"} dark /><SummaryRow label="Execution" value={execution?.status ?? "Waiting"} dark />{execution?.transactionHash ? <p className="break-all rounded-xl bg-white/10 p-3 text-xs">{execution.transactionHash}</p> : null}</aside>
      </div> : null}
    </section>
  );
}

function Input({ label, value, onChange, required = false, suffix }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; suffix?: string }) {
  return (
    <label className="block w-full text-sm font-medium text-slate-700">
      {label}
      <span className="relative mt-2 block"><input value={value} inputMode={suffix ? "decimal" : undefined} required={required} onChange={(event) => onChange(event.target.value)} className={`min-h-11 w-full rounded-xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2 ${suffix ? "pr-16" : ""}`} />{suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-slate-500">{suffix}</span> : null}</span>
    </label>
  );
}

function EvidenceFile({ label, onChange }: { label: string; onChange: (file: File | null) => void }) {
  return <label className="block rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-medium text-slate-700">{label}<input type="file" accept=".pdf,.json,.jpg,.jpeg,.png,.csv,.txt" required onChange={(event) => onChange(event.target.files?.[0] ?? null)} className="mt-3 block w-full text-sm" /></label>;
}

function DecisionSummary({ decision, dueDate, approval, execution, pending, onApprove, onExecute, onOverride }: { decision: PaymentDecisionResponse; dueDate: string; approval: DecisionApprovalResponse | null; execution: PaymentExecutionResponse | null; pending: boolean; onApprove: () => void; onExecute: () => void; onOverride: (action: "PAY" | "DELAY" | "REJECT", reason: string, proposedExecutionAt: string | null) => Promise<void> }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideAction, setOverrideAction] = useState<"PAY" | "DELAY" | "REJECT">("PAY");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideAt, setOverrideAt] = useState("");
  const passed = decision.checks.filter((check) => check.status === "PASS").length;
  const attention = decision.checks.filter((check) => check.status !== "PASS");
  const action = decision.derivedAction;
  const title = action === "PAY" ? "Ready for autonomous payment" : action === "DELAY" ? "Payment deferred" : action === "ESCALATE" ? "Owner approval required" : "Payment blocked";
  const explanation = action === "PAY"
    ? "All required evidence and treasury controls permit payment now."
    : action === "DELAY"
      ? `The invoice is not due yet${dueDate ? ` (due ${new Date(`${dueDate}T00:00:00`).toLocaleDateString()})` : ""}, so the agent is preserving liquidity until the payment window.`
      : action === "ESCALATE"
        ? "The amount exceeds an autonomous policy limit and needs an authorized reviewer."
        : "One or more required controls blocked this payment.";
  return <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Decision summary</p><h5 className="mt-1 text-lg font-semibold">{title}</h5><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{explanation}</p></div><Status value={action} /></div><div className="grid gap-2 sm:grid-cols-3"><SummaryMetric label="Policy checks" value={`${passed}/${decision.checks.length} passed`} /><SummaryMetric label="Route" value={`${decision.routeEnvironment} · ${decision.routeAssetSymbol}`} /><SummaryMetric label="Approval" value={action === "ESCALATE" ? approval?.status ?? "Required" : "Not required"} /></div>{attention.length ? <div className="space-y-2">{attention.map((check) => <div key={check.code} className="rounded-xl bg-white p-3 text-sm"><div className="flex justify-between gap-3"><strong>{check.code.replaceAll("_", " ")}</strong><Status value={check.status} /></div><p className="mt-1 text-slate-500">{check.message}</p></div>)}</div> : null}<details><summary className="cursor-pointer text-sm font-semibold text-blue-700">View all {decision.checks.length} policy checks</summary><div className="mt-3 space-y-2">{decision.checks.map((check) => <div key={check.code} className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm"><span>{check.code.replaceAll("_", " ")}</span><Status value={check.status} /></div>)}</div></details><div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">{action === "PAY" ? <button disabled={pending || execution !== null} onClick={onExecute} className="btn">Request payment</button> : null}{action === "ESCALATE" ? <><button disabled={pending || approval !== null} onClick={onApprove} className="btn">Approve payment</button><button disabled={pending || approval === null || execution !== null} onClick={onExecute} className="btn-secondary">Request payment</button></> : null}{action === "DELAY" ? <p className="text-sm text-slate-600">No approval or payment action is required now.</p> : null}<button type="button" disabled={pending || execution !== null} onClick={() => setOverrideOpen((value) => !value)} className="btn-secondary">Override decision</button></div>{overrideOpen ? <form className="space-y-3 rounded-xl border border-blue-200 bg-white p-4" onSubmit={async (event) => { event.preventDefault(); await onOverride(overrideAction, overrideReason, overrideAction === "DELAY" ? new Date(overrideAt).toISOString() : null); setOverrideOpen(false); }}><label className="block text-sm font-medium text-slate-700">Override action<select value={overrideAction} onChange={(event) => setOverrideAction(event.target.value as typeof overrideAction)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4"><option value="PAY">Pay now</option><option value="DELAY">Reschedule</option><option value="REJECT">Reject</option></select></label>{overrideAction === "DELAY" ? <label className="block text-sm font-medium text-slate-700">New payment time<input type="datetime-local" required value={overrideAt} onChange={(event) => setOverrideAt(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-4" /></label> : null}<Input label="Reason for override" value={overrideReason} onChange={setOverrideReason} required /><button disabled={pending || !overrideReason.trim() || (overrideAction === "DELAY" && !overrideAt)} className="btn">Apply override</button></form> : null}</div>;
}

function SummaryMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>; }

function StageButton({ number, label, active, complete, disabled = false, onClick }: { number: string; label: string; active: boolean; complete: boolean; disabled?: boolean; onClick: () => void }) { return <button type="button" role="tab" aria-selected={active} disabled={disabled} onClick={onClick} className={`flex items-center gap-3 rounded-xl border p-3 text-left ${active ? "border-cyan-500 bg-white" : "border-transparent bg-slate-100"} disabled:opacity-45`}><span className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${complete ? "bg-emerald-600 text-white" : active ? "bg-cyan-600 text-white" : "bg-white text-slate-600"}`}>{complete ? "✓" : number}</span><span className="text-sm font-semibold">{label}</span></button>; }
function StateCard({ label, status }: { label: string; status: string }) { return <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm"><span className="min-w-0 truncate font-medium">{label}</span><Status value={status} /></div>; }
function EmptyState({ children }: { children: React.ReactNode }) { return <p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm leading-6 text-slate-500">{children}</p>; }
function Status({ value }: { value: string }) { const pass = ["PASS", "PAY", "ACCEPTED", "ACTIVE", "AUTHORIZED", "VERIFIED", "VERIFIED_ACTIVE", "CONFIRMED"].includes(value); const blocked = ["BLOCK", "REJECT", "REJECTED"].includes(value); return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase ${pass ? "bg-emerald-100 text-emerald-800" : blocked ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}>{value.replaceAll("_", " ")}</span>; }
function SummaryRow({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) { return <p className="flex justify-between gap-3 text-sm"><span className={dark ? "text-slate-400" : "text-slate-500"}>{label}</span><strong className="max-w-[65%] truncate text-right">{value}</strong></p>; }
function shortAddress(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }

function readVendorAddresses(vendor: WorkspaceRecord | undefined): VendorAddressResponse[] {
  const details = vendor?.details as { addresses?: VendorAddressResponse[] } | undefined;
  return Array.isArray(details?.addresses) ? details.addresses : [];
}
