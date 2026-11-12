# aosp-nav

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/yksnian/aosp-nav-vscode)

Instant source navigation for Android (AOSP) in VSCode — go-to-definition, completion and reference resolution across **all** Java and Kotlin modules (frameworks/base, packages/modules/*, system_server services, ...), with zero manual project setup.

The VSCode counterpart of [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim); both share the same jar-selection algorithm and rule data.

## Why

Opening AOSP in VSCode with the Java extension alone gives you almost nothing: AOSP is not a Gradle/Maven project, so the language server sees only the file you opened. Meanwhile the build output (`out/soong/.intermediates`) contains 10,000+ jars that could provide every symbol — but feeding them all in blindly means duplicated classes, stub jars hijacking navigation, and an index that never finishes.

aosp-nav bridges that gap automatically:

1. **Detect** — open any `.java` file in an AOSP checkout; the plugin walks up from the file path to find the AOSP root (before that, it is fully silent).
2. **Select** — compute the dependency closure of the selected module dirs from `out/soong/module_bp_java_deps.json`, with a built-variant fallback per module: a few hundred jars instead of the whole `out/soong/.intermediates` tree.
3. **Inject** — write the ordered jar list to `java.project.referencedLibraries`, apply AOSP compatibility switches (disable Gradle/Maven importers, exclude `out/`/`.repo/` from import), and keep the file watcher/search away from the huge `out/` tree (`files.watcherExclude`, `search.exclude`). The write is automatic (no confirmation) and retried on the next file open if it fails.
4. **Guard** — the eclipse guard scans the whole workspace for leftover `.project` markers (old jdtls/buildship sessions) and excludes every such directory from import detection, so jdt.ls keeps creating its invisible project and `referencedLibraries` actually applies (see FAQ).
5. **Cache** — persist the list, auto-invalidated by algorithm version or exclusion-config fingerprint. Configuration changes just work.

## Requirements

- VSCode >= 1.95
- [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) (`redhat.java`) — installed automatically via `extensionDependencies`
- Optional, Kotlin navigation: [vscode-kotlin](https://marketplace.visualstudio.com/items?itemName=fwcd.kotlin) (`fwcd.kotlin`) — see [Kotlin support](#kotlin-support-experimental)
- Optional, C/C++ navigation: [clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd) (`llvm-vs-code-extensions.vscode-clangd`). The extension bundles no clangd binary; point `clangd.path` at the AOSP prebuilt (`prebuilts/clang/host/linux-x86/clang-*/bin/clangd`), or accept the one-time suggestion from aosp-nav
- A **compiled** AOSP tree (`out/soong/.intermediates` present)

Recommended for large trees — raise the language server heap (user settings):

```jsonc
"java.jdt.ls.vmargs": "-Xmx8G -Xms2G --add-modules=ALL-SYSTEM --add-opens=java.base/java.util=ALL-UNNAMED"
```

## Usage

1. Open any `.java` file inside an AOSP checkout (having the AOSP root open as a workspace folder is fine — nothing happens until a Java file is opened).
2. Status bar: `$(sync~spin) AOSP` → `$(check) AOSP:<n>` within seconds (subsequent opens come from cache, instantly).
3. **First run, before anything is injected**: a one-time modal asks whether to pick Java source-root modules. Picking opens the module picker and injects exactly what you select; dismissing it (or choosing "Use defaults") selects the default modules — `frameworks/base/core/java` and `frameworks/base/services/core` — and injects every first-party source root they own (16 roots / ~7.5k `.java` on a real tree). The default is written to `aosp-nav.java.sourceRootModules`, so the picker shows exactly those two modules checked. In a sub-directory window nothing is asked and the folder's build-index modules are used. Change the choice later with `AOSP: Select Java Source Roots by Module`.
4. **First time only**: the language server indexes the classpath in the background — 30–60 minutes on frameworks/base-sized trees, high CPU is normal. It is one-time; later opens are instant. Do **not** restart the language server during this phase.
5. Navigate: F12 / completions now resolve `android.*`, `com.android.*`, system_server internals, etc. Types that exist only in jars (AIDL interfaces, proto classes, aconfig flags) land in the decompiled view — expected, since no `.java` for them exists in the source tree.

Works with the AOSP root or any sub-checkout (e.g. `frameworks/base`) as the workspace — detection is per opened file, not per folder. If the guard finds leftover Eclipse metadata dirs on first use (typical when opening the AOSP root on a machine that previously ran the nvim plugin or buildship), it offers a one-time "clean and reload" (`java.clean.workspace`): the clean rebuilds the language-server workspace, after which the first Eclipse index takes ~30–60 minutes — one-time cost.

Messages follow the VS Code display language: Chinese for zh-cn, English everywhere else.

## Install & verify (user checklist)

1. Install `redhat.java` (declared dependency). For C/C++ install `llvm-vs-code-extensions.vscode-clangd` separately — the clangd extension bundles no server.
2. Install the VSIX in the same environment as the AOSP checkout. In Remote-WSL, run `code --install-extension aosp-nav-0.2.0.vsix` from the WSL terminal, then reload the window.
3. Open the AOSP checkout as a workspace folder. Multi-root windows work, but all C/C++ files in one window share a single `clangd.arguments`.
4. **Java**: open any `.java` file and wait for `$(check) AOSP:<n>`. The module picker runs before injection; skipping it selects the default modules (`frameworks/base/core/java` + `frameworks/base/services/core` and all their first-party roots in an AOSP-root window). `sourcePaths` are pushed into the running language server, so no reload is normally needed — the reload prompt only appears if jdt.ls rejects the live update, once per distinct root list.
5. **C/C++**: set `clangd.path` to `<root>/prebuilts/clang/host/linux-x86/clang-r*/bin/clangd` (or accept the first-open suggestion). Open a `.cpp`; the first file may start with old arguments and then restart clangd once after the 800 ms debounce. Later files reuse the server. Verify with F12 on a symbol referenced by an `#include` in a C/C++ file — it should resolve to the corresponding header in the source tree. `AOSP: Show Diagnostics` should report `cpp origin` as `compdb` or `cc_deps`.
6. **Generated headers (AIDL/protobuf outputs, etc.)**: `cc_deps` intentionally carries no `out/soong/.intermediates` paths. Generate the official database with `make SOONG_GEN_COMPDB=1 nothing` (or `m SOONG_GEN_COMPDB=1 nothing`) in the same tree, then reload the window once so the plugin switches to the compdb tier.
7. **Reload Window is needed only for**: switching to a compdb generated after the session started, and the rare case where jdt.ls rejects the live `sourcePaths` update. Source-root changes (`aosp-nav.java.sourceRoots` / `sourceRootModules`), incremental C/C++ entry writes and ordinary `clangd.arguments` updates need no reload.

## Commands

| Command                       | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `AOSP: Rescan Jars`           | Drop the jar cache and rescan (also re-runs the eclipse guard, skipping its 24 h cache — stale `.project` dirs deleted by hand are picked up immediately) |
| `AOSP: Show Diagnostics`      | Structured self-check (root / cache / settings / extensions / guard) — attach it to issues |
| `AOSP: Fix Eclipse Metadata Blockers` | Run the one-time clean+reload for leftover Eclipse metadata dirs |
| `AOSP: Reset Plugin Settings` | Remove every setting this plugin added (incl. the workspace layer). Keys it merged into keep your own entries |

## Configuration

Exclusion lists use **append** semantics by default: your entries are added after the built-in defaults (which already cover every known stub family). Set `aosp-nav.excludeMerge` to `"replace"` to discard the defaults.

| Setting                  | Default    | Description                                                  |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `aosp-nav.enabled`       | `true`     | Enable the plugin                                            |
| `aosp-nav.androidRoot`   | `null`     | Explicit AOSP root; auto-detected per opened file when null  |
| `aosp-nav.excludeJars`   | `[]`       | Regex matched against jar file name AND module name, e.g. `"fake"` drops every jar/module containing it |
| `aosp-nav.excludePaths`  | `[]`       | Substring keywords on the jar path relative to `.intermediates/` (same base as `excludeGlobs`), e.g. `"external/cronet"` |
| `aosp-nav.excludeGlobs`  | `[]`       | Regex on the path relative to `.intermediates/`. Anchor with `^` for top-level precision, e.g. `"^packages/apps/"` |
| `aosp-nav.excludeMerge`  | `"append"` | `append` = user lists added after defaults; `replace` = defaults discarded |
| `aosp-nav.settingsScope` | `"workspace"` | Where `referencedLibraries` and the Gradle/Maven importer switches are written: `workspace` (`.vscode/settings.json` inside the repo, no impact on other Java projects) or `global` (user settings, shared across windows, but absolute jar paths pollute non-AOSP Java projects). Since 0.1.2 the write needs no confirmation; switching scope auto-clears our previous list from the other layer. A switch you set back to `true` yourself is always left alone |
| `aosp-nav.kotlin.enabled` | `false` | Experimental: feed the same jar list to the fwcd kotlin-language-server via its global classpath script (see [Kotlin support](#kotlin-support-experimental)) |
| `aosp-nav.java.sourceRoots` | `[]` | Extra source roots (relative to the AOSP root, or absolute) added on top of the module selection and written to the workspace layer of `java.project.sourcePaths`. An empty array means "no hand-written additions", not "disable injection" — module selection (or the root-window defaults) still applies. Applied to the running server without a reload |
| `aosp-nav.java.sourceRootModules` | `[]` (never written = root-window defaults) | Module directories picked via `AOSP: Select Java Source Roots by Module`. An AOSP-root window with no written selection persists `frameworks/base/core/java` + `frameworks/base/services/core` here and injects every first-party source root they own (16 roots / ~7.5k `.java` on a real tree); a sub-directory window uses the production modules under it (tests/demos/samples/commercial excluded) from `out/soong/module_bp_java_deps.json`. Writing an explicit list (even `[]` = none) disables both defaults. Applied without a reload |
| `aosp-nav.cpp.enabled` | `true` | C/C++ navigation via clangd (see [C/C++ navigation](#cc-navigation-clangd)) |
| `aosp-nav.cpp.restartDebounceMs` | `800` | Debounce before restarting clangd after `clangd.arguments` actually changed; later CDB entry writes reload without restart |
| `aosp-nav.cpp.suggestClangdPath` | `true` | Offer the AOSP prebuilt clangd for `clangd.path` (only written after an explicit click) |
| `aosp-nav.cpp.curatedIncludes` | see below | Include dirs (root-relative, missing ones skipped) used only by the Android.bp fallback tier |
| `aosp-nav.cpp.headerLibDepth` | `3` | Max depth when resolving `header_libs` inside the same Android.bp (fallback tier only) |

Notes on multi-repo windows: with the `global` scope, opening files from different sub-checkouts in one window injects the **union** of jars (they heavily overlap anyway). With the default `workspace` scope the list is written per repo — open each sub-checkout in its own window for strictly per-repo classpaths.

### Java source navigation (`java.project.sourcePaths`)

By default cross-module go-to-definition lands in the decompiled `jdt://` view of the injected jar. The plugin therefore writes `java.project.sourcePaths` (workspace layer only — paths are written relative to the workspace folder, and absolute AOSP paths never reach your user settings) with the hand-written roots from `aosp-nav.java.sourceRoots` plus the selected modules. Until a module selection is written, an AOSP-root window selects the two default modules (`frameworks/base/core/java`, `frameworks/base/services/core`) and injects **all** their first-party roots — 16 roots / ~7.5k `.java` on a real tree, versus 2 roots / 7.2k when only the two directories are taken literally; the extra roots are small sibling source dirs of those modules (e.g. `frameworks/base/nfc-non-updatable/java`, `frameworks/base/services/telecom/mainline/java`, `frameworks/libs/modules-utils/java`). A sub-directory window uses the production modules under the folder (from `out/soong/module_bp_java_deps.json`) instead. On a real tree, cross-module references to types under those roots land in the real `.java` file instead of the decompiled view.

Two deliberate limits:

- **The list is partial by design.** Injecting `sourcePaths` switches off jdt.ls' per-file source inference, so modules *not* listed lose *source* navigation; jar navigation still works. Add the roots you actually work in to `aosp-nav.java.sourceRoots`, or pick modules with `AOSP: Select Java Source Roots by Module` — there, checked modules are listed first, and the filter box shows how many module directories are hidden by eclipse-guard exclusions (it only counts rules the plugin wrote itself; if none, no number is shown). Writing the whole tree is not viable (210k packaged `.java` files / 8.4k source-root union on a real checkout).
- **No reload for the normal path.** The plugin pushes the list into the running jdt.ls session (`java.project.listSourcePaths` / `addToSourcePath` / `removeFromSourcePath` forwarded through `java.execute.workspaceCommand`, gated on redhat.java's `serverReady()`). Only when the server rejects that live update does it show a "Reload Window" prompt — deduplicated per distinct root list per workspace, so a systematic rejection does not re-ask on every reload. The runtime sync removes only entries this extension wrote; hand-written `java.project.sourcePaths` entries are never touched. The plugin never calls `java.project.getAll` / `getClasspaths` to probe the result — on a real AOSP tree those block for minutes.

## C/C++ navigation (clangd)

Opening a C/C++ file under the detected AOSP root feeds clangd real compile flags instead of falling back to a generic host configuration. The plugin uses three tiers, in order:

1. **compdb** — if `out/soong/development/ide/compdb/compile_commands.json` exists (generate it with `make SOONG_GEN_COMPDB=1 nothing`), clangd is pointed at that directory. Nothing is copied or re-written.
2. **cc_deps** — if `out/soong/module_bp_cc_deps.json` exists (normal builds write it), the module section for the opened file is read line-by-line (the file has ~14k modules / ~147k srcs; parsing all of it on every open is avoided). Header search dirs become `-I`, system dirs `-isystem`, flags are copied, dead paths are pruned, and `--target` is derived from the bionic `uapi/asm-*` dir. One CDB entry is upserted into a plugin-managed `compile_commands.json` under the extension's global storage.
3. **Android.bp** — last resort when neither build artifact exists. Nearest `Android.bp`, same-file `header_libs`, plus `aosp-nav.cpp.curatedIncludes`.

**Why the server restart is rare.** clangd reads `clangd.arguments` only at process start, but it reloads its compilation database when a tracked document changes. Therefore:

- new/updated entries for a newly opened file are written incrementally and picked up without a restart;
- `clangd.restart` is scheduled only when the effective argument list really changed (e.g. the compdb appeared, or the managed CDB moved), debounced by `aosp-nav.cpp.restartDebounceMs` (default 800 ms);
- reopening the same file, or writing an identical entry, never restarts clangd.

User-visible impact: the very first C/C++ file of a session may start clangd with the previous arguments for a fraction of a second, then one debounced restart occurs (brief “clangd restarting” / preamble re-parse, completions settle again). After that, opening more files does not restart the server.

The plugin never overrides your own `--compile-commands-dir`: if any layer already sets it, that value wins. On a real tree, a symbol from a `libbase` header resolves through the cc_deps tier (112 flags, target `aarch64-linux-android`) to the corresponding header in the source tree.

Limitations:

- **Generated headers are not in cc_deps.** AIDL/protobuf outputs live under `out/soong/.intermediates`, which `module_bp_cc_deps.json` does not list. Files including headers generated by AIDL/protobuf keep that error until those headers are generated / the official compdb is generated. The plugin does not fabricate include paths to hide it.
- **Header files and bp fallback are best-effort.** A header is usually not in a module's `srcs`, and the fallback cannot resolve `header_libs`/`cc_defaults` that live in a parent `Android.bp` (nvim builds a whole-tree index for that; VS Code does not). `cc_deps` remains the reliable tier.
- **One `clangd.arguments` per window.** In a multi-root window the flag follows the last opened AOSP root; open each checkout in its own window.

## Jar selection rules

The injected list is the **dependency closure of the selected module dirs**, not a blind walk of `out/soong/.intermediates`:

1. **Seeds and edges** — every module whose `path` is one of the selected module dirs; the walk follows `dependencies` + `libs` + `static_libs`. Jars are the `jars` entries of every module reached, accepted only when the file exists on disk (tree-relative paths; absolute and `..` paths are rejected).
2. **Common set** — `core-oj` and `core-libart` are always added. soong records the bootclasspath as a compile input, not as a dependency edge, so the walk never reaches libcore and every `java.lang.*` reference would dangle without it.
3. **Variant fallback** — when *every* jar the index lists for a module is missing on disk, the module's `out/soong/.intermediates/<path>/<name>/` directory is scanned: variant dirs in descending name order (`android_common_apexNN` before `android_common`), then `javac` > `combined` > `turbine-combined`. This recovers modules whose index entry names a variant the tree never built — typically a turbine header jar while the `javac` output exists. Recovered modules are reported as `rescued` and their index entries are not counted as `dropped`.
4. **Counts** — one scan reports `jars`, `dropped` (unique jar entries with no file on disk even after the fallback), `rescued`, `unbuilt` (modules with jar candidates but nothing built) and `dangling` (dependency names absent from the build index). Reference tree: **774 jars / 333 MB** versus 1276 / 834 MB for the full list; dropped 986, rescued 527, unbuilt 280, dangling 5.
5. **Fallbacks never empty the classpath** — no module selection, a missing/invalid index, an index older than `build.ninja` (a build is running), or a zero-jar closure all keep the previous full list and log the reason. The log names the dangling modules so you can add them via the module picker.
6. **Diagnostics** — the `jar source` row repeats the mode (`closure`, or `full-list fallback` plus the reason) and the counts above; the output channel has one line per scan and `AOSP: Rescan` shows the same summary as a notification.

The full-list fallback (used only when the closure cannot be computed) keeps the earlier artifact rules — variant/bucket selection, `.impl` normalization, pre-jarjar dedup, stub-family exclusion and directory-priority ordering.

## Kotlin support (experimental)

`Ctrl+Shift+P` -> `Open User Settings (JSON)`, set `aosp-nav.kotlin.enabled: true` and install [vscode-kotlin](https://marketplace.visualstudio.com/items?itemName=fwcd.kotlin) (`fwcd.kotlin`) — the companion of fwcd kotlin-language-server; it downloads the language server on first use, so one online start is needed. The plugin then feeds the **same jar list** to the Kotlin language server:

1. **Inject** — per-root jar lists go to `~/.config/kotlin-language-server/aosp-nav/`, and the server's global classpath script (`~/.config/kotlin-language-server/classpath`) is kept up to date. The script dispatches on the workspace root: AOSP roots get their jars; everything else prints nothing and fwcd falls back to its normal gradle/maven resolution — the stray `build.gradle` files in the tree are never touched, no importer switches needed.
2. **Guard & family takeover** — a foreign user-managed classpath script is never overwritten (the plugin stays off that channel and warns once), but a script generated by [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) is recognized as family: it is moved to `classpath.nvim.bak` and becomes the dispatch script's fallback branch (unknown roots still get the nvim logic: make-era trees, sibling checkouts, jar fallback dir), and aosp-nav.nvim recognizes this plugin's marker and does not rewrite the file — no ping-pong.
3. **Rollback** — `AOSP: Reset Plugin Settings` removes the script and jar lists and restores the nvim family script from `classpath.nvim.bak` if one was taken over; foreign scripts are untouched.

What to expect: navigation mirrors the Java channel — opened files resolve source-level, types that live only in jars (AIDL, proto, aconfig) land in the decompiled view. Java→Kotlin jumps already work with the setting off, since `kotlinc` jars have been part of the injected list all along.

## FAQ

### Navigation doesn't work right after the first injection

The Eclipse background index is still running (status-bar spinner). Wait for CPU to settle — 30–60 minutes on the first open of a large tree.

If the status bar shows `$(warning) AOSP:<n> stale` / diagnostics reports eclipse-guard blockers, see the next section.

### Status bar says "N stale" / opening the AOSP root has no navigation at all (eclipse guard)

jdt.ls applies `java.project.referencedLibraries` **only to the invisible project**; any directory containing a `.project` file (with or without `.classpath`) is imported as a real Eclipse project instead, and a single imported project suppresses the invisible project entirely — the injected jars never apply, opened files fall into the jar-less default project, and navigation is dead. These markers are usually left behind by earlier nvim-jdtls/buildship sessions (e.g. `external/<lib>/`, or sub-checkouts once opened with older tooling); before 0.1.2, opening the AOSP root always hit this.

A `.project` alone is enough to block the root invisible project, so the criterion is `.project` presence only — no `.classpath` requirement and no depth cap (a real AOSP tree has 159 such dirs, 4 of them deeper than level 5). Excluding only part of them leaves the root without an invisible project.

Handling (automatic): the guard writes each such dir into the workspace layer of `java.import.exclusions` (exact absolute-path match, no effect on other projects) and offers a one-time "clean and reload" — already-imported projects persist inside the language-server workspace, so `java.clean.workspace` must rebuild it for the exclusions to take effect. After the clean, the first Eclipse index takes ~30–60 minutes; never needed again. You can also trigger it manually via `AOSP: Fix Eclipse Metadata Blockers`. If the `.project` sits in the workspace folder itself, no exclusion is written (a whole-window rule would exclude everything); the plugin warns once instead, and the fix is to open the AOSP root or a sub-directory (e.g. `frameworks/base`) as the workspace folder.

### Java reports "Syntax Server ... -32097" or "An error has occurred ... config_ss_linux"

The redhat.java Syntax Server (a startup accelerator that shares one configuration directory with the main server) can get corrupted when several windows reload at once (typically right after installing/upgrading an extension) — afterwards every startup logs `couldn't create connection to server (-32097)`. Navigation itself is unaffected (the main server provides it); repair once:

```bash
EXT=$(ls -d <DATA>/extensions/redhat.java-*/ | head -1)
GS=<DATA>/user-data/User/globalStorage/redhat.java/1.56.0
cp "$EXT/server/config_ss_linux/config.ini" "$GS/config_ss_linux/config.ini"
```

`<DATA>` is `~/.vscode-server/data` for Remote-WSL, or `<install-dir>/data` for portable/self-managed installs. Reload the window afterwards.

### Diagnostics says `jdt.ls.vmargs ⚠`

The default heap is too small for the injected list (780 jars / ~330 MB of classes on a reference tree). Add `"java.jdt.ls.vmargs": "-Xmx8G ..."` to user settings and reload. If the plugin reports heap-dump / `OutOfMemoryError` evidence, raise it further and consider `java.autobuild.enabled: false` — the plugin never writes either setting.

### Stuck at "Importing Gradle project(s)" / "Validating Gradle wrapper checksum"

A few `build.gradle` files are scattered in the AOSP tree (mostly in test directories). The plugin disables both importers automatically, in the layer `aosp-nav.settingsScope` selects (the repo's `.vscode/settings.json` by default, so your other Java projects keep their Gradle support). If you need to set them yourself — or run an older version — add:

```jsonc
"java.import.gradle.enabled": false,
"java.import.maven.enabled": false
```

The plugin only writes these when no layer has an explicit value, so an explicit `true` of yours is respected rather than overwritten on the next open.

Note: older plugin versions also wrote `java.import.gradle.wrapper.checksums` — that key no longer exists upstream (renamed `java.imports.gradle.wrapper.checksums`) and was a no-op anyway once gradle import is disabled; it is no longer written and can be removed from settings.

### A type is still unresolvable

Run `AOSP: Show Diagnostics` and check: root detected? `jar source` reports `closure` with a few hundred jars (a `full-list fallback` line names the reason and shows ~1276)? `referencedLibraries` in sync? If a specific class is missing, it may be a generated-only type whose module wasn't selected — check the `dropped` / `dangling` counts, search the module name in the cache file (`jars-*.json` under the extension's global storage), and report an issue with the diagnostics output.

### Changing exclusion settings doesn't take effect

It does — the cache header carries a fingerprint of the exclusion config, and a configuration change immediately triggers a rescan (no need to reopen a Java file). If it truly doesn't, report with diagnostics (that would be a bug).

### Kotlin navigation doesn't work

Check the `kotlin` lines in `AOSP: Show Diagnostics`: the extension must be `fwcd.kotlin`, the classpath script must report `ours` or family status (an aosp-nav.nvim script is taken over automatically on the next open), and vscode-kotlin needs one online start to download the language server.

### Kotlin Language Client: couldn't create connection to server / The Kotlin Language Client server crashed x times

For example:
```
Exception in thread "main" java.lang.IllegalArgumentException: 25.0.4.1
    at com.intellij.util.lang.JavaVersion.parse(JavaVersion.java:307)
    ...
    at org.javacs.kt.CompilerClassPath.<init>(CompilerClassPath.kt:32)
    at org.javacs.kt.MainKt.main(Main.kt:42)
```

The Kotlin compiler bundled with [fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server) cannot parse a **four-part** version number, so a JDK such as `25.0.4.1` makes the server exit during construction; a three-part version like `21.0.8` is fine.

Fix: point to a JDK with a **three-part** version number in user settings:

```jsonc
"kotlin.java.home": "/usr/lib/jvm/java-21-openjdk-amd64"
```

### Windows / WSL

The extension runs where the opened folder lives. With Remote-WSL, install the extension to the WSL side (`code --install-extension` from the WSL shell); the AOSP tree must be reachable from WSL.

### Offline workstation

Everything works fully offline: the extension itself only reads local files, and Gradle/Maven importers are disabled (see the Gradle FAQ above). Package the `.vsix` files on a networked machine, then `code --install-extension *.vsix` on the target.

## Development

```bash
npm install
npm run compile        # then F5 in VSCode (launch config included) → Extension Development Host
npx @vscode/vsce package   # → aosp-nav-<version>.vsix
```

The jar-selection rules live in `resources/defaults.json`, shared with [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) as the single source of truth; test case IDs mirror the nvim test suite. Keep both sides in sync when changing rules.

## License

MIT
