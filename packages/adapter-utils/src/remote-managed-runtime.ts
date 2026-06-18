import path from "node:path";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  reapStaleRemoteRunWorkspaces,
  removeRemoteRunWorkspace,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import { resolveRunWorkspaceGcConfig } from "./runtime-workspace-gc.js";
import { runningProcesses } from "./server-utils.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  restoreWorkspace(): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  assets?: RemoteManagedRuntimeAsset[];
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const workspaceRemoteDir = path.posix.join(
    baseWorkspaceRemoteDir,
    ".paperclip-runtime",
    "runs",
    input.runId,
    "workspace",
  );
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  // `workspaceRemoteDir` is `<base>/.paperclip-runtime/runs/<runId>/workspace`,
  // so its parent is this run's throwaway directory and the grandparent is the
  // shared runs root that all runs share.
  const perRunWorkspaceDir = path.posix.dirname(workspaceRemoteDir);
  const runsRootDir = path.posix.dirname(perRunWorkspaceDir);
  const gcConfig = resolveRunWorkspaceGcConfig();

  const preparedWorkspace = await prepareWorkspaceForSshExecution({
    spec: input.spec,
    localDir: input.workspaceLocalDir,
    remoteDir: workspaceRemoteDir,
  });

  // Opportunistic sweep of stale sibling run directories. This runs on every
  // run preparation (so it doubles as the periodic + disk-pressure guard) and
  // is best-effort: a failure must never block starting a run. The remote
  // sweep is TTL-based; the max-count / max-total-size budgets in the GC policy
  // are enforced by the local `sweepLocalRunWorkspaces` helper. Live runs are
  // spared by name via the in-memory process registry, so an old mtime alone
  // can never reap an active run.
  if (gcConfig.sweepEnabled) {
    const spareRunIds = [input.runId, ...runningProcesses.keys()];
    await reapStaleRemoteRunWorkspaces({
      spec: input.spec,
      runsRootDir,
      retentionMs: gcConfig.policy.retentionMs,
      spareRunIds,
    }).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[paperclip] failed to reap stale run workspaces under ${runsRootDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  const restoreExclude = preparedWorkspace.gitBacked ? [".git", ".paperclip-runtime"] : [".paperclip-runtime"];
  const baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
    exclude: restoreExclude,
  });

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
      });
    }
  } catch (error) {
    await restoreWorkspaceFromSshExecution({
      spec: input.spec,
      localDir: input.workspaceLocalDir,
      remoteDir: workspaceRemoteDir,
      baselineSnapshot,
      restoreGitHistory: preparedWorkspace.gitBacked,
    });
    throw error;
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    restoreWorkspace: async () => {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
      });
      // The per-run copy is throwaway once changes are merged back. Remove it
      // so `.paperclip-runtime/runs` stays bounded. Best-effort: a failed
      // delete is left for the next prepare-time sweep rather than surfaced as
      // a run failure. Set PAPERCLIP_KEEP_RUN_WORKSPACE=1 to retain it for
      // debugging.
      if (!gcConfig.keepWorkspace) {
        await removeRemoteRunWorkspace(input.spec, perRunWorkspaceDir).catch((error) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[paperclip] failed to remove run workspace ${perRunWorkspaceDir}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    },
  };
}
