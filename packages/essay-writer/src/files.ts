import { open, mkdir, readFile, lstat, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { parseJsonText } from "@mantou/text-quality";
export class UserError extends Error { constructor(public code: string, public hint: string) { super(code); } }
export function fail(code: string, hint: string): never { throw new UserError(code, hint); }
export const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export async function readLimited(path: string, max = 1_000_000): Promise<Buffer> {
  const handle = await open(path, "r");
  try { const info = await handle.stat(); if (!info.isFile() || info.size > max) fail("file-size", "Choose a regular file within the documented size limit.");
    const buffer = Buffer.alloc(max + 1); let length = 0;
    while (length < buffer.length) { const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > max) fail("file-size", "The file exceeds the input limit."); return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
export function utf8(data: Uint8Array): string {
  try { return new TextDecoder("utf-8", {fatal:true}).decode(data); } catch { return fail("encoding", "Save the file as UTF-8. UTF-16 files are not supported."); }
}
export async function readJson(path: string, max?: number): Promise<unknown> { return parseJsonText(utf8(await readLimited(path, max))); }
export async function createNewDirectory(path: string) {
  const target = resolve(path); await mkdir(dirname(target), {recursive:true});
  try { await mkdir(target, {mode:0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") fail("output-exists", "Choose a new output folder. Existing sessions are never overwritten."); throw e; }
  return target;
}
export async function writeNew(path: string, value: string | Uint8Array) {
  const h = await open(path, "wx", 0o600); try { await h.writeFile(value); await h.sync(); } finally { await h.close(); }
}
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export async function regularWithin(root: string, name: string, max = 1_000_000) {
  const target = resolve(root, name); const diff = relative(root, target);
  if (diff.startsWith("..") || isAbsolute(diff)) fail("path-scope", "Session files must remain inside the session.");
  const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) fail("session-file", "Session files must be regular files, not links.");
  return readLimited(target, max);
}
