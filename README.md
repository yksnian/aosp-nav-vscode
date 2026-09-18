# aosp-nav

[![Version](https://img.shields.io/badge/version-0.1.4-blue.svg)](https://github.com/yksnian/aosp-nav-vscode)

Instant source navigation for Android (AOSP) in VSCode — go-to-definition, completion and reference resolution across **all** Java modules (frameworks/base, packages/modules/*, system_server services, ...), with zero manual project setup.

The VSCode counterpart of [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim); both share the same jar-selection algorithm and rule data.

## Why

Opening AOSP in VSCode with the Java extension alone gives you almost nothing: AOSP is not a Gradle/Maven project, so the language server sees only the file you opened. Meanwhile the build output (`out/soong/.intermediates`) contains 10,000+ jars that could provide every symbol — but feeding them all in blindly means duplicated classes, stub jars hijacking navigation, and an index that never finishes.

aosp-nav bridges that gap automatically:

1. **Detect** — open any `.java` file in an AOSP checkout; the plugin walks up from the file path to find the AOSP root (before that, it is fully silent).
2. **Select** — scan `out/soong/.intermediates` and pick exactly one set of artifacts per module, excluding the whole API-stub zoo and ordering real implementations before anything suspicious.
3. **Inject** — write the ordered jar list to `java.project.referencedLibraries`, apply AOSP compatibility switches (disable Gradle/Maven importers, exclude `out/`/`.repo/` from import), and keep the file watcher/search away from the huge `out/` tree (`files.watcherExclude`, `search.exclude`). The write is automatic (no confirmation) and retried on the next file open if it fails.
4. **Guard** — the eclipse guard scans the workspace for leftover `.project`+`.classpath` directories (old jdtls/buildship sessions) and excludes them from import detection, so jdt.ls keeps creating its invisible project and `referencedLibraries` actually applies (see FAQ).
5. **Cache** — persist the list, auto-invalidated by algorithm version or exclusion-config fingerprint. Configuration changes just work.

## Requirements

- VSCode >= 1.85
- [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) (`redhat.java`) — installed automatically via `extensionDependencies`
- A **compiled** AOSP tree (`out/soong/.intermediates` present)

Recommended for large trees — raise the language server heap (user settings):

```jsonc
"java.jdt.ls.vmargs": "-Xmx8G -Xms2G --add-modules=ALL-SYSTEM --add-opens=java.base/java.util=ALL-UNNAMED"
```

## Usage

1. Open any `.java` file inside an AOSP checkout (having the AOSP root open as a workspace folder is fine — nothing happens until a Java file is opened).
2. Status bar: `$(sync~spin) AOSP` → `$(check) AOSP:<n>` within seconds (subsequent opens come from cache, instantly).
3. **First time only**: the language server indexes the classpath in the background — 30–60 minutes on frameworks/base-sized trees, high CPU is normal. It is one-time; later opens are instant. Do **not** restart the language server during this phase.
4. Navigate: F12 / completions now resolve `android.*`, `com.android.*`, system_server internals, etc. Types that exist only in jars (AIDL interfaces, proto classes, aconfig flags) land in the decompiled view — expected, since no `.java` for them exists in the source tree.

Works with the AOSP root or any sub-checkout (e.g. `frameworks/base`) as the workspace — detection is per opened file, not per folder. If the guard finds leftover Eclipse metadata dirs on first use (typical when opening the AOSP root on a machine that previously ran the nvim plugin or buildship), it offers a one-time "clean and reload" (`java.clean.workspace`): the clean rebuilds the language-server workspace, after which the first Eclipse index takes ~30–60 minutes — one-time cost.

Messages follow the VS Code display language: Chinese for zh-cn, English everywhere else.

## Commands

| Command                       | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `AOSP: Rescan Jars`           | Drop the jar cache and rescan (also re-runs the eclipse guard) |
| `AOSP: Show Diagnostics`      | Structured self-check (root / cache / settings / extensions / guard) — attach it to issues |
| `AOSP: Fix Eclipse Metadata Blockers` | Run the one-time clean+reload for leftover Eclipse metadata dirs |
| `AOSP: Reset Plugin Settings` | Roll back every settings key this plugin has written (incl. workspace layer) |

## Configuration

Exclusion lists use **append** semantics by default: your entries are added after the built-in defaults (which already cover every known stub family). Set `aosp-nav.excludeMerge` to `"replace"` to discard the defaults.

| Setting                  | Default    | Description                                                  |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `aosp-nav.enabled`       | `true`     | Enable the plugin                                            |
| `aosp-nav.androidRoot`   | `null`     | Explicit AOSP root; auto-detected per opened file when null  |
| `aosp-nav.excludeJars`   | `[]`       | Regex matched against jar file name AND module name, e.g. `"fake"` drops every jar/module containing it |
| `aosp-nav.excludePaths`  | `[]`       | Substring keywords on the full path, e.g. `"external/cronet"` |
| `aosp-nav.excludeGlobs`  | `[]`       | Regex on the path relative to `.intermediates/`. Anchor with `^` for top-level precision, e.g. `"^packages/apps/"` |
| `aosp-nav.excludeMerge`  | `"append"` | `append` = user lists added after defaults; `replace` = defaults discarded |
| `aosp-nav.settingsScope` | `"workspace"` | Where `referencedLibraries` is written: `workspace` (`.vscode/settings.json` inside the repo, no impact on other Java projects) or `global` (user settings, shared across windows, but absolute jar paths pollute non-AOSP Java projects). Since 0.1.2 the write needs no confirmation; switching scope auto-clears our previous list from the other layer |

Notes on multi-repo windows: with the `global` scope, opening files from different sub-checkouts in one window injects the **union** of jars (they heavily overlap anyway). With the default `workspace` scope the list is written per repo — open each sub-checkout in its own window for strictly per-repo classpaths.

## Jar selection rules

`out/soong/.intermediates` produces multiple jars per module; the plugin keeps only what navigation needs:

1. **Variant**: `android_common` preferred; `android_common_apexNN` as fallback (core-oj etc. only have apex variants); host (`linux_glibc_common`) and product variants excluded.
2. **Type buckets**: `javac`/`kotlinc` (module's own compiled sources) are **always kept** — mixed Java/Kotlin modules have both directories, each holding half the classes. `combined` (fat jar, main source of duplicate classes) / `turbine*` (API signatures, no method bodies) only as fallback when a module has no own-source artifacts.
3. **`.impl` normalization**: the real compilation of a `java_sdk_library` lives in `<name>.impl`; the suffix is stripped for dedup.
4. **pre-jarjar dedup**: soong exports `<name>-pre-jarjar` modules with pre-rename classes sharing FQNs with the base module; dropped when the base module has its own artifact, kept as orphans otherwise.
5. **Stub families excluded by default**: `*stubs*`, `*-stub` (sysprop-library-stub-*), `*-headers` (framework-minus-apex-headers), `^jrt-fs.jar$`, prebuilt module-SDK stubs (`^prebuilts/sdk/sdk_`), plus R/lint/dex/srcjars/kapt jars.
6. **Directory-priority ordering**: `packages/modules/` > `frameworks/`, `libcore/`, ... > `external/`, `tools/` > `prebuilts/` & unknown. The classpath is ordered and JDT takes the first hit, so even an unnoticed stub always sorts behind its real implementation.

## FAQ

### Navigation doesn't work right after the first injection

The Eclipse background index is still running (status-bar spinner). Wait for CPU to settle — 30–60 minutes on the first open of a large tree.

If the status bar shows `$(warning) AOSP:<n> stale` / diagnostics reports eclipse-guard blockers, see the next section.

### Status bar says "N stale" / opening the AOSP root has no navigation at all (eclipse guard)

jdt.ls applies `java.project.referencedLibraries` **only to the invisible project**; any sub-directory containing both `.project` and `.classpath` is imported as a real Eclipse project instead, which suppresses the invisible project entirely — the injected jars never apply, opened files fall into the jar-less default project, and navigation is dead. These dirs are usually metadata left behind by earlier nvim-jdtls/buildship sessions (e.g. `external/<lib>/`, or sub-checkouts once opened with older tooling); before 0.1.2, opening the AOSP root always hit this.

Handling (automatic): the guard writes each such dir into the workspace layer of `java.import.exclusions` (exact absolute-path match, no effect on other projects) and offers a one-time "clean and reload" — already-imported projects persist inside the language-server workspace, so `java.clean.workspace` must rebuild it for the exclusions to take effect. After the clean, the first Eclipse index takes ~30–60 minutes; never needed again. You can also trigger it manually via `AOSP: Fix Eclipse Metadata Blockers`.

Note: dirs with only `.project` and no `.classpath` (e.g. the nvim plugin's `packages/modules/Connectivity/.project`) are harmless and left alone.

### Java reports "Syntax Server ... -32097" or "An error has occurred ... config_ss_linux"

The redhat.java Syntax Server (a startup accelerator that shares one configuration directory with the main server) can get corrupted when several windows reload at once (typically right after installing/upgrading an extension) — afterwards every startup logs `couldn't create connection to server (-32097)`. Navigation itself is unaffected (the main server provides it); repair once:

```bash
EXT=$(ls -d <DATA>/extensions/redhat.java-*/ | head -1)
GS=<DATA>/user-data/User/globalStorage/redhat.java/1.56.0
cp "$EXT/server/config_ss_linux/config.ini" "$GS/config_ss_linux/config.ini"
```

`<DATA>` is `~/.vscode-server/data` for Remote-WSL, or `<install-dir>/data` for portable/self-managed installs. Reload the window afterwards.

### Diagnostics says `jdt.ls.vmargs ⚠`

The default heap is too small for 1000+ jars. Add `"java.jdt.ls.vmargs": "-Xmx8G ..."` to user settings and reload.

### Stuck at "Importing Gradle project(s)" / "Validating Gradle wrapper checksum"

A few `build.gradle` files are scattered in the AOSP tree (e.g. `frameworks/base/tests/UiBench`). The plugin disables both importers automatically; if you manage settings manually (or run an older version), make sure the user settings.json contains the two switches below, then reload:

```jsonc
"java.import.gradle.enabled": false,
"java.import.maven.enabled": false
```

Note: older plugin versions also wrote `java.import.gradle.wrapper.checksums` — that key no longer exists upstream (renamed `java.imports.gradle.wrapper.checksums`) and was a no-op anyway once gradle import is disabled; it is no longer written and can be removed from settings.

### A type is still unresolvable

Run `AOSP: Show Diagnostics` and check: root detected? jar count sane (~1200–1400)? `referencedLibraries` in sync? If a specific class is missing, it may be a generated-only type whose module wasn't selected — search the module name in the cache file (`jars-*.json` under the extension's global storage) and report an issue with the diagnostics output.

### Changing exclusion settings doesn't take effect

It does — the cache header carries a fingerprint of the exclusion config, and a configuration change immediately triggers a rescan (no need to reopen a Java file). If it truly doesn't, report with diagnostics (that would be a bug).

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
