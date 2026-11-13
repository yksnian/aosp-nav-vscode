import { describe, it, expect } from "vitest";
import * as zlib from "zlib";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { extractZip } from "../src/infra/unzip";

/** Minimal in-memory zip writer for the extractor tests: stored (0) and
 *  deflate (8) entries, central directory + EOCD, crc fields left empty
 *  (extractZip does not verify them). */
function buildZip(entries: { name: string; data: Buffer; method: 0 | 8 }[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const payload = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(e.method, 8);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    body.push(lfh, name, payload);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(e.method, 10);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += 30 + name.length + payload.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, ...central, eocd]);
}

describe("extractZip", () => {
  it("extracts stored and deflated entries with nested dirs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-unzip-"));
    try {
      const zip = path.join(dir, "server.zip");
      await fs.writeFile(
        zip,
        buildZip([
          { name: "server/", data: Buffer.alloc(0), method: 0 },
          { name: "server/bin/kotlin-language-server", data: Buffer.from("#!/bin/sh\necho hi\n"), method: 0 },
          { name: "server/lib/kls.jar", data: Buffer.from("jar-bytes-".repeat(200)), method: 8 },
        ])
      );
      const dest = path.join(dir, "out");
      await extractZip(zip, dest);
      expect(await fs.readFile(path.join(dest, "server/bin/kotlin-language-server"), "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect((await fs.readFile(path.join(dest, "server/lib/kls.jar"), "utf8")).length).toBe(2000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-zip input", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-unzip-"));
    try {
      const zip = path.join(dir, "bad.zip");
      await fs.writeFile(zip, "definitely not a zip");
      await expect(extractZip(zip, path.join(dir, "out"))).rejects.toThrow(/not a zip/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses path traversal entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-unzip-"));
    try {
      const zip = path.join(dir, "evil.zip");
      await fs.writeFile(
        zip,
        buildZip([{ name: "../escape.txt", data: Buffer.from("x"), method: 0 }])
      );
      await expect(extractZip(zip, path.join(dir, "out"))).rejects.toThrow(/suspicious zip entry/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
