"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  addVendorAddress,
  approveDecision,
  createVendor,
  evaluateInvoicePayment,
  executeDecision,
  recordDocumentExtraction,
  recordEvidenceDocument,
  verifyInvoice,
  verifyVendorAddress,
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

export function VendorInvoiceWorkflows({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const [vendorName, setVendorName] = useState("");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("100.00");
  const [invoiceHash, setInvoiceHash] = useState("");
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

  const extractionOutput = useMemo(
    () => ({
      vendorName: vendor?.displayName ?? vendorName,
      invoiceNumber,
      currency: "USDC",
      amount: invoiceAmount,
      payoutAddress,
    }),
    [invoiceAmount, invoiceNumber, payoutAddress, vendor?.displayName, vendorName],
  );

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
    await run("Invoice evidence recorded", async () => {
      setDocument(
        await recordEvidenceDocument(token, organizationId, {
          documentType: "INVOICE",
          filename: `${invoiceNumber || "invoice"}.pdf`,
          contentType: "application/pdf",
          sizeBytes: 1024,
          sha256Hex: invoiceHash,
          storageKey: `invoices/${invoiceHash}.pdf`,
        }),
      );
    });
  }

  async function submitExtraction() {
    if (document === null) return setError("Record invoice evidence first.");
    await run("Extraction provenance recorded", async () => {
      setExtraction(
        await recordDocumentExtraction(token, organizationId, document.id, {
          schemaName: "invoice",
          schemaVersion: "1",
          modelProvider: "manual-demo",
          modelName: "human-entered",
          sourceSha256Hex: document.sha256Hex,
          output: extractionOutput,
        }),
      );
    });
  }

  async function submitInvoiceVerification() {
    if (vendor === null || vendorAddress === null || document === null) {
      return setError("Vendor, address and evidence are required.");
    }
    await run("Invoice verified", async () => {
      setObligation(
        await verifyInvoice(token, organizationId, {
          vendorId: vendor.id,
          vendorAddressId: vendorAddress.id,
          evidenceDocumentId: document.id,
          extractionId: extraction?.id,
          invoiceNumber,
          currency: "USDC",
          amount: invoiceAmount,
          lineItems: [{ description: "Invoice total", amount: invoiceAmount }],
        }),
      );
    });
  }

  async function submitDecision() {
    if (obligation === null) return setError("Verify an invoice first.");
    await run("Decision dry run completed", async () => {
      setDecision(
        await evaluateInvoicePayment(token, organizationId, {
          invoiceVersionId: obligation.versionId,
          modelAction: "PAY",
          modelName: "manual-demo",
          modelRationale: "Invoice matched vendor, payout address and evidence.",
          promptVersion: "frontend-f2",
          route: {
            liquidityRoute: "OPERATING",
            environment: "arc-testnet",
            chainId: 5042002,
            assetSymbol: "USDC",
          },
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      );
    });
  }

  async function submitApproval() {
    if (decision === null) return setError("Run a decision first.");
    await run("Decision approved", async () => {
      setApproval(await approveDecision(token, organizationId, decision.id));
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
          <Input label="Evidence SHA-256 hex" value={invoiceHash} onChange={setInvoiceHash} required />
          <button disabled={pending} className="btn">Record document</button>
          <button type="button" disabled={pending || document === null} onClick={submitExtraction} className="btn-secondary">
            Record extraction
          </button>
          <Result value={document ?? extraction} />
        </form>

        <div className="space-y-3 rounded-2xl bg-white p-4">
          <h4 className="font-semibold">4. Verify, decide, approve</h4>
          <button disabled={pending} onClick={submitInvoiceVerification} className="btn">Verify invoice</button>
          <button disabled={pending || obligation === null} onClick={submitDecision} className="btn-secondary">Dry-run decision</button>
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
  return <pre className="max-h-52 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(value, null, 2)}</pre>;
}

function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  return <p className={tone === "error" ? "mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" : "mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"}>{text}</p>;
}
