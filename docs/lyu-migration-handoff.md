# Lyu 引擎移植 — 交接单

> 用途：上一轮 agent 的上下文烧完了，这份文件是唯一的真相来源。
> 新会话**先读这个文件**，不要重新调研，直接从「下一步」开始。

## 目标

把 `lyu` 从薄壳（`main()` 委托 + 依赖 pi 0.87.1）换成**自带引擎的真产品**：

- 引擎（pi 1.5.2 官方 dist）随包发布，身份是 lyu，装完只有 `lyu` 命令、没有 `pi`
- 我们 7 个扩展作为**带依赖的包**安装，不能只拷 `.ts`（拷了过去依赖解析不到，静默失效——实测过）
- 配置目录 `~/.lyu/agent`，项目目录 `.lyu/`

## 已完成（都有实测）

| 项 | 做法 | 证据 |
|---|---|---|
| 引擎 vendor | `packages/agent/scripts/vendor.mjs` 按 `package.json` 的 `vendor.piCLI: 1.5.2` 拉 dist 进本包（21M） | `dist/.vendor-version` = 1.5.2 |
| 换身份 | `piConfig: {name: "lyu", configDir: ".lyu"}`、`bin` 只有 `lyu` | `--version` → `0.2.0`；假 HOME 下只生成 `.lyu`，`.pi` 一次没出现 |
| 扩展注册 | `bin/lyu.js` 启动时把本包写进 `<agentDir>/settings.json` 的 `packages` | 7 个扩展全加载（TUI `[Extensions]` 可见） |
| 扩展依赖 | 因为注册成「包」，依赖从本包 `node_modules` 解析 | 记忆系统能下 24M 模型到 `~/.lyu/agent/memory/models/` |
| 全局安装 | `npm i -g --prefix /tmp/x .` | `bin/` 里只有 `lyu`，无 `pi` |
| A-3 搬 init | `packages/agent/src/init.ts`，`piDir → lyuDir`（它本来就在写 `.lyu`），`bin` 加 `lyu-init` | 临时目录跑只建 `.lyu` |
| A-4 删薄壳 | `git rm -r -f packages/cli` + 删目录，全仓无外部引用 | `packages/` 只剩 `agent` / `extensions` |
| A-1 长句文案 | `vendor.mjs` 里 `REBRAND` 表，替换 `"Pi can explain its own features..."` | 命中 2 个 js；剩 1 处在 `.js.map`（不上屏） |
| item 2 记忆失败要说话 | `src/memory/embed.ts` 加 `explainEmbedderError()` / `describeEmbedderProblem()`；`extensions/memory.ts` 每会话报一次 + `/memory` 显示原因 + 跳过写入计数 | 单测 6 条；真会话输出 `[memory] 嵌入器不可用：本地没有模型缓存…` |
| item 1 横幅（`Pi v0.2.0`） | `vendor.mjs` 的 `PATCHES` 把 `piWordmark()` 从写死的 `P`+`i` 改成从 `APP_NAME` 派生 | pty 实跑：Apple Terminal 分支出 `Lyu v0.2.0`，iTerm 分支出 logo + `v0.2.0`；裸 `Pi v` 命中 0 |
| A-2 拆包（消 `peerDependencies` 警告） | 新建 `packages/extensions-pi`（`@lyu/extensions`）把 `extensions/` + `src/` 搬过去，host 模块走 `peerDependencies: "*"`；agent 只留引擎并依赖它；`lyu-init` 换成 `bin/lyu-init.js`（jiti 转 `.ts`） | pty 实跑：`[Extension issues]` 块消失、`[Extensions]` 里 7 个仍在；**真 `node_modules` 布局**（把包拷进 `node_modules/@lyu/extensions`，不是 symlink）下扩展照样加载；`lyu-init` 在同一布局下跑通；`npm pack --dry-run` 两个包都带齐 `extensions/`+`src/` / `bin/`；搬完后记忆扩展照样把 24M 模型下进临时 HOME（= `@huggingface/transformers` 从新包位置解析得到） |

