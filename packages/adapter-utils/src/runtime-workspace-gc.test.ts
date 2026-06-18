import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_WORKSPACE_RETENTION_HOURS,
  resolveRunWorkspaceGcConfig,
  selectRunWorkspacesToReap,
  sweepLocalRunWorkspaces,
  type RunWorkspaceEntry,
  type RunWorkspaceGcConfig,
} from "./runtime-workspace-gc.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_000 * HOUR_MS;

function entry(runId: string, ageHours: number, sizeBytes?: number): RunWorkspaceEntry {
  return {
    runId,
    path: `/runs/${runId}`,
    mtimeMs: NOW - ageHours * HOUR_MS,
    sizeBytes,
  };
}

function reapedIds(entries: RunWorkspaceEntry[]): string[] {
  return entries.map((e) => e.runId);
}

describe("selectRunWorkspacesToReap", () => {
  it("reaps directories older than the TTL and keeps fresh ones", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("old", 48), entry("fresh", 1), entry("borderline", 23)],
      now: NOW,
      policy: { retentionMs: 24 * HOUR_MS },
    });
    expect(reapedIds(result)).toEqual(["old"]);
  });

  it("never reaps an active run even when it is far past the TTL (live-process spare)", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("active-stale", 240), entry("dead-stale", 240)],
      activeRunIds: ["active-stale"],
      now: NOW,
      policy: { retentionMs: 24 * HOUR_MS },
    });
    expect(reapedIds(result)).toEqual(["dead-stale"]);
  });

  it("never reaps a protected run (e.g. the run being prepared)", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("current", 240), entry("other", 240)],
      protectRunIds: ["current"],
      now: NOW,
      policy: { retentionMs: 24 * HOUR_MS },
    });
    expect(reapedIds(result)).toEqual(["other"]);
  });

  it("enforces maxCount, keeping the newest survivors", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("a", 1), entry("b", 2), entry("c", 3), entry("d", 4)],
      now: NOW,
      // TTL disabled so only maxCount applies.
      policy: { retentionMs: 0, maxCount: 2 },
    });
    // Newest two (a, b) kept; older two (c, d) reaped, oldest first.
    expect(reapedIds(result)).toEqual(["d", "c"]);
  });

  it("does not reap active runs to satisfy maxCount", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("a", 1), entry("b", 2), entry("c", 3)],
      activeRunIds: ["a", "b", "c"],
      now: NOW,
      policy: { retentionMs: 0, maxCount: 0 },
    });
    expect(result).toEqual([]);
  });

  it("enforces a total-size budget, keeping the newest prefix that fits", () => {
    const result = selectRunWorkspacesToReap({
      entries: [
        entry("newest", 1, 600),
        entry("middle", 2, 600),
        entry("oldest", 3, 600),
      ],
      now: NOW,
      policy: { retentionMs: 0, maxTotalBytes: 1000 },
    });
    // newest (600) fits; middle would push to 1200 > 1000 → middle and oldest reaped.
    expect(reapedIds(result)).toEqual(["oldest", "middle"]);
  });

  it("keeps the single newest survivor even if it alone exceeds the budget", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("huge", 1, 5000), entry("small", 2, 10)],
      now: NOW,
      policy: { retentionMs: 0, maxTotalBytes: 1000 },
    });
    expect(reapedIds(result)).toEqual(["small"]);
  });

  it("treats unknown sizes as zero so they never trip the budget alone", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("a", 1), entry("b", 2), entry("c", 3)],
      now: NOW,
      policy: { retentionMs: 0, maxTotalBytes: 1024 },
    });
    expect(result).toEqual([]);
  });

  it("returns nothing when no rule is enabled", () => {
    const result = selectRunWorkspacesToReap({
      entries: [entry("a", 100), entry("b", 200)],
      now: NOW,
      policy: { retentionMs: 0 },
    });
    expect(result).toEqual([]);
  });
});

