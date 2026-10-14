"use client";

import { FormEvent, useState } from "react";
import { useSendTransaction } from "@privy-io/react-auth";
import {
  addVendorAddress,
  approveDecision,
  createVendor,
  evaluateInvoicePaymentWithAgent,
  executeDecision,
  extractInvoiceDocument,
  uploadEvidenceDocument,
  verifyInvoice,
  verifyVendorAddress,
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
} from "@/lib/api";

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
  const { sendTransaction } = useSendTransaction();
  const [vendorName, setVendorName] = useState("");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("100.00");
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [paymentRoute, setPaymentRoute] = useState(paymentRoutes[0].value);
  const [vendor, setVendor] = useState<VendorResponse | null>(null);
  const [vendorAddress, setVendorAddress] = useState<VendorAddressResponse | null>(null);
  const [document, setDocument] = useState<EvidenceDocumentResponse | null>(null);
  const [extraction, setExtraction] = useState<DocumentExtractionResponse | null>(null);
  const [obligation, setObligation] = useState<PayableObligationResponse | null>(null);
  const [decision, setDecision] = useState<PaymentDecisionResponse | null>(null);
  const [approval, setApproval] = useState<DecisionApprovalResponse | null>(null);
  const [execution, setExecution] = useState<PaymentExecutionResponse | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submitVendor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("Vendor recorded", async () => {
      setVendor(await createVendor(token, organizationId, { displayName: vendorName }));
    });
  }

  async function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (vendor === null) return setError("Create a vendor first.");
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

  async function submitAddressVerification() {
    if (vendorAddress === null) return setError("Add a payout address first.");
    await run("Vendor address verified", async () => {
      setVendorAddress(await verifyVendorAddress(token, organizationId, vendorAddress.id));
    });
  }

  async function submitDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invoiceFile === null) return setError("Choose an invoice file first.");
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
    if (document === null) return setError("Record invoice evidence first.");
    await run("Invoice extracted for review", async () => {
      const extracted = await extractInvoiceDocument(token, organizationId, document.id);
      setExtraction(extracted);
      const output = extracted.output as {
        invoiceNumber?: string | null;
        amount?: string | null;
        payoutAddress?: string | null;
      };
      if (output.invoiceNumber) setInvoiceNumber(output.invoiceNumber);
      if (output.amount) setInvoiceAmount(output.amount);
      if (output.payoutAddress) setPayoutAddress(output.payoutAddress);
    });
  }

  async function submitInvoiceVerification() {
    if (vendor === null || vendorAddress === null || document === null || extraction === null) {
      return setError("Vendor, address and reviewed extraction are required.");
    }
    await run("Invoice verified", async () => {
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
    });
  }

  async function submitClaimConfirmation() {
    if (document === null || extraction === null)
      return setError("Extract an invoice first.");
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
          payoutAddress,
          currency: "USDC",
        },
      );
      setExtraction({ ...extraction, reviewStatus: "CONFIRMED" });
    });
  }

  async function submitDecision() {
    if (obligation === null) return setError("Verify an invoice first.");
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

  async function submitApproval() {
    if (decision === null) return setError("Run a decision first.");
    await run("Decision approved", async () => {
      const result = await approveDecision(token, organizationId, decision.id);
      const transaction = await sendTransaction({to:result.ownerAction.to,data:result.ownerAction.data,chainId:result.ownerAction.chainId,value:0});
      await confirmLifecycleAction(token,organizationId,result.ownerAction.id,transaction.hash);
      setApproval(result);
    });
  }

  async function submitExecution() {
    if (decision === null) return setError("Run a decision first.");
    await run("Execution requested", async () => {
      setExecution(await executeDecision(token, organizationId, decision.id));
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
      setError(reason instanceof Error ? reason.message : "Workflow failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="font-semibold">Invoice and vendor workflow</h3>
      <p className="mt-2 text-sm text-slate-600">
        Create the vendor source, record evidence, compare the decision checks,
        then approve and request execution through backend-controlled routes.
      </p>
      {error !== "" ? <Notice tone="error" text={error} /> : null}
      {message !== "" ? <Notice tone="success" text={message} /> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <form onSubmit={submitVendor} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">1. Vendor</h4>
          <Input label="Vendor name" value={vendorName} onChange={setVendorName} required />
          <button disabled={pending} className="btn">Create vendor</button>
          <Result value={vendor} />
        </form>

        <form onSubmit={submitAddress} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">2. Payout address</h4>
          <Input label="Arc USDC payout address" value={payoutAddress} onChange={setPayoutAddress} required />
          <button disabled={pending} className="btn">Add address</button>
          <button type="button" disabled={pending || vendorAddress === null} onClick={submitAddressVerification} className="btn-secondary">
            Verify address
          </button>
          <Result value={vendorAddress} />
        </form>

        <form onSubmit={submitDocument} className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">3. Invoice evidence</h4>
          <Input label="Invoice number" value={invoiceNumber} onChange={setInvoiceNumber} required />
          <Input label="Invoice amount USDC" value={invoiceAmount} onChange={setInvoiceAmount} required />
          <label className="block text-sm font-medium text-slate-700">
            Invoice file
            <input type="file" accept=".pdf,.json,.jpg,.jpeg,.png,.csv,.txt" required onChange={(event) => setInvoiceFile(event.target.files?.[0] ?? null)} className="mt-2 block w-full text-sm" />
          </label>
          <button disabled={pending} className="btn">Upload and verify document</button>
          <button type="button" disabled={pending || document === null} onClick={submitExtraction} className="btn-secondary">
            Extract invoice
          </button>
          <Result value={document ?? extraction} />
        </form>

        <div className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">4. Verify, decide, approve</h4>
          <label className="block text-sm font-medium text-slate-700">Payment route<select value={paymentRoute} onChange={(event) => setPaymentRoute(event.target.value as typeof paymentRoute)} className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500">{paymentRoutes.map((route) => <option key={route.value} value={route.value}>{route.label}</option>)}</select></label>
          <button disabled={pending || extraction === null || extraction.reviewStatus !== "CONFIRMED"} onClick={submitInvoiceVerification} className="btn">Verify invoice</button>
          {extraction?.reviewStatus === "PENDING_REVIEW" ? (
            <button disabled={pending} onClick={submitClaimConfirmation} className="btn-secondary">Confirm extracted claims</button>
          ) : null}
          <button disabled={pending || obligation === null} onClick={submitDecision} className="btn-secondary">Generate agent decision</button>
          <button disabled={pending || decision === null} onClick={submitApproval} className="btn-secondary">Approve</button>
          <button disabled={pending || approval === null} onClick={submitExecution} className="btn-secondary">Request execution</button>
          <Result value={execution ?? approval ?? decision ?? obligation} />
        </div>
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
  const entries = Object.entries(value as Record<string, unknown>).filter(([key, item]) => !["metadata", "providerPayload", "ownerAction", "ownerActions"].includes(key) && item !== null && typeof item !== "object").slice(0, 8);
  return <dl className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">{entries.map(([key, item]) => <div key={key} className="flex justify-between gap-3"><dt className="text-slate-500">{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd className="max-w-[60%] truncate font-medium">{String(item)}</dd></div>)}</dl>;
}

function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  return <p className={tone === "error" ? "mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" : "mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"}>{text}</p>;
}