| README 完整重写 | 根 `README.md` 换成新产品的：安装（源码）、接模型（`/login` / 环境变量 / `models.json`）、两个配置目录表、工具/扩展/命令/环境变量、两包架构与补丁纪律、延伸阅读、已知限制 | 所有 .md 链接逐个 `-f` 验过都在；bin/工具/env 变量名全对着代码核过（不是凭印象）；全局已装 `pi` 的前提下把那条会误报的校验改了 |
| `lyu-init` 重写（原本是假货） | 不再写 `.lyu/config.yaml`，改为合并写 `<agent-dir>/models.json` + 建 `AGENTS.md`；扩展清单从扩展包 `package.json` 读；新增 `lyuAgentDir()` 不回落 `~/.pi` | pty 实跑向导（ollama 预设）→ 写 `~/.lyu/agent/models.json`；同一 HOME 下 `lyu --list-models` 出现 `gpt-4o 128K 16.4K` = 我写的元数据，证明引擎真读了；解析不了的 `models.json` 会中止不覆盖 |
| 旧子包与根 `package.json` 清理 | `git rm` 掉 11 个旧子包（38 个文件）+ 孤立的 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json`；根 `package.json` 改成只转发到 `packages/agent` 的壳 | `npm run lyu -- --version` → `0.2.0`；`src/` 里对 `packages/extensions/` 的引用已经搜不到；`/tmp/verify-lyu.sh` 六步全绿 |

### 横幅那一格的真相（省得下一个人再盲搜）

那行不是 `APP_NAME`，也不是 `Pi v${VERSION}` 拼的，所以 `grep 'Pi v'` 永远搜不到：

- 走的是 `pi-logo.ts` 的 `piWordmark()`：`foregroundAnsi(CORAL)` + `P` + `RESET` + `foregroundAnsi(YELLOW)` + `i`
- **两个字母是写死的字符串**，中间还夹着 ANSI，任何“Pi v”组合搜法都不可能命中
- 只有 macOS Apple Terminal（`TERM_PROGRAM=Apple_Terminal`）走这条文字兜底，其它终端走半格像素 logo，logo 本身不含文字品牌
- 终端标题 / `--version` 走的是 `APP_NAME` / `APP_TITLE`，所以一直是对的 —— 两条来源不一致才是病根

修法（已落地）：`vendor.mjs` 里 `PATCHES` 表把函数体换成从 `APP_NAME` 派生，
`APP_NAME = "pi"` 时结果与上游逐字节一致（`P`+`i`），`"lyu"` 时是 `Lyu`。**没有硬编品牌名**。

### 拆包那一格的四个坑（下次改包结构前先看）

1. **npm 会自己把 peer 装进本地树**。`peerDependencies: "*"` 是引擎硬要求的，但源码树里没有上层
   `node_modules` 去满足它，`npm install` 会把最新版 pi（实测 1.6.1，不是 vendored 的 1.5.2）连整棵
   依赖树（141 个包、多跑 400M）装进 `packages/extensions-pi/node_modules`。`--omit=peer` 不够，
   连 peer 的子树都留；`npm prune` 反而把它们又装回来。**解法**：`packages/extensions-pi/.npmrc` 写
   `legacy-peer-deps=true` → 只剩 transformers 闭包 54 个包、0 个 extraneous。
2. **`.ts` 在 `node_modules` 下 node 拒绝剥类型**（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。
   所以 `bin` 不能直接指向 `src/init.ts`：换成 `bin/lyu-init.js`，用引擎自己带的 jiti 转一道。
   扩展本身不受影响 —— 引擎的扩展加载器本来就跑在 jiti 上。
3. **拆包不会造成双实例**。引擎在 `core/extensions/loader.ts` 的 `getAliases()` 里用 jiti alias
   把 4 个 host 模块和 `typebox` 全部指向**引擎自己的**实例，扩展包里的副本永远轮不到被加载。
   这就是 `peerDependencies: "*"` 的本意，也是警告要表达的意思。
4. **`file:` 依赖发布前必须换成版本号**。现在 `packages/agent/package.json` 写的是
   `"@lyu/extensions": "file:../extensions-pi"`（本地可复现、可验证）；一旦真要发 npm，
   这个 spec 会被原样发出去、装到用户机器上必然报错，必须先改成 `"0.2.0"` 并先把
   `@lyu/extensions` 发上去。

## 未完成

### 1. B — 出站清洗（需求是**反的**，别做错）
用户要求：**默认把控制块和思考都显示出来**，给开关让人自己关掉。不是默认隐藏。

- 剥/显对象：`<analysis>`、`<thinking>`、`<summary>` 这类控制块，以及思考通道残留
- 默认：显示（透明优先，符合「状态不能骗人」）
- 开关：环境变量关掉（如 `LYU_SANITIZE=0` 或 `LYU_SHOW_REASONING=1`，命名待定）
- **前提**：先读 `packages/coding-agent/src/core/extensions/types.ts` 里消息相关 hook，确认哪个能改 assistant 消息内容。已知 `tool_call` 能原地改 `event.input`，消息侧的可写字段**未确认**。不确认就写，出来的扩展是假的——装了但一个字没剥。

### 2. 版本检查会劝用户跑 `lyu update` —— 那是把上游 pi 装回来

TUI 底部会弹：

```
Update Available
New version 1.6.1 is available. Run lyu update
```

已经查清为什么危险：

- 版本来源是 `https://pi.dev/api/latest-version`，返回
  `{"ok":true,"version":"1.6.1","packageName":"@earendil-works/pi-coding-agent"}` —— 那是**上游 pi 的发布**
