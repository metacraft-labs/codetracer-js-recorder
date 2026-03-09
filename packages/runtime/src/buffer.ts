/**
 * Typed-array event buffer for CodeTracer runtime.
 *
 * Events are stored in compact typed arrays to avoid per-event object
 * allocation. When the buffer reaches the configured threshold, it is
 * flushed via a configurable callback.
 *
 * Event kind codes:
 *   0 = step
 *   1 = enter
 *   2 = ret
 */

/** Numeric event kind codes matching the instrumenter output. */
export const EVENT_STEP = 0 as const;
export const EVENT_ENTER = 1 as const;
export const EVENT_RET = 2 as const;

export type EventKind =
  | typeof EVENT_STEP
  | typeof EVENT_ENTER
  | typeof EVENT_RET;

/** A flushed batch — a snapshot of the typed arrays at flush time. */
export interface EventBatch {
  /** Event kind per slot (0=step, 1=enter, 2=ret). */
  eventKinds: Uint8Array;
  /** siteId (for step) or fnId (for enter/ret) per slot. */
  ids: Uint32Array;
  /** Number of valid events in this batch. */
  length: number;
}

/** Callback invoked when the buffer is flushed. */
export type FlushCallback = (batch: EventBatch) => void;

/**
 * Fixed-capacity ring buffer backed by typed arrays.
 *
 * Usage:
 *   const buf = new EventBuffer();
 *   buf.push(EVENT_STEP, siteId);
 *   // ... when full, flush callback fires automatically
 */
export class EventBuffer {
  /** Configurable capacity (default 4096). */
  readonly capacity: number;

  /** Event kind per slot. */
  readonly eventKinds: Uint8Array;
  /** siteId or fnId per slot. */
  readonly ids: Uint32Array;

  /** Current number of buffered events. */
  private _length: number = 0;

  /** User-provided flush callback. */
  private _onFlush: FlushCallback | null = null;

  /** Accumulated flushed batches (for testing / inspection). */
  readonly flushedBatches: EventBatch[] = [];

  constructor(capacity: number = 4096) {
    this.capacity = capacity;
    this.eventKinds = new Uint8Array(capacity);
    this.ids = new Uint32Array(capacity);
  }

  /** Current number of buffered (unflushed) events. */
  get length(): number {
    return this._length;
  }

  /** Register a callback to be invoked on each flush. */
  set onFlush(cb: FlushCallback | null) {
    this._onFlush = cb;
  }

  get onFlush(): FlushCallback | null {
    return this._onFlush;
  }

  /**
   * Append one event to the buffer.
   * If the buffer is full after this push, it is automatically flushed.
   */
  push(kind: EventKind, id: number): void {
    const idx = this._length;
    this.eventKinds[idx] = kind;
    this.ids[idx] = id;
    this._length = idx + 1;

    if (this._length >= this.capacity) {
      this.flush();
    }
  }

  /**
   * Flush all buffered events.
   *
   * Creates a snapshot batch (copies of the typed arrays up to _length),
   * invokes the flush callback if set, stores the batch in flushedBatches,
   * and resets the write cursor to 0.
   *
   * No-op if the buffer is empty.
   */
  flush(): void {
    if (this._length === 0) return;

    const batch: EventBatch = {
      eventKinds: this.eventKinds.slice(0, this._length),
      ids: this.ids.slice(0, this._length),
      length: this._length,
    };

    this.flushedBatches.push(batch);

    if (this._onFlush) {
      this._onFlush(batch);
    }

    // Reset write cursor — we reuse the same backing arrays.
    this._length = 0;
  }
}
