import { describe, expect, it } from "vitest";
import {
  AUTOBUILD_JAR_THRESHOLD,
  autobuildState,
  decideAutobuild,
} from "../src/jdtls/autobuild";

describe("decideAutobuild", () => {
  const base = { workspaceIsAospRoot: true, jars: 774, explicit: false, ours: false };

  it("never writes when the workspace folder is not the AOSP root", () => {
    const d = decideAutobuild({ ...base, workspaceIsAospRoot: false });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("not the AOSP root");
  });

  it("never overrides an explicit user value, even on a huge root", () => {
    const d = decideAutobuild({ ...base, explicit: true });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("set by the user");
  });

  it("does not rewrite a value it wrote itself", () => {
    const d = decideAutobuild({ ...base, explicit: true, ours: true });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("already disabled by aosp-nav");
  });

  it("does not write below the jar threshold", () => {
    const d = decideAutobuild({ ...base, jars: AUTOBUILD_JAR_THRESHOLD - 1 });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("only");
  });

  it("writes at and above the threshold", () => {
    expect(decideAutobuild({ ...base, jars: AUTOBUILD_JAR_THRESHOLD }).write).toBe(true);
    expect(decideAutobuild({ ...base, jars: 774 }).write).toBe(true);
  });
});

describe("autobuildState", () => {
  it("defaults to on when no layer sets the key", () => {
    expect(autobuildState(undefined, false)).toEqual({ value: true, source: "default" });
    expect(autobuildState({}, false)).toEqual({ value: true, source: "default" });
  });

  it("reports a plugin write as the origin of the workspace value", () => {
    expect(autobuildState({ workspaceValue: false }, true)).toEqual({ value: false, source: "plugin" });
  });

  it("distinguishes user layers", () => {
    expect(autobuildState({ workspaceValue: true }, false)).toEqual({ value: true, source: "user-workspace" });
    expect(autobuildState({ workspaceFolderValue: false }, false)).toEqual({
      value: false,
      source: "user-workspace-folder",
    });
    expect(autobuildState({ globalValue: false }, false)).toEqual({ value: false, source: "user-global" });
  });

  it("workspace wins over workspace-folder and global", () => {
    expect(
      autobuildState({ workspaceValue: true, workspaceFolderValue: false, globalValue: false }, false)
    ).toEqual({ value: true, source: "user-workspace" });
  });

  it("respects a changed default value", () => {
    expect(autobuildState({ defaultValue: false }, false)).toEqual({ value: false, source: "default" });
  });
});