- 拿它和我们的 `0.2.0` 比大小，等于拿两个不相干的版本号比，所以**每次启动必然劝你更新**
- `lyu update` 用的是 `latestRelease.packageName ?? PACKAGE_NAME`，也就是
  `npm i -g @earendil-works/pi-coding-agent@1.6.1` —— 全局装上上游 pi，`pi` 命令回来了，
  身份故事当场破功，还可能和 vendored 引擎打架

要么把版本检查关掉（`PI_OFFLINE` 只是环境变量，不能指望用户设），要么让它认我们自己的发布源。
**这是个决策题，得用户点头**，别自己挑。

### 3. `lyu --help` 里还有上游措辞

`lyu update [source|self|pi]`、部分文案里的 "pi" —— 都在 vendored dist 里，只影响文字不影响行为。
要改就走 `vendor.mjs` 的 `PATCHES` 表（和横幅同一个机制），别手改 dist。

## 这一轮修掉的两处「写了不生效」

### `lyu-init` 原本是假货

旧 `src/init.ts` 往 `.lyu/config.yaml` 写 `custom_provider:` + `lyu.providers:`，但 vendored 1.5.2
**一处都不读 yaml 配置**（`grep -rho "[A-Za-z0-9_.-]*\.yaml" dist | sort -u` 只有 frontmatter 用的那两个）。
引擎认的只有 `<agent-dir>/{settings,models,auth,mcp}.json`。所以跑完向导、再改它生成的 yaml，
一个字都不会生效 —— 和「装了但一个字没剥」同一类假象。

它还列着旧的 11 个 `@lyu/extension-*` 往 `.lyu/extensions/` 建软链，指向 `packages/extensions/*/dist`，
而新引擎一个都不引用。

现在改成：选预设 → **合并写** `<agent-dir>/models.json`（`$schema` + `providers.<name>.{baseUrl,api,apiKey,models}`，
`apiKey` 写 `$ENV_NAME` 引用而不是明文）+ 建 `AGENTS.md`。扩展清单从扩展包自己的 `package.json`
的 `pi.extensions` 读，不写死。
实测判据：向导跑完，同一个 `HOME` 下 `lyu --list-models | grep gpt-4o` 能看到那条、且带的是我写的
`128K/16.4K` 元数据 —— 这才是「引擎真读了」的证据（只 `cat` 文件不算）。

两个细节值得记：
- **解析不了的 `models.json` 必须中止，不能覆盖**。里面可能只有一处手逗号，重写会把整份配置吞掉。
- `agentDir()` 在 `~/.lyu/agent` 不存在时会回退到 `~/.pi/agent` —— 对扩展是对的（跟着用户在跑的产品走），
  对安装向导是错的（会写进 pi 的目录，然后引擎去 `~/.lyu/agent` 找，找不到）。
  所以新增 `lyuAgentDir()`：env → `~/.lyu/agent`，**不**回退到 pi。

### 旧子包与根 `package.json`

