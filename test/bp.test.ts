import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { lookupBp, parseBlueprint, pickModule } from "../src/clangd/bp";

const BP = `// a comment
cc_library {
    name: "libfoo",
    srcs: ["a.cpp", "b.cpp"],
    local_include_dirs: ["inc"],
    export_include_dirs: ["export"],
    cflags: ["-DFOO", "+not-a-flag"],
    header_libs: ["libbar"],
    target: {
        android: {
            srcs: ["nested.cpp"],
            cflags: ["-DNESTED"],
        },
    },
}

cc_library_static {
    name: "libbar",
    export_include_dirs: ["bar_inc"],
}

cc_binary {
    name: "tool",
}
`;

describe("parseBlueprint", () => {
  it("parses cc_* blocks and ignores other block types", () => {
    const mods = parseBlueprint(BP);
    expect(mods.map((m) => m.name)).toEqual(["libfoo", "libbar", "tool"]);
  });

  it("does not pick nested fields into the depth-1 module", () => {
    const mods = parseBlueprint(BP);
    const foo = mods.find((m) => m.name === "libfoo")!;
    expect(foo.fields.cflags).toEqual(["-DFOO", "+not-a-flag"]);
    expect(foo.fields.srcs).toEqual(["a.cpp", "b.cpp"]);
  });

  it("strips line and block comments without touching strings", () => {
    const mods = parseBlueprint('cc_library { name: "x", srcs: ["a//b.cpp"] } /* tail */');
    expect(mods[0].name).toBe("x");
    expect(mods[0].fields.srcs).toEqual(["a//b.cpp"]);
  });
});

describe("pickModule", () => {
  const mods = parseBlueprint(BP);

  it("matches a srcs entry by basename", () => {
    const m = pickModule(mods, "/aosp/x/a.cpp", "/aosp", "/aosp/x");
    expect(m?.name).toBe("libfoo");
  });

  it("matches a srcs entry by root-relative path", () => {
    const m = pickModule(mods, "/aosp/x/b.cpp", "/aosp", "/aosp/x");
    expect(m?.name).toBe("libfoo");
  });

  it("falls back to the first compilable module", () => {
    const m = pickModule(mods, "/aosp/x/unknown.cpp", "/aosp", "/aosp/x");
    expect(m?.name).toBe("libfoo");
  });
});

describe("lookupBp fallback", () => {
  it("assembles include dirs, flags and same-file header_libs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-bp-"));
    try {
      await fs.writeFile(path.join(root, "Android.bp"), BP);
      const existing = new Set([
        path.join(root, "inc"),
        path.join(root, "export"),
        path.join(root, "bar_inc"),
        path.join(root, "system/libbase/include"),
      ]);
      const r = await lookupBp(root, path.join(root, "a.cpp"), {
        curatedIncludes: ["system/libbase/include"],
        headerLibDepth: 3,
        isDir: (p) => existing.has(p),
      });
      expect(r?.origin).toBe("bp");
      expect(r?.module).toBe("libfoo");
      expect(r?.args).toContain("-I" + path.join(root, "inc"));
      expect(r?.args).toContain("-I" + path.join(root, "export"));
      expect(r?.args).toContain("-I" + path.join(root, "bar_inc"));
      expect(r?.args).toContain("-DFOO");
      expect(r?.args).toContain("-I" + path.join(root, "system/libbase/include"));
      expect(r?.args).not.toContain("+not-a-flag");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when neither a bp nor curated dirs exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-bp-"));
    try {
      const r = await lookupBp(root, path.join(root, "a.cpp"), {
        curatedIncludes: [],
        headerLibDepth: 3,
        isDir: () => false,
      });
      expect(r).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
