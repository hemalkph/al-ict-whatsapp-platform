import { HandlerTimeoutError } from "./errors";

/**
 * Rejects with HandlerTimeoutError once `ms` elapsed, calling `onTimeout` first so a cooperative handler can stop. The
 * underlying work is NOT cancelled (it may still be running); its transaction cannot commit afterwards because the
 * fenced completion refuses once the event left PROCESSING or the signal is aborted. Its later rejection is swallowed
 * here because the caller already has an outcome.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new HandlerTimeoutError());
    }, ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