- 删掉 `packages/extensions/` 下 11 个旧子包（`git rm`，38 个跟踪文件）+ 孤立的 `pnpm-lock.yaml`、
  `pnpm-workspace.yaml`、`tsconfig.base.json`（两个新包都没有 tsconfig，也没人再跑 pnpm）
- 根 `package.json` 重写：`0.2.0` / `private` / 描述改成新产品的 /
  `scripts` 只剩 `lyu`、`init`、`vendor`、`setup` 四个转发到 `packages/agent` 的壳
- 删完复验：`npm run lyu -- --version` → `0.2.0`；`/tmp/verify-lyu.sh` 六步全绿
  （真 API 通、24M 模型下到临时 HOME、全局只有 lyu/lyu-init、HOME 下只有 `.lyu`）

## 约束（不要违反）

- **不 commit、不 push**（用户没点头）。注意 `my-RTR` 里还有一堆未跟踪文件不能带上
- git 身份必须是 `WeeeeeKdY <242365433+WeeeeeKdY@users.noreply.github.com>`，**不是** `liuyuan90`
- 不卸载全局 `pi`；`my-pi` 和 `lyu-code` 两个仓都要维护
- 项目目录用 `.lyu/`，读的时候兼容老 `.pi/`
- 扩展代码不许写死 `~/.pi`，走 `src/agent-dir.ts` 的 `agentDir()`
- 一切 hook 永不打断会话；但**失败必须说一声**，不能静默降级
- 验证必须实操，不靠推断
- **用 grep 判「引擎支不支持 X」之前，先确认那个名字不是从 `APP_NAME` 拼出来的**。
  实例：`grep LYU_CODING_AGENT_DIR dist` 搜不到，差点去“修”一个不存在的 bug；
  真相是 `ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR``，引擎**认**，实测设一下就生效了。
  字面量搜不到 ≠ 不支持；换实测或看 `sourcesContent`。

## 环境备忘

- 目录布局：`packages/agent` = 引擎包（`lyu-code`，带 vendored dist 和 `bin/lyu.js`），
  `packages/extensions-pi` = 扩展包（`@lyu/extensions`）。两个包各自 npm 装依赖
  （`packages/agent/node_modules` 是 npm 扁平布局，不是 pnpm；根 `node_modules` 是空的）
- 网络：`github.com:443` 不通，`api.github.com` 和 `registry.npmjs.org` 正常 → 拉源码用 `gh api repos/<o>/<r>/tarball/<tag>`
- 本地 pi 源码仓 `/Users/liuyuan/LangChainPractice/pi`：分支 `snapshot/v1.5.2` @ `2be548bd`（1.5.2 全量），`main` @ `20b78eaf`（v0.79.0）保留待将来 merge
- macOS 无 `timeout`，用 `perl -e 'alarm N; exec @ARGV'`；`sed` 不认 `\b`，用 `perl -pi -e`
- 验证脚本：`bash /tmp/verify-lyu.sh`（绝对路径 + 临时 HOME，不碰 `~/.pi`）。第 3 步看两件事：
  有 `[memory]` 行 = 嵌入器坏了并在说话；没这行但临时 HOME 里有 24M 模型缓存 = 嵌入器正常（它就不该出声）。
  两样都没有，才是扩展没加载
- `packages/agent/.lyu/extensions/` 是个空目录，测 `lyu-init` 时 cwd 在包目录留下的，无害
- 抓 TUI 横幅：`python3 /tmp/capture-long.py [Apple_Terminal|iTerm.app]`。比 `capture-banner.py`
  好用：它把剥完 ANSI 的**每一行**都打出来（能直接看到 `[Extensions]` 和有没有警告），
  再额外报「命中几个 `<名字> vX.Y.Z`」和「裸 `Pi v` 命中几次」。同样走 pty，不写 pty 抓不到
- 抓 TUI 横幅：`python3 /tmp/capture-banner.py [Apple_Terminal|iTerm.app]`。用 pty 起 TUI、
  抓原始字节、剥 ANSI 后找 `<名字> vX.Y.Z`。管道里 TUI 不进交互模式，**不写 pty 是抓不到的**。
  它会清空并重建 `/tmp/lyu-banner-home`、`/tmp/lyu-banner-proj`，原始字节落 `/tmp/banner-raw.bin`
