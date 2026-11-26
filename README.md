# Lyu

> 自带引擎的 coding agent。装完只有 `lyu` 一个命令，没有 `pi`。

Lyu 不是套在别人命令行外面的壳：引擎（pi 1.5.2 的官方 dist）随包发布，版本钉死在
`packages/agent/package.json` 的 `vendor.piCLI` 里；扩展也是包的一部分，装完就都在。
配置走 `~/.lyu/agent` 和项目里的 `.lyu/`，不碰 `~/.pi`。

```
Lyu = pi 1.5.2 引擎（vendored）+ 7 个随包扩展 + 1 个启动器
```

## 为什么不是薄壳

早先的版本只做一件事：`import { main } from "pi"`，然后 `main(argv)`。这样有三个问题，
每一个都会让「这是另一个产品」这句话不成立：

- 用户还得先装全局 `pi`，装哪个版本由用户决定 —— 我们说的「基于 1.5.2」是假的
- 上游一改 API，壳就碎；上游一升级，行为就变
- 我们的扩展要单独 `npm install`，还要手工链到 `.pi/extensions/`

现在把 dist 直接 vendor 进包、把扩展做成包的依赖，这三件事一起消失。

## 安装

目前只能从源码装（npm 还没发，见文末「已知限制」）：

```bash
git clone https://github.com/WeeeeeKdY/lyu-code.git
cd lyu-code/packages/agent

npm install
npm install -g .        # 或者 npm link，看你习惯
```

验证装对了：

```bash
lyu --version                       # 0.2.0
ls "$(npm root -g)/lyu-code/bin"    # 只有 lyu.js lyu-init.js extensions-package.js，没有 pi
```

（不用去数全局 `bin/` 里有没有 `pi` —— 你自己可能还装着上游 pi，那是另一回事；
关键是 lyu 这个包自身不提供 `pi` 命令。）

## 第一次跑：先接一个模型

```bash
lyu                     # 起 TUI
```

TUI 里 `/login` 走 OAuth，或者用环境变量：

```bash
OPENAI_API_KEY=sk-... lyu
ANTHROPIC_API_KEY=... lyu
```

不想手写配置就跑向导（选个预设，它写 `models.json` + `AGENTS.md`）：

```bash
lyu-init
```

要接 Ollama / vLLM / 任何 OpenAI 兼容端点，也可以直接写 `~/.lyu/agent/models.json`：

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

`apiKey` 支持 `$VAR` / `${VAR}` 插值、字面值、`!command`（请求时执行）。

```bash
lyu --list-models        # 看当前能用的模型
lyu --model sonnet       # 指定模型（支持模糊匹配、provider/id、:thinking 后缀）
```

## 配置放在哪

用户级（`~/.lyu/agent`，可用 `LYU_CODING_AGENT_DIR` 改）：

| 文件 | 作用 |
|---|---|
| `settings.json` | 偏好设置、资源路径、要加载的包（`lyu` 启动时会把扩展包注册到这里） |
| `models.json` | 兼容端点、模型、模型覆盖 |
| `auth.json` | 登录凭据（`/login` 写的） |
| `mcp.json` | 全局 MCP server |
| `keybindings.json` | 键位 |
| `AGENTS.md` | 跨项目生效的指令 |
| `extensions/` `skills/` `prompts/` `themes/` | 用户级扩展、技能、提示模板、主题 |

项目级（`.<工作目录>/.lyu`，属于项目本地文件，要项目被信任后才加载 —— 首次会让你确认，或 `--approve`）：

| 文件 | 作用 |
|---|---|
| `settings.json` | 项目级设置与资源路径 |
| `mcp.json` | 项目 MCP server |
| `SYSTEM.md` / `APPEND_SYSTEM.md` | 替换 / 追加 system prompt |
| `extensions/` `skills/` `prompts/` `themes/` | 项目级资源 |

项目根目录的 `AGENTS.md` / `CLAUDE.md` 也会被读（`--no-context-files` 关掉）。

## 用起来

```bash
lyu                          # 交互 TUI
lyu "看看这个项目的架构"       # 带 prompt 起 TUI
lyu -p "只回答 ok"            # headless，跑完就退（脚本里用这个）
lyu -c                       # 继续当前目录最近的会话
lyu -r                       # 挑一个会话继续
lyu --mode json -p "..."     # 结构化输出
```

常用入口都能 `--help`：`lyu --help`、`lyu auth --help`、`lyu mcp --help`。

## 自带什么

### 工具

引擎的 8 个内置工具：`bash` `read` `edit` `write` `grep` `find` `glob` `ls`。

扩展再加 3 个：

| 工具 | 干什么 |
|---|---|
| `todo` | 把计划显式写出来，每轮都能看到自己的进度（只活在本会话） |
| `remember` | 显式记一条记忆，跨会话可检索 |
| `spawn_subagent` | 把独立任务丢给另一个 lyu 进程，只收结论，过程不占当前上下文（最多嵌 2 层） |

