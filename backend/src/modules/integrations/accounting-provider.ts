export type AccountingProvider = 'ODOO' | 'ERPNEXT';
export type AccountingRecordType =
  'VENDOR' | 'PURCHASE_ORDER' | 'PURCHASE_RECEIPT' | 'VENDOR_BILL';

export interface AccountingProviderConfig {
  provider: AccountingProvider;
  baseUrl: string;
  databaseName: string | null;
  credentials: OdooCredentials | ErpNextCredentials;
}

export interface OdooCredentials {
  apiKey: string;
}

export interface ErpNextCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface ImportedAccountingRecord {
  recordType: AccountingRecordType;
  externalId: string;
  providerUpdatedAt: string | null;
  normalizedData: Record<string, unknown>;
  rawData: Record<string, unknown>;
}

type Request = typeof fetch;

const ODOO_MODELS: ReadonlyArray<{
  recordType: AccountingRecordType;
  model: string;
  fields: string[];
  domain: unknown[];
}> = [
  {
    recordType: 'VENDOR',
    model: 'res.partner',
    fields: ['id', 'write_date', 'name', 'active', 'supplier_rank'],
    domain: [['supplier_rank', '>', 0]],
  },
  {
    recordType: 'PURCHASE_ORDER',
    model: 'purchase.order',
    fields: [
      'id',
      'write_date',
      'name',
      'state',
      'partner_id',
      'currency_id',
      'amount_total',
      'date_order',
      'order_line',
    ],
    domain: [],
  },
  {
    recordType: 'PURCHASE_RECEIPT',
    model: 'stock.picking',
    fields: [
      'id',
      'write_date',
      'name',
      'state',
      'partner_id',
      'origin',
      'scheduled_date',
      'date_done',
      'move_ids',
    ],
    domain: [['picking_type_code', '=', 'incoming']],
  },
  {
    recordType: 'VENDOR_BILL',
    model: 'account.move',
    fields: [
      'id',
      'write_date',
      'name',
      'state',
      'partner_id',
      'currency_id',
      'amount_total',
      'amount_residual',
      'invoice_date',
      'invoice_date_due',
      'invoice_origin',
      'payment_state',
      'invoice_line_ids',
    ],
    domain: [['move_type', '=', 'in_invoice']],
  },
];

const ERPNEXT_DOCTYPES: ReadonlyArray<{
  recordType: AccountingRecordType;
  doctype: string;
  fields: string[];
}> = [
  {
    recordType: 'VENDOR',
    doctype: 'Supplier',
    fields: ['name', 'modified', 'supplier_name', 'disabled'],
  },
  {
    recordType: 'PURCHASE_ORDER',
    doctype: 'Purchase Order',
    fields: [
      'name',
      'modified',
      'supplier',
      'status',
      'currency',
      'grand_total',
      'transaction_date',
    ],
  },
  {
    recordType: 'PURCHASE_RECEIPT',
    doctype: 'Purchase Receipt',
    fields: [
      'name',
      'modified',
      'supplier',
      'status',
      'currency',
      'grand_total',
      'posting_date',
    ],
  },
  {
    recordType: 'VENDOR_BILL',
    doctype: 'Purchase Invoice',
    fields: [
      'name',
      'modified',
      'supplier',
      'status',
      'currency',
      'grand_total',
      'outstanding_amount',
      'posting_date',
      'due_date',
      'bill_no',
    ],
  },
];

export async function fetchAccountingRecords(
  config: AccountingProviderConfig,
  cursor: Date | null,
  request: Request = fetch,
): Promise<ImportedAccountingRecord[]> {
  return config.provider === 'ODOO'
    ? fetchOdoo(config, cursor, request)
    : fetchErpNext(config, cursor, request);
}

export async function writeSettlementNote(
  config: AccountingProviderConfig,
  externalBillId: string,
  note: string,
  request: Request = fetch,
): Promise<string> {
  if (config.provider === 'ODOO') {
    if (!/^\d+$/.test(externalBillId))
      throw new Error('Odoo bill id must be numeric');
    const result = await jsonRequest(
      request,
      `${config.baseUrl}/json/2/account.move/message_post`,
      {
        method: 'POST',
        headers: odooHeaders(config),
        body: JSON.stringify({ ids: [Number(externalBillId)], body: note }),
      },
    );
    return scalarReference((result as { id?: unknown }).id, externalBillId);
  }

  const result = await jsonRequest(
    request,
    `${config.baseUrl}/api/resource/Comment`,
    {
      method: 'POST',
      headers: erpNextHeaders(config),
      body: JSON.stringify({
        comment_type: 'Comment',
        reference_doctype: 'Purchase Invoice',
        reference_name: externalBillId,
        content: note,
      }),
    },
  );
  const data = (result as { data?: { name?: unknown } }).data;
  return scalarReference(data?.name, externalBillId);
}

