#!/usr/bin/env node
/**
 * 把 pi 引擎的 dist 拉进本包。
 *
 * 为什么要有这一步：我们要的是「装完 lyu 就是完整引擎」，不是壳。
 * 上游发布的 dist 是自包含的 bundle，把它放进我们自己的包里、配上我们自己的
 * package.json（name/bin/piConfig），引擎的身份、配置目录、命令名就全是 lyu 的，
 * 而且一行上游源码都不用改 —— 上游升级只要改 package.json 里的 vendor.piCLI。
 *
 * 用法：
 *   node scripts/vendor.mjs          # 已是指定版本就跳过
 *   node scripts/vendor.mjs --force  # 强制重取
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.vendor?.piCLI;

if (!version) {
	console.error("[vendor] package.json 里缺 vendor.piCLI，不知道该取哪个版本");
	process.exit(1);
}

const stampPath = join(root, "dist", ".vendor-version");
const forced = process.argv.includes("--force");
if (!forced && existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === version) {
	console.log(`[vendor] dist 已是 ${version}，跳过`);
	process.exit(0);
}

/**
 * dist 补丁表。
 *
 * 为什么要有补丁：引擎的身份（名字、配置目录、命令名）全部来自本包 package.json 的
 * piConfig，只有少数几处上游把 "pi" 直接写死在代码里。我们改这些地方，而不是改上游
 * 源码 —— 补丁点少、看得见、升级时对不上会立刻报错。
 *
 * 两条铁律：
 *   1. 绝不硬编成 "Lyu"。补丁只许把「写死的 pi」换成「从 APP_NAME 派生」，
 *      APP_NAME = "pi" 时结果必须与上游逐字节一致，否则就不是改品牌而是分叉。
 *   2. 补丁打不上就中止。命中 0 等于没打，装上去的东西会静默说谎 —— 那比装不上更糟。
 */
const PATCHES = [
	{
		id: "header-wordmark",
		why: "TUI 横幅的字标（Apple Terminal 走文字兜底时显示的那行 `Pi v0.2.0`）上游把 P 和 i 写死了",
		patches: [
			{
				// 真正跑的那份：dist/bundle 里压缩过的 chunk
				only: "bundle/chunks/",
				find:
					"function piWordmark(){let mode=theme.getColorMode();" +
					"return`${foregroundAnsi(CORAL,mode)}P${RESET}${foregroundAnsi(YELLOW,mode)}i${RESET}`}",
				replace:
					"function piWordmark(){let mode=theme.getColorMode(),name=APP_NAME||\"pi\";" +
					"return`${foregroundAnsi(CORAL,mode)}${name.charAt(0).toUpperCase()}${RESET}" +
					"${foregroundAnsi(YELLOW,mode)}${name.slice(1)}${RESET}`}",
				required: true,
			},
			{
				// 同一个模块未压缩的副本。当前 bundle 不引用它，但不能在包里留一份会说谎的代码。
				// 必须钉在单个文件上：同样的 import 行每个 component 都有一份，放开就会注到 27 个文件里。
				only: "modes/interactive/components/pi-logo.js",
				find: 'import { theme } from "../theme/theme.js";',
				replace: 'import { theme } from "../theme/theme.js";\nimport { APP_NAME } from "../../../config.js";',
			},
			{
				only: "modes/interactive/components/pi-logo.js",
				find: '    return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;',
				replace:
					'    const name = APP_NAME || "pi";\n' +
					"    return `${foregroundAnsi(CORAL, mode)}${name.charAt(0).toUpperCase()}${RESET}" +
					"${foregroundAnsi(YELLOW, mode)}${name.slice(1)}${RESET}`;",
			},
		],
	},
	{
		id: "header-hint-copy",
		why: "横幅下面那句自我介绍里点了两次 Pi",
		patches: [
			{
				find: "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
				replace: "Lyu can explain its own features and look up its docs. Ask it how to use or extend Lyu.",
				required: true,
			},
		],
	},
];

