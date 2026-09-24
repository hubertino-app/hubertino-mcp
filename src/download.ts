import { existsSync, statSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

/**
 * Pick the directory an export is saved to: an explicit absolute directory,
 * else HUBERTINO_DOWNLOAD_DIR, else ~/Downloads when it exists, else the OS
 * temp directory.
 */
export function resolveDownloadDir(explicit: string | undefined, configured: string | null): string {
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(`directory must be an absolute path (got "${explicit}").`);
    }
    return resolve(explicit);
  }
  if (configured) return resolve(configured);
  const downloads = join(homedir(), "Downloads");
  try {
    if (existsSync(downloads) && statSync(downloads).isDirectory()) return downloads;
  } catch {
    // fall through
  }
  return tmpdir();
}

/**
 * Stream `body` into `dir/filename` without ever overwriting an existing file:
 * `leads.csv` becomes `leads-1.csv`, `leads-2.csv`, … when taken.
 * Returns the absolute path and the number of bytes written.
 */
export async function saveStream(
  body: ReadableStream<Uint8Array>,
  dir: string,
  filename: string,
): Promise<{ path: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const { name, ext } = parsePath(filename);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let path = "";
  for (let i = 0; i < 1000 && !handle; i++) {
    path = join(dir, i === 0 ? `${name}${ext}` : `${name}-${i}${ext}`);
    try {
      handle = await open(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (!handle) throw new Error(`Could not find a free file name for ${filename} in ${dir}.`);

  let bytes = 0;
  const source = Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  try {
    await pipeline(source, handle.createWriteStream());
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw err;
  }
  return { path, bytes };
}
