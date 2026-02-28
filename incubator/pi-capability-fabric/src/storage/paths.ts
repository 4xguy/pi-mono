import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FabricScope = "project" | "global";

export interface FabricPathOptions {
  scope?: FabricScope;
  cwd?: string;
  homeDir?: string;
}

export interface FabricPaths {
  scope: FabricScope;
  root: string;
  registryDir: string;
  capabilitiesDir: string;
  profilesDir: string;
  runsDir: string;
  handoffsDir: string;
  policiesDir: string;
}

export function getProjectFabricRoot(cwd: string = process.cwd()): string {
  return join(cwd, ".pi", "cap-fabric");
}

export function getGlobalFabricRoot(homeDir: string = homedir()): string {
  return join(homeDir, ".pi", "agent", "cap-fabric");
}

export function resolveFabricScope(options: FabricPathOptions = {}): FabricScope {
  if (options.scope) {
    return options.scope;
  }

  const cwd = options.cwd ?? process.cwd();
  const projectRoot = getProjectFabricRoot(cwd);
  if (existsSync(projectRoot)) {
    return "project";
  }

  return "global";
}

export function getFabricPaths(options: FabricPathOptions = {}): FabricPaths {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const scope = resolveFabricScope({ ...options, cwd, homeDir });
  const root = scope === "project" ? getProjectFabricRoot(cwd) : getGlobalFabricRoot(homeDir);

  return {
    scope,
    root,
    registryDir: join(root, "registry"),
    capabilitiesDir: join(root, "capabilities"),
    profilesDir: join(root, "profiles"),
    runsDir: join(root, "runs"),
    handoffsDir: join(root, "handoffs"),
    policiesDir: join(root, "policies"),
  };
}
