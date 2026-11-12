import { setTimeout } from 'node:timers/promises';

export async function runWorkerLoop(
  work: () => Promise<unknown>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
) {
  while (!signal.aborted) {
    try {
      await work();
    } catch (error) {
      onError(error);
    }
    try {
      await setTimeout(10_000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
