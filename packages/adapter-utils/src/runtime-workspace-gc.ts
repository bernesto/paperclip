import { promises as fsPromises, type Dirent } from "node:fs";
import path from "node:path";

/**
 * Garbage collection for per-run execution workspaces.
 *
 * Managed runtimes copy the canonical workspace into a throwaway per-run
 * directory at `<baseCwd>/.paperclip-runtime/runs/<runId>/workspace`. Once a
 * run reaches a terminal state, {@link restoreWorkspace} merges any file
 * changes back to the canonical workspace, leaving the per-run copy as pure
 * waste. Without a reaper these directories accumulate unbounded (observed:
 * ~13 GB/day on a busy host), eventually exhausting disk and producing
 * recurring `ENOSPC` failures.
 *
 * This module provides the transport-agnostic *selection* logic plus a local
 * filesystem sweep. The actual deletion of remote (SSH / sandbox) run
 * directories is performed by the runtime helpers that own the transport; they
 * reuse {@link selectRunWorkspacesToReap} and {@link resolveRunWorkspaceGcConfig}
 * so the policy stays in one place.
 */

export const DEFAULT_RUN_WORKSPACE_RETENTION_HOURS = 24;

/** Describes a single per-run workspace directory discovered on disk. */
export interface RunWorkspaceEntry {
  /** The run id (the directory name under `runs/`). */
  runId: string;
  /** Absolute (local) or remote path to the per-run directory. */
  path: string;
  /** Last-modified time in epoch milliseconds. */
  mtimeMs: number;
  /**
   * Total size of the directory in bytes, when known. Used only by the
   * `maxTotalBytes` rule; entries with an unknown size are treated as 0 so a
   * caller that cannot afford to measure sizes still benefits from the TTL and
   * max-count rules.
   */
  sizeBytes?: number;
}

/** Retention policy applied during selection. */
export interface RunWorkspaceGcPolicy {
  /** Reap terminal directories older than this many milliseconds. `<= 0` disables the TTL rule. */
  retentionMs: number;
  /** Keep at most this many terminal directories (newest kept). `null`/unset disables the rule. */
  maxCount?: number | null;
  /** Keep terminal directories whose cumulative size fits this byte budget. `null`/unset disables the rule. */
  maxTotalBytes?: number | null;
}

export interface SelectRunWorkspacesToReapInput {
  entries: RunWorkspaceEntry[];
  /**
   * Run ids that have a live process in the in-memory registry. These are
   * spared unconditionally — the process-registry signal is authoritative,
   * which is why a stale mtime can never reap a live run (a manual purge that
   * bumps mtimes therefore cannot trick the sweep into killing active work).
   */
  activeRunIds?: Iterable<string>;
  /** Additional run ids to spare (e.g. the run currently being prepared). */
  protectRunIds?: Iterable<string>;
  /** Current time in epoch milliseconds. */
  now: number;
  policy: RunWorkspaceGcPolicy;
}

function normalizeMaxCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function normalizeMaxBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function entrySize(entry: RunWorkspaceEntry): number {
  return typeof entry.sizeBytes === "number" && entry.sizeBytes > 0 ? entry.sizeBytes : 0;
}

/**
 * Decide which per-run workspace directories should be removed.
 *
 * Active and protected runs are never returned. Among the remaining (terminal)
 * candidates a directory is reaped if it matches *any* enabled rule:
 *   1. TTL — older than `retentionMs`.
 *   2. max-count — beyond the newest `maxCount` survivors.
 *   3. max-total-size — outside the newest prefix that fits `maxTotalBytes`.
 *
 * The result is ordered oldest-first so callers delete the least-recently-used
 * directories first.
 */
