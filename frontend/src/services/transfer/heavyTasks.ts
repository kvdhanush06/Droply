import type { WorkerRequest, WorkerResponse } from './transferWorker';

/**
 * Main-thread client for the heavy transfer-worker tasks that are not chunk
 * reads: ZIP creation (with per-file progress) and PBKDF2 password
 * derivation. Keeps multi-second work off the UI thread so the page never
 * freezes while preparing a large or password-protected batch.
 */

interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

let apiPromise: Promise<Client | null> | null = null;

interface Client {
  worker: Worker;
  pending: Map<number, PendingTask>;
}

let idCounter = 1;
function nextRequestId(): number {
  return idCounter++;
}

function spawnClient(): Promise<Client | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  try {
    const worker = new Worker(new URL('./transferWorker.ts', import.meta.url), { type: 'module' });
    const pending = new Map<number, PendingTask>();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const task = pending.get(response.requestId);
      if (!task) return;
      if (response.kind === 'error') {
        pending.delete(response.requestId);
        task.reject(new Error(response.message));
        return;
      }
      if (response.kind === 'zip-progress') {
        task.onProgress?.(response.done, response.total);
        return;
      }
      pending.delete(response.requestId);
      task.resolve(response.kind === 'zip' ? response.blob : response.kind === 'pbkdf2' ? response.bits : undefined);
    };
    worker.onerror = () => {
      for (const task of pending.values()) task.reject(new Error('Worker task failed.'));
      pending.clear();
    };
    return Promise.resolve({ worker, pending });
  } catch {
    return Promise.resolve(null);
  }
}

function getClient(): Promise<Client | null> {
  if (!apiPromise) apiPromise = spawnClient();
  return apiPromise;
}

function runTask<T>(
  message: WorkerRequest extends infer R ? R extends { requestId: number } ? Omit<R, 'requestId'> : never : never,
  onProgress?: (done: number, total: number) => void,
): Promise<T> {
  return (async () => {
    const client = await getClient();
    if (!client) throw new Error('Worker unavailable.');
    return new Promise<T>((resolve, reject) => {
      const requestId = nextRequestId();
      client.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      client.worker.postMessage({ ...message, requestId } as WorkerRequest);
    });
  })();
}

/**
 * Zips files in the worker, reporting per-file progress. Falls back to the
 * main thread when workers are unavailable.
 */
export async function zipInWorker(
  files: File[],
  names: string[],
  level: 0 | 6,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  try {
    return await runTask<Blob>({ kind: 'zip', files, names, level }, onProgress);
  } catch (err) {
    if (err instanceof Error && err.message === 'Worker unavailable.') {
      const { zipFilesWithProgress } = await import('./zip');
      return zipFilesWithProgress(files, names, level, onProgress);
    }
    throw err;
  }
}

/**
 * Derives PBKDF2-HMAC-SHA256 bits in the worker. Returns null when the
 * worker is unavailable so callers can fall back to synchronous derivation.
 */
export async function pbkdf2InWorker(
  password: string,
  salt: Uint8Array,
  iterations: number,
  outputBytes: number,
): Promise<Uint8Array | null> {
  try {
    return await runTask<Uint8Array>({ kind: 'pbkdf2', password, salt, iterations, outputBytes });
  } catch {
    return null;
  }
}
