/**
 * Async context tracking for CodeTracer runtime.
 *
 * Uses Node.js `async_hooks.executionAsyncId()` to detect when execution
 * switches between different async contexts (e.g., across await boundaries,
 * setTimeout callbacks, Promise resolutions).
 *
 * The approach:
 *   - Install a minimal async hook (init-only) so that `executionAsyncId()`
 *     returns meaningful values after async boundaries.
 *   - Before each trace event, compare the current execution async ID
 *     to the last one we saw.
 *   - If it changed, emit ThreadStart (if new) + ThreadSwitch events.
 *
 * Without the hook installed, `executionAsyncId()` returns 0 for all
 * async continuations, making context tracking impossible.
 *
 * This module is stateful per-tracker instance, so each recording session
 * or test can have its own independent tracker.
 */

import { executionAsyncId, createHook } from "node:async_hooks";
import type { AsyncHook } from "node:async_hooks";
import type { EventBuffer } from "./buffer.js";
import { EVENT_THREAD_START, EVENT_THREAD_SWITCH } from "./buffer.js";

/**
 * Async context tracker.
 *
 * Tracks which async execution context is current and emits
 * ThreadStart / ThreadSwitch events into the event buffer when
 * the context changes.
 */
export class AsyncContextTracker {
  /** Set of async context IDs we have already seen. */
  private readonly _knownContexts = new Set<number>();

  /** The last async context ID we emitted an event for. */
  private _lastCtxId = 0;

  /** Whether tracking is enabled. */
  private _enabled = false;

  /** The async hook instance (installed to enable executionAsyncId tracking). */
  private _hook: AsyncHook | null = null;

  /**
   * Enable async context tracking.
   *
   * Installs a minimal async hook so that `executionAsyncId()` returns
   * meaningful values after async boundaries, then records the current
   * execution context as the initial context (emits a ThreadStart for it).
   */
  enable(buffer: EventBuffer): void {
    if (this._enabled) return;
    this._enabled = true;

    // Install a minimal async hook. Only the `init` callback is needed —
    // it tells Node.js to track async resource creation, which makes
    // executionAsyncId() return correct values in async continuations.
    // Using a no-op init keeps overhead minimal.
    this._hook = createHook({
      init() {},
    });
    this._hook.enable();

    const ctxId = executionAsyncId();
    this._knownContexts.add(ctxId);
    buffer.push(EVENT_THREAD_START, ctxId);
    this._lastCtxId = ctxId;
  }

  /** Disable async context tracking and remove the async hook. */
  disable(): void {
    this._enabled = false;
    if (this._hook) {
      this._hook.disable();
      this._hook = null;
    }
  }

  /** Whether tracking is currently enabled. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** The last emitted context ID (for testing). */
  get lastCtxId(): number {
    return this._lastCtxId;
  }

  /** The set of known context IDs (for testing). */
  get knownContexts(): ReadonlySet<number> {
    return this._knownContexts;
  }

  /**
   * Check whether the async context has changed since the last event.
   *
   * If the context changed:
   *   - If this is a new context (never seen before), emit ThreadStart.
   *   - Emit ThreadSwitch.
   *
   * This should be called before every step/enter/ret event.
   */
  checkContext(buffer: EventBuffer): void {
    if (!this._enabled) return;

    const ctxId = executionAsyncId();
    if (ctxId !== this._lastCtxId) {
      if (!this._knownContexts.has(ctxId)) {
        this._knownContexts.add(ctxId);
        buffer.push(EVENT_THREAD_START, ctxId);
      }
      buffer.push(EVENT_THREAD_SWITCH, ctxId);
      this._lastCtxId = ctxId;
    }
  }

  /**
   * Reset the tracker state.
   * Useful for testing.
   */
  reset(): void {
    this.disable();
    this._knownContexts.clear();
    this._lastCtxId = 0;
  }
}
