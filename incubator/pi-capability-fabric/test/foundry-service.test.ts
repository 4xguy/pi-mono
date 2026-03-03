import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFabricInit } from "../src/commands/fabric-init.js";
import { FoundryService } from "../src/foundry/foundry-service.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { readTextFile, writeTextFileAtomic } from "../src/storage/files.js";
import { getFabricPaths } from "../src/storage/paths.js";
import { createTempDir, removeTempDir } from "./helpers.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((path) => removeTempDir(path)));
});

describe("foundry service", () => {
  it("builds, tests, promotes, and runs a capability", async () => {
    const cwd = await createTempDir("pi-cap-fabric-foundry-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const foundry = new FoundryService({ paths });

    const buildResult = await foundry.buildCapability({
      capabilityId: "github.issues.search",
      name: "GitHub Issue Search",
      language: "typescript",
      tags: ["github", "issues"],
      alias: "gh-issues",
      authProvider: "github-token",
      authScopes: ["repo"],
    });

    expect(buildResult.entry.status).toBe("draft");
    expect(buildResult.manifest.status).toBe("draft");

    const testResult = await foundry.testCapability({
      capabilityIdOrAlias: "gh-issues",
      input: {
        query: "bug",
      },
    });

    expect(testResult.passed).toBe(true);
    expect(testResult.manifest.status).toBe("tested");
    expect(testResult.report.result).toBe("pass");
    expect(testResult.runtimeRunId).not.toBeNull();

    const promoteResult = await foundry.promoteCapability({
      capabilityIdOrAlias: "gh-issues",
    });

    expect(promoteResult.entry.status).toBe("promoted");
    expect(promoteResult.manifest.status).toBe("promoted");

    const runtime = new RuntimeService({ paths });
    const runtimeResult = await runtime.executeCapability({
      capabilityIdOrAlias: "gh-issues",
      input: {
        query: "bug",
      },
    });

    expect(runtimeResult.ok).toBe(true);
    expect(runtimeResult.output).toEqual({
      capability_id: "github.issues.search",
      ok: true,
      input: {
        query: "bug",
      },
    });
  });

  it("blocks failed validation and prevents promotion", async () => {
    const cwd = await createTempDir("pi-cap-fabric-foundry-fail-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const paths = getFabricPaths({ scope: "project", cwd });
    const foundry = new FoundryService({ paths });

    await foundry.buildCapability({
      capabilityId: "internal.fail.check",
      name: "Internal Fail Check",
      language: "typescript",
      tags: ["internal"],
    });

    await writeTextFileAtomic(
      join(paths.root, "capabilities/internal.fail.check/versions/v0001/tool.ts"),
      [
        'throw new Error("forced failure");',
        "",
      ].join("\n"),
    );

    const testResult = await foundry.testCapability({
      capabilityIdOrAlias: "internal.fail.check",
      input: {
        check: true,
      },
    });

    expect(testResult.passed).toBe(false);
    expect(testResult.manifest.status).toBe("blocked");
    expect(testResult.report.result).toBe("fail");

    await expect(
      foundry.promoteCapability({
        capabilityIdOrAlias: "internal.fail.check",
      }),
    ).rejects.toThrow(/tested status required/);

    const reportText = await readTextFile(join(paths.root, testResult.reportPath));
    const report = JSON.parse(reportText) as { result: string };
    expect(report.result).toBe("fail");
  });
});