### 扩展

7 个扩展随包安装、启动自动加载，不用单独装。每个都能关：

| 扩展 | 干什么 | 关掉的开关 |
|---|---|---|
| `guard` | 危险命令/敏感路径门禁 + 审计日志 | `PI_GUARD_MODE=off` |
| `memory` | 会话结束落一条记忆 + 按需检索注入 | `PI_MEMORY_MODE=off` |
| `stats` | 成本与用量：状态栏 + `/stats` + 当日合计 | 无（不影响正确性） |
| `codegraph` | 搜索/编辑后自动补代码图谱上下文 | `PI_CODEGRAPH_DISABLED=1` |
| `subagent` | `spawn_subagent` 工具 | 无专门开关（可用 `--exclude-tools spawn_subagent`） |
| `todo` | `todo` 工具 | 无专门开关 |
| `plannotator-auto` | 本轮长提案自动丢进 Plannotator 浏览器批注 | `PI_PLANNOTATOR_AUTO_DISABLED=1` |

全局关掉所有扩展：`--no-extensions`（显式 `-e` 仍生效）。

几条设计取舍值得知道，因为它们决定了你会不会觉得它烦：

- **`guard` 默认 `ask`**：交互模式下弹确认，headless（`-p`、workflow 节点）直接拒绝。
  想先观察不拦，用 `audit`（只记日志）；想全放行用 `off`。
  **门禁自己出 bug 一律放行**（fail-open），要反过来设 `PI_GUARD_FAIL=closed`。
  豁免写 `~/.lyu/agent/guard.json` 的 `{ "allow": ["rule-id"] }`，审计落 `guard-audit.jsonl`。
- **`memory` 不改 system prompt**，而是往对话尾部追加一条消息。system prompt 一变，
  KV 缓存前缀全失效，每轮多花一次完整 prefill 的钱。检索用本地 embedding
  （`Xenova/bge-small-zh-v1.5`，约 24M，首次下到 `~/.lyu/agent/memory/models/`），
  2000 条以内暴力余弦就够快，不引入向量库。
  嵌入器坏了不会静默：`/memory` 里能看到原因，`PI_MEMORY_DEBUG=1` 还会在 stderr 说一声。
- **`stats` 只提醒不熔断**。超 `PI_DAILY_BUDGET` 时提醒一次，不会把你正在干的事掐断。
- **所有扩展的 hook 都 fail-open**：外部二进制不在、超时、返回畸形数据，结果都是「这轮少点料」，
  不是「这轮失败」。

### slash 命令

引擎自带：`/login` `/model` `/settings` `/reload` `/compact` 等（`/help` 看全）。

扩展加的：`/guard` `/memory` `/stats` `/subagent` `/codegraph` `/annotate-last` `/plannotator-auto`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `LYU_CODING_AGENT_DIR` | 换掉 `~/.lyu/agent` |
| `PI_GUARD_MODE` | `off` / `audit` / `ask`(默认) / `strict` |
| `PI_GUARD_FAIL` | `closed` = 门禁自身出错时也拦（默认放行） |
| `PI_GUARD_AUDIT` | `0` = 不写审计日志 |
| `PI_MEMORY_MODE` | `off` = 关记忆 |
| `PI_MEMORY_OFFLINE` | `1` = 不下载模型（只用本地缓存） |
| `PI_MEMORY_MODEL` / `PI_MEMORY_MODEL_DIR` | 换 embedding 模型 / 缓存目录 |
| `PI_MEMORY_DEBUG` | `1` = 嵌入器出问题时打到 stderr |
| `PI_DAILY_BUDGET` | 当日花费提醒阈值（美元） |
| `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_BIN` | 子代理层数（自增，用户一般别碰）/ 换 lyu 可执行文件 |
| `PI_CODEGRAPH_DISABLED` / `PI_CODEGRAPH_CONFIG` | 关代码图谱 / 指定配置 |
| `PI_GITNEXUS_BIN` / `PI_CBM_BIN` | 指定 `gitnexus` / codebase-memory 可执行文件 |
| `PI_PLANNOTATOR_AUTO_DISABLED` / `PI_PLANNOTATOR_BIN` | 关自动批注 / 指定 plannotator 可执行文件 |

`PI_*` 是历史命名（引擎和扩展一开始都叫 pi），为了不让已有的脚本和配置失效就留着了。

## 架构

```
lyu-code/
├── packages/
│   ├── agent/                  # 引擎包：lyu-code
│   │   ├── bin/lyu.js          # 启动器：注册扩展包 → 交给 dist/bundle/cli.js
│   │   ├── bin/lyu-init.js     # lyu-init：交互向导，写 models.json + AGENTS.md
│   │   ├── dist/               # vendored 的 pi 1.5.2 dist（21M，随包发布）
│   │   ├── scripts/vendor.mjs  # 拉 dist + 打品牌补丁
│   │   └── docs/               # 引擎文档（随包发，README 里的链接都指这里）
│   └── extensions-pi/          # 扩展包：@lyu/extensions
│       ├── extensions/*.ts     # 7 个扩展
│       └── src/                # 它们的实现
├── docs/lyu-migration-handoff.md   # 移植进度与踩过的坑（改引擎前先看）
└── package.json                # 只是一个入口壳：scripts 转发到 packages/agent
```

