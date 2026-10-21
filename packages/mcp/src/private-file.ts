// Files only this user may read (the MCP token, the OpenNan credentials): a new temp file opened with "wx" and
// mode 0600 is renamed over the target, so an older file's mode never carries over; symlinks are refused.
import { promises as fs } from "node:fs";
import path from "node:path";

export class PrivateFileError extends Error {}

export async function writePrivateFile(file: string, content: string): Promise<void> {
    const existing = await fs.lstat(file).catch(() => null);
    if (existing?.isSymbolicLink()) throw new PrivateFileError(`${file} is a symlink; refusing to write through it`);
    if (existing && !existing.isFile()) throw new PrivateFileError(`${file} is not a regular file`);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
        await handle.writeFile(content);
    } finally {
        await handle.close();
    }
    await fs.rename(tmp, file);
}
