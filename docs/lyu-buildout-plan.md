# Lyu 产品化计划（lyu + lyu-desktop）

> 状态基线：2026-11-27。第 1、2、3.1、3.2、3.3 步已完成并实测通过；剩下的是发版决策与第 4 步出站清洗。
> 本文是所有后续工作的执行清单，每一步都带**可验证的判据**（不接受"看起来好了"）。

## 0. 背景：机器上曾经同时跑着三个引擎

所有混乱的根源，先把它钉死：

| 命令 | 来源 | 引擎版本 | 配置目录 | 状态 |
| --- | --- | --- | --- | --- |
| `lyu`（旧） | 全局 npm `lyu-code@0.1.4` | 自带 pi 0.87.1 | `~/.pi/agent` | 每次启动报错 |
| `pi` | 全局 npm `@earendil-works/pi-coding-agent@1.5.2` | 1.5.2 | `~/.pi/agent` | 正常（桌面端在用它） |
| `lyu`（新） | 本仓 `packages/agent`，vendored 引擎 | 1.5.2 | `~/.lyu/agent` | 本轮装上，已验证 |

旧 `lyu` 报的那个 `pi.registerToolRenderer is not a function`，原因不是新扩展坏了，而是**新扩展跑在旧引擎上**：`pi-open-tui` 声明 `peer >=1.5.0`，而它所在的运行时是 0.87.1，那个 API 在 0.87.1 里一次都不存在。

## 1. 引擎切换 —— 已完成 ✅

### 做了什么

1. 旧 `0.1.4` 整个目录移到 `/tmp/lyu-0.1.4-backup/lyu-code`（**移动，不删除**）
2. 清掉 nvm 里两个指向旧 `dist/index.js` 的软链
3. `npm i -g /Users/liuyuan/LangChainPractice/Lyu-code/packages/agent`
4. 配置迁移到 `~/.lyu/agent`：
   - `settings.json`：11 条扩展 + 模型/provider/主题/powerline/skills 等标量
   - `models.json` / `models-store.json`：provider 与模型定义
   - `AGENTS.md`：全局指令
   - `trust.json`：项目信任（**不种就等于扩展全不加载，且不报错**）
   - `npm` 目录软链到 `~/.pi/agent/npm`，让 `npm:` 前缀的扩展不必重装

### 迁移中踩到的三件事

**a. `npm:` 扩展的解析基准是 agent 目录。** 把它们原样抄进 `~/.lyu/agent/settings.json`，会去 `~/.lyu/agent/npm/node_modules` 找，那儿什么都没有。解法是软链共用一份 `npm/`。

**b. `my-RTR` 开发副本与打包版工具撞名。** `~/.pi` 的配置里注册了 `~/my-RTR`（我们自己扩展的开发副本），它和 `@lyu/extensions` 是同一套 7 个文件，于是 `remember` / `spawn_subagent` / `todo` 三个工具重复注册、直接失败。解法：新配置里去掉开发副本，由打包版取代。

**c. 第三方 TUI 扩展会把 "Pi" 品牌画回来。** `pi-open-tui` 的标题框硬编 `Pi`，`pi-beautiful-tui` 的 `i18n.ts` 里是 `有问题尽管问 Pi`，`pi-powerline-footer/welcome.ts` 里是 `Welcome back!` + ` pi agent `。**这些都不是我们引擎的漏补丁** —— 已经用「同 cwd、只换 HOME」的隔离实验证明过。第一轮迁移先把 `pi-open-tui` 留在外面，其余照迁。

### 判据（全部实测过）

```
lyu --version                     → 0.2.0
which lyu                         → ~/.nvm/.../bin/lyu → .../lyu-code/bin/lyu.js
lyu -p "reply with the single word ok" → ok（三个 provider 注册、默认真实模型调用成功）
[Extensions]                       → @plannotator/pi-extension, codegraph.ts, guard.ts,
                                     memory.ts, pi-beautiful-tui, pi-catdesk-provider,
                                     pi-catpaw-relay-provider, pi-extension, pi-mcp-adapter,
                                     pi-meituan-provider, pi-powerline-footer,
                                     pi-wechat-assistant, plan-execute, plannotator-auto.ts,
                                     stats.ts, subagent.ts, todo.ts   ← 无 Failed to load
TUI 头部                            → Lyu v0.2.0
TUI 长句                            → "Lyu can explain its own features and look up its docs."
```

