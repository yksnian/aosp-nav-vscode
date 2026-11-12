import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { Defaults, ExclusionConfig, ExcluMerge } from "./core/types";

export interface AospConfig {
  enabled: boolean;
  androidRoot: string | null;
  excludeMerge: ExcluMerge;
  settingsScope: "global" | "workspace";
  exclude: ExclusionConfig;
  kotlinEnabled: boolean;
  javaSourceRoots: string[];
  javaSourceRootModules: string[];
  cpp: CppConfig;
}

export interface CppConfig {
  enabled: boolean;
  /** Delay before a changed `clangd.arguments` triggers `clangd.restart`. */
  restartDebounceMs: number;
  /** Offer the AOSP prebuilt clangd via `clangd.path` (never writes it
   *  without an explicit click). */
  suggestClangdPath: boolean;
  /** Android.bp fallback baseline. */
  curatedIncludes: string[];
  headerLibDepth: number;
}

export const DEFAULT_CURATED_INCLUDES = [
  "bionic/libc/include",
  "bionic/libm/include",
  "system/core/include",
  "system/libbase/include",
  "system/logging/liblog/include",
  "system/unwinding/libunwindstack/include",
  "frameworks/native/include",
  "frameworks/av/include",
  "frameworks/base/include",
  "system/media/audio/include",
  "hardware/libhardware/include",
  "external/libcxx/include",
];

let cachedDefaults: Defaults | null = null;

/** Load shared rules data (single source shared with the nvim plugin). */
export async function loadDefaults(ctx: vscode.ExtensionContext): Promise<Defaults> {
  if (cachedDefaults) return cachedDefaults;
  const p = path.join(ctx.extensionUri.fsPath, "resources", "defaults.json");
  cachedDefaults = JSON.parse(await fs.readFile(p, "utf8")) as Defaults;
  return cachedDefaults;
}

export function getConfig(): AospConfig {
  const c = vscode.workspace.getConfiguration("aosp-nav");
  return {
    enabled: c.get<boolean>("enabled") ?? true,
    androidRoot: c.get<string | null>("androidRoot") ?? null,
    excludeMerge: (c.get<ExcluMerge>("excludeMerge") ?? "append") as ExcluMerge,
    settingsScope: (c.get<"global" | "workspace">("settingsScope") ?? "workspace") as "global" | "workspace",
    exclude: {
      jars: c.get<string[]>("excludeJars") ?? [],
      paths: c.get<string[]>("excludePaths") ?? [],
      globs: c.get<string[]>("excludeGlobs") ?? [],
    },
    kotlinEnabled: c.get<boolean>("kotlin.enabled") ?? false,
    // no static fallback: defaults come from autoModulesForFolder (build
    // index); this list is purely the user's hand-written additions now
    javaSourceRoots: c.get<string[]>("java.sourceRoots") ?? [],
    javaSourceRootModules: c.get<string[]>("java.sourceRootModules") ?? [],
    cpp: {
      enabled: c.get<boolean>("cpp.enabled") ?? true,
      restartDebounceMs: c.get<number>("cpp.restartDebounceMs") ?? 800,
      suggestClangdPath: c.get<boolean>("cpp.suggestClangdPath") ?? true,
      curatedIncludes: c.get<string[]>("cpp.curatedIncludes") ?? DEFAULT_CURATED_INCLUDES,
      headerLibDepth: c.get<number>("cpp.headerLibDepth") ?? 3,
    },
  };
}

/** Merge semantics: append = defaults + user (dedup; a user entry shadowing a
 *  default keeps the default out), replace = user only. */
export function effectiveExclusions(cfg: AospConfig, defaults: Defaults): ExclusionConfig {
  const d: ExclusionConfig = {
    jars: defaults.excludeJars,
    paths: defaults.excludePaths,
    globs: defaults.excludeGlobs,
  };
  if (cfg.excludeMerge === "replace") return cfg.exclude;
  const merged = (defs: string[], user: string[]): string[] => {
    const userSet = new Set(user);
    const out: string[] = [];
    for (const v of defs) {
      if (!userSet.has(v)) out.push(v);
    }
    for (const v of user) out.push(v);
    return out;
  };
  return {
    jars: merged(d.jars, cfg.exclude.jars),
    paths: merged(d.paths, cfg.exclude.paths),
    globs: merged(d.globs, cfg.exclude.globs),
  };
}
