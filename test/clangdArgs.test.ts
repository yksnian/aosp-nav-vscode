import { describe, it, expect, vi } from "vitest";
import {
  compileCommandsFlag,
  hasCompileCommandsDir,
  planClangdArguments,
  removeOwnArguments,
} from "../src/clangd/clangdArgs";
import { Debouncer } from "../src/infra/debounce";

describe("clangd.arguments planning", () => {
  it("does nothing when no CDB directory is available", () => {
    const p = planClangdArguments(["--background-index"], null);
    expect(p).toEqual({ next: ["--background-index"], changed: false, injected: false, flag: null });
  });

  it("appends the compile-commands-dir flag while preserving user args", () => {
    const p = planClangdArguments(["--background-index"], "/cache/cpp");
    expect(p.changed).toBe(true);
    expect(p.injected).toBe(true);
    expect(p.next).toEqual(["--background-index", "--compile-commands-dir=/cache/cpp"]);
  });

  it("is idempotent when the same flag is already present", () => {
    const existing = ["--background-index", compileCommandsFlag("/cache/cpp")];
    const p = planClangdArguments(existing, "/cache/cpp");
    expect(p.changed).toBe(false);
    expect(p.injected).toBe(true);
    expect(p.next).toEqual(existing);
  });

  it("defers to a user-configured flag in either form", () => {
    expect(hasCompileCommandsDir(["--compile-commands-dir=/mine"])).toBe(true);
    expect(hasCompileCommandsDir(["--compile-commands-dir", "/mine"])).toBe(true);
    const inline = planClangdArguments(["--compile-commands-dir=/mine"], "/cache/cpp");
    expect(inline.changed).toBe(false);
    expect(inline.next).toEqual(["--compile-commands-dir=/mine"]);
  });

  it("replaces a stale flag previously written by this extension", () => {
    const stale = compileCommandsFlag("/cache/old");
    const p = planClangdArguments(["--background-index", stale], "/cache/new", [stale]);
    expect(p.changed).toBe(true);
    expect(p.next).toEqual(["--background-index", "--compile-commands-dir=/cache/new"]);
  });

  it("drops its own stale flag when the user has their own", () => {
    const stale = compileCommandsFlag("/cache/old");
    const p = planClangdArguments(
      ["--compile-commands-dir=/mine", stale],
      "/cache/new",
      [stale]
    );
    expect(p.changed).toBe(true);
    expect(p.next).toEqual(["--compile-commands-dir=/mine"]);
  });

  it("removes only the flags this extension wrote", () => {
    const args = ["--background-index", "--compile-commands-dir=/mine", compileCommandsFlag("/our")];
    expect(removeOwnArguments(args, [compileCommandsFlag("/our")])).toEqual([
      "--background-index",
      "--compile-commands-dir=/mine",
    ]);
  });
});

describe("Debouncer", () => {
  it("coalesces rapid calls into one trailing run", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = new Debouncer(800, fn);
      d.schedule();
      d.schedule();
      d.schedule();
      expect(fn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(799);
      expect(fn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(d.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel prevents the trailing run", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = new Debouncer(800, fn);
      d.schedule();
      d.cancel();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