**回退**：`npm i -g lyu-code@0.1.4`（该版本在 npm 上有发布，一条命令回到原点）。

`~/.pi` 全程一个字节未改 —— 桌面端和历史会话仍靠它。

## 2. 把两处断掉的连接接上

现状：桌面端 spawn 的是字面量 `pi`；Workflow tab 只有 12 行常量指向 `127.0.0.1:18789`，而它的后端扩展被误删了（目前仅靠一个残留进程的内存活着）。

1. **恢复 workflow 扩展** —— git `ae52067` 里的 8 个文件回原路径，跑一次 `tsc`
   断点：它的 build 会 `npm --prefix ../wf-agent-guard run build` 取 `agent-guard.js`，那个包是 0.87.1 的、已删。选择：把 guard 逻辑并进本包 ＞ 恢复并升级 wf-agent-guard ＞ 先跳过 guard。
   判据：`http://127.0.0.1:18789` 能打开，且端口来自扩展自身启动而非残留进程
2. **桌面端命令改成 `lyu`** —— 3 处 `?? "pi"` → `?? "lyu"`，保留 `PI_COMMAND` 覆盖，并显式传 `LYU_CODING_AGENT_DIR`
   桌面端已有 `login-shell-env.ts`（Finder/Dock 启动也能拿到登录 shell 的 PATH），所以只要 `lyu` 在 PATH 上就能找到
3. **端口单一来源** —— 18789 现在硬编在扩展与桌面端两处，收敛到一处
4. **重打 Lyu.app** —— `build:web` → `build` → 装机。漏 `build:web` 会白屏，而 electron-builder 对缺失的 `extraResources` 不报错，只会静默拷空目录
   判据：从 Dock 启动，新会话进程树里是可执行文件 `lyu`，读的是 `~/.lyu/agent`，Workflow tab 打得开

## 3. 让 lyu 真正成为自有产品

### 3.1 路线选择（待定）

- **A：继续 vendored dist + 补丁层**（现 4 条补丁，零命中即中止 + `node --check` 体检）。升级便宜，补丁点少且看得见。
- **B：源码 fork**（上游 4300 文件 / 72 万行 TS / 54M）。改得彻底，但从此刻起自己维护一个 70 万行引擎，上游每次修复都要手工搬。

推荐 A：dist 是自包含 bundle，4 条补丁已经跑通并可回归；B 的长期成本是数量级差别。

### 3.2 品牌与行为清理（按危险程度排）

| 项 | 现状 | 处置 |
| --- | --- | --- |
| 安装遥测 | 启动时向 `pi.dev/api/report-install` 报版本 | ✅ 已移除（不是改成默认关 —— 默认关还能被 `PI_TELEMETRY=1` 打开） |
| 版本检查 / `lyu update` | 按上游 `packageName` 判定「该更新」，进而装回上游 pi | ✅ 发布源改指 npm 上的 `lyu-code`（`LYU_LATEST_VERSION_URL` 可覆盖）。实测假源返回 9.9.9 时提示的是 `lyu-code@9.9.9` |
| 更新日志 / 下载提示 | 链到 `pi.dev/changelog`、上游 releases | ✅ 改指本仓（`LYU_CHANGELOG_URL` / `LYU_DOWNLOAD_URL`） |
| 安装脚本提示 | 「npm 装法不受支持」时给的是 `curl -fsSL https://pi.dev/install.sh \| sh` | ✅ 改指本仓安装说明 —— 这是全表唯一会诱导用户装错东西的一条 |
| 会话分享 | `pi.dev/session/` | 保留（我们没有查看器，关掉等于把功能做成坏的），在 NOTICE 里标注 |
| `radius.pi.dev` | 36 处，上游托管的 LLM 网关 | 保留，NOTICE 里标注为上游服务 |
| `pi.dev/oauth`、theme schema、单文件版自更新源 | 各 2 处 | 保留并标注；最后一项在我们的分发形态下走不到 |
| **LICENSE / NOTICE** | **vendored 的 MIT dist 没带版权声明** | ✅ 已补 `LICENSE` + `NOTICE.md`（上游项目、版本、版权人、MIT 全文、我们改了什么、仍是上游服务的清单） |

