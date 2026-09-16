# aosp-nav

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/yksnian/aosp-nav-vscode)

Android (AOSP) 源码导航插件: 在 VSCode 中获得跨 **所有** Java 模块(frameworks/base、packages/modules/*、system_server 服务……) 的跳转、补全与引用解析, 无需任何手动工程配置。

本插件是 [aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) 的VSCode 版本, 两者共享同一套 jar 选择算法与规则数据。

## 为什么需要它

直接用 Java 扩展打开 AOSP 几乎什么都做不了: AOSP 不是 Gradle/Maven 工程,语言服务器只认识你打开的那一个文件。而编译产物(`out/soong/.intermediates`) 里的 1w+ 个 jar 明明包含全部符号——但盲目全部灌进去, 意味着类重复、桩 jar 劫持跳转、索引永远跑不完。

aosp-nav 自动弥合这个鸿沟:

1. **检测** —— 打开 AOSP 内任意 `.java` 文件, 插件从文件路径向上找到 AOSP根 (在此之前完全静默);
2. **选择** —— 扫描 `out/soong/.intermediates`, 每模块只保留一套必要产物,排除整个桩家族, 并保证真身永远排在可疑产物之前;
3. **注入** —— 将有序 jar 列表写入 `java.project.referencedLibraries`,并应用 AOSP 兼容开关;
4. **缓存** —— 列表持久化, 由算法版本号或排除配置指纹自动失效。修改配置即生效, 无需手动清理。

## 依赖

- VSCode >= 1.85
- [Java 语言支持](https://marketplace.visualstudio.com/items?itemName=redhat.java)(`redhat.java`)——通过 `extensionDependencies` 自动安装
- **已编译**的 AOSP 树 (存在 `out/soong/.intermediates`)

大代码树建议调高语言服务器堆内存 (用户 settings.json):

```jsonc
"java.jdt.ls.vmargs": "-Xmx8G -Xms2G --add-modules=ALL-SYSTEM --add-opens=java.base/java.util=ALL-UNNAMED"
```

## 使用

1. 打开 AOSP checkout 内任意 `.java` 文件 (把 AOSP 根作为 workspace 打开也可以——打开 Java 文件之前什么都不会发生)。
2. 观察状态栏: `$(sync~spin) AOSP` → `$(check) AOSP:<n>` (数秒; 之后走缓存,秒级)。
3. **仅首次**: 语言服务器后台索引 classpath——frameworks/base 量级的树需30-60 分钟, CPU 高占用属正常, 索引状态持久化, 之后打开秒级。**索引期间请勿重启语言服务器**。
4. 跳转/补全即可解析 `android.*`、`com.android.*`、system_server 内部类型等。只存在于 jar 中的类型 (AIDL 接口、proto 类、aconfig flags) 跳转落点为反编译视图——属预期行为, 源码树内本就没有它们的 .java。

workspace 打开 AOSP 根或任意子仓库 (如 frameworks/base) 均可; 检测以打开的文件为准, 不依赖 workspace 位置。

## 命令

| 命令                          | 说明                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `AOSP: Rescan Jars`           | 清除 jar 缓存并重扫                                          |
| `AOSP: Show Diagnostics`      | 结构化自检报告 (root/缓存/settings/扩展状态)——提 issue 时请附上 |
| `AOSP: Reset Plugin Settings` | 回滚本插件写入过的所有 settings                              |

## 配置

排除列表默认使用 **append** 语义: 你的条目追加到内置默认值之后 (默认值已覆盖全部已知桩家族)。设置 `aosp-nav.excludeMerge` 为 `"replace"` 可丢弃默认值。

| 配置项                   | 默认       | 说明                                                         |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `aosp-nav.enabled`       | `true`     | 启用插件                                                     |
| `aosp-nav.androidRoot`   | `null`     | 显式指定 AOSP 根; null 时按打开文件自动检测                  |
| `aosp-nav.excludeJars`   | `[]`       | 正则, 同时匹配 jar 文件名与模块名, 如 `"fake"` 排除所有含 fake 的 jar/模块 |
| `aosp-nav.excludePaths`  | `[]`       | 完整路径的子串关键词, 如 `"external/cronet"`                 |
| `aosp-nav.excludeGlobs`  | `[]`       | 匹配 `.intermediates/` 之后相对路径的正则。用 `^` 锚定可精确到顶层目录, 如 `"^packages/apps/"` |
| `aosp-nav.excludeMerge`  | `"append"` | `append` = 用户列表追加到默认值后; `replace` = 丢弃默认值    |
| `aosp-nav.settingsScope` | `"global"` | `referencedLibraries` 写入位置: `global` (用户 settings, 多窗口共享, 不污染仓库) 或 `workspace` (仓库内 `.vscode/settings.json`) |

多仓库窗口说明: 默认 `global` 档下, 同一窗口打开不同子仓库的文件时注入jar 的**并集** (重叠度本来就很高)。如需严格的 per-repo classpath, 用`workspace` 档 + 分窗口打开。

## Jar 选择规则

`out/soong/.intermediates` 下同一模块会产出多份 jar, 插件只保留导航所需的产物:

1. **变体**: `android_common` 首选; `android_common_apexNN` 兜底 (core-oj等只有 apex 变体); host (`linux_glibc_common`) 与产品变体排除。

2. **类型分桶**: `javac`/`kotlinc` (模块自身编译产物) **全保留**——混合Java/Kotlin 模块两个目录各含一半类; `combined` (fat jar, 类重复主因) /`turbine*` (API 签名, 无方法体) 仅当模块无自身产物时兜底取一份。

3. **`.impl` 归一化**: `java_sdk_library` 的真实编译产物在 `<name>.impl`子模块, 剥后缀参与去重。

4. **pre-jarjar 去重**: soong 会导出 `<name>-pre-jarjar` 独立模块 (改包名前的类, 与基模块同 FQN); 基模块有自身产物时丢弃, 孤立模块保留。

5. **桩家族默认排除**: `*stubs*`、`*-stub` (sysprop-library-stub-* 等)、`*-headers` (framework-minus-apex-headers)、`^jrt-fs.jar$`、预构建module SDK 桩 (`^prebuilts/sdk/sdk_`), 以及 R/lint/dex/srcjars/kapt jar。

6. 目录优先级排序

   : 

   ```
   packages/modules/
   ```

    \> 

   ```
   frameworks/
   ```

   、

   ```
   libcore/
   ```

   、…

   > `external/`、`tools/` > `prebuilts/` 与未知目录。classpath 有序且JDT 按序取类——即使有漏网桩也永远排在真身之后。

## FAQ

### 首次注入后跳转不工作

Eclipse 后台索引还在跑 (状态栏转圈)。等 CPU 降下来——大树首次需 30-60 分钟。

### Diagnostics 显示 `jdt.ls.vmargs ⚠`

默认堆内存对 1000+ jar 太小。用户 settings.json 加`"java.jdt.ls.vmargs": "-Xmx8G ..."` 后重新加载。

### 卡在 "Importing Gradle project(s)" / "Validating Gradle wrapper checksum"

AOSP 树内散落着少量 build.gradle (如 frameworks/base/tests/UiBench)。插件会自动写入以下开关; 若你手动管理 settings (或使用旧版本), 请确认用户settings.json 含以下三条后 reload:

```jsonc
"java.import.gradle.enabled": false,"java.import.maven.enabled": false,"java.import.gradle.wrapper.checksums": []
```

第三条是关键: wrapper checksum 校验**不受** `import.gradle.enabled` 管辖,无网工作站会卡在下载超时。

### 某个类型仍然解析不了

运行 `AOSP: Show Diagnostics` 检查: root 检测到了吗? jar 数量正常(~1200-1400)? `referencedLibraries` 同步了吗? 若是特定类缺失, 可能是其模块未被选中——在扩展 global storage 的 `jars-*.json` 缓存文件里搜该模块名, 连同 diagnostics 输出一起提 issue。

### 修改排除配置后不生效

会生效的——缓存头带有排除配置指纹, 下次打开 Java 文件自动重扫。若确实没生效, 带 diagnostics 输出提 issue (那是 bug)。

### Windows / WSL

扩展运行在打开的文件夹所在一侧。Remote-WSL 场景下扩展需安装到 WSL 侧(在 WSL 终端里 `code --install-extension`); AOSP 树需能从 WSL 访问。

### 无网工作站

全流程可离线: 插件本身只读本地文件, Gradle/Maven 导入器被禁用 (这正是上面 wrapper checksum 开关重要的原因)。在联网机器打包 `.vsix`, 目标机`code --install-extension *.vsix` 即可。

## 开发

```bash
npm install
npm run compile# VSCode 中 F5 (已含 launch 配置) → Extension Development Hostnpx
@vscode/vsce package   # → aosp-nav-<version>.vsix
```

jar 选择规则集中在 `resources/defaults.json`, 与[aosp-nav.nvim](https://github.com/yksnian/aosp-nav.nvim) 共享单一来源;测试用例 ID 与 nvim 测试套件镜像。修改规则时请保持两端同步。

## License

MIT
