/** Pure data types shared across core modules. No vscode/node imports. */

export interface Defaults {
  schemaVersion: number;
  excludeJars: string[];
  excludePaths: string[];
  excludeGlobs: string[];
  ownTags: string[];
  repackagedTags: string[];
  soongTagPriority: string[];
  dirPriority: Array<[string, number]>;
  dirPriorityFallback: number;
  makeJars: string[];
  makeBlacklist: string[];
}

export interface ExclusionConfig {
  jars: string[];   // regex sources, matched against jar name AND module name
  paths: string[];  // substring keywords on full path
  globs: string[];  // regex on path relative to .intermediates/
}

export type ExcluMerge = "append" | "replace";

export interface ScanEntry {
  absPath: string;
  relPath: string;    // relative to the .intermediates base dir
  moduleName: string; // with .impl stripped
  variant: string;
  type: string;       // javac | kotlinc | combined | turbine-combined | ...
}

export interface ScanStats {
  scanned: number;
  excluded: number;
  selected: number;
  dedupPreJarjar: number;
}

export interface ScanResult {
  jars: string[];
  stats: ScanStats;
}
