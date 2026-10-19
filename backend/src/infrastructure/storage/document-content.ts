import { BadRequestException } from '@nestjs/common';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export function assertDocumentContentType(
  bytes: Uint8Array,
  declaredType: string,
): void {
  const declared = declaredType.toLowerCase();
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return requireType(declared, 'application/pdf');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return requireType(declared, 'image/png');
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return requireType(declared, 'image/jpeg');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestException('Document bytes do not match content type');
  }
  if (
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
      );
    })
  )
    throw new BadRequestException('Document bytes do not match content type');
  if (declared === 'application/json') {
    try {
      JSON.parse(text);
    } catch {
      throw new BadRequestException('Document bytes are not valid JSON');
    }
    return;
  }
  if (declared !== 'text/plain' && declared !== 'text/csv')
    throw new BadRequestException('Document bytes do not match content type');
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function requireType(actual: string, expected: string): void {
  if (actual !== expected)
    throw new BadRequestException('Document bytes do not match content type');
}
