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
 *   3 = write (console output capture — `process.stdout.write` etc.)
 *   4 = thread_start
 *   5 = thread_switch
 *   6 = thread_exit
 *   7 = assignment (M16a: synthetic `__ct.write(siteId)` event for a
 *                   recognised simple-assignment shape; the native
 *                   addon resolves it to the manifest's write-site
 *                   metadata and synthesises a `BindVariable +
 *                   Assignment` pair into the trace stream)
 *   8 = marker (M25 correlation marker placed by user code at a
 *               boundary crossing; the native addon writes it as a
 *               tracepoint `Event` whose metadata carries the full
 *               `MarkerPayload` the db-backend's correlation index
 *               decodes)
 */

/** Numeric event kind codes matching the instrumenter output. */
export const EVENT_STEP = 0 as const;
export const EVENT_ENTER = 1 as const;
export const EVENT_RET = 2 as const;
export const EVENT_WRITE = 3 as const;
export const EVENT_THREAD_START = 4 as const;
export const EVENT_THREAD_SWITCH = 5 as const;
export const EVENT_THREAD_EXIT = 6 as const;
export const EVENT_ASSIGNMENT = 7 as const;
export const EVENT_MARKER = 8 as const;

export type EventKind =
  | typeof EVENT_STEP
  | typeof EVENT_ENTER
  | typeof EVENT_RET
  | typeof EVENT_WRITE
  | typeof EVENT_THREAD_START
  | typeof EVENT_THREAD_SWITCH
  | typeof EVENT_THREAD_EXIT
  | typeof EVENT_ASSIGNMENT
  | typeof EVENT_MARKER;

/** Encoded representation of a JS value for tracing. */
export interface EncodedValue {
  value: unknown;
  typeKind: string;
}

/** A value entry associated with a specific event in a batch. */
export interface ValueEntry {
  /** Index of the event in the batch this value belongs to. */
  eventIndex: number;
  /** Encoded argument values (for enter events). */
  args?: EncodedValue[];
  /** Encoded return value (for ret events). */
  returnValue?: EncodedValue;
  /** Encoded assignment target value (for assignment events). */
  assignmentValue?: EncodedValue;
}

/** A write entry associated with a Write event (console output). */
export interface WriteEntry {
  /** Index of the event in the batch this write belongs to. */
  eventIndex: number;
  /** Write kind: "stdout" or "stderr". */
  kind: string;
  /** The written content. */
  content: string;
}

/**
 * A correlation-marker entry associated with an `EVENT_MARKER` event.
 *
 * Markers are how a value's journey across a process boundary becomes
 * traceable: the sending process records one at the point the value
 * leaves, the receiving process records one where it arrives, and the
 * debugger pairs them by `(boundary, key)`. The pairing is string
 * equality on the key, so the *same* logical identifier must be passed
 * on both sides.
 *
 * See `codetracer-specs/GUI/Debugging-Features/Correlation-Markers.md`.
 */
export interface MarkerEntry {
  /** Index of the event in the batch this marker belongs to. */
  eventIndex: number;
  /** `"send"` at the point the value leaves, `"recv"` where it arrives. */
  direction: "send" | "recv";
  /** Boundary identifier shared by both sides of the crossing. */
  boundary: string;
  /** Correlation key, stringified — pairing is string equality. */
  key: string;
  /** Optional human-readable value shown on the boundary hop. */
  payload?: string;
  /**
   * Name of the binding the value came from on this side of the
   * boundary.
   *
   * This is load-bearing for cross-process origin: when a chain crosses
   * here, the debugger continues the walk on *this* name in the sending
   * recording. Without it the walk resumes on a placeholder and finds
   * nothing, so the chain shows the boundary but no history beyond it.
   */
  showText?: string;
}

/** A flushed batch — a snapshot of the typed arrays at flush time. */
export interface EventBatch {
  /** Event kind per slot (0=step, 1=enter, 2=ret, 3=write, 4=thread_start, 5=thread_switch, 6=thread_exit). */
  eventKinds: Uint8Array;
  /** siteId (for step) or fnId (for enter/ret) per slot. Id is unused for write events (set to 0). */
  ids: Uint32Array;
  /** Number of valid events in this batch. */
  length: number;
  /** Captured values for enter/ret events. */
  values: ValueEntry[];
  /** Captured writes for write events (console output). */
  writes: WriteEntry[];
  /** Captured correlation markers for marker events. */
  markers: MarkerEntry[];
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

  /** Pending value entries for the current buffer window. */
  private _values: ValueEntry[] = [];

  /** Pending write entries for the current buffer window. */
  private _writes: WriteEntry[] = [];

  /** Pending correlation-marker entries for the current buffer window. */
  private _markers: MarkerEntry[] = [];

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
   * Attach a value entry to the most recently pushed event.
   * The eventIndex is automatically set to the current buffer position - 1.
   */
  pushValue(entry: ValueEntry): void {
    this._values.push(entry);
  }

  /**
   * Attach a write entry to the most recently pushed event.
   */
  pushWrite(entry: WriteEntry): void {
    this._writes.push(entry);
  }

  /**
   * Attach a correlation-marker entry to the most recently pushed event.
   */
  pushMarker(entry: MarkerEntry): void {
    this._markers.push(entry);
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
      values: this._values,
      writes: this._writes,
      markers: this._markers,
    };

    this.flushedBatches.push(batch);

    if (this._onFlush) {
      this._onFlush(batch);
    }

    // Reset write cursor, values, and writes — we reuse the same backing arrays.
    this._length = 0;
    this._values = [];
    this._writes = [];
    this._markers = [];
  }
}