### 3.3 品牌自检 —— 已完成 ✅

`scripts/brand-check.mjs`，vendor 末尾自动跑：

- **必须为零**：我们替换掉的出站地址，出现即失败（说明补丁漏了）
- **带基线计数**：`pi.dev` / `earendil-works` / `pi-coding-agent` / `pi-mono` / `PI_` 的数量与 `brand-baseline.json` 比对，动了就失败并打印分布

它在实跑中派上过用场：加了 installer 补丁后计数从 66 掉到 62，脚本当场指出「我们的补丁生效了，可 `--update`」；
反过来，上游哪天新增一处出口，涨上去也会当场失败。这样"还剩多少不是我们的"是数字，不是感觉。

## 4. 出站清洗（需求是反的，别做错）

**默认把控制块和思考都显示出来**，给开关让人自己关掉 —— 透明优先，符合「状态不能骗人」。

对象：`<analysis>` / `<thinking>` / `<summary>` 这类控制块，以及思考通道残留。

**前提**：先确认 1.5.2 消息侧哪个 hook 能改 assistant 内容。确认不了就不写 —— 否则做出来的是"装了但一个字没剥"的假扩展。

## 5. 收尾

`lyu-code` 与 `lyu-desktop` 两仓提交推送；README / 交接单 / REBRAND.md 同步。

## 6. 发布 —— 已完成 ✅

`lyu-code@0.2.0` 已发到 npm，`latest` 从 `0.1.4` 切到 `0.2.0`。

发布物的验证不看日志，看装下来跑：

```
npm i -g --prefix /tmp/lyupub lyu-code@0.2.0
lyu --version                        → 0.2.0
LICENSE / NOTICE.md                  → 都在包里
grep 发布源补丁 / 安装提示补丁         → 各 2 个文件命中
lyu update（真实网络）                → lyu is already up to date (v0.2.0)
```

**npm 11 的发布是异步的，这是个坑。** `PUT` 返回 `202 Accepted`，npm 会打印 `+ lyu-code@0.2.0` 且退出码 0，
但当时 registry 上根本查不到 —— tarball 404、版本列表还是 0.1.0–0.1.4、metadata 的 modified 停在 9 月。
真正的判据是 `https://registry.npmjs.org/lyu-code/-/lyu-code-0.2.0.tgz` 返回 200，实测用了 **14 分钟**。
另一个可靠信号：再发一次若报 `You cannot publish over the previously published versions: 0.2.0`，
说明服务端已经认下这个版本（在异步队列里），只需要等。

## 已知限制（写进文档，不藏着）

- 第三方 TUI 扩展（beautiful-tui / powerline-footer / open-tui）自带 "Pi" 品牌。它们不在我们仓里，改法是改别人的包或不用它们；第一轮已把 `pi-open-tui` 留在外面
- `lyu update` 认我们自己的发布源。`lyu-code@0.2.0` 已发布，`latest` 已从 0.1.4 切到 0.2.0，所以它现在的输出 `already up to date (v0.2.0)` 是真的比对结果，不是兜底文案
- 桌面端数据目录仍是 `~/.paseo`（daemon 侧）；`PASEO_*` 环境变量、`paseo://` 协议前缀都还在（协议里同时认 `lyu://`）
- 桌面端连的是「已经在跑的 daemon」：daemon 若是旧的（例如全局 `@getpaseo/cli` 里那份 server），桌面端的引擎改动不生效
