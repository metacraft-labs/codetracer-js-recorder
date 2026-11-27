/**
 * Run a command without blocking the test worker's event loop.
 *
 * `spawnSync` blocks the vitest worker for as long as the child runs. The
 * conformance legs run CLIs that take tens of seconds on an idle host and
 * minutes on a busy one, and while one ran the worker could neither answer
 * vitest's RPC (vitest then reports "[vitest-worker]: Timeout calling
 * onTaskUpdate" as an unhandled error, which fails the run on its own) nor
 * let the test's own timeout fire, so a slow run was reported by everything
 * but the test. This runs the child asynchronously and kills it after
 * `timeoutMs`, as `spawnSync`'s `timeout` did.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  /** The exit status, or null when a signal ended the child. */
  status: number | null;
  /** The signal that ended the child, if one did. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
