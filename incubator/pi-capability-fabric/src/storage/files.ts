import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDirectories(paths: string[]): Promise<void> {
  for (const path of paths) {
    await mkdir(path, { recursive: true });
  }
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeTextFileIfMissing(path: string, content: string): Promise<boolean> {
  if (await fileExists(path)) {
    return false;
  }

  await ensureParentDirectory(path);
  await writeFile(path, content, "utf8");
  return true;
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await ensureParentDirectory(path);
  await writeFile(path, content, "utf8");
}

export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  await ensureParentDirectory(path);

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

export async function appendTextLine(path: string, line: string): Promise<void> {
  await ensureParentDirectory(path);
  await appendFile(path, `${line}\n`, "utf8");
}