没有 workspace、也没有根 `node_modules`：两个包各自 `npm install`，互不干涉（原因见下方「为什么是两个包」）。
根 `package.json` 只提供 `npm run lyu` / `npm run init` / `npm run vendor` 三个转发脚本。

### 为什么是两个包

引擎运行时依赖 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-tui`、`typebox`，而扩展侧被要求把这几个
写成 `peerDependencies: "*"`（引擎的扩展加载器看到 `dependencies` 里有它们会警告：装出重复副本会绕过
加载器、产生两份运行时模块）。一个 `package.json` 同时扮这两个角色必然冲突，所以拆开。

拆开不会造成双实例：引擎在 `core/extensions/loader.ts` 里用 jiti alias 把那 4 个包和 `typebox`
全部指向自己的实例，扩展包里就算有副本也轮不到加载。

### 品牌只有一个来源

`piConfig.name` 是 `"lyu"`，命令名、终端标题、横幅、配置目录全从它派生。`bin` 里没有 `pi`，
装完也不会有 `pi` 命令。横幅那行不是 `APP_NAME` 拼的（走的是 `pi-logo.ts` 的 `piWordmark()`，
里面写死了 `P`+`i`），所以 `vendor.mjs` 用一个补丁表把它改成从 `APP_NAME` 派生：

- `APP_NAME = "pi"` 时结果与上游逐字节一致，`"lyu"` 时是 `Lyu` —— **没有硬编品牌名**
- 补丁命中 0 次就**中止**，不静默放过；打完对每个改过的文件跑 `node --check`
- 每个补丁带 `only:` 限定目标文件（不限定的话，注 import 会命中 27 个文件，其中
  `first-time-setup.js` 本来就 import 了 `APP_NAME`，直接变重复声明）

## 开发

```bash
cd packages/agent
npm install                 # 引擎包
cd ../extensions-pi
npm install                 # 扩展包（注意有 .npmrc，别改成别的装法，原因写在里面）
```

改了引擎补丁之后：

```bash
cd packages/agent
node scripts/vendor.mjs --force     # 重新拉 dist + 打补丁
```

值得手动确认的四件事（这些脚本代替不了）：

1. `lyu --version` 是 `0.2.0`
2. 临时 HOME 下只生成 `.lyu`，`.pi` 一次都不出现
3. TUI 里 `[Extensions]` 那 7 个都在，且**没有** `[Extension issues]` / `peerDependencies` 警告
4. 横幅是 `Lyu v0.2.0`（TUI 只在 stdin 是终端时才画，管道里抓不到，得用 pty）

## 延伸阅读

引擎的完整文档随包发布在 `packages/agent/docs/`（链接指仓库里的相对路径）：

- [配置总览](packages/agent/docs/configuration.md) · [设置项](packages/agent/docs/settings.md) · [模型与兼容端点](packages/agent/docs/models.md)
- [扩展怎么写的](packages/agent/docs/extensions.md) · [slash 命令](packages/agent/docs/slash-commands.md) · [技能](packages/agent/docs/skills.md)
- [MCP](packages/agent/docs/mcp.md) · [会话](packages/agent/docs/sessions.md) · [压缩](packages/agent/docs/compaction.md)
- [安全与项目信任](packages/agent/docs/security.md) · [环境变量](packages/agent/docs/environment-variables.md)

改引擎补丁之前，先看 [`docs/lyu-migration-handoff.md`](docs/lyu-migration-handoff.md)：
里面记了哪些地方不能动、哪些坑已经踩过（比如为什么 `grep 'Pi v'` 永远搜不到横幅）。

## 已知限制

诚实的清单，都是还没收尾的地方：

- **npm 上还没发**。`packages/agent` 依赖 `@lyu/extensions` 用的是 `file:../extensions-pi`
  （本地可复现、可验证）。真要发，得先发扩展包、再把这里换成版本号，否则用户装上就解析不到。
- **`lyu update` 指向的是上游 pi 的发布源**，跟着它做会 `npm i -g @earendil-works/pi-coding-agent`，
  把 `pi` 装回来。这个提示暂时请忽略，正在改成认自己的源。
- **引擎里还有上游措辞**：`lyu --help` 的 `update [source|self|pi]`、部分文案里的 "pi"。
  只影响文字，不影响行为。
- **`PI_ANNOTATE_DISABLE` 没人读**：`src/subagent/run.ts` 会往子进程塞它，但本仓没有任何地方消费；
  真正关自动批注的是 `PI_PLANNOTATOR_AUTO_DISABLED`。

## License

MIT
