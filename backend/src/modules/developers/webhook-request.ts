import { lookup } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix);
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address);
  if (isIP(address) === 6)
    return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  return false;
}

export function postWebhook(
  value: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (isIP(hostname) && !isPublicAddress(hostname))
  )
    throw new Error('Webhook destination must be public HTTPS');
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers,
        agent: false,
        signal: AbortSignal.timeout(10_000),
        // Validate the addresses used by the socket, not a separate DNS lookup.
        lookup: (host, options, callback) => {
          lookup(host, { all: true }, (error, addresses) => {
            if (
              error ||
              !addresses.length ||
              addresses.some((item) => !isPublicAddress(item.address))
            ) {
              callback(
                error ??
                  new Error(
                    'Webhook destination resolves to a private network',
                  ),
                '',
                4,
              );
              return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error('Webhook redirects are not allowed'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            response.destroy(new Error('Webhook response exceeds 16 KiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 1000),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
