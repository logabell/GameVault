import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(targetFilePath: string): Promise<void> {
  await mkdir(dirname(targetFilePath), { recursive: true });
}

export async function readFileIfExists(targetFilePath: string): Promise<Uint8Array | null> {
  try {
    return await readFile(targetFilePath);
  } catch {
    return null;
  }
}

export async function writeBinaryFile(
  targetFilePath: string,
  payload: Uint8Array,
): Promise<void> {
  await ensureDir(targetFilePath);
  await writeFile(targetFilePath, payload);
}

export function writeBinaryFileSync(
  targetFilePath: string,
  payload: Uint8Array,
): void {
  mkdirSync(dirname(targetFilePath), { recursive: true });
  const tempFilePath = `${targetFilePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempFilePath, payload);
  renameSync(tempFilePath, targetFilePath);
}
