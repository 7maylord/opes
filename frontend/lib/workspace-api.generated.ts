// Generated from backend/openapi.workspace.json. Do not edit.

export type WorkspaceKind = "vendor" | "evidence" | "invoice" | "decision" | "execution" | "subscription" | "escrow" | "ledger" | "audit";

export type WorkspaceRecord = {
  id: string;
  kind: WorkspaceKind;
  title: string;
  subtitle: string;
  status: string;
  amountAtomic: string | null;
  assetSymbol: string | null;
  chainId: number | null;
  transactionHash: string | null;
  createdAt: string;
  updatedAt: string;
  details: Record<string, unknown>;
};

export type WorkspacePage = {
  items: Array<WorkspaceRecord> ;
  nextCursor: string | null;
};

export type WorkspaceHistoryEvent = {
  id: string;
  eventType: string;
  status: string;
  transactionHash: string | null;
  createdAt: string;
  details: Record<string, unknown>;
};

export type WorkspaceDetail = {
  record: WorkspaceRecord;
  history: Array<WorkspaceHistoryEvent> ;
};

