/**
 * Provider Extension — 模型 Provider 注册与管理
 *
 * P0 核心扩展。通过 pi.registerProvider() 注册自定义 Provider，
 * 提供预设 Provider 配置和运行时管理命令。
 *
 * 功能：
 * 1. 预设 Provider 模板（OpenAI/Anthropic/DeepSeek/OpenRouter/本地）
 * 2. 从 .pi/config.yaml 的 lyu.providers 读取配置并注册
 * 3. /provider 命令：列出/切换 provider
 * 4. /models 命令：列出当前 provider 的可用模型
 */

import type {
  ExtensionFactory,
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Provider 预设 ──────────────────────────────────────────────

interface ProviderPreset {
  name: string;
  label: string;
  baseUrl: string;
  api: ProviderConfig["api"];
  apiKeyEnv: string;
  models: ProviderModelConfig[];
}

/**
 * 常见 Provider 预设。用户在 .pi/config.yaml 的 lyu.providers 中
 * 引用 preset 名即可，不需要手写完整配置。
 */
const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    name: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 1.25 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.075 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "o3",
        name: "o3",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 1 },
        contextWindow: 200000,
        maxTokens: 100000,
      },
      {
        id: "o4-mini",
        name: "o4-mini",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0.55 },
        contextWindow: 200000,
        maxTokens: 100000,
      },
    ],
  },

  anthropic: {
    name: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  },

  deepseek: {
    name: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [
      {
        id: "deepseek-r1",
        name: "DeepSeek R1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
        contextWindow: 128000,
        maxTokens: 65536,
      },
      {
        id: "deepseek-v3",
        name: "DeepSeek V3",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
        contextWindow: 128000,
        maxTokens: 65536,
      },
    ],
  },

  openrouter: {
    name: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: [
      {
        id: "anthropic/claude-sonnet-4-20250514",
        name: "Claude Sonnet 4 (OpenRouter)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
      {
        id: "openai/gpt-4o",
        name: "GPT-4o (OpenRouter)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  },

  "local-vllm": {
    name: "local-vllm",
    label: "本地 vLLM",
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    apiKeyEnv: "VLLM_API_KEY",
    models: [
      {
        id: "default",
        name: "本地模型 (vLLM)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      },
    ],
  },
};

// ─── 配置文件读取 ──────────────────────────────────────────────

interface LyuProviderEntry {
  /** 引用预设名（openai/anthropic/deepseek/openrouter/local-vllm） */
  preset?: string;
  /** 覆盖 baseUrl */
  baseUrl?: string;
  /** 覆盖 API key 环境变量 */
  apiKeyEnv?: string;
  /** 覆盖 API 格式 */
  api?: string;
  /** 自定义模型列表（覆盖预设的） */
  models?: ProviderModelConfig[];
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

interface LyuProviderConfig {
  providers?: Record<string, LyuProviderEntry>;
}

/**
 * 从 .pi/config.yaml 读取 lyu.providers 配置。
 * Pi 的 config.yaml 用 YAML 格式，这里做简单解析。
 */
function readProviderConfig(cwd: string): LyuProviderConfig {
  const configPath = path.join(cwd, ".pi", "config.yaml");
  if (!fs.existsSync(configPath)) return {};

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return parseProviderYaml(content);
  } catch {
    return {};
  }
}

/**
 * 极简 YAML 解析：只提取 lyu.providers 下的结构。
 * 格式：
 *   lyu:
 *     providers:
 *       my-openai:
 *         preset: openai
 *         baseUrl: https://...
 *         models:
 *           - id: gpt-4o
 *             ...
 */
function parseProviderYaml(content: string): LyuProviderConfig {
  const lines = content.split("\n");
  const result: LyuProviderConfig = { providers: {} };

  let inLyuProviders = false;
  let currentProvider: string | null = null;
  let currentIndent = 0;

  for (const line of lines) {
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // 检测 lyu: 节点
    if (trimmed === "lyu:" && indent === 0) {
      inLyuProviders = false;
      currentProvider = null;
      continue;
    }

    // 检测 providers: 节点（在 lyu: 下，indent = 2）
    if (trimmed === "providers:" && indent === 2 && inLyuProviders !== undefined) {
      // 检查上一行是否是 lyu:
      inLyuProviders = true;
      continue;
    }

    if (!inLyuProviders) continue;

    // provider 条目（indent = 4）
    if (indent === 4 && trimmed.endsWith(":")) {
      currentProvider = trimmed.slice(0, -1);
      currentIndent = indent;
      (result.providers! as any)[currentProvider] = {};
      continue;
    }

    if (!currentProvider) continue;
    const entry = result.providers![currentProvider]!;

    // 属性（indent = 6）
    if (indent === 6) {
      const [key, ...rest] = trimmed.split(":");
      const value = rest.join(":").trim();
      if (!value) continue;

      if (key === "preset") (entry as any).preset = value;
      else if (key === "baseUrl") (entry as any).baseUrl = value;
      else if (key === "apiKeyEnv") (entry as any).apiKeyEnv = value;
      else if (key === "api") (entry as any).api = value;
      else if (key === "enabled") (entry as any).enabled = value !== "false";
    }
  }

  return result;
}

// ─── 解析 Provider 配置 → ProviderConfig ──────────────────────

function resolveProviderConfig(
  name: string,
  entry: LyuProviderEntry
): ProviderConfig | null {
  if (entry.enabled === false) return null;

  let config: ProviderConfig;

  if (entry.preset) {
    // 基于预设
    const preset = PRESETS[entry.preset];
    if (!preset) {
      console.warn(`[lyu:provider] 未知预设: ${entry.preset}，跳过 provider "${name}"`);
      return null;
    }

    config = {
      name: preset.label,
      baseUrl: entry.baseUrl || preset.baseUrl,
      apiKey: `$${entry.apiKeyEnv || preset.apiKeyEnv}`,
      api: (entry.api as ProviderConfig["api"]) || preset.api,
      models: entry.models || preset.models,
    };
  } else {
    // 纯自定义
    if (!entry.baseUrl) {
      console.warn(`[lyu:provider] provider "${name}" 缺少 baseUrl，跳过`);
      return null;
    }

    config = {
      name,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKeyEnv ? `$${entry.apiKeyEnv}` : undefined,
      api: entry.api as ProviderConfig["api"],
      models: entry.models,
    };
  }

  return config;
}

// ─── Extension ────────────────────────────────────────────────

const providerExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // 记录已注册的 provider
  const registeredProviders: string[] = [];

  // 在 session_start 时注册所有 provider
  pi.on("session_start", (_event, ctx) => {
    const lyuConfig = readProviderConfig(ctx.cwd);
    const providers = lyuConfig.providers || {};

    for (const [name, entry] of Object.entries(providers)) {
      const config = resolveProviderConfig(name, entry);
      if (!config) continue;

      try {
        pi.registerProvider(name, config);
        registeredProviders.push(name);
      } catch (err) {
        console.warn(`[lyu:provider] 注册 provider "${name}" 失败:`, err);
      }
    }
  });

  // /provider 命令：列出已注册的 provider 和预设
  pi.registerCommand("provider", {
    description: "管理 Provider：列出已注册/可用预设",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "list" || subcommand === "") {
        // 列出已注册的 provider
        const lines: string[] = ["📋 已注册 Provider:"];
        if (registeredProviders.length === 0) {
          lines.push("  （无，使用 .pi/config.yaml 配置 lyu.providers）");
        } else {
          for (const name of registeredProviders) {
            lines.push(`  ✅ ${name}`);
          }
        }
        lines.push("");
        lines.push("📦 可用预设:");
        for (const [key, preset] of Object.entries(PRESETS)) {
          lines.push(`  • ${key.padEnd(14)} — ${preset.label} (${preset.api})`);
        }
        ctx.ui.notify(lines.join("\n"));
      } else if (subcommand === "presets") {
        const lines = PRESETS
          ? Object.entries(PRESETS).map(([key, p]) => {
              const modelList = p.models.map((m) => `    - ${m.id} (${m.name})`).join("\n");
              return `**${p.label}** (${key})\n  Base URL: ${p.baseUrl}\n  API: ${p.api}\n  Key: $${p.apiKeyEnv}\n  模型:\n${modelList}`;
            }).join("\n\n")
          : "（无预设）";
        ctx.ui.notify(`📦 Provider 预设详情:\n\n${lines}`);
      } else {
        ctx.ui.notify(
          "用法: /provider [list|presets]\n  list    — 列出已注册 provider\n  presets — 查看预设详情"
        );
      }
    },
  });

  // /models 命令：列出当前可用的模型
  pi.registerCommand("models", {
    description: "列出当前可用的模型",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const lines: string[] = ["🤖 可用模型:\n"];

      // 从 Pi modelRegistry 获取已注册的模型
      try {
        const available = ctx.modelRegistry.getAvailable();
        if (available.length > 0) {
          // 按 provider 分组
          const byProvider = new Map<string, typeof available>();
          for (const model of available) {
            const provider = model.provider;
            const list = byProvider.get(provider) || [];
            list.push(model);
            byProvider.set(provider, list);
          }
          for (const [provider, models] of byProvider) {
            lines.push(`**${provider}**:`);
            for (const m of models) {
              const ctxWin = ((m.contextWindow ?? 0) / 1000).toFixed(0);
              lines.push(`  ${m.id.padEnd(45)} ctx=${ctxWin}k`);
            }
            lines.push("");
          }
        } else {
          lines.push("  （暂无已配置的模型）");
        }
      } catch {
        lines.push("  （无法读取模型列表）");
      }

      if (registeredProviders.length > 0) {
        lines.push(`已注册 provider: ${registeredProviders.join(", ")}`);
      }

      ctx.ui.notify(lines.join("\n"));
    },
  });
};

export default providerExtension;
