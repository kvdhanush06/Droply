import type { FileMeta } from './protocol';

/**
 * Source of file chunks for the sender. Implemented by a worker pool when
 * Web Workers are available and by direct main-thread slicing otherwise —
 * the transfer engine is agnostic to which one is in use.
 */
export interface ChunkSource {
  /** Reads up to `length` bytes at `offset`; returns an empty buffer at EOF. */
  read(file: FileMeta & { file: File }, offset: number, length: number): Promise<ArrayBuffer>;
  dispose(): void;
}

interface PendingRequest {
  resolve: (buffer: ArrayBuffer) => void;
  reject: (err: Error) => void;
  file: File;
  length: number;
}

/**
 * Worker-backed chunk reader. Requests are serialized per worker; a small
 * pool spreads concurrent reads of different files across threads.
 */
export class WorkerChunkSource implements ChunkSource {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<Worker, PendingRequest>();
  private nextIndex = 0;

  constructor(workerCount: number) {
    for (let i = 0; i < Math.max(1, workerCount); i += 1) {
      const worker = new Worker(new URL('./transferWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent) => {
        const response = event.data as { kind: string; requestId?: number; buffer?: ArrayBuffer; message?: string };
        const pending = this.pending.get(worker);
        if (!pending) return;
        this.pending.delete(worker);
        if (response.kind === 'error') {
          pending.reject(new Error(response.message ?? 'Worker read failed.'));
          return;
        }
        const buffer = response.buffer ?? new ArrayBuffer(0);
        pending.resolve(buffer);
      };
      worker.onerror = () => {
        const pending = this.pending.get(worker);
        if (pending) {
          this.pending.delete(worker);
          pending.reject(new Error('Worker crashed while reading.'));
        }
      };
      this.workers.push(worker);
    }
  }

  async read(entry: FileMeta & { file: File }, offset: number, length: number): Promise<ArrayBuffer> {
    const worker = this.workers[this.nextIndex % this.workers.length]!;
    this.nextIndex += 1;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(worker, { resolve, reject, file: entry.file, length });
      worker.postMessage({
        kind: 'read',
        requestId: Date.now() ^ Math.floor(Math.random() * 0xffffffff),
        file: entry.file,
        offset,
        length,
      });
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.pending.clear();
  }
}

/** Main-thread fallback with the same interface. */
export class InlineChunkSource implements ChunkSource {
  async read(entry: FileMeta & { file: File }, offset: number, length: number): Promise<ArrayBuffer> {
    const end = Math.min(offset + length, entry.file.size);
    if (offset >= end) return new ArrayBuffer(0);
    const slice = entry.file.slice(offset, end);
    return slice.arrayBuffer();
  }

  dispose(): void {
    /* nothing to release */
  }
}

/** True when the environment supports module workers. */
export function workersAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

export function createChunkSource(poolSize = 2): ChunkSource {
  if (workersAvailable()) {
    try {
      return new WorkerChunkSource(poolSize);
    } catch {
      /* fall through to inline */
    }
  }
  return new InlineChunkSource();
}