export function selectRunWorkspacesToReap(input: SelectRunWorkspacesToReapInput): RunWorkspaceEntry[] {
  const spared = new Set<string>([
    ...(input.activeRunIds ?? []),
    ...(input.protectRunIds ?? []),
  ]);

  const candidates = input.entries.filter((entry) => !spared.has(entry.runId));
  // Newest first; ties broken by runId for deterministic output.
  const newestFirst = [...candidates].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
  );

  const reap = new Set<string>();
  const retentionMs = Number.isFinite(input.policy.retentionMs) && input.policy.retentionMs > 0
    ? input.policy.retentionMs
    : 0;

  // Rule 1: TTL.
  if (retentionMs > 0) {
    for (const entry of newestFirst) {
      if (input.now - entry.mtimeMs > retentionMs) reap.add(entry.path);
    }
  }

  // Rule 2: max-count of the survivors.
  const maxCount = normalizeMaxCount(input.policy.maxCount);
  if (maxCount != null) {
    const survivors = newestFirst.filter((entry) => !reap.has(entry.path));
    for (let index = maxCount; index < survivors.length; index += 1) {
      reap.add(survivors[index]!.path);
    }
  }

  // Rule 3: total-size budget. Keep the newest prefix that fits, reap the rest.
  const maxTotalBytes = normalizeMaxBytes(input.policy.maxTotalBytes);
  if (maxTotalBytes != null) {
    let accumulated = 0;
    let overBudget = false;
    for (const entry of newestFirst) {
      if (reap.has(entry.path)) continue;
      if (overBudget) {
        reap.add(entry.path);
        continue;
      }
      const size = entrySize(entry);
      // Always keep at least the newest survivor even if it alone exceeds the
      // budget — there is nothing smaller to fall back to.
      if (accumulated > 0 && accumulated + size > maxTotalBytes) {
        overBudget = true;
        reap.add(entry.path);
        continue;
      }
      accumulated += size;
    }
  }

  return candidates
    .filter((entry) => reap.has(entry.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

/** Resolved GC configuration for the runtime workspace reaper. */
export interface RunWorkspaceGcConfig {
  /**
   * When true, finished runs keep their per-run workspace (opt-out for
   * debugging) and the opportunistic sweep is disabled.
   */
  keepWorkspace: boolean;
  /** Whether the prepare-time stale sweep should run. */
  sweepEnabled: boolean;
  policy: RunWorkspaceGcPolicy;
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseNumberEnv(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve the GC configuration from environment variables.
 *
 *   PAPERCLIP_KEEP_RUN_WORKSPACE         truthy → never auto-clean (debug opt-out)
 *   PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS  TTL in hours (default 24)
 *   PAPERCLIP_RUN_WORKSPACE_MAX_COUNT    keep at most N terminal run dirs
 *   PAPERCLIP_RUN_WORKSPACE_MAX_TOTAL_MB total byte budget across terminal dirs
 *   PAPERCLIP_RUN_WORKSPACE_SWEEP_DISABLED truthy → skip the prepare-time sweep
 */
export function resolveRunWorkspaceGcConfig(
  env: NodeJS.ProcessEnv = process.env,
): RunWorkspaceGcConfig {
  const keepWorkspace = parseBooleanEnv(env.PAPERCLIP_KEEP_RUN_WORKSPACE);
  const retentionHours = parseNumberEnv(env.PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS);
  const retentionMs =
    (retentionHours != null && retentionHours > 0
      ? retentionHours
      : DEFAULT_RUN_WORKSPACE_RETENTION_HOURS) *
    60 *
    60 *
    1000;
  const maxCount = normalizeMaxCount(parseNumberEnv(env.PAPERCLIP_RUN_WORKSPACE_MAX_COUNT));
  const maxTotalMb = parseNumberEnv(env.PAPERCLIP_RUN_WORKSPACE_MAX_TOTAL_MB);
  const maxTotalBytes = normalizeMaxBytes(maxTotalMb != null ? maxTotalMb * 1024 * 1024 : null);
  const sweepDisabled = parseBooleanEnv(env.PAPERCLIP_RUN_WORKSPACE_SWEEP_DISABLED);

  return {
    keepWorkspace,
    sweepEnabled: !keepWorkspace && !sweepDisabled,
    policy: { retentionMs, maxCount, maxTotalBytes },
  };
}

/** Minimal filesystem surface, injectable so the sweep is unit-testable. */
export interface RunWorkspaceFsLike {
  readdir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  stat(target: string): Promise<{ mtimeMs: number }>;
  rm(target: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface SweepRunWorkspacesResult {
  /** True when the sweep was disabled or the runs directory does not exist. */
  skipped: boolean;
  /** Number of candidate run directories examined. */
  scanned: number;
  /** Paths successfully removed. */
  reaped: string[];
  /** Paths whose removal failed (non-fatal). */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Sweep a *local* `.paperclip-runtime/runs` directory, removing stale/over-budget
 * per-run workspaces. Active and protected runs are spared. Failures to remove
 * an individual directory are collected and reported rather than thrown, so a
 * single locked directory cannot abort the whole sweep.
 */
export async function sweepLocalRunWorkspaces(input: {
  runsDir: string;
  config: RunWorkspaceGcConfig;
  now: number;
  activeRunIds?: Iterable<string>;
  protectRunIds?: Iterable<string>;
  fs?: RunWorkspaceFsLike;
}): Promise<SweepRunWorkspacesResult> {
  const empty: SweepRunWorkspacesResult = { skipped: true, scanned: 0, reaped: [], failed: [] };
  if (!input.config.sweepEnabled) return empty;

  const fs = input.fs ?? (fsPromises as unknown as RunWorkspaceFsLike);

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(input.runsDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return empty;
    throw error;
  }

  const entries: RunWorkspaceEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const runId = dirent.name;
    const dirPath = path.join(input.runsDir, runId);
    try {
      const stats = await fs.stat(dirPath);
      entries.push({ runId, path: dirPath, mtimeMs: stats.mtimeMs });
    } catch {
      // Vanished between readdir and stat, or unreadable — ignore.
    }
  }

  const toReap = selectRunWorkspacesToReap({
    entries,
    activeRunIds: input.activeRunIds,
    protectRunIds: input.protectRunIds,
    now: input.now,
    policy: input.config.policy,
  });

  const reaped: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const entry of toReap) {
    try {
      await fs.rm(entry.path, { recursive: true, force: true });
      reaped.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { skipped: false, scanned: entries.length, reaped, failed };
}
