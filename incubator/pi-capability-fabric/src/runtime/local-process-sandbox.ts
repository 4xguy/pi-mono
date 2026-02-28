import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname } from "node:path";
import type { SandboxAdapter, SandboxExecutionResult, SandboxExecutionSpec } from "./sandbox.js";

interface SpawnCommand {
  command: string;
  args: string[];
}

const require = createRequire(import.meta.url);

function resolveTsxCliPath(): string {
  return require.resolve("tsx/cli");
}

function createSpawnCommand(spec: SandboxExecutionSpec): SpawnCommand {
  if (spec.language === "python") {
    return {
      command: process.env.PYTHON_BIN ?? "python3",
      args: [spec.entrypointPath],
    };
  }

  const extension = extname(spec.entrypointPath).toLowerCase();
  const isTypeScript = extension === ".ts" || extension === ".tsx" || extension === ".mts";

  if (isTypeScript) {
    return {
      command: process.execPath,
      args: [resolveTsxCliPath(), spec.entrypointPath],
    };
  }

  return {
    command: process.execPath,
    args: [spec.entrypointPath],
  };
}

export class LocalProcessSandbox implements SandboxAdapter {
  async execute(spec: SandboxExecutionSpec): Promise<SandboxExecutionResult> {
    const { command, args } = createSpawnCommand(spec);
    const startedAt = Date.now();

    return new Promise<SandboxExecutionResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...(spec.env ?? {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let finished = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        reject(error);
      });

      const timeoutMs = Math.max(1, Math.floor(spec.timeoutSec * 1000));
      const timer = setTimeout(() => {
        if (finished) {
          return;
        }
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("close", (exitCode: number | null) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);

        resolve({
          exitCode,
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        });
      });

      const payload = JSON.stringify(spec.input ?? null);
      child.stdin.write(payload, "utf8");
      child.stdin.end();
    });
  }
}
