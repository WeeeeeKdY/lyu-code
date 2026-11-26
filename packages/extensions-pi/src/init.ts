#!/usr/bin/env node
/**
 * lyu-init —— 交互式初始化
 *
 * 只做两件引擎需要人帮忙的事：
 *   1. 接一个模型端点：写 `<agent-dir>/models.json`（引擎唯一认的模型配置入口）
 *   2. 建 `AGENTS.md`（项目约定，引擎会读）
 *
 * 以前这里还写 `.lyu/config.yaml` 的 `custom_provider` 和 `.lyu/extensions/` 的软链，
 * 新引擎两样都不认也不需要：模型只认 `models.json`，7 个扩展随包加载。
 * 那些输出留着只会骗人 —— 编辑了不生效的配置，比没配置更难查。
 *
 * 保留向导形态只是给第一次用的人一个入口，不是它非有不可。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { lyuAgentDir } from "./agent-dir.ts";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let closed = false;
rl.on("close", () => {
	closed = true;
});

function question(prompt: string): Promise<string> {
	if (closed) return Promise.resolve("");
	return new Promise((resolve) => rl.question(prompt, resolve));
}

// ─── Provider 预设 ──────────────────────────────────────────────
// api 取值必须是引擎认识的（见 packages/agent/docs/models-configuration.md）：
// openai-completions / openai-responses / anthropic-messages / google-generative-ai

const PROVIDER_PRESETS: Record<
	string,
	{ label: string; baseUrl: string; api: string; apiKeyEnv: string; defaultModel: string; note?: string }
> = {
	openai: {
		label: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		api: "openai-completions",
		apiKeyEnv: "OPENAI_API_KEY",
		defaultModel: "gpt-4o",
	},
	anthropic: {
		label: "Anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		api: "anthropic-messages",
		apiKeyEnv: "ANTHROPIC_API_KEY",
		defaultModel: "claude-sonnet-4-20250514",
	},
	deepseek: {
		label: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		defaultModel: "deepseek-chat",
	},
	openrouter: {
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		api: "openai-completions",
		apiKeyEnv: "OPENROUTER_API_KEY",
		defaultModel: "anthropic/claude-sonnet-4-20250514",
	},
	ollama: {
		label: "Ollama（本地）",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		apiKeyEnv: "OLLAMA_API_KEY",
		defaultModel: "qwen2.5-coder:7b",
		note: "Ollama 不校验 key，apiKey 写什么都行",
	},
	vllm: {
		label: "本地 vLLM",
		baseUrl: "http://localhost:8000/v1",
		api: "openai-completions",
		apiKeyEnv: "VLLM_API_KEY",
		defaultModel: "default",
		note: "vLLM 不校验 key，apiKey 写什么都行",
	},
};

/** 从扩展包自己的 package.json 读内置扩展清单（不在这里写死，免得漂移）。 */
function builtinExtensions(): string[] {
	try {
		const pkgPath = path.resolve(__dirname, "../package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { pi?: { extensions?: string[] } };
		return (pkg.pi?.extensions ?? []).map((p) => path.basename(p).replace(/\.ts$/, ""));
	} catch {
		return [];
	}
}

type ModelsFile = {
	$schema?: string;
	providers?: Record<string, unknown>;
	[key: string]: unknown;
};

function readModelsFile(file: string): ModelsFile {
	if (!fs.existsSync(file)) {
		return { $schema: "https://pi.dev/schemas/models.schema.json", providers: {} };
	}
	const raw = fs.readFileSync(file, "utf-8");
	let parsed: ModelsFile;
	try {
		parsed = JSON.parse(raw) as ModelsFile;
	} catch (err) {
		// 绝不覆盖解析不了的文件 —— 里面可能只有一处手误，重写会把整份配置连注释一起吞掉
		throw new Error(
			`${file} 不是合法 JSON，先修好它再来（${(err as Error).message}）。\n` +
				`这个文件是你的，我不会覆盖它。`,
		);
	}
	parsed.providers ??= {};
	return parsed;
}

async function main() {
	if (!process.stdin.isTTY) {
		console.error("lyu-init 需要交互终端。非交互场景直接手写 models.json，字段见：");
		console.error("  packages/agent/docs/models.md#configure-a-compatible-endpoint");
		process.exit(1);
	}

	const cwd = process.cwd();
	console.log("\n🚀 Lyu 初始化");
	console.log("━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`工作目录: ${cwd}`);

	const extensions = builtinExtensions();
	if (extensions.length) {
		console.log(`内置扩展: ${extensions.length} 个（随包加载，不用选、也不用装）`);
		console.log(`  ${extensions.join("  ")}`);
	}
	console.log("");

	// ── 1. 模型端点 ────────────────────────────────────────────

	console.log("── 模型端点 ──");
	console.log("（要是打算用 /login 登录现成的 provider，这一步可以按 Ctrl-C 跳过）");
	console.log("");
	console.log("可用预设:");
	for (const [key, p] of Object.entries(PROVIDER_PRESETS)) {
		console.log(`  ${key.padEnd(12)} — ${p.label} (${p.api})`);
	}
	console.log(`  ${"custom".padEnd(12)} — 自定义（任何 OpenAI / Anthropic 兼容端点）`);
	console.log("");

	const choice = (await question("选一个，或输入 custom: ")).trim();
	if (closed) {
		console.log("\n已取消。");
		process.exit(0);
	}

	let providerName: string;
	let baseUrl: string;
	let api: string;
	let modelName: string;
	let apiKey: string;
	let apiKeyEnv = "";

	const preset = PROVIDER_PRESETS[choice];
	if (preset) {
		providerName = choice;
		baseUrl = (await question(`Base URL [${preset.baseUrl}]: `)).trim() || preset.baseUrl;
		modelName = (await question(`模型名 [${preset.defaultModel}]: `)).trim() || preset.defaultModel;
		api = preset.api;
		if (preset.note) {
			apiKey = "local";
		} else {
			apiKeyEnv = preset.apiKeyEnv;
			apiKey = `$${apiKeyEnv}`;
		}
		console.log(`✅ 使用预设: ${preset.label}`);
	} else {
		providerName = (await question("Provider 名称（如 my-endpoint）: ")).trim() || "custom";
		baseUrl = (await question("Base URL: ")).trim();
		api = (await question(`API 格式 [openai-completions]: `)).trim() || "openai-completions";
		modelName = (await question("模型名: ")).trim();
		apiKeyEnv = (await question(`API Key 环境变量名 [${providerName.toUpperCase()}_API_KEY]: `)).trim() ||
			`${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		// 写 $VAR 引用而不是明文 key：文件可以进版本库，密钥留在环境里
		apiKey = `$${apiKeyEnv}`;
	}

	if (!baseUrl || !modelName) {
		console.log("\nBase URL 和模型名不能空，什么都没写。");
		process.exit(1);
	}

	const modelsPath = path.join(lyuAgentDir(), "models.json");
	const models = readModelsFile(modelsPath);
	const existed = Object.hasOwn(models.providers ?? {}, providerName);
	(models.providers as Record<string, unknown>)[providerName] = {
		baseUrl,
		api,
		apiKey,
		models: [{ id: modelName }],
	};

	fs.mkdirSync(lyuAgentDir(), { recursive: true });
	fs.writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
	console.log(
		`${existed ? "✅ 已更新" : "✅ 已写入"} ${modelsPath}` +
			(existed ? `（${providerName} 原来就有，已替换这一项，其它 provider 没动）` : ""),
	);

	// ── 2. AGENTS.md ──────────────────────────────────────────

	console.log("");
	const agentsPath = path.join(cwd, "AGENTS.md");
	if (fs.existsSync(agentsPath)) {
		console.log("✓ AGENTS.md 已存在，不动它");
	} else {
		fs.writeFileSync(
			agentsPath,
			`# AGENTS.md\n\n## 项目指引\n\n<!-- 在这里写你的项目约定，Lyu 每次会话都会读 -->\n<!-- 例如：语言、框架、测试命令、代码风格、不要碰的目录 -->\n`,
		);
		console.log("✅ 创建 AGENTS.md");
	}

	// ── 收尾 ──────────────────────────────────────────────────

	console.log("");
	console.log("━━━━━━━━━━━━━━━━━━━━━━");
	console.log("🎉 好了");
	console.log("");
	console.log(`  端点:   ${providerName} (${api})`);
	console.log(`  URL:    ${baseUrl}`);
	console.log(`  模型:   ${modelName}`);
	console.log("");
	console.log("下一步:");
	let step = 1;
	if (apiKeyEnv) console.log(`  ${step++}. export ${apiKeyEnv}=<你的 key>`);
	else console.log(`  ${step++}. 本地端点，不用设 key（要校验就自己 export 一个）`);
	console.log(`  ${step++}. lyu --list-models     # 应该能看到 ${modelName}`);
	console.log(`  ${step++}. lyu                 # 起来后 /model 选它`);

	rl.close();
}

main().catch((err) => {
	console.error("\n初始化失败:", err instanceof Error ? err.message : err);
	rl.close();
	process.exit(1);
});
