import { expect, test } from "@playwright/test";

test("vendor submits a correction without treasury access", async ({ page }) => {
  let submitted = false;
  await page.route("http://mock.api/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/upload")) return route.fulfill({ status: 200 });
    if (url.endsWith("/submissions/uploads")) return route.fulfill({ json: {
      submission: { id: "submission-2" },
      upload: { document: { status: "STAGING" }, uploadUrl: "http://mock.api/upload", uploadHeaders: {} },
    } });
    if (url.endsWith("/submissions/submission-2/finalize")) {
      submitted = true;
      return route.fulfill({ json: { id: "submission-2", documentId: "doc-2", rootSubmissionId: "submission-1", version: 2, status: "SUBMITTED", vendorNote: null, documentType: "INVOICE", filename: "invoice-v2.txt", createdAt: "2026-10-15T00:00:00Z", submittedAt: "2026-10-15T00:00:01Z" } });
    }
    if (url.endsWith("/submissions")) return route.fulfill({ json: submitted ? [
      { id: "submission-1", documentId: "doc-1", rootSubmissionId: "submission-1", version: 1, status: "SUPERSEDED", vendorNote: null, documentType: "INVOICE", filename: "invoice-v1.txt", createdAt: "2026-10-14T00:00:00Z", submittedAt: "2026-10-14T00:00:01Z" },
      { id: "submission-2", documentId: "doc-2", rootSubmissionId: "submission-1", version: 2, status: "SUBMITTED", vendorNote: null, documentType: "INVOICE", filename: "invoice-v2.txt", createdAt: "2026-10-15T00:00:00Z", submittedAt: "2026-10-15T00:00:01Z" },
    ] : [{ id: "submission-1", documentId: "doc-1", rootSubmissionId: "submission-1", version: 1, status: "SUBMITTED", vendorNote: null, documentType: "INVOICE", filename: "invoice-v1.txt", createdAt: "2026-10-14T00:00:00Z", submittedAt: "2026-10-14T00:00:01Z" }] });
    return route.fulfill({ json: { organizationName: "Alpha Co", vendorName: "Canteen Supplies", contactEmail: "billing@example.com", expiresAt: "2026-11-15T00:00:00Z" } });
  });
  await page.goto("/vendor/test-token");
  await expect(page.getByRole("heading", { name: "Canteen Supplies × Alpha Co" })).toBeVisible();
  await page.getByLabel("Correction of").selectOption("submission-1");
  await page.getByLabel("Invoice or supporting document").setInputFiles({ name: "invoice-v2.txt", mimeType: "text/plain", buffer: Buffer.from("corrected invoice") });
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("Document submitted for review.")).toBeVisible();
  await expect(page.getByText("SUPERSEDED")).toBeVisible();
  await expect(page.getByText("approve payments or change payout details")).toBeVisible();
});
