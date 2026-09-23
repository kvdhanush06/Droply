import { useRef, useState, type DragEvent, type KeyboardEvent, type ChangeEvent } from 'react';
import { FileUp } from 'lucide-react';

interface DropZoneProps {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  zipAvailable?: boolean;
  zipEnabled: boolean;
  onToggleZip?: (enabled: boolean) => void;
  passwordEnabled: boolean;
  onTogglePassword?: (enabled: boolean) => void;
}

/**
 * Collects every file under the dropped entries, preserving the folder path
 * in each File's `relativePath` property (used only when the batch is zipped;
 * otherwise RoomPage flattens to plain file names).
 *
 * Two browser quirks make this subtle:
 *  1. `webkitGetAsEntry()` is only valid synchronously, during the drop
 *     event — so entries are captured into an array before any await.
 *  2. `readEntries()` returns at most 100 entries per call and must be
 *     called repeatedly until it returns an empty batch, or large folders
 *     silently truncate.
 */
async function scanDataTransfer(entries: FileSystemEntry[]): Promise<File[]> {
  const files: File[] = [];

  const fileFromEntry = (entry: FileSystemFileEntry, path: string): Promise<File | null> =>
    new Promise((resolve) => {
      entry.file(
        (file) => {
          const rel = path ? `${path}/${file.name}` : file.name;
          Object.defineProperty(file, 'relativePath', { value: rel, configurable: true });
          Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
          resolve(file);
        },
        () => resolve(null), // unreadable/permission-denied file: skip it
      );
    });

  const readDir = (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
    new Promise((resolve) => {
      const all: FileSystemEntry[] = [];
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              resolve(all);
              return;
            }
            all.push(...batch);
            readBatch(); // keep going until the directory is drained
          },
          () => resolve(all),
        );
      };
      readBatch();
    });

  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const file = await fileFromEntry(entry as FileSystemFileEntry, path);
      if (file) files.push(file);
      return;
    }
    if (entry.isDirectory) {
      const nextPath = path ? `${path}/${entry.name}` : entry.name;
      const children = await readDir(entry as FileSystemDirectoryEntry);
      for (const child of children) {
        await walk(child, nextPath);
      }
    }
  };

  for (const entry of entries) {
    await walk(entry, '');
  }
  return files;
}

/**
 * Drag-and-drop target with a keyboard-accessible file picker. Also hosts
 * the zip and password toggles that apply to the next batch.
 */
export function DropZone({
  disabled,
  onFiles,
  zipAvailable,
  zipEnabled,
  onToggleZip,
  passwordEnabled,
  onTogglePassword,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    dragDepth.current += 1;
    setDragOver(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (disabled) return;
    const dt = event.dataTransfer;
    const files = Array.from(dt?.files ?? []);
    // Capture entries synchronously — the DataTransfer is invalidated right
    // after this handler returns, so no await may precede this line.
    const entries: FileSystemEntry[] = [];
    if (dt?.items) {
      for (const item of Array.from(dt.items)) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
    }
    if (entries.length > 0) {
      void scanDataTransfer(entries).then((scanned) => {
        if (scanned.length > 0) {
          onFiles(scanned);
        } else if (files.length > 0) {
          onFiles(files);
        }
      });
      return;
    }
    if (files.length > 0) onFiles(files);
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) onFiles(files);
    event.target.value = '';
  };

  const classes = ['dropzone'];
  if (dragOver) classes.push('drag-over');
  if (disabled) classes.push('disabled');

  return (
    <div
      className={classes.join(' ')}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={disabled ? 'File drop zone (connect a device first)' : 'Drop files here or press Enter to choose'}
      onClick={openPicker}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <FileUp className="dropzone-icon" aria-hidden />
      <p className="dropzone-title">{dragOver ? 'Release to add files' : 'Drop files here'}</p>
      <p className="dropzone-sub">
        {disabled
          ? 'Waiting for another device to connect…'
          : 'or press Enter / click to choose files — they travel straight to the connected device'}
      </p>
      <div className="dropzone-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn btn-sm btn-outline" disabled={disabled} onClick={openPicker}>
          <FileUp size={14} aria-hidden /> Choose files
        </button>
      </div>
      {(zipAvailable || onTogglePassword) && (
        <div className="dropzone-toggles" onClick={(e) => e.stopPropagation()}>
          {zipAvailable && (
            <label className="dropzone-toggle">
              <input
                type="checkbox"
                checked={zipEnabled}
                onChange={(e) => onToggleZip?.(e.target.checked)}
                disabled={disabled}
              />
              Zip before sending
            </label>
          )}
          {onTogglePassword && (
            <label className="dropzone-toggle">
              <input
                type="checkbox"
                checked={passwordEnabled}
                onChange={(e) => onTogglePassword?.(e.target.checked)}
                disabled={disabled}
              />
              Password-protect
            </label>
          )}
        </div>
      )}
      <input ref={inputRef} type="file" multiple className="visually-hidden" tabIndex={-1} onChange={onInputChange} />
    </div>
  );
}
