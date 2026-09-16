# aosp-nav

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/yksnian/aosp-nav-vscode)

Instant source navigation for Android (AOSP) in VSCode — go-to-definition,completion and reference resolution across **all** Java modules(frameworks/base, packages/modules/*, system_server services, ...), with zeromanual project setup.

The VSCode counterpart of [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim);both share the same jar-selection algorithm and rule data.

## Why

Opening AOSP in VSCode with the Java extension alone gives you almost nothing:AOSP is not a Gradle/Maven project, so the language server sees only the fileyou opened. Meanwhile the build output (`out/soong/.intermediates`) contains 10,000+ jars that could provide every symbol — but feeding them all in blindlymeans duplicated classes, stub jars hijacking navigation, and an index thatnever finishes.

aosp-nav bridges that gap automatically:

1. **Detect** — open any `.java` file in an AOSP checkout; the plugin walks upfrom the file path to find the AOSP root (before that, it is fully silent).
2. **Select** — scan `out/soong/.intermediates` and pick exactly one set ofartifacts per module, excluding the whole API-stub zoo and ordering realimplementations before anything suspicious.
3. **Inject** — write the ordered jar list to`java.project.referencedLibraries` and apply AOSP compatibility switches.
4. **Cache** — persist the list, auto-invalidated by algorithm version orexclusion-config fingerprint. Configuration changes just work.

## Requirements

- VSCode >= 1.85
- [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java)(`redhat.java`) — installed automatically via `extensionDependencies`
- A **compiled** AOSP tree (`out/soong/.intermediates` present)

Recommended for large trees — raise the language server heap (user settings):

```jsonc
"java.jdt.ls.vmargs": "-Xmx8G -Xms2G --add-modules=ALL-SYSTEM --add-opens=java.base/java.util=ALL-UNNAMED"
```

## Usage

1. Open any `.java` file inside an AOSP checkout (having the AOSP root open asa workspace folder is fine — nothing happens until a Java file is opened).
2. Status bar: `$(sync~spin) AOSP` → `$(check) AOSP:<n>` within seconds(subsequent opens come from cache, instantly).
3. **First time only**: the language server indexes the classpath in thebackground — 30–60 minutes on frameworks/base-sized trees, high CPU isnormal. It is one-time; later opens are instant. Do **not** restart thelanguage server during this phase.
4. Navigate: F12 / completions now resolve `android.*`, `com.android.*`,system_server internals, etc. Types that exist only in jars (AIDLinterfaces, proto classes, aconfig flags) land in the decompiled view —expected, since no `.java` for them exists in the source tree.

Works with the AOSP root or any sub-checkout (e.g. `frameworks/base`) as theworkspace — detection is per opened file, not per folder.

## Commands

| Command                       | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `AOSP: Rescan Jars`           | Drop the jar cache and rescan                                |
| `AOSP: Show Diagnostics`      | Structured self-check (root / cache / settings / extensions) — attach it to issues |
| `AOSP: Reset Plugin Settings` | Roll back every settings key this plugin has written         |

## Configuration

Exclusion lists use **append** semantics by default: your entries are addedafter the built-in defaults (which already cover every known stub family).Set `aosp-dev.excludeMerge` … i.e. `aosp-nav.excludeMerge` to `"replace"` todiscard the defaults.

| Setting                  | Default    | Description                                                  |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `aosp-nav.enabled`       | `true`     | Enable the plugin                                            |
| `aosp-nav.androidRoot`   | `null`     | Explicit AOSP root; auto-detected per opened file when null  |
| `aosp-nav.excludeJars`   | `[]`       | Regex matched against jar file name AND module name, e.g. `"fake"` drops every jar/module containing it |
| `aosp-nav.excludePaths`  | `[]`       | Substring keywords on the full path, e.g. `"external/cronet"` |
| `aosp-nav.excludeGlobs`  | `[]`       | Regex on the path relative to `.intermediates/`. Anchor with `^` for top-level precision, e.g. `"^packages/apps/"` |
| `aosp-nav.excludeMerge`  | `"append"` | `append` = user lists added after defaults; `replace` = defaults discarded |
| `aosp-nav.settingsScope` | `"global"` | Where `referencedLibraries` is written: `global` (user settings, shared across windows, no repo pollution) or `workspace` (`.vscode/settings.json` inside the repo) |

Notes on multi-repo windows: with the default `global` scope, opening filesfrom different sub-checkouts in one window injects the **union** of jars(they heavily overlap anyway). For strictly per-repo classpath, use the`workspace` scope with separate windows.

## Jar selection rules

`out/soong/.intermediates` produces multiple jars per module; the plugin keepsonly what navigation needs:

1. **Variant**: `android_common` preferred; `android_common_apexNN` asfallback (core-oj etc. only have apex variants); host(`linux_glibc_common`) and product variants excluded.
2. **Type buckets**: `javac`/`kotlinc` (module's own compiled sources) are**always kept** — mixed Java/Kotlin modules have both directories, eachholding half the classes. `combined` (fat jar, main source of duplicateclasses) / `turbine*` (API signatures, no method bodies) only as fallbackwhen a module has no own-source artifacts.
3. **`.impl` normalization**: the real compilation of a `java_sdk_library`lives in `<name>.impl`; the suffix is stripped for dedup.
4. **pre-jarjar dedup**: soong exports `<name>-pre-jarjar` modules withpre-rename classes sharing FQNs with the base module; dropped when thebase module has its own artifact, kept as orphans otherwise.
5. **Stub families excluded by default**: `*stubs*`, `*-stub`(sysprop-library-stub-*), `*-headers` (framework-minus-apex-headers),`^jrt-fs.jar$`, prebuilt module-SDK stubs (`^prebuilts/sdk/sdk_`), plusR/lint/dex/srcjars/kapt jars.
6. **Directory-priority ordering**: `packages/modules/` > `frameworks/`,`libcore/`, ... > `external/`, `tools/` > `prebuilts/` & unknown. Theclasspath is ordered and JDT takes the first hit, so even an unnoticedstub always sorts behind its real implementation.

## FAQ

### Navigation doesn't work right after the first injection

The Eclipse background index is still running (status-bar spinner). Wait forCPU to settle — 30–60 minutes on the first open of a large tree.

### Diagnostics says `jdt.ls.vmargs ⚠`

The default heap is too small for 1000+ jars. Add`"java.jdt.ls.vmargs": "-Xmx8G ..."` to user settings and reload.

### Stuck at "Importing Gradle project(s)" / "Validating Gradle wrapper checksum"

A few `build.gradle` files are scattered in the AOSP tree (e.g.`frameworks/base/tests/UiBench`). The plugin writes the switches belowautomatically; if you manage settings manually (or run an older version),make sure the user settings.json contains all three, then reload:

```jsonc
"java.import.gradle.enabled": false,"java.import.maven.enabled": false,"java.import.gradle.wrapper.checksums": []
```

The third one is essential: wrapper checksum validation is **not** governedby `import.gradle.enabled`, and offline workstations hang on the downloadtimeout.

### A type is still unresolvable

Run `AOSP: Show Diagnostics` and check: root detected? jar count sane(~1200–1400)? `referencedLibraries` in sync? If a specific class is missing,it may be a generated-only type whose module wasn't selected — search themodule name in the cache file (`jars-*.json` under the extension's globalstorage) and report an issue with the diagnostics output.

### Changing exclusion settings doesn't take effect

It does — the cache header carries a fingerprint of the exclusion config;the next Java file open triggers a rescan automatically. If it truly doesn't,report with diagnostics (that would be a bug).

### Windows / WSL

The extension runs where the opened folder lives. With Remote-WSL, installthe extension to the WSL side (`code --install-extension` from the WSLshell); the AOSP tree must be reachable from WSL.

### Offline workstation

Everything works fully offline: the extension itself only reads local files,and Gradle/Maven importers are disabled (which is exactly why the wrapperchecksum switch matters — see above). Package the `.vsix` files on anetworked machine, then `code --install-extension *.vsix` on the target.

## Development

```bash
npm installnpm run compile# F5 in VSCode (launch config included) → Extension Development Hostnpx @vscode/vsce package   # → aosp-nav-<version>.vsix
```

The jar-selection rules live in `resources/defaults.json`, shared with[aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) as the singlesource of truth; test case IDs mirror the nvim test suite. Keep both sidesin sync when changing rules.

## License

MIT