async function fetchOdoo(
  config: AccountingProviderConfig,
  cursor: Date | null,
  request: Request,
): Promise<ImportedAccountingRecord[]> {
  const records: ImportedAccountingRecord[] = [];
  for (const definition of ODOO_MODELS) {
    for (let offset = 0; offset < 10_000; offset += 100) {
      const domain = [...definition.domain];
      if (cursor) domain.push(['write_date', '>=', toOdooDate(cursor)]);
      const page = await jsonRequest(
        request,
        `${config.baseUrl}/json/2/${definition.model}/search_read`,
        {
          method: 'POST',
          headers: odooHeaders(config),
          body: JSON.stringify({
            domain,
            fields: definition.fields,
            limit: 100,
            offset,
            order: 'write_date,id',
          }),
        },
      );
      if (!Array.isArray(page))
        throw new Error(`Odoo ${definition.model} returned invalid data`);
      for (const raw of page) {
        const object = requireObject(raw, `Odoo ${definition.model} record`);
        records.push(normalizeOdoo(definition.recordType, object));
      }
      if (page.length < 100) break;
      if (offset === 9_900)
        throw new Error(`Odoo ${definition.model} exceeded sync limit`);
    }
  }
  return records;
}

async function fetchErpNext(
  config: AccountingProviderConfig,
  cursor: Date | null,
  request: Request,
): Promise<ImportedAccountingRecord[]> {
  const records: ImportedAccountingRecord[] = [];
  for (const definition of ERPNEXT_DOCTYPES) {
    for (let offset = 0; offset < 10_000; offset += 100) {
      const params = new URLSearchParams({
        fields: JSON.stringify(definition.fields),
        order_by: 'modified asc',
        limit_start: String(offset),
        limit_page_length: '100',
      });
      if (cursor)
        params.set(
          'filters',
          JSON.stringify([['modified', '>=', cursor.toISOString()]]),
        );
      const response = await jsonRequest(
        request,
        `${config.baseUrl}/api/resource/${encodeURIComponent(definition.doctype)}?${params}`,
        { method: 'GET', headers: erpNextHeaders(config) },
      );
      const page = (response as { data?: unknown }).data;
      if (!Array.isArray(page))
        throw new Error(`ERPNext ${definition.doctype} returned invalid data`);
      for (const raw of page) {
        const object = requireObject(
          raw,
          `ERPNext ${definition.doctype} record`,
        );
        records.push(normalizeErpNext(definition.recordType, object));
      }
      if (page.length < 100) break;
      if (offset === 9_900)
        throw new Error(`ERPNext ${definition.doctype} exceeded sync limit`);
    }
  }
  return records;
}

function normalizeOdoo(
  recordType: AccountingRecordType,
  raw: Record<string, unknown>,
): ImportedAccountingRecord {
  return {
    recordType,
    externalId: requireIdentifier(raw.id),
    providerUpdatedAt: optionalDate(raw.write_date),
    normalizedData: compact({
      name: raw.name,
      status: raw.state ?? (raw.active === false ? 'DISABLED' : 'ACTIVE'),
      vendor: manyToOneName(raw.partner_id),
      currency: manyToOneName(raw.currency_id),
      total: raw.amount_total,
      outstanding: raw.amount_residual,
      date: raw.date_order ?? raw.date_done ?? raw.invoice_date,
      dueDate: raw.invoice_date_due,
      source: raw.origin ?? raw.invoice_origin,
      paymentStatus: raw.payment_state,
      lineIds: raw.order_line ?? raw.move_ids ?? raw.invoice_line_ids,
    }),
    rawData: raw,
  };
}

function normalizeErpNext(
  recordType: AccountingRecordType,
  raw: Record<string, unknown>,
): ImportedAccountingRecord {
  return {
    recordType,
    externalId: requireIdentifier(raw.name),
    providerUpdatedAt: optionalDate(raw.modified),
    normalizedData: compact({
      name: raw.supplier_name ?? raw.name,
      status: raw.status ?? (raw.disabled ? 'DISABLED' : 'ACTIVE'),
      vendor: raw.supplier,
      currency: raw.currency,
      total: raw.grand_total,
      outstanding: raw.outstanding_amount,
      date: raw.transaction_date ?? raw.posting_date,
      dueDate: raw.due_date,
      source: raw.bill_no,
    }),
    rawData: raw,
  };
}

function odooHeaders(config: AccountingProviderConfig): Record<string, string> {
  const credentials = config.credentials;
  return compactHeaders({
    Authorization: `bearer ${credentials.apiKey}`,
    'Content-Type': 'application/json',
    'X-Odoo-Database': config.databaseName ?? undefined,
  });
}

function erpNextHeaders(
  config: AccountingProviderConfig,
): Record<string, string> {
  const credentials = config.credentials as ErpNextCredentials;
  return {
    Authorization: `token ${credentials.apiKey}:${credentials.apiSecret}`,
    'Content-Type': 'application/json',
  };
}

async function jsonRequest(
  request: Request,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await request(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(`Accounting provider returned HTTP ${response.status}`);
  return body;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(value: unknown): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim() === ''
  ) {
    throw new Error('Accounting record identifier is missing');
  }
  return String(value);
}

function optionalDate(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const date = new Date(
    value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`,
  );
  if (Number.isNaN(date.getTime()))
    throw new Error('Accounting record modified date is invalid');
  return date.toISOString();
}

function manyToOneName(value: unknown): unknown {
  return Array.isArray(value) ? value[1] : value;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== false,
    ),
  );
}

function compactHeaders(
  value: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function toOdooDate(value: Date): string {
  return value
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

function scalarReference(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : fallback;
}
