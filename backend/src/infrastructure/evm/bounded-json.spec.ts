import { readBoundedJson } from './bounded-json';

it('cancels an oversized stream before the rest can consume memory', async () => {
  const cancel = jest.fn();
  let reads = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel,
    }),
  );
  await expect(readBoundedJson(response, 2048)).rejects.toThrow('too large');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(reads).toBeLessThanOrEqual(4);
});