describe("resolveRunWorkspaceGcConfig", () => {
  it("uses the default retention and enables the sweep with an empty env", () => {
    const config = resolveRunWorkspaceGcConfig({});
    expect(config.keepWorkspace).toBe(false);
    expect(config.sweepEnabled).toBe(true);
    expect(config.policy.retentionMs).toBe(DEFAULT_RUN_WORKSPACE_RETENTION_HOURS * HOUR_MS);
    expect(config.policy.maxCount).toBeNull();
    expect(config.policy.maxTotalBytes).toBeNull();
  });

  it("honors the keep-workspace opt-out and disables the sweep", () => {
    const config = resolveRunWorkspaceGcConfig({ PAPERCLIP_KEEP_RUN_WORKSPACE: "1" });
    expect(config.keepWorkspace).toBe(true);
    expect(config.sweepEnabled).toBe(false);
  });

  it("parses retention hours, max count and max total MB", () => {
    const config = resolveRunWorkspaceGcConfig({
      PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS: "6",
      PAPERCLIP_RUN_WORKSPACE_MAX_COUNT: "10",
      PAPERCLIP_RUN_WORKSPACE_MAX_TOTAL_MB: "512",
    });
    expect(config.policy.retentionMs).toBe(6 * HOUR_MS);
    expect(config.policy.maxCount).toBe(10);
    expect(config.policy.maxTotalBytes).toBe(512 * 1024 * 1024);
  });

  it("falls back to the default retention for invalid or non-positive values", () => {
    expect(resolveRunWorkspaceGcConfig({ PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS: "0" }).policy.retentionMs).toBe(
      DEFAULT_RUN_WORKSPACE_RETENTION_HOURS * HOUR_MS,
    );
    expect(resolveRunWorkspaceGcConfig({ PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS: "nonsense" }).policy.retentionMs).toBe(
      DEFAULT_RUN_WORKSPACE_RETENTION_HOURS * HOUR_MS,
    );
  });

  it("can disable only the sweep while still cleaning on completion", () => {
    const config = resolveRunWorkspaceGcConfig({ PAPERCLIP_RUN_WORKSPACE_SWEEP_DISABLED: "true" });
    expect(config.keepWorkspace).toBe(false);
    expect(config.sweepEnabled).toBe(false);
  });
});

describe("sweepLocalRunWorkspaces", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeRunDir(runsDir: string, runId: string, ageHours: number): Promise<string> {
    const dir = path.join(runsDir, runId);
    await mkdir(path.join(dir, "workspace"), { recursive: true });
    await writeFile(path.join(dir, "workspace", "file.txt"), "x", "utf8");
    const when = new Date(NOW - ageHours * HOUR_MS);
    await utimes(dir, when, when);
    return dir;
  }

  it("removes stale run dirs from a real directory while sparing active runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gc-"));
    cleanupDirs.push(root);
    const runsDir = path.join(root, "runs");
    await makeRunDir(runsDir, "stale-dead", 48);
    await makeRunDir(runsDir, "stale-active", 48);
    const freshDir = await makeRunDir(runsDir, "fresh", 1);

    const config: RunWorkspaceGcConfig = {
      keepWorkspace: false,
      sweepEnabled: true,
      policy: { retentionMs: 24 * HOUR_MS },
    };
    const result = await sweepLocalRunWorkspaces({
      runsDir,
      config,
      now: NOW,
      activeRunIds: ["stale-active"],
    });

    expect(result.skipped).toBe(false);
    expect(result.reaped).toEqual([path.join(runsDir, "stale-dead")]);
    expect(result.failed).toEqual([]);
    // Active + fresh survive.
    await expect(stat(path.join(runsDir, "stale-active"))).resolves.toBeDefined();
    await expect(stat(freshDir)).resolves.toBeDefined();
    await expect(stat(path.join(runsDir, "stale-dead"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a no-op when the runs directory does not exist", async () => {
    const result = await sweepLocalRunWorkspaces({
      runsDir: path.join(os.tmpdir(), "paperclip-gc-missing-dir-xyz"),
      config: { keepWorkspace: false, sweepEnabled: true, policy: { retentionMs: HOUR_MS } },
      now: NOW,
    });
    expect(result.skipped).toBe(true);
    expect(result.reaped).toEqual([]);
  });

  it("skips entirely when the sweep is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gc-"));
    cleanupDirs.push(root);
    const runsDir = path.join(root, "runs");
    await makeRunDir(runsDir, "stale", 100);

    const result = await sweepLocalRunWorkspaces({
      runsDir,
      config: { keepWorkspace: true, sweepEnabled: false, policy: { retentionMs: HOUR_MS } },
      now: NOW,
    });
    expect(result.skipped).toBe(true);
    await expect(stat(path.join(runsDir, "stale"))).resolves.toBeDefined();
  });
});
