# Lyu-code

> A minimal coding agent built on [Pi](https://github.com/earendil-works/pi) — Extension 选装，不做中间层。

**核心理念**：Pi 的原生 Extension 系统已经足够强大，不需要 agent-runtime 那层 SPI。

```
Lyu-code = Pi coding-agent + 9 个选装 Extension
```

## ✨ 功能

- 🤖 **Provider 管理** — 5 个预设（OpenAI/Anthropic/DeepSeek/OpenRouter/本地 vLLM），动态注册
- 🔒 **安全拦截** — 15 条危险命令规则（rm -rf/sudo/curl|sh/kubectl delete 等）
- 🛑 **循环检测** — 重复/振荡/超量三层循环检测，防 agent 无限循环
- 📋 **Plan 模式** — 先规划再执行，防 agent 一上来就乱改
- 🧠 **上下文管理** — 75%/90% 双阈值提醒，自动建议 compact
- 🕐 **环境提醒** — 注入时间/git/OS 信息到 system prompt
- 📦 **Skill 发现** — 自动发现 .pi/skills/ 和 ~/.pi/agent/skills/
- ✂️ **输出截断** — 超 30k 字符/500 行自动截断，防上下文撑爆

## 🚀 快速开始

```bash
# 安装
npm install -g @lyu/cli

# 初始化配置（交互式）
lyu-init

# 启动
lyu

# 或带 prompt 启动
lyu "帮我看看这个项目的架构"
```

### 从源码构建

```bash
git clone https://github.com/WeeeeeKdY/lyu-code.git
cd lyu-code
pnpm install
pnpm build

# 启动
node packages/cli/dist/index.js
```

## ⚙️ 配置 Provider

`lyu-init` 支持预设选择：

```
可用预设:
  openai         — OpenAI (openai-responses)
  anthropic      — Anthropic (anthropic-messages)
  deepseek       — DeepSeek (openai-completions)
  openrouter     — OpenRouter (openai-completions)
  local-vllm     — 本地 vLLM (openai-completions)
  custom         — 自定义配置
```

手动配置 `.pi/config.yaml`：

```yaml
# Pi 原生格式（Pi 直接读取）
custom_provider:
  openai:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    api: openai-responses
    models:
      - id: gpt-4o
        name: GPT-4o
        reasoning: false
        input: [text, image]
        cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 1.25 }
        context_window: 128000
        max_tokens: 16384

# Lyu-code 预设格式（provider extension 读取）
lyu:
  providers:
    my-openai:
      preset: openai       # 引用预设，自动填充
    my-proxy:              # 或自定义
      baseUrl: https://proxy.example.com/v1
      apiKeyEnv: PROXY_API_KEY
      api: openai-completions
```

## 🔌 Extension 选装

| 优先级 | Extension | npm 包 | 说明 |
|--------|-----------|--------|------|
| P0 | `lyu-defaults` | `@lyu/extension-lyu-defaults` | 品牌 prompt + /review 审查工具 |
| P0 | `provider` | `@lyu/extension-provider` | Provider 注册与管理（5 预设） |
| P0 | `permission` | `@lyu/extension-permission` | 危险命令拦截（15 条规则） |
| P0 | `runaway-guard` | `@lyu/extension-runaway-guard` | 无限循环检测 |
| P0 | `skills` | `@lyu/extension-skills` | Skill 发现与注入 |
| P1 | `context-manager` | `@lyu/extension-context-manager` | 上下文窗口管理 |
| P1 | `system-reminder` | `@lyu/extension-system-reminder` | 环境信息提醒 |
| P1 | `plan-mode` | `@lyu/extension-plan-mode` | Plan 模式 |
| P2 | `tool-output-budget` | `@lyu/extension-tool-output-budget` | 工具输出截断 |

Pi 自动发现 `.pi/extensions/` 下的 extension。`lyu-init` 会帮你创建符号链接。

### 单独安装 extension

```bash
npm install @lyu/extension-provider @lyu/extension-permission
```

然后在 `.pi/extensions/` 中创建链接指向 `node_modules/@lyu/extension-*/dist/index.js`。

### 写一个自己的 Extension

```typescript
// .pi/extensions/my-tool/index.ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const myExtension: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful",
    parameters: { type: "object", properties: {} },
    async execute(id, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text" as const, text: "Hello!" }], details: undefined };
    },
  });
};

export default myExtension;
```

## 🏗️ 架构

```
Lyu-code/
├── packages/
│   ├── cli/                    # 入口（薄壳，~30 行）
│   └── extensions/
│       ├── lyu-defaults/       # P0: 品牌 + 审查
│       ├── provider/           # P0: Provider 管理
│       ├── permission/         # P0: 安全拦截
│       ├── runaway-guard/      # P0: 循环检测
│       ├── skills/             # P0: Skill 发现
│       ├── context-manager/    # P1: 上下文管理
│       ├── system-reminder/    # P1: 环境提醒
│       ├── plan-mode/          # P1: Plan 模式
│       └── tool-output-budget/ # P2: 输出截断
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

**入口只有 ~30 行**：设置进程标题 → import Pi → `main(argv)`。所有差异化逻辑都在 Extension 里。

## 🎯 为什么不需要 agent-runtime？

- Pi 的 `on('before_agent_start')` 能改 system prompt → 不需要 `contributeSystemPrompt`
- Pi 的 `on('tool_call')` 能 block 工具 → 不需要 Mavis 的 `before_tool_call`
- Pi 的文件系统发现 `.pi/extensions/` → 不需要 Profile Overlay
- Pi 的 `registerTool` + 条件 execute → 不需要 per-turn 工厂
- **Extension 选装 > 运行时组装**

## Pi 原生能力（全部可用）

| 能力 | 说明 |
|------|------|
| 7 个内置工具 | bash, read, edit, write, grep, find, ls |
| 30+ 事件 | tool_call, tool_result, context, before_agent_start, ... |
| registerTool | 自定义工具 |
| registerCommand | slash 命令 |
| registerProvider | 自定义模型 Provider |
| registerShortcut | 快捷键 |
| MCP | 内置 MCP 客户端支持 |
| Skills | 内置 Skill 加载 |
| ACP | Agent Client Protocol |

## License

MIT
