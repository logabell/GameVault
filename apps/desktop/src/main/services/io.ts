import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
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

export function writeBinaryFileSync(
  targetFilePath: string,
  payload: Uint8Array,
  options: {
    beforeReplace?: () => void;
    validateWrittenFile?: (tempFilePath: string) => void;
  } = {},
): void {
  mkdirSync(dirname(targetFilePath), { recursive: true });
  const tempFilePath = `${targetFilePath}.${process.pid}.${Date.now()}.tmp`;
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(tempFilePath, 'w');
    let bytesWritten = 0;
    while (bytesWritten < payload.byteLength) {
      bytesWritten += writeSync(
        fileDescriptor,
        payload,
        bytesWritten,
        payload.byteLength - bytesWritten,
      );
    }
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;

    options.validateWrittenFile?.(tempFilePath);
    options.beforeReplace?.();
    renameSync(tempFilePath, targetFilePath);
  } catch (error) {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    rmSync(tempFilePath, { force: true });
    throw error;
  }
}
