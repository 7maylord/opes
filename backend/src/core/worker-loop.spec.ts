import { runWorkerLoop } from './worker-loop';

it('drains in-flight work on shutdown without starting an overlapping run', async () => {
  const stop = new AbortController();
  let finish!: () => void;
  const work = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const error = jest.fn();
  const loop = runWorkerLoop(work, stop.signal, error);
  stop.abort();
  let drained = false;
  void loop.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await loop;
  expect(work).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});
