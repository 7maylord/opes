import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns';
import { IncomingMessage } from 'node:http';
import { request, RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { isPublicAddress, postWebhook } from './webhook-request';
jest.mock('node:https', () => ({ request: jest.fn() }));
jest.mock('node:dns', () => ({ lookup: jest.fn() }));

describe('webhook network boundary', () => {
  afterEach(() => jest.resetAllMocks());
  it('rejects private DNS results at the socket lookup boundary', async () => {
    jest.mocked(lookup).mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (
        error: Error | null,
        addresses: Array<{ address: string; family: number }>,
      ) => void,
    ) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as never);
    jest.mocked(request).mockImplementation(((
      _url: URL,
      options: RequestOptions,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        end: () => {
          const resolve = options.lookup as (
            host: string,
            options: { all: boolean },
            callback: (error: Error | null) => void,
          ) => void;
          resolve('receiver.example', { all: true }, (error) =>
            req.emit('error', error),
          );
        },
      });
      return req;
    }) as never);
    await expect(
      postWebhook('https://receiver.example', '{}', {}),
    ).rejects.toThrow('private network');
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::',
  ])('rejects private and special addresses: %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['93.184.216.34', '2606:4700:4700::1111'])(
    'permits global address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
  function respond(status: number, size: number) {
    const response = Object.assign(new PassThrough(), { statusCode: status });
    jest.mocked(request).mockImplementation(((
      _url: URL,
      options: RequestOptions,
      receive: (res: IncomingMessage) => void,
    ) => {
      expect(options.agent).toBe(false);
      expect(options.lookup).toBeDefined();
      return Object.assign(new EventEmitter(), {
        end: () => {
          receive(response as unknown as IncomingMessage);
          queueMicrotask(() => response.end(Buffer.alloc(size)));
        },
      });
    }) as never);
  }
  it('rejects redirects without making another request', async () => {
    respond(307, 0);
    await expect(postWebhook('https://example.com', '{}', {})).rejects.toThrow(
      'redirects',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('aborts oversized bodies instead of buffering them before truncation', async () => {
    respond(200, 16_385);
    await expect(postWebhook('https://example.com', '{}', {})).rejects.toThrow(
      '16 KiB',
    );
  });
  it('rejects private literal destinations before opening a socket', () => {
    expect(() => postWebhook('https://[::ffff:127.0.0.1]/', '{}', {})).toThrow(
      'public HTTPS',
    );
    expect(request).not.toHaveBeenCalled();
  });
});