/** 把补丁表打到 dist 上。先全量核对命中数，全绿了才落盘 —— 不许写出半打补丁的树。 */
function applyPatches(distDir) {
	const files = readdirSync(distDir, { recursive: true }).filter((f) => typeof f === "string" && f.endsWith(".js"));

	const edits = new Map(); // file → 打完补丁的文本
	const hits = new Map(); // patch → 命中数

	for (const rel of files) {
		const file = join(distDir, rel);
		let text = readFileSync(file, "utf8");
		let touched = false;
		for (const entry of PATCHES) {
			for (const patch of entry.patches) {
				if (patch.only && !rel.includes(patch.only)) continue;
				const found = text.split(patch.find).length - 1;
				if (found === 0) continue;
				text = text.split(patch.find).join(patch.replace);
				hits.set(patch, (hits.get(patch) ?? 0) + found);
				touched = true;
				console.log(`[vendor] 补丁 ${entry.id} → ${rel} ×${found}`);
			}
		}
		if (touched) edits.set(file, text);
	}

	const all = PATCHES.flatMap((entry) => entry.patches.map((patch) => ({ entry, patch })));
	const fatal = all.filter(({ patch }) => patch.required && !hits.has(patch));
	if (fatal.length > 0) {
		for (const { entry } of fatal) {
			console.error(`[vendor] 补丁 ${entry.id} 没命中：${entry.why}`);
		}
		console.error("[vendor] 上游可能改了这段代码。去 dist 里找到原文，更新 scripts/vendor.mjs 的 PATCHES 再重来。");
		console.error("[vendor] 中止：带着没打上的补丁发出去，等于装了个会说谎的引擎。");
		process.exit(1);
	}

	// 非必需的补丁（包里未被引用的副本）漏了不拦发布，但要说一声，别让人以为打上了。
	for (const { entry, patch } of all) {
		if (!hits.has(patch)) console.warn(`[vendor] 警告：补丁 ${entry.id} 有一处没命中（${entry.why}），那份副本可能已经不在了`);
	}

	for (const [file, text] of edits) writeFileSync(file, text);

	// 补丁是字符串替换，能拼出语法错的代码（已经栽过一次：往 27 个文件里注了重复的 import）。
	// 落盘后逐个过一遍语法，错了就中止，别等用户启动时才发现。
	for (const file of edits.keys()) {
		try {
			execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
		} catch (err) {
			console.error(`[vendor] 补丁把 ${file} 改出了语法错误：\n${err.stderr?.toString() ?? err.message}`);
			console.error("[vendor] 中止：装出去的东西必须是能跑的。");
			process.exit(1);
		}
	}
}

const tmp = mkdtempSync(join(tmpdir(), "lyu-vendor-"));
try {
	const spec = `@earendil-works/pi-coding-agent@${version}`;
	console.log(`[vendor] 取 ${spec}`);
	execFileSync("npm", ["pack", spec, "--pack-destination", tmp, "--silent"], { stdio: "inherit" });

	const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
	if (!tgz) {
		console.error("[vendor] npm pack 没产出 tgz");
		process.exit(1);
	}
	execFileSync("tar", ["xzf", join(tmp, tgz), "-C", tmp], { stdio: "inherit" });

	const src = join(tmp, "package");
	const srcDist = join(src, "dist");
	if (!existsSync(srcDist)) {
		console.error("[vendor] 包内没有 dist/，上游结构变了，需要看代码");
		process.exit(1);
	}

	rmSync(join(root, "dist"), { recursive: true, force: true });
	cpSync(srcDist, join(root, "dist"), { recursive: true });

	// 用户可见文案换成我们自己的名字：只换整句，绝不碰标识符
	applyPatches(join(root, "dist"));

	// 引擎运行时会读 docs/ 和 schemas/（getDocsPath / getExamplesPath）
	for (const extra of ["docs", "schemas"]) {
		const from = join(src, extra);
		if (existsSync(from)) {
			rmSync(join(root, extra), { recursive: true, force: true });
			cpSync(from, join(root, extra), { recursive: true });
		}
	}

	writeFileSync(stampPath, `${version}\n`);
	console.log(`[vendor] 完成 → dist/ (${version})`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
