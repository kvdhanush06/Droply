import { Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';

/** Zip creation runs fully in-browser; no size limit beyond available memory. */
export function isZipSupported(): boolean {
  return typeof zipSync === 'function';
}

/**
 * Zips the given files into a single archive on the fly (small batches only).
 * Entry names must already be sanitized by the caller (no traversal).
 */
export async function fflateZip(files: File[], names: string[], level: 0 | 6): Promise<Blob> {
  if (files.length !== names.length) {
    throw new Error('Zip input mismatch between files and names.');
  }
  if (files.length === 0) {
    throw new Error('Nothing to zip.');
  }
  const tree: Zippable = {};
  const used = new Set<string>();
  for (let i = 0; i < files.length; i += 1) {
    let name = names[i]!;
    if (!name || name === '.' || name === '..') name = 'file';
    let final = name;
    for (let n = 2; used.has(final); n += 1) {
      final = `${name} (${n})`;
    }
    used.add(final);
    tree[final] = new Uint8Array(await files[i]!.arrayBuffer());
  }
  const zipped = zipSync(tree, { level });
  return new Blob([zipped], { type: 'application/zip' });
}

/* ------------------------------------------------------------------ */
/* Streaming zip with progress                                         */
/* ------------------------------------------------------------------ */

/** Yields to the event loop so a worker (or page) stays responsive. */
const yieldToEvent = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Files are fed to the compressor in slices of this size. */
const ZIP_SLICE_BYTES = 8 * 1024 * 1024;

/**
 * Zips files into a single archive WITHOUT holding every raw input in
 * memory: each file is streamed through the compressor slice by slice and
 * released before the next one is read. Reports per-file progress so the UI
 * can show a live indicator instead of a frozen page.
 *
 * Runs synchronously per slice (via fflate's streaming `Zip`), so it is safe
 * to call inside a Web Worker — which is exactly where the transfer engine
 * runs it. On the main-thread fallback the yields between slices keep the
 * page responsive.
 *
 * Entry names must already be sanitized by the caller (no traversal).
 */
export async function zipFilesWithProgress(
  files: File[],
  names: string[],
  level: 0 | 6,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  if (files.length !== names.length) {
    throw new Error('Zip input mismatch between files and names.');
  }
  if (files.length === 0) {
    throw new Error('Nothing to zip.');
  }

  const chunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  // Resolved when the `Zip` stream emits its final chunk (after end()).
  let finishZip!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishZip = resolve;
  });
  const zipper = new Zip((err, data, final) => {
    if (err) {
      zipError = new Error(err.message || 'Zip compression failed.');
      finishZip();
      return;
    }
    if (!zipError && data.length > 0) chunks.push(data);
    if (final) finishZip();
  });
  // The Zip stream is synchronous for sync sub-streams: by the time end()
  // returns, every chunk (including the central directory) has been emitted.
  // `finished` still guards against exotic async timing.

  const used = new Set<string>();
  for (let i = 0; i < files.length; i += 1) {
    if (zipError) throw zipError;
    let name = names[i]!;
    if (!name || name === '.' || name === '..') name = 'file';
    let final = name;
    for (let n = 2; used.has(final); n += 1) {
      final = `${name} (${n})`;
    }
    used.add(final);

    const file = files[i]!;
    const stream =
      level === 0
        ? new ZipPassThrough(final)
        : new ZipDeflate(final, { level });
    zipper.add(stream);

    for (let offset = 0; offset < file.size; offset += ZIP_SLICE_BYTES) {
      const slice = file.slice(offset, Math.min(offset + ZIP_SLICE_BYTES, file.size));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      stream.push(bytes, false);
      // Release the slice and let timers/IO interleave between pushes.
      await yieldToEvent();
    }
    stream.push(new Uint8Array(0), true);
    onProgress?.(i + 1, files.length);
  }
  if (zipError) throw zipError;
  zipper.end();
  await finished;
  if (zipError) throw zipError;

  return new Blob(chunks as unknown as BlobPart[], { type: 'application/zip' });
}
