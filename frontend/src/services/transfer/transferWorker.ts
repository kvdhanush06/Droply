/// <reference lib="webworker" />
import { zipFilesWithProgress } from './zip';
import { pbkdf2Sha256 } from './jsCrypto';

/**
 * Transfer worker: chunk reading, zip creation and (insecure-context)
 * PBKDF2 password derivation off the main thread.
 *
 * One request in, one response out. Chunk reads transfer ownership of the
 * ArrayBuffer back to the main thread with zero copies; zip reports per-file
 * progress so the UI stays live; PBKDF2 (250k iterations) keeps the page
 * responsive while the password handshake runs.
 */

export type WorkerRequest =
  | {
      kind: 'read';
      requestId: number;
      file: File;
      offset: number;
      length: number;
    }
  | {
      kind: 'zip';
      requestId: number;
      files: File[];
      names: string[];
      level: 0 | 6;
    }
  | {
      kind: 'pbkdf2';
      requestId: number;
      password: string;
      salt: Uint8Array;
      iterations: number;
      outputBytes: number;
    };

export type WorkerResponse =
  | { kind: 'read'; requestId: number; buffer: ArrayBuffer; byteLength: number }
  | { kind: 'zip'; requestId: number; blob: Blob }
  | { kind: 'zip-progress'; requestId: number; done: number; total: number }
  | { kind: 'pbkdf2'; requestId: number; bits: Uint8Array }
  | { kind: 'error'; requestId: number; message: string };

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  void (async () => {
    try {
      if (request.kind === 'read') {
        const { file, offset, length, requestId } = request;
        if (offset < 0 || length <= 0) throw new Error('Invalid read range.');
        const end = Math.min(offset + length, file.size);
        if (offset >= end) {
          const response: WorkerResponse = {
            kind: 'read',
            requestId,
            buffer: new ArrayBuffer(0),
            byteLength: 0,
          };
          ctx.postMessage(response);
          return;
        }
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();
        const response: WorkerResponse = { kind: 'read', requestId, buffer, byteLength: buffer.byteLength };
        ctx.postMessage(response, [buffer]);
        return;
      }

      if (request.kind === 'zip') {
        const requestId = request.requestId;
        const blob = await zipFilesWithProgress(request.files, request.names, request.level, (done, total) => {
          const progress: WorkerResponse = { kind: 'zip-progress', requestId, done, total };
          ctx.postMessage(progress);
        });
        const response: WorkerResponse = { kind: 'zip', requestId, blob };
        ctx.postMessage(response);
        return;
      }

      if (request.kind === 'pbkdf2') {
        const requestId = request.requestId;
        const bits = pbkdf2Sha256(
          new TextEncoder().encode(request.password),
          request.salt,
          request.iterations,
          request.outputBytes,
        );
        const response: WorkerResponse = { kind: 'pbkdf2', requestId, bits };
        ctx.postMessage(response, [bits.buffer]);
        return;
      }
    } catch (err) {
      const response: WorkerResponse = {
        kind: 'error',
        requestId: 'requestId' in request ? request.requestId : -1,
        message: err instanceof Error ? err.message : 'Worker task failed.',
      };
      ctx.postMessage(response);
    }
  })();
};
