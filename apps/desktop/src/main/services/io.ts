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
