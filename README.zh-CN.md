# aosp-nav

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/yksnian/aosp-nav-vscode)

Android (AOSP) 源码导航插件: 在 VSCode 中获得跨 **所有** Java/Kotlin 模块 (frameworks/base、packages/modules/*、system_server 服务……) 的跳转、补全与引用解析, 无需任何手动工程配置。

本插件是 [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) 的 VSCode 版本, 两者共享同一套 jar 选择算法与规则数据。

## 为什么需要它

直接用 Java 扩展打开 AOSP 几乎什么都做不了: AOSP 不是 Gradle/Maven 工程, 语言服务器只认识你打开的那一个文件。而编译产物 (`out/soong/.intermediates`) 里的 1w+ 个 jar 明明包含全部符号——但盲目全部灌进去, 意味着类重复、桩 jar 劫持跳转、索引永远跑不完。

aosp-nav 自动弥合这个鸿沟:

1. **检测** —— 打开 AOSP 内任意 `.java` 文件, 插件从文件路径向上找到 AOSP 根 (在此之前完全静默);
2. **选择** —— 按所选模块目录从 `out/soong/module_bp_java_deps.json` 计算依赖闭包, 并对每个模块做"已编译变体"回退: 注入几百个 jar, 不再整树遍历 `out/soong/.intermediates`。
3. **注入** —— 将有序 jar 列表写入 `java.project.referencedLibraries`,应用 AOSP 兼容开关 (禁用 Gradle/Maven 导入器、排除 `out/`/`.repo/`), 并让文件监视/搜索避开庞大的 `out/` 树 (`files.watcherExclude`、`search.exclude`); 写入自动完成, 无需确认, 失败会在下次打开文件时自动重试;
4. **护栏** —— eclipse guard 扫描 workspace 内含 `.project` 的遗留目录 (旧 jdtls/buildship 会话产物), 把它们排除出导入检测, 保证 jdt.ls 为你的目录创建 invisible project、`referencedLibraries` 真正生效 (见 FAQ);
5. **缓存** —— 列表持久化, 由算法版本号或排除配置指纹自动失效。修改配置即生效, 无需手动清理。

## 依赖

- VSCode >= 1.95
- [Java 语言支持](https://marketplace.visualstudio.com/items?itemName=redhat.java) (`redhat.java`)——通过 `extensionDependencies` 自动安装
- 可选, Kotlin 跳转: [vscode-kotlin](https://marketplace.visualstudio.com/items?itemName=fwcd.kotlin) (`fwcd.kotlin`)——见 [Kotlin 支持](#kotlin-支持实验性)
- 可选, C/C++ 跳转: [clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd) (`llvm-vs-code-extensions.vscode-clangd`)。扩展不自带 clangd 二进制, 需把 `clangd.path` 指向 AOSP prebuilt (`prebuilts/clang/host/linux-x86/clang-*/bin/clangd`), 或接受插件的一次性提示
- **已编译**的 AOSP 树 (存在 `out/soong/.intermediates`)

大代码树建议调高语言服务器堆内存 (用户 settings.json):

```jsonc
"java.jdt.ls.vmargs": "-Xmx8G -Xms2G --add-modules=ALL-SYSTEM --add-opens=java.base/java.util=ALL-UNNAMED"
```

## 使用

1. 打开 AOSP checkout 内任意 `.java` 文件 (把 AOSP 根作为 workspace 打开也可以——打开 Java 文件之前什么都不会发生)。
2. 观察状态栏: `$(sync~spin) AOSP` → `$(check) AOSP:<n>` (数秒; 之后走缓存, 秒级)。
3. **首次运行, 在注入之前**: 会弹一次模态窗, 询问是否选择 Java 源码根模块。选择则打开模块选择器, 只注入你勾选的模块; 关闭弹窗 (或选"使用默认值") 则默认勾选 `frameworks/base/core/java` 与 `frameworks/base/services/core` 两个模块, 并注入它们各自拥有的全部一级源码根 (真实树上为 16 个根 / 约 7.5k 个 `.java`)。该默认值会写入 `aosp-nav.java.sourceRootModules`, 因此再次打开模块选择器时就是这两项处于勾选状态。子目录窗口不弹窗, 使用该目录的构建索引模块。之后可通过 `AOSP: Select Java Source Roots by Module` 修改。
4. **仅首次**: 语言服务器后台索引 classpath——frameworks/base 量级的树需 30-60 分钟, CPU 高占用属正常, 索引状态持久化, 之后打开秒级。**索引期间请勿重启语言服务器**。
5. 跳转/补全即可解析 `android.*`、`com.android.*`、system_server 内部类型等。只存在于 jar 中的类型 (AIDL 接口、proto 类、aconfig flags) 跳转落点为反编译视图——属预期行为, 源码树内本就没有它们的 .java。

workspace 打开 AOSP 根或任意子仓库 (如 frameworks/base) 均可; 检测以打开的文件为准, 不依赖 workspace 位置。若 guard 首次在工作区发现 Eclipse 元数据遗留目录 (常见于打开 AOSP 根目录、且此前用过 nvim 版插件或 buildship 的机器), 会提示一次性"清理并重载" (即 `java.clean.workspace`): 清理会重建语言服务器工作区, 之后 Eclipse 首次索引约 30-60 分钟, 属一次性开销。

提示信息跟随 VS Code 显示语言: 中文环境显示中文, 其他语言一律英文。

## 安装与验证 (用户清单)

1. 安装 `redhat.java` (扩展依赖)。C/C++ 需另外安装 `llvm-vs-code-extensions.vscode-clangd`——clangd 扩展不自带服务端。
2. 在与 AOSP checkout 相同的环境里安装 VSIX。Remote-WSL 下在 WSL 终端执行 `code --install-extension aosp-nav-0.2.0.vsix`, 然后重载窗口。
3. 把 AOSP checkout 作为 workspace 打开。多根窗口可用, 但同一窗口内所有 C/C++ 文件共用一份 `clangd.arguments`。
4. **Java**: 打开任意 `.java`, 等状态栏变为 `$(check) AOSP:<n>`。模块选择弹窗在注入之前出现; 跳过则默认勾选 `frameworks/base/core/java` + `frameworks/base/services/core` 两个模块并注入其全部一级源码根 (AOSP 根窗口)。`sourcePaths` 会直接推送到运行中的语言服务器, 正常情况下无需重载; 只有当 jdt.ls 拒绝热更新时才会提示重载, 且同一份源码根列表只提示一次。
5. **C/C++**: 把 `clangd.path` 指向 `<root>/prebuilts/clang/host/linux-x86/clang-r*/bin/clangd` (或接受首次打开时的建议)。打开一个 `.cpp`; 首个文件可能先用旧参数启动, 约 800 ms 去抖后重启一次 clangd, 之后复用。验证: 打开一个包含 `#include` 的 C/C++ 文件, 对文件内引用的符号按 F12 → 应落到源码树内的对应头文件。`AOSP: Show Diagnostics` 中 `cpp origin` 应显示 `compdb` 或 `cc_deps`。
6. **生成头 (AIDL/protobuf 产物等)**: `cc_deps` 故意不包含 `out/soong/.intermediates`。在同一棵树执行 `make SOONG_GEN_COMPDB=1 nothing` (或 `m SOONG_GEN_COMPDB=1 nothing`) 生成官方 compdb, 再重载一次窗口切换到 compdb 档。
7. **需要重载窗口的场景仅限**: 会话开始后才生成 compdb 需要切换档位, 以及 jdt.ls 拒绝热更新 `sourcePaths` 的少数情况。修改源码根 (`aosp-nav.java.sourceRoots` / `sourceRootModules`)、C/C++ 增量条目写入与普通 `clangd.arguments` 变更都不需要重载。

## 命令

| 命令                          | 说明                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `AOSP: Rescan Jars`           | 清除 jar 缓存并重扫 (同时重跑 eclipse guard, 跳过其 24 小时缓存——手动删掉的 `.project` 遗留目录会立即被重新识别) |
| `AOSP: Show Diagnostics`      | 结构化自检报告 (root/缓存/settings/扩展状态/guard)——提 issue 时请附上 |
| `AOSP: Fix Eclipse Metadata Blockers` | 对遗留 Eclipse 元数据目录执行一次性"清理并重载"        |
| `AOSP: Reset Plugin Settings` | 移除本插件添加过的所有设置 (含 workspace 层); 合并过的键保留你自己的条目 |

## 配置

排除列表默认使用 **append** 语义: 你的条目追加到内置默认值之后 (默认值已覆盖全部已知桩家族)。设置 `aosp-nav.excludeMerge` 为 `"replace"` 可丢弃默认值。

| 配置项                   | 默认       | 说明                                                         |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `aosp-nav.enabled`       | `true`     | 启用插件                                                     |
| `aosp-nav.androidRoot`   | `null`     | 显式指定 AOSP 根; null 时按打开文件自动检测                  |
| `aosp-nav.excludeJars`   | `[]`       | 正则, 同时匹配 jar 文件名与模块名, 如 `"fake"` 排除所有含 fake 的 jar/模块 |
| `aosp-nav.excludePaths`  | `[]`       | 相对于 `.intermediates/` 的 jar 路径子串关键词 (与 `excludeGlobs` 同基准), 如 `"external/cronet"` |
| `aosp-nav.excludeGlobs`  | `[]`       | 匹配 `.intermediates/` 之后相对路径的正则。用 `^` 锚定可精确到顶层目录, 如 `"^packages/apps/"` |
| `aosp-nav.excludeMerge`  | `"append"` | `append` = 用户列表追加到默认值后; `replace` = 丢弃默认值    |
| `aosp-nav.settingsScope` | `"workspace"` | `referencedLibraries` 与 Gradle/Maven 导入器开关的写入位置: `workspace` (仓库内 `.vscode/settings.json`, 不影响其他 Java 工程) 或 `global` (用户 settings, 多窗口共享, 但绝对路径 jar 会污染非 AOSP 的 Java 工程)。0.1.2 起写入不再需要确认; 切换 scope 时插件会自动清掉自己先前写在另一层的旧列表。你自己改回 `true` 的开关插件不会再动 |
| `aosp-nav.kotlin.enabled` | `false` | 实验性: 将同一份 jar 列表经 fwcd kotlin-language-server 的全局 classpath 脚本注入 (见 [Kotlin 支持](#kotlin-支持实验性)) |
| `aosp-nav.java.sourceRoots` | `[]` | 手写补充的源码根 (相对 AOSP 根或绝对路径), 叠加在模块选择之上写入 workspace 层 `java.project.sourcePaths`。空数组表示"没有手写补充", 不再等于"关闭注入"——模块选择 (或根窗口默认值) 仍会生效。直接热更新到运行中的服务器, 无需重载 |
| `aosp-nav.java.sourceRootModules` | `[]` (从未写入 = 根窗口默认模块) | 通过 `AOSP: Select Java Source Roots by Module` 选择的模块目录。AOSP 根窗口在从未写入时会默认写入并勾选 `frameworks/base/core/java` + `frameworks/base/services/core`, 注入它们各自拥有的全部一级源码根 (真实树上 16 个根 / 约 7.5k 个 `.java`); 子目录窗口则使用该目录下的生产模块 (排除 tests/demos/samples/commercial), 来自 `out/soong/module_bp_java_deps.json`。显式写入列表 (即使 `[]` 表示全不选) 会关闭这两种默认。无需重载 |
| `aosp-nav.cpp.enabled` | `true` | C/C++ 走 clangd (见 [C/C++ 跳转](#cc-跳转-clangd)) |
| `aosp-nav.cpp.restartDebounceMs` | `800` | `clangd.arguments` 真正变化后重启 clangd 的 debounce; 后续增量 CDB 条目由 clangd 自动重载, 不重启 |
| `aosp-nav.cpp.suggestClangdPath` | `true` | 提示把 `clangd.path` 指向 AOSP prebuilt (仅在用户点击后写入) |
| `aosp-nav.cpp.curatedIncludes` | 见下 | 仅 Android.bp 兜底层使用的 include 目录 (相对 AOSP 根, 不存在的会跳过) |
| `aosp-nav.cpp.headerLibDepth` | `3` | Android.bp 兜底层中同文件 `header_libs` 的最大解析深度 |

多仓库窗口说明: `global` 档下, 同一窗口打开不同子仓库的文件时注入 jar 的**并集** (重叠度本来就很高)。默认 `workspace` 档按仓库写入——每个子仓库用独立窗口打开即可获得严格的 per-repo classpath。

## Java 源码跳转 (`java.project.sourcePaths`)

默认跨模块跳转落在注入 jar 的反编译视图。插件因此把 `aosp-nav.java.sourceRoots` 的手写根与已选模块一起写入 workspace 层 `java.project.sourcePaths` (相对 workspace folder 的路径; 绝对 AOSP 路径不会进入用户设置)。在写入模块选择之前, AOSP 根窗口默认勾选 `frameworks/base/core/java` 与 `frameworks/base/services/core` 两个模块, 并注入它们拥有的**全部**一级源码根——真实树上 16 个根 / 约 7.5k 个 `.java`, 而只取这两个目录字面量是 2 个根 / 7.2k; 多出来的根是这两个模块的小型兄弟源码目录 (例如 `frameworks/base/nfc-non-updatable/java`、`frameworks/base/services/telecom/mainline/java`、`frameworks/libs/modules-utils/java`)。子目录窗口则使用该目录下的生产模块 (来自 `out/soong/module_bp_java_deps.json`)。真树上跨模块引用这些根内的类型时, 会跳到真实 `.java` 文件, 而不是反编译视图。

两个刻意的限制:

- **列表按设计不完整。** 注入 `sourcePaths` 会关闭 jdt.ls 的逐文件源码推断, 未列出的模块只丢**源码**跳转, jar 跳转仍保留。把常改模块的源码根加进 `aosp-nav.java.sourceRoots`, 或用 `AOSP: Select Java Source Roots by Module` 选模块——选择器里已勾选的模块排在最前, 筛选框会显示有多少模块目录被 eclipse guard 的排除项隐藏 (只统计插件自己写入的规则; 一个都没有时不显示数字)。整树写入不可行 (真树 21 万打包 `.java` / 8.4k 源码根并集)。
- **正常路径不需要重载。** 插件把列表热推送到运行中的 jdt.ls 会话 (`java.project.listSourcePaths` / `addToSourcePath` / `removeFromSourcePath` 经 `java.execute.workspaceCommand` 转发, 以 redhat.java 的 `serverReady()` 为就绪信号)。只有当服务器拒绝热更新时才提示"重载窗口", 且按源码根列表去重——同一份列表被系统性拒绝也不会每次重载都弹。运行期同步只移除本插件写入的条目, 手写的 `java.project.sourcePaths` 条目不会被删。插件不会调用 `java.project.getAll` / `getClasspaths` 探测结果——真树上它们会阻塞数分钟。

## C/C++ 跳转 (clangd)

在检测到的 AOSP 根内打开 C/C++ 文件时, 插件按三级链路给 clangd 提供真实编译参数:

1. **compdb** — 若存在 `out/soong/development/ide/compdb/compile_commands.json` (`make SOONG_GEN_COMPDB=1 nothing` 生成), 直接把 clangd 指向该目录, 不复制、不重写。
2. **cc_deps** — 若存在 `out/soong/module_bp_cc_deps.json` (常规构建会写), 按行流式读取打开文件所属模块段 (~14k 模块 / ~147k srcs, 避免每次全量解析)。header 目录转 `-I`, system 目录转 `-isystem`, flag 原样保留, 死路径剪枝, 由 bionic `uapi/asm-*` 推导 `--target`。只为当前文件向插件管理的 `compile_commands.json` (扩展 globalStorage) 增量 upsert 一条。
3. **Android.bp** — 仅当前两者都不存在时兜底: 最近的 `Android.bp` + 同文件 `header_libs` + `aosp-nav.cpp.curatedIncludes`。

**为什么很少重启 clangd。** clangd 只在进程启动时读 `clangd.arguments`, 但文档变化后会重载 compilation database。因此:

- 新打开文件写入/更新条目后无需重启;
- 仅当生效的参数列表真正变化 (如 compdb 出现、CDB 目录变化) 才在 `aosp-nav.cpp.restartDebounceMs` (默认 800 ms) 去抖后执行一次 `clangd.restart`;
- 重复打开同一文件、写入相同条目都不会重启。

用户可感知影响: 会话内第一个 C/C++ 文件可能先用上一次参数启动 clangd, 随后发生一次去抖重启 (短暂的 clangd 重启/preamble 重解析, 补全稍后恢复); 之后继续打开文件不再重启。

插件绝不覆盖你手写的 `--compile-commands-dir`。真树验收: 打开一个引用 `libbase` 头文件的 C++ 文件, 其符号经 cc_deps 链路 (112 个参数, target `aarch64-linux-android`) 跳转到源码树内的对应头文件。

已知限制:

- **cc_deps 不含生成头。** AIDL/protobuf 产物在 `out/soong/.intermediates`, `module_bp_cc_deps.json` 不收录。包含由 AIDL/protobuf 生成的头的文件, 在该头生成/官方 compdb 生成前会持续报错, 插件不会伪造 include 路径掩盖。
- **头文件与 bp 兜底是启发式。** 头文件通常不在模块 `srcs` 中; 兜底层也解析不了父目录 `Android.bp` 里的 `header_libs`/`cc_defaults` (nvim 版为此建全树索引, VS Code 版未做)。可靠链路仍是 `cc_deps`。
- **一个窗口只有一份 `clangd.arguments`。** 多根窗口下 flag 跟随最后打开的 AOSP 根; 请每个 checkout 单独开窗口。

## Jar 选择规则

注入的列表是**所选模块目录的依赖闭包**, 不再盲目遍历 `out/soong/.intermediates`:

1. **种子与边**: `path` 命中所选模块目录的所有模块为种子; 沿 `dependencies` + `libs` + `static_libs` 遍历。jar 取所达模块的 `jars` 条目, 仅当文件确实在磁盘上才接受 (只认树相对路径, 绝对路径与含 `..` 的路径拒绝)。

2. **公共集**: 恒加入 `core-oj` 与 `core-libart`。soong 把 bootclasspath 记为编译输入而非依赖边, 闭包永远走不到 libcore; 缺了它所有 `java.lang.*` 引用都会失联。

3. **变体回退**: 某模块在索引里登记的所有 jar 都不在磁盘时, 直接扫 `<模块>/out/soong/.intermediates/<path>/<name>/`: 变体目录按名字倒序 (`android_common_apexNN` 先于 `android_common`), 再按 `javac` > `combined` > `turbine-combined` 取。这能救回"索引登记了树里从未构建的变体"的模块——典型是索引给 turbine 头 jar 而树里只有 `javac` 产物。救回的模块计入 `rescued`, 其索引条目不再计入 `dropped`。

4. **计数**: 每次扫描报 `jars`、`dropped` (回退后仍无文件的唯一 jar 条目数)、`rescued`、`unbuilt` (有 jar 候选但完全没编译的模块数)、`dangling` (构建索引里不存在的依赖名)。参考树: **774 jars / 333 MB**, 对照全量列表 1276 / 834 MB; dropped 986、rescued 527、unbuilt 280、dangling 5。

5. **回退绝不写空 classpath**: 没有模块选择、索引缺失/损坏、索引比 `build.ninja` 旧 (正在构建)、闭包为 0 个 jar——四种情况都保留上一份全量列表并记录原因; 日志会列出 dangling 模块名, 便于在模块选择器里手动勾选补回。

6. **诊断**: 诊断面板 `jar source` 行重复上述模式 (`closure`, 或 `full-list fallback` + 原因) 与计数; 输出通道每次扫描一行, `AOSP: Rescan` 完成时以通知形式给出同一份汇总。

全量列表回退 (仅在闭包无法计算时使用) 仍沿用此前的产物规则——变体/类型分桶选择、`.impl` 归一化、pre-jarjar 去重、桩家族排除与目录优先级排序。

## Kotlin 支持 (实验性)

`Ctrl+Shift+P` -> `Open User Settings (JSON)`, 设置 `aosp-nav.kotlin.enabled: true` 并安装 [vscode-kotlin](https://marketplace.visualstudio.com/items?itemName=fwcd.kotlin) (`fwcd.kotlin`, fwcd kotlin-language-server 的官方配套; 首次使用会下载语言服务器, 需联网一次)。插件随后把 **同一份 jar 列表** 喂给 Kotlin 语言服务器:

1. **注入** —— 每个根的 jar 列表写入 `~/.config/kotlin-language-server/aosp-nav/`, 并维护服务器的全局 classpath 脚本 (`~/.config/kotlin-language-server/classpath`)。脚本按 workspace root 分发: AOSP 根输出其 jar 列表; 其他目录输出空, fwcd 回落到正常的 gradle/maven 解析——树内散落的 `build.gradle` 永远不会被碰, 也无需任何导入器开关。
2. **护栏与家族接管** —— 陌生用户自管的 classpath 脚本不会被覆盖 (插件不接管该通道并警告一次); 而 [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) 生成的脚本会被识别为家族脚本: 移动为 `classpath.nvim.bak` 并作为分发脚本的 fallback 分支 (未注册的 root 仍走 nvim 逻辑: make-era 树、兄弟 checkout、jar fallback 目录), 且 aosp-nav.nvim 认得本插件的标记、不会反向覆盖——不会乒乓。
3. **回滚** —— `AOSP: Reset Plugin Settings` 移除脚本与 jar 列表, 并在接管过家族脚本时从 `classpath.nvim.bak` 还原; 陌生脚本不受影响。

预期体验: 与 Java 通道一致——已打开的文件按源码解析; 只存在于 jar 中的类型 (AIDL、proto、aconfig) 落在反编译视图。Java→Kotlin 跳转在开关关闭时即可用——`kotlinc` jar 本就在注入列表中。

## FAQ

### 首次注入后跳转不工作

Eclipse 后台索引还在跑 (状态栏转圈)。等 CPU 降下来——大树首次需 30-60 分钟。

若状态栏显示 `$(warning) AOSP:<n> stale` / diagnostics 提示 eclipse guard 有 blocker, 见下一节。

### 状态栏提示 "N stale" / 打开 AOSP 根目录后跳转全挂 (eclipse guard)

jdt.ls 的 `java.project.referencedLibraries` **只对 invisible project 生效**; 而树里任何含 `.project` 的子目录都会被当作真实 Eclipse 工程导入, 导致 invisible project 永远不创建、注入的 jar 完全无效——打开的文件落入无 classpath 的 default project, 跳转全挂。这些目录一般是早年 nvim-jdtls/buildship 会话遗留的元数据 (典型如 `external/<lib>/`、或曾用旧工具打开过的子仓库), 0.1.2 之前打开 AOSP 根目录必然踩中。

处理 (自动): guard 把这些目录逐个写进 workspace 层 `java.import.exclusions` (绝对路径精确匹配, 不影响其他工程), 并提示一次性"清理并重载"——因为已导入的工程持久化在语言服务器工作区里, 必须 `java.clean.workspace` 重建后排除才生效。清理后 Eclipse 首次索引约 30-60 分钟, 此后不再需要。也可手动执行 `AOSP: Fix Eclipse Metadata Blockers`。若 `.project` 就在 workspace 目录本身, 插件不会写入排除规则 (整窗排除等于把所有内容都排除); 此时改为警告一次, 正确的做法是把 AOSP 根或其子目录 (如 `frameworks/base`) 作为 workspace 打开。

注: 只要含 `.project` 就足以阻断根 invisible project, 判据只看 `.project` 是否存在, 不要求 `.classpath`, 也没有深度上限 (真树有 159 个此类目录, 其中 4 个深于 5 层)。只排除一部分等于没有 invisible project。

### Java 报 "Syntax Server ... -32097" 或 "An error has occurred ... config_ss_linux"

redhat.java 的 Syntax Server (启动加速用的辅助服务, 与主服务共用一份共享配置目录) 在多窗口同时 reload 时可能被损坏 (典型场景: 刚安装/升级完插件), 之后每次启动都报 `couldn't create connection to server (-32097)`。跳转本身不受影响 (导航由主服务提供), 修复一次即可:

```bash
EXT=$(ls -d <DATA>/extensions/redhat.java-*/ | head -1)
GS=<DATA>/user-data/User/globalStorage/redhat.java/1.56.0
cp "$EXT/server/config_ss_linux/config.ini" "$GS/config_ss_linux/config.ini"
```

`<DATA>`: Remote-WSL 下是 `~/.vscode-server/data`, 便携/自解压安装是 `<安装目录>/data`。拷贝后 reload 窗口。

### Diagnostics 显示 `jdt.ls.vmargs ⚠`

默认堆内存对注入列表太小 (参考树 780 个 jar / 约 330 MB 类)。用户 settings.json 加 `"java.jdt.ls.vmargs": "-Xmx8G ..."` 后重新加载。若插件报出 heap dump / `OutOfMemoryError` 证据, 请继续调大堆并考虑 `java.autobuild.enabled: false`——这两项设置插件都不会代写。

### 卡在 "Importing Gradle project(s)" / "Validating Gradle wrapper checksum"

AOSP 树内散落着少量 build.gradle (多见于测试目录)。插件会自动禁用两个导入器, 写在 `aosp-nav.settingsScope` 指定的层 (默认是仓库内 `.vscode/settings.json`, 因此你自己的其他 Java 工程仍保留 Gradle 支持)。若需手动设置 (或使用旧版本), 加上:

```jsonc
"java.import.gradle.enabled": false,
"java.import.maven.enabled": false
```

插件只会在任何层都没有显式值时写入, 因此你显式设的 `true` 不会被下次打开覆盖。

注: 旧版插件还写过 `java.import.gradle.wrapper.checksums`——该 key 上游已改名(`java.imports.gradle.wrapper.checksums`), 且 gradle 导入禁用后本就无效; 插件已不再写入, settings 中的残留条目可删。

### 某个类型仍然解析不了

运行 `AOSP: Show Diagnostics` 检查: root 检测到了吗? `jar source` 为 `closure` 且 jar 数为几百 (若是 `full-list fallback`, 该行会给出原因并显示约 1276)? `referencedLibraries` 同步了吗? 若是特定类缺失, 可能是其模块未被选中——查看 `dropped` / `dangling` 计数, 在扩展 global storage 的 `jars-*.json` 缓存文件里搜该模块名, 连同 diagnostics 输出一起提 issue。

### 修改排除配置后不生效

会生效的——缓存头带有排除配置指纹, 修改配置会立即触发重扫 (无需重新打开 Java 文件)。若确实没生效, 带 diagnostics 输出提 issue (那是 bug)。

### Kotlin 跳转不工作

检查 `AOSP: Show Diagnostics` 的 `kotlin` 行: 扩展必须是 `fwcd.kotlin`, classpath 脚本须显示 `ours` 或家族接管状态 (后者在下次注入时自动接管), 且需联网下载语言服务器。

### Kotlin Language Client: couldn't create connection to server / The Kotlin Language Client server crashed x times
如:
```
Exception in thread "main" java.lang.IllegalArgumentException: 25.0.4.1
    at com.intellij.util.lang.JavaVersion.parse(JavaVersion.java:307)
    ...
    at org.javacs.kt.CompilerClassPath.<init>(CompilerClassPath.kt:32)
    at org.javacs.kt.MainKt.main(Main.kt:42)
```

[fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server) 捆绑的 Kotlin 编译器无法解析**四段式**版本号, 因此 `25.0.4.1` 之类的 JDK 会让 server 在构造阶段直接退出; 三段式如 `21.0.8` 正常。

解决办法:
在用户 settings 中指定版本号为**三段式**的 JDK 路径(前提你装在机器上了):

```jsonc
"kotlin.java.home": "/usr/lib/jvm/java-21-openjdk-amd64"
```

### Windows / WSL

扩展运行在打开的文件夹所在一侧。Remote-WSL 场景下扩展需安装到 WSL 侧 (在 WSL 终端里 `code --install-extension`); AOSP 树需能从 WSL 访问。

### 无网工作站

全流程可离线: 插件本身只读本地文件, Gradle/Maven 导入器被禁用 (见上方 Gradle FAQ)。在联网机器打包 `.vsix`, 目标机 `code --install-extension *.vsix` 即可。

## 开发

```bash
npm install
npm run compile        # 之后 VSCode 中 F5 (已含 launch 配置) → Extension Development Host
npx @vscode/vsce package   # → aosp-nav-<version>.vsix
```

jar 选择规则集中在 `resources/defaults.json`, 与 [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) 共享单一来源; 测试用例 ID 与 nvim 测试套件镜像。修改规则时请保持两端同步。

## License

MIT
