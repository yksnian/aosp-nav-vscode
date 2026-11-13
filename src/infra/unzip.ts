import * as path from "path";
import * as fs from "fs/promises";
import * as zlib from "zlib";

/** Minimal zip extractor for the ktlsp server.zip bootstrap.
 *
 *  Central-directory driven (sizes there are authoritative even when entries
 *  use data descriptors), stored (0) and deflate (8) entries only — no zip64:
 *  the archive is ~87 MiB, far below the 4 GiB / 65535-entry limits. */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const buf = await fs.readFile(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`refusing to extract suspicious zip entry: ${name}`);
    }
    // the local header may carry its own extra field of a different length
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(dataStart, dataStart + csize);
    const out = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (out === null) throw new Error(`unsupported zip compression method ${method} for ${name}`);
    const target = path.join(destDir, name);
    if (name.endsWith("/")) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, out);
  }
}
