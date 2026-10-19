import {
  AccountingProviderConfig,
  fetchAccountingRecords,
  writeSettlementNote,
} from './accounting-provider';

function response(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function requestUrl(value: string | URL | Request): string {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.toString()
      : value.url;
}

describe('accounting providers', () => {
  it('imports fixed Odoo 19 models with JSON-2 bearer authentication', async () => {
    const requestMock = jest.fn(
      (...args: [string | URL | Request, RequestInit?]) => {
        const text = requestUrl(args[0]);
        const id = text.includes('res.partner')
          ? 1
          : text.includes('purchase.order')
            ? 2
            : text.includes('stock.picking')
              ? 3
              : 4;
        return Promise.resolve(
          response([
            {
              id,
              write_date: '2026-10-14 09:00:00',
              name: `R${id}`,
              state: 'done',
            },
          ]),
        );
      },
    );
    const request = requestMock as unknown as typeof fetch;
    const config: AccountingProviderConfig = {
      provider: 'ODOO',
      baseUrl: 'https://odoo.example',
      databaseName: 'tenant-db',
      credentials: { apiKey: 'odoo-key' },
    };

    const records = await fetchAccountingRecords(
      config,
      new Date('2026-10-13T00:00:00Z'),
      request,
    );

    expect(records.map((record) => record.recordType)).toEqual([
      'VENDOR',
      'PURCHASE_ORDER',
      'PURCHASE_RECEIPT',
      'VENDOR_BILL',
    ]);
    expect(requestMock).toHaveBeenCalledTimes(4);
    const [, init] = requestMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      Authorization: 'bearer odoo-key',
      'X-Odoo-Database': 'tenant-db',
    });
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '',
    ) as { domain: unknown[] };
    expect(body).toMatchObject({
      limit: 100,
      offset: 0,
      order: 'write_date,id',
    });
    expect(body.domain).toContainEqual([
      'write_date',
      '>=',
      '2026-10-13 00:00:00',
    ]);
  });

  it('imports fixed ERPNext DocTypes with token auth and a cursor', async () => {
    const requestMock = jest.fn(() =>
      Promise.resolve(
        response({
          data: [
            {
              name: 'DOC-1',
              modified: '2026-10-14 09:00:00',
              status: 'Submitted',
            },
          ],
        }),
      ),
    );
    const request = requestMock as unknown as typeof fetch;
    const config: AccountingProviderConfig = {
      provider: 'ERPNEXT',
      baseUrl: 'https://erp.example',
      databaseName: null,
      credentials: { apiKey: 'key', apiSecret: 'secret' },
    };

    const records = await fetchAccountingRecords(
      config,
      new Date('2026-10-13T00:00:00Z'),
      request,
    );

    expect(records).toHaveLength(4);
    const [url, init] = requestMock.mock.calls[0];
    expect(requestUrl(url)).toContain('/api/resource/Supplier?');
    expect(requestUrl(url)).toContain('filters=');
    expect(init?.headers).toMatchObject({ Authorization: 'token key:secret' });
  });

  it('writes settlement evidence as provider document comments', async () => {
    const requestMock = jest.fn(() =>
      Promise.resolve(response({ data: { name: 'COMMENT-1' } })),
    );
    const request = requestMock as unknown as typeof fetch;
    const reference = await writeSettlementNote(
      {
        provider: 'ERPNEXT',
        baseUrl: 'https://erp.example',
        databaseName: null,
        credentials: { apiKey: 'key', apiSecret: 'secret' },
      },
      'PINV-1',
      'settled',
      request,
    );
    expect(reference).toBe('COMMENT-1');
    const [url, init] = requestMock.mock.calls[0];
    expect(requestUrl(url)).toBe('https://erp.example/api/resource/Comment');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reference_doctype: 'Purchase Invoice',
      reference_name: 'PINV-1',
    });
  });

  it('paginates without losing records at the cursor boundary', async () => {
    const requestMock = jest.fn(
      (...args: [string | URL | Request, RequestInit?]) => {
        const url = requestUrl(args[0]);
        const body: unknown =
          typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : {};
        if (!url.includes('res.partner')) return Promise.resolve(response([]));
        const offset = Number((body as { offset?: unknown }).offset ?? 0);
        const records =
          offset === 0
            ? Array.from({ length: 100 }, (_, id) => ({
                id: id + 1,
                write_date: '2026-10-14 09:00:00',
                name: `Vendor ${id + 1}`,
              }))
            : [
                {
                  id: 101,
                  write_date: '2026-10-14 09:00:00',
                  name: 'Vendor 101',
                },
              ];
        return Promise.resolve(response(records));
      },
    );
    const records = await fetchAccountingRecords(
      {
        provider: 'ODOO',
        baseUrl: 'https://odoo.example',
        databaseName: null,
        credentials: { apiKey: 'key' },
      },
      new Date('2026-10-14T09:00:00Z'),
      requestMock,
    );
    expect(records).toHaveLength(101);
    expect(requestMock).toHaveBeenCalledTimes(5);
  });

  it('preserves cancellation status and rejects provider schema drift', async () => {
    const cancelled = jest.fn(() =>
      Promise.resolve(
        response([
          {
            id: 1,
            write_date: '2026-10-14 09:00:00',
            state: 'cancel',
          },
        ]),
      ),
    );
    const records = await fetchAccountingRecords(
      {
        provider: 'ODOO',
        baseUrl: 'https://odoo.example',
        databaseName: null,
        credentials: { apiKey: 'key' },
      },
      null,
      cancelled,
    );
    expect(
      records.every((record) => record.normalizedData.status === 'cancel'),
    ).toBe(true);

    await expect(
      fetchAccountingRecords(
        {
          provider: 'ERPNEXT',
          baseUrl: 'https://erp.example',
          databaseName: null,
          credentials: { apiKey: 'key', apiSecret: 'secret' },
        },
        null,
        jest.fn(() => Promise.resolve(response({ changed: true }))),
      ),
    ).rejects.toThrow('returned invalid data');
  });
});
