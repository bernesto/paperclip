import { describe, expect, it } from "vitest";

import {
  assertRunWorkspaceTreePath,
  buildReapStaleRunWorkspacesScript,
  buildRemoveRunWorkspaceScript,
} from "./ssh.js";

const RUNS = "/srv/app/.paperclip-runtime/runs";

describe("assertRunWorkspaceTreePath", () => {
  it("accepts the runs root and per-run children", () => {
    expect(() => assertRunWorkspaceTreePath(RUNS)).not.toThrow();
    expect(() => assertRunWorkspaceTreePath(`${RUNS}/`)).not.toThrow();
    expect(() => assertRunWorkspaceTreePath(`${RUNS}/run-123`)).not.toThrow();
    expect(() => assertRunWorkspaceTreePath(`${RUNS}/run-123/workspace`)).not.toThrow();
    // Windows-style separators normalize to the same tree.
    expect(() => assertRunWorkspaceTreePath("C:\\app\\.paperclip-runtime\\runs\\run-1")).not.toThrow();
  });

  it("rejects paths outside a .paperclip-runtime/runs tree", () => {
    expect(() => assertRunWorkspaceTreePath("/")).toThrow();
    expect(() => assertRunWorkspaceTreePath("")).toThrow();
    expect(() => assertRunWorkspaceTreePath("/home/user/project")).toThrow();
    expect(() => assertRunWorkspaceTreePath("/srv/app/.paperclip-runtime")).toThrow();
    // A sibling whose name merely starts with "runs" must not match.
    expect(() => assertRunWorkspaceTreePath("/srv/app/.paperclip-runtime/runsXYZ")).toThrow();
  });
});

describe("buildRemoveRunWorkspaceScript", () => {
  it("removes the directory recursively with the path quoted", () => {
    const script = buildRemoveRunWorkspaceScript(`${RUNS}/run-123`);
    expect(script).toBe(`rm -rf -- '${RUNS}/run-123'`);
  });
});

describe("buildReapStaleRunWorkspacesScript", () => {
  it("guards on directory existence and reaps by mtime, sparing named runs", () => {
    const script = buildReapStaleRunWorkspacesScript({
      runsRootDir: RUNS,
      retentionMinutes: 1440,
      spareRunIds: ["active-1", "current-run"],
    });
    expect(script).toContain(`if [ -d '${RUNS}' ]; then`);
    expect(script).toContain(`find '${RUNS}' -mindepth 1 -maxdepth 1 -type d`);
    expect(script).toContain("-mmin +1440");
    expect(script).toContain("! -name 'active-1'");
    expect(script).toContain("! -name 'current-run'");
    expect(script).toContain("-exec rm -rf -- {} +");
  });

  it("floors fractional minutes and drops blank spare ids", () => {
    const script = buildReapStaleRunWorkspacesScript({
      runsRootDir: RUNS,
      retentionMinutes: 90.9,
      spareRunIds: ["", "  ", "keep"],
    });
    expect(script).toContain("-mmin +90");
    expect(script).toContain("! -name 'keep'");
    expect(script).not.toContain("! -name ''");
  });
});
