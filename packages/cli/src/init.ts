#!/usr/bin/env node
/**
 * lyu init — 交互式初始化 Lyu-code 配置
 *
 * 在项目根目录创建 .pi/ 目录结构，配置 Provider 和 Extension。
 * 同时写两份 provider 配置：
 *   1. Pi 原生的 custom_provider（config.yaml）— Pi 直接读
 *   2. lyu.providers — 给 provider extension 做预设引用
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// ─── Provider 预设 ──────────────────────────────────────────────

const PROVIDER_PRESETS: Record<string, {
  label: string;
  baseUrl: string;
  apiFormat: string;
  apiKeyEnv: string;
  defaultModel: string;
}> = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "openai-responses",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiFormat: "anthropic-messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-20250514",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiFormat: "openai-completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v3",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "openai-completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
  },
  "local-vllm": {
    label: "本地 vLLM",
    baseUrl: "http://localhost:8000/v1",
    apiFormat: "openai-completions",
    apiKeyEnv: "VLLM_API_KEY",
    defaultModel: "default",
  },
};

// ─── 所有可用 Extension ────────────────────────────────────────

const ALL_EXTENSIONS = [
  { id: "lyu-defaults",       label: "Lyu-code 默认（品牌 prompt + 审查工具）",     priority: "P0" },
  { id: "provider",           label: "Provider 注册与管理（预设+动态注册）",      priority: "P0" },
  { id: "permission",         label: "危险命令拦截（rm -rf, sudo, curl|sh）",       priority: "P0" },
  { id: "runaway-guard",      label: "无限循环检测（重复/振荡工具调用）",            priority: "P0" },
  { id: "skills",             label: "Skill 发现与注入",                            priority: "P0" },
  { id: "context-manager",    label: "上下文窗口管理（提醒 compact）",               priority: "P1" },
  { id: "system-reminder",    label: "环境信息提醒（时间/git/OS）",                  priority: "P1" },
  { id: "plan-mode",          label: "Plan 模式（先规划再执行）",                    priority: "P1" },
  { id: "tool-output-budget", label: "工具输出截断（防上下文撑爆）",             priority: "P2" },
];

// ─── 查找 extension 构建产物 ───────────────────────────────────

function findExtensionDist(extId: string): string | null {
  const candidates = [
    path.resolve(__dirname, `../../packages/extensions/${extId}/dist/index.js`),
    path.resolve(__dirname, `../node_modules/@lyu/extension-${extId}/dist/index.js`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── 主流程 ────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();
  const piDir = path.join(cwd, ".pi");
  const extDir = path.join(piDir, "extensions");

  console.log("");
  console.log("🚀 Lyu-code 初始化向导");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`工作目录: ${cwd}`);
  console.log("");

  // 1. 创建 .pi 目录
  fs.mkdirSync(extDir, { recursive: true });
  console.log("✅ 创建 .pi/extensions/ 目录");

  // ── 2. 配置 Provider ────────────────────────────────────────

  console.log("");
  console.log("── 模型 Provider ──");
  console.log("");

  // 先展示预设
  console.log("可用预设:");
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    console.log(`  ${key.padEnd(14)} — ${preset.label} (${preset.apiFormat})`);
  }
  console.log(`  ${"custom".padEnd(14)} — 自定义配置`);
  console.log("");

  const providerChoice = await question("选择预设或输入 custom: ");

  let providerName: string;
  let baseUrl: string;
  let apiKeyEnv: string;
  let modelName: string;
  let apiFormat: string;
  let usePreset = false;

  if (providerChoice && providerChoice !== "custom" && PROVIDER_PRESETS[providerChoice]) {
    // 用预设
    const preset = PROVIDER_PRESETS[providerChoice];
    providerName = providerChoice;
    baseUrl = preset.baseUrl;
    apiKeyEnv = preset.apiKeyEnv;
    apiFormat = preset.apiFormat;
    usePreset = true;

    console.log(`✅ 使用预设: ${preset.label}`);
    modelName = await question(`模型名 [${preset.defaultModel}]: `) || preset.defaultModel;

    // 允许覆盖 base URL
    const overrideUrl = await question(`Base URL [${preset.baseUrl}]: `);
    if (overrideUrl) baseUrl = overrideUrl;
  } else {
    // 自定义
    providerName = await question("Provider 名称 (如 my-openai): ");
    baseUrl = await question("Base URL: ");
    apiKeyEnv = await question("API Key 环境变量名 (如 OPENAI_API_KEY): ");
    modelName = await question("模型名: ");
    apiFormat = await question("API 格式 (openai-completions / openai-responses / anthropic-messages) [openai-completions]: ") || "openai-completions";
  }

  // 写 .pi/config.yaml — 同时写 Pi 原生的 custom_provider 和 lyu.providers
  const configYaml = `# Lyu-code 配置 — 由 lyu init 生成

# Pi 原生 custom_provider（Pi 直接读取）
custom_provider:
  ${providerName}:
    base_url: ${baseUrl}
    api_key_env: ${apiKeyEnv}
    api: ${apiFormat}
    models:
      - id: ${modelName}
        name: ${modelName}
        reasoning: false
        input:
          - text
          - image
        cost:
          input: 0
          output: 0
          cache_read: 0
          cache_write: 0
        context_window: 128000
        max_tokens: 16384

# Lyu-code provider 扩展配置（provider extension 读取）
lyu:
  providers:
    ${providerName}:
${usePreset ? `      preset: ${providerChoice}` : ""}
      baseUrl: ${baseUrl}
      apiKeyEnv: ${apiKeyEnv}
      api: ${apiFormat}
`;
  fs.writeFileSync(path.join(piDir, "config.yaml"), configYaml);
  console.log("✅ 写入 .pi/config.yaml");

  // ── 3. Extension 选装 ───────────────────────────────────────

  console.log("");
  console.log("── Extension 选装 ──");

  for (const ext of ALL_EXTENSIONS) {
    console.log(`  [${ext.priority}] ${ext.id.padEnd(22)} — ${ext.label}`);
  }
  console.log("");

  const installAll = await question("安装全部 P0 Extension? (Y/n): ");
  const selected: string[] = [];

  if (installAll.toLowerCase() !== "n") {
    for (const ext of ALL_EXTENSIONS.filter((e) => e.priority === "P0")) {
      selected.push(ext.id);
    }
  }

  for (const ext of ALL_EXTENSIONS.filter((e) => e.priority !== "P0")) {
    const answer = await question(`安装 ${ext.id} [${ext.priority}]? (y/N): `);
    if (answer.toLowerCase() === "y") {
      selected.push(ext.id);
    }
  }

  // 链接选中的 extension
  let linked = 0;
  for (const extId of selected) {
    const distPath = findExtensionDist(extId);
    const linkPath = path.join(extDir, `${extId}.js`);

    if (distPath) {
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(distPath, linkPath);
      console.log(`  ✅ ${extId} → ${distPath}`);
      linked++;
    } else {
      console.log(`  ⚠️  ${extId}: 构建产物未找到，跳过（请先 pnpm build）`);
    }
  }

  if (linked > 0) {
    console.log(`✅ 已链接 ${linked} 个 Extension`);
  }

  // ── 4. 创建 AGENTS.md ──────────────────────────────────────

  const agentsMd = `# AGENTS.md

## 项目指引

<!-- 在这里描述你的项目约定，Lyu-code 会读取这些内容 -->
<!-- 例如：使用的语言、框架、测试方式、代码风格等 -->
`;
  if (!fs.existsSync(path.join(cwd, "AGENTS.md"))) {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), agentsMd);
    console.log("✅ 创建 AGENTS.md");
  }

  // ── 完成 ────────────────────────────────────────────────────

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🎉 初始化完成！");
  console.log("");
  console.log("配置概览:");
  console.log(`  Provider: ${providerName} (${apiFormat})`);
  console.log(`  Base URL: ${baseUrl}`);
  console.log(`  模型:     ${modelName}`);
  console.log(`  扩展:     ${selected.length} 个`);
  console.log("");
  console.log("下一步:");
  console.log(`  1. 设置环境变量: export ${apiKeyEnv}=<your-key>`);
  console.log("  2. 启动: lyu");
  console.log(`  3. 或: lyu "帮我看看这个项目"`);
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("初始化失败:", err);
  rl.close();
  process.exit(1);
});
