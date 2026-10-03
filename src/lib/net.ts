/** Small networking helpers: timeouts, one retry, a worker pool and a start-time rate limiter. */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.status = status;
  }
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * fetch + body parsing inside one timed, retried unit. A slow or stalled server fails fast with a
 * readable message instead of hanging the pipeline. 429 and 5xx are retried once.
 */
async function run<T>(
  url: string,
  opts: RequestOptions,
  signal: AbortSignal | undefined,
  parse: (res: Response) => Promise<T>
): Promise<T> {
  const { timeoutMs = 20000, retries = 1, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortError();
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (res.ok) return await parse(res);
      const err = new HttpError(res.status, `${hostOf(url)} answered HTTP ${res.status}`);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = err;
        await delay(700 * (attempt + 1));
        continue;
      }
      throw err;
    } catch (e) {
      if (signal?.aborted) throw abortError();
      if (e instanceof HttpError) throw e;
      if (timedOut) {
        lastErr = new Error(`${hostOf(url)} did not answer within ${Math.round(timeoutMs / 1000)} s`);
      } else {
        lastErr = e;
      }
      if (attempt >= retries) throw lastErr;
      await delay(500);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

export function fetchJson<T = any>(url: string, opts: RequestOptions = {}, signal?: AbortSignal): Promise<T> {
  return run(url, opts, signal, (r) => r.json() as Promise<T>);
}

export function fetchText(url: string, opts: RequestOptions = {}, signal?: AbortSignal): Promise<string> {
  return run(url, opts, signal, (r) => r.text());
}

export const isAbortError = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/** Run fn over items with at most `limit` in flight, keeping result order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Job {
  priority: number;
  seq: number;
  signal?: AbortSignal;
  start: () => void;
  cancel: () => void;
}

/**
 * Spaces request *starts* by `intervalMs` without waiting for earlier requests to finish, so several
 * can be in flight at the permitted rate. Higher priority first, FIFO within a priority.
 */
export class RateLimiter {
  private queue: Job[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  private seq = 0;

  constructor(public intervalMs: number) {}

  schedule<T>(fn: () => Promise<T>, opts: { priority?: number; signal?: AbortSignal } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority: opts.priority ?? 0,
        seq: this.seq++,
        signal: opts.signal,
        start: () => {
          fn().then(resolve, reject);
        },
        cancel: () => reject(abortError()),
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0) return;
    const wait = Math.max(0, this.last + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      let job = this.queue.shift();
      while (job && job.signal?.aborted) {
        job.cancel();
        job = this.queue.shift();
      }
      if (job) {
        this.last = Date.now();
        job.start();
      }
      this.pump();
    }, wait);
  }
}
