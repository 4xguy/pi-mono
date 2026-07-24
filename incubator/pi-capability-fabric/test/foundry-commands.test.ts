import { afterEach, describe, expect, it } from "vitest";
import { runFabricBuild } from "../src/commands/fabric-build.ts";
import { runFabricInit } from "../src/commands/fabric-init.ts";
import { runFabricPromote } from "../src/commands/fabric-promote.ts";
import { runFabricTest } from "../src/commands/fabric-test.ts";
import { runFabricShow } from "../src/commands/fabric-show.ts";
import { createTempDir, removeTempDir } from "./helpers.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((path) => removeTempDir(path)));
});

describe("foundry commands", () => {
  it("build/test/promote command flow works", async () => {
    const cwd = await createTempDir("pi-cap-fabric-foundry-cmd-");
    cleanupDirs.push(cwd);

    await runFabricInit({ scope: "project", cwd });

    const build = await runFabricBuild({
      scope: "project",
      cwd,
      capabilityId: "slack.message.post",
      name: "Slack Message Post",
      language: "typescript",
      tags: ["slack", "messaging"],
      alias: "slack-post",
    });

    expect(build.entry.status).toBe("draft");

    const tested = await runFabricTest({
      scope: "project",
      cwd,
      capabilityIdOrAlias: "slack-post",
      input: {
        channel: "general",
        text: "hello",
      },
    });

    expect(tested.passed).toBe(true);
    expect(tested.manifest.status).toBe("tested");

    const promoted = await runFabricPromote({
      scope: "project",
      cwd,
      capabilityIdOrAlias: "slack-post",
    });

    expect(promoted.entry.status).toBe("promoted");

    const shown = await runFabricShow("slack-post", {
      scope: "project",
      cwd,
    });

    expect(shown.capability?.entry.status).toBe("promoted");
  });
});
