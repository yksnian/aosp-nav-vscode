import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyJdtlsCrash, jdtlsWorkspaceDir, probeJdtlsCrash } from "../src/jdtls/crashSignals";

const tmps: string[] = [];
async function makeWs(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-crash-"));
  tmps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}
afterEach(async () => {
  while (tmps.length) {
    const t = tmps.pop()!;
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("classifyJdtlsCrash", () => {
  it("reports no crash for an empty probe (a normal restart leaves no trace)", () => {
    const r = classifyJdtlsCrash([], [], null);
    expect(r.confirmed).toBe(false);
    expect(r.evidence).toBe("");
    expect(r.newestMs).toBe(0);
  });

  it("reports heap dumps", () => {
    const r = classifyJdtlsCrash([{ name: "java_pid123.hprof", mtimeMs: 500 }], [], null);
    expect(r.confirmed).toBe(true);
    expect(r.heapDumps).toEqual(["java_pid123.hprof"]);
    expect(r.evidence).toContain("1 heap dump(s)");
    expect(r.newestMs).toBe(500);
  });

  it("reports OOM traces from the Eclipse log", () => {
    const r = classifyJdtlsCrash([], ["java.lang.OutOfMemoryError: Java heap space"], 900);
    expect(r.confirmed).toBe(true);
    expect(r.oomTraces).toBe(1);
    expect(r.oomSample).toContain("OutOfMemoryError");
    expect(r.evidence).toContain("OutOfMemoryError");
    expect(r.newestMs).toBe(900);
  });

  it("takes the newest evidence mtime and caps the summary", () => {
    const r = classifyJdtlsCrash(
      [
        { name: "a.hprof", mtimeMs: 100 },
        { name: "b.hprof", mtimeMs: 700 },
        { name: "c.hprof", mtimeMs: 300 },
        { name: "d.hprof", mtimeMs: 200 },
      ],
      ["OutOfMemoryError"],
      400
    );
    expect(r.newestMs).toBe(700);
    expect(r.evidence).toContain("4 heap dump(s)");
    expect(r.evidence).toContain("(+1 more)");
  });
});

describe("probeJdtlsCrash", () => {
  it("returns an empty probe for a missing directory", async () => {
    const r = await probeJdtlsCrash(path.join(os.tmpdir(), "aosp-nav-no-such-ws"));
    expect(r.confirmed).toBe(false);
  });

  it("ignores a clean Eclipse log and ordinary files", async () => {
    const ws = await makeWs({
      "workspace-folder": "",
      ".metadata/.log": "!ENTRY org.eclipse.osgi 1 0 2026-11-01\n!MESSAGE FrameworkEvent INFO\n",
      "notes.txt": "hello",
    });
    const r = await probeJdtlsCrash(ws);
    expect(r.confirmed).toBe(false);
  });

  it("detects a heap dump in the server working directory", async () => {
    const ws = await makeWs({ "java_pid4711.hprof": "not really a dump" });
    const r = await probeJdtlsCrash(ws);
    expect(r.confirmed).toBe(true);
    expect(r.heapDumps).toEqual(["java_pid4711.hprof"]);
  });

  it("detects hs_err fatal-error logs", async () => {
    const ws = await makeWs({ "hs_err_pid99.log": "# fatal error" });
    const r = await probeJdtlsCrash(ws);
    expect(r.heapDumps).toEqual(["hs_err_pid99.log"]);
  });

  it("detects OutOfMemoryError in the Eclipse log tail", async () => {
    const ws = await makeWs({
      ".metadata/.log": [
        "!ENTRY org.eclipse.jdt.ls 4 0 2026-11-11",
        "java.lang.OutOfMemoryError: Java heap space",
        "\tat org.eclipse.jdt.internal.compiler.ast.LambdaExpression.copy(LambdaExpression.java:1110)",
        "",
      ].join("\n"),
    });
    const r = await probeJdtlsCrash(ws);
    expect(r.confirmed).toBe(true);
    expect(r.oomTraces).toBe(1);
    expect(r.evidence).toContain(".metadata/.log");
  });
});

describe("jdtlsWorkspaceDir", () => {
  it("derives the redhat.java workspace from the extension storage path", () => {
    expect(jdtlsWorkspaceDir("/data/User/workspaceStorage/abc/acme.aosp-nav"))
      .toBe("/data/User/workspaceStorage/abc/redhat.java/jdt_ws");
  });
});
