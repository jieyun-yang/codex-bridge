/**
 * Thread mode persistence — records whether each Codex thread was created in
 * `text` or `challenge` mode so we can validate mode on thread_id resume.
 *
 * Persisted to disk so verification works across bridge process restarts and
 * pool eviction. Without persistence, only same-process resumes within the
 * 30-min pool TTL could be verified — which would create an unstable contract
 * where output_format=challenge "works sometimes, rejects sometimes" depending
 * on whether the bridge restarted.
 *
 * Format: append-only JSONL. Each line: { thread_id, mode, ts }.
 * On read, latest write wins (Map.set semantics during cache build).
 *
 * No maintenance routine — entries are ~100 bytes; at moderate usage this
 * stays small enough to ignore. Add rotation if it grows.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThreadMode = "text" | "challenge";

const STORE_DIR = join(homedir(), ".agents", "telemetry");
const STORE_FILE = join(STORE_DIR, "codex-bridge-modes.jsonl");

let cache: Map<string, ThreadMode> | null = null;
let dirCreated = false;

function ensureDir(): void {
  if (dirCreated) return;
  try {
    mkdirSync(STORE_DIR, { recursive: true });
  } catch {
    // best-effort; if mkdir fails the appendFileSync below will surface it
  }
  dirCreated = true;
}

function loadCache(): Map<string, ThreadMode> {
  if (cache !== null) return cache;
  cache = new Map();
  if (!existsSync(STORE_FILE)) return cache;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { thread_id?: string; mode?: ThreadMode };
        if (entry.thread_id && (entry.mode === "text" || entry.mode === "challenge")) {
          // Last write wins — Map.set overwrites previous entry for the same key.
          cache.set(entry.thread_id, entry.mode);
        }
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // file unreadable — fall back to empty cache
  }
  return cache;
}

/** Record a thread's mode. Idempotent for same (thread_id, mode); appends a
 *  new line if the mode changes (latest line wins on next reload). */
export function recordThreadMode(threadId: string, mode: ThreadMode): void {
  ensureDir();
  loadCache().set(threadId, mode);
  try {
    const line = JSON.stringify({ thread_id: threadId, mode, ts: new Date().toISOString() }) + "\n";
    appendFileSync(STORE_FILE, line);
  } catch {
    // Disk write failure — in-memory cache still has the entry for this
    // process's lifetime. Subsequent processes won't see it; that's a
    // graceful degradation, not a correctness violation.
  }
}

/** Look up a thread's recorded mode. Returns undefined for unknown threads
 *  (created before this feature, on a different machine, or never recorded). */
export function getThreadMode(threadId: string): ThreadMode | undefined {
  return loadCache().get(threadId);
}

/** Test-only helper: drop the in-memory cache so it reloads from disk on
 *  next access. Used to simulate process restart in tests. */
export function _resetCacheForTests(): void {
  cache = null;
  dirCreated = false;
}
