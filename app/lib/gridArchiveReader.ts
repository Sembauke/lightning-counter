import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import type { GridArchiveQuery, GridArchiveResult } from './gridArchiveTypes';

const MAX_PENDING = 16;
const REQUEST_TIMEOUT_MS = 5_000;

interface Job {
  id: number;
  query: GridArchiveQuery;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  removeAbort: () => void;
  resolve: (result: GridArchiveResult) => void;
  reject: (error: Error) => void;
}

class ArchiveReader {
  private worker: Worker | null = null;
  private active: Job | null = null;
  private queue: Job[] = [];
  private retiring = false;
  private closed = false;
  private sequence = 0;

  constructor(private readonly dbFile: string) {}

  read(query: GridArchiveQuery, signal?: AbortSignal): Promise<GridArchiveResult> {
    if (this.closed || signal?.aborted || this.queue.length + Number(!!this.active) >= MAX_PENDING) {
      return Promise.reject(new Error('Archive temporarily unavailable'));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, query, settled: false, resolve, reject,
        removeAbort: () => {}, timer: setTimeout(() => {
          this.reject(job);
          this.queue = this.queue.filter(candidate => candidate !== job);
          if (this.active === job) this.retire();
        }, REQUEST_TIMEOUT_MS) };
      const abort = () => {
        this.reject(job);
        if (this.active !== job) {
          clearTimeout(job.timer);
          this.queue = this.queue.filter(candidate => candidate !== job);
        }
        // An active cancelled query still has its deadline. Do not let repeated
        // panning spawn workers or leave a running SQLite query unbounded.
      };
      signal?.addEventListener('abort', abort, { once: true });
      job.removeAbort = () => signal?.removeEventListener('abort', abort);
      this.queue.push(job);
      this.pump();
    });
  }

  private reject(job: Job): void {
    job.removeAbort();
    if (!job.settled) {
      job.settled = true;
      job.reject(new Error('Archive temporarily unavailable'));
    }
  }

  private pump(): void {
    if (this.closed || this.active || this.retiring) return;
    if (!this.queue.length) { this.worker?.unref(); return; }
    if (!this.worker) {
      const worker = new Worker(path.join(process.cwd(), 'server', 'gridArchiveWorker.cjs'), { workerData: { dbFile: this.dbFile } });
      this.worker = worker;
      worker.on('message', (message: { id: number; result?: GridArchiveResult; error?: string }) => {
        if (this.worker !== worker || this.retiring) return;
        const job = this.active;
        if (!job || message.id !== job.id) return;
        clearTimeout(job.timer);
        job.removeAbort();
        this.active = null;
        if (message.result && !job.settled) { job.settled = true; job.resolve(message.result); }
        else if (message.error) this.reject(job);
        this.pump();
      });
      worker.on('error', () => this.retire());
      worker.on('exit', () => {
        if (this.worker !== worker) return;
        if (this.active) { clearTimeout(this.active.timer); this.reject(this.active); this.active = null; }
        this.worker = null;
        this.retiring = false;
        this.pump();
      });
    }
    const job = this.queue.shift()!;
    this.active = job;
    this.worker.ref();
    this.worker.postMessage({ id: job.id, query: job.query });
  }

  private retire(): void {
    if (this.retiring || !this.worker) return;
    this.retiring = true;
    if (this.active) { clearTimeout(this.active.timer); this.reject(this.active); }
    // Wait for exit before a replacement starts: even if native SQLite takes
    // time to stop, the number of worker threads stays bounded at one.
    void this.worker.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
      clearTimeout(job.timer);
      this.reject(job);
    }
    this.queue = [];
    this.active = null;
    if (this.worker) await this.worker.terminate();
  }
}

// Share the single reader across route bundles and development module reloads.
const globals = globalThis as typeof globalThis & { _gridArchiveReaders?: Map<string, ArchiveReader>; _gridArchiveCleanup?: boolean };
const readers = globals._gridArchiveReaders ??= new Map();

export function readGridArchive(query: GridArchiveQuery, signal?: AbortSignal): Promise<GridArchiveResult> {
  const dbFile = path.resolve(process.env.DB_PATH ?? (fs.existsSync('/data') ? '/data' : './tmp'), 'lightning.db');
  let reader = readers.get(dbFile);
  if (!reader) { reader = new ArchiveReader(dbFile); readers.set(dbFile, reader); }
  return reader.read(query, signal);
}

export async function closeGridArchiveReaders(): Promise<void> {
  const closing = [...readers.values()];
  readers.clear();
  await Promise.all(closing.map(reader => reader.close()));
}

if (!globals._gridArchiveCleanup) {
  globals._gridArchiveCleanup = true;
  process.once('beforeExit', () => { void closeGridArchiveReaders(); });
}
