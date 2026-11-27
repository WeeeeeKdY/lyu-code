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
 * 补丁分两类，判据不同，别混着用：
 *
 *   kind: "brand" —— 换品牌。铁律是「绝不硬编成 Lyu」：只许把写死的 pi 换成从
 *     APP_NAME 派生，APP_NAME = "pi" 时结果必须与上游逐字节等价。做不到等价的，
 *     不属于这一类。
 *
 *   kind: "policy" —— 换行为：发布源、遥测、外链。这一类天生做不到与上游等价
 *     （上游就是要往 pi.dev 报，我们就是要不报），所以判据换成：
 *       1) 每条都带环境变量出口，用户能改回去（LYU_*_URL）；
 *       2) 必须在 NOTICE.md 里列出来，写清改了什么、为什么；
 *       3) 必须有 expect 计数，命中数不对就中止 —— 上游多一处或少一处都要当场发现。
 *
 * 两类共同的铁律：补丁打不上就中止。命中 0 等于没打，装上去的东西会静默说谎 ——
 * 那比装不上更糟。命中数少于预期更糟：那意味着同一个常量的另一份副本没被改到。
 */

/**
 * 生成"把 APP_NAME 首字母大写"的 dist 源码片段。
 *
 * 为什么要在补丁里拼这段代码：APP_NAME 是 "lyu"（小写，命令行名要小写），
 * 所以品牌名出现在句首时必须自己大写 —— 否则横幅下面会印出「lyu can explain…」。
 * 字标处上游本来就是 charAt(0).toUpperCase()，这里保持一致。
 */
const CAP_NAME = "${APP_NAME.charAt(0).toUpperCase()}${APP_NAME.slice(1)}";

/** 把一句自我介绍里的两处品牌名换成大写品牌名。 */
const capitalizeBrand = (sentence) => `\`${sentence.replaceAll("Pi", CAP_NAME)}\``;

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
		kind: "brand",
		why: "横幅下面那句自我介绍里点了两次 Pi。两份副本的引号形态不同：未压缩版是模板串，bundle 里是双引号字面量 —— 所以必须连引号一起换成模板串，否则 ${APP_NAME} 不会被求值，界面上会原样出现七个字符",
		patches: [
			{
				only: "modes/interactive/interactive-mode.js",
				find: "`Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`",
				replace: capitalizeBrand("Pi can explain its own features and look up its docs. Ask it how to use or extend Pi."),
				required: true,
				expect: 1,
			},
			{
				only: "bundle/chunks/",
				find: '"Pi can explain its own features and look up its docs. Ask it how to use or extend Pi."',
				replace: capitalizeBrand("Pi can explain its own features and look up its docs. Ask it how to use or extend Pi."),
				required: true,
				expect: 1,
			},
		],
	},
	{
		id: "release-channel",
		kind: "policy",
		why: "版本检查 / lyu update 的发布源。上游指 pi.dev，跟着跑会把上游 pi 装回来；改成我们自己的 npm 包 —— 装不装得上由我们的发布决定，不再是上游的发布决定",
		patches: [
			{
				find: '"https://pi.dev/api/latest-version"',
				replace: '(process.env.LYU_LATEST_VERSION_URL || "https://registry.npmjs.org/lyu-code/latest")',
				required: true,
				expect: 2,
			},
		],
	},
	{
		id: "install-telemetry-removed",
		kind: "policy",
		why: "启动时往 pi.dev/api/report-install 报一条安装记录。我们不需要安装量数据，也没有理由替上游收集 —— 直接摘掉，不是改成默认关（默认关还能被 PI_TELEMETRY=1 打开）",
		patches: [
			{
				only: "modes/interactive/interactive-mode.js",
				find: "    reportInstallTelemetry(version) {\n        if (process.env.PI_OFFLINE) {",
				replace: "    reportInstallTelemetry(version) {\n        return; // lyu: 安装遥测已移除，见 NOTICE.md\n        if (process.env.PI_OFFLINE) {",
				required: true,
				expect: 1,
			},
			{
				only: "bundle/chunks/",
				find: "reportInstallTelemetry(version2){process.env.PI_OFFLINE||",
				replace: "reportInstallTelemetry(version2){return;process.env.PI_OFFLINE||",
				required: true,
				expect: 1,
			},
		],
	},
	{
		id: "changelog-url",
		kind: "policy",
		why: "「有新版本」提示里的 Changelog 链接指向 pi.dev（我们发了版，那里不会有我们的更新日志）",
		patches: [
			{
				find: '"https://pi.dev/changelog"',
				replace: '(process.env.LYU_CHANGELOG_URL || "https://github.com/WeeeeeKdY/lyu-code/releases")',
				required: true,
				expect: 2,
			},
		],
	},
	{
		id: "installer-command-hint",
		kind: "policy",
		why: "「你这个 npm 装法不受支持，改用官方安装脚本」的提示，给的命令是 curl https://pi.dev/install.sh | sh —— 用户照着做就把上游 pi 装回来了。这是全表里唯一一条会诱导用户装错东西的补丁",
		patches: [
			{
				only: "package-manager-cli.js",
				find:
					'process.platform === "win32"\n                            ? \'powershell -c "irm https://pi.dev/install.ps1 | iex"\'\n' +
					'                            : "curl -fsSL https://pi.dev/install.sh | sh"',
				replace: '"https://github.com/WeeeeeKdY/lyu-code#install"',
				required: true,
				expect: 1,
			},
			{
				only: "bundle/chunks/",
				find:
					'process.platform==="win32"?\'powershell -c "irm https://pi.dev/install.ps1 | iex"\'' +
					':"curl -fsSL https://pi.dev/install.sh | sh"',
				replace: '"https://github.com/WeeeeeKdY/lyu-code#install"',
				required: true,
				expect: 1,
			},
		],
	},
	{
		id: "download-hint-url",
		kind: "policy",
		why: "装不上更新时给的『去这里下载』指向上游 pi 的 releases —— 照做就把 pi 装回来了",
		patches: [
			{
				// config.js 里本来就在模板串里，直接插值即可
				only: "config.js",
				find: "`Download from: https://github.com/earendil-works/pi/releases/latest`",
				replace: "`Download from: ${process.env.LYU_DOWNLOAD_URL || \"https://github.com/WeeeeeKdY/lyu-code/releases/latest\"}`",
				required: true,
				expect: 1,
			},
			{
				// bundle 里是双引号字面量，必须连引号一起换成模板串，否则插值不会求值
				only: "bundle/chunks/",
				find: '"Download from: https://github.com/earendil-works/pi/releases/latest"',
				replace: "`Download from: ${process.env.LYU_DOWNLOAD_URL || \"https://github.com/WeeeeeKdY/lyu-code/releases/latest\"}`",
				required: true,
				expect: 1,
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

	// 命中数必须与 expect 一致。少了意味着同一常量的另一份副本没被改到 ——
	// 引擎照跑，但有一部分行为还指着上游，这种"半个补丁"最难查，所以直接拦下。
	const miscount = all.filter(({ patch }) => patch.expect !== undefined && (hits.get(patch) ?? 0) !== patch.expect);
	if (miscount.length > 0) {
		for (const { entry, patch } of miscount) {
			console.error(`[vendor] 补丁 ${entry.id} 命中 ${hits.get(patch) ?? 0} 次，预期 ${patch.expect} 次：${entry.why}`);
		}
		console.error("[vendor] 中止：全改或全不改，不许只改一半。");
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

	// 品牌自检：把"还剩多少不是我们的"变成一个可测数字，而不是靠 grep 猜。
	execFileSync(process.execPath, [join(root, "scripts", "brand-check.mjs")], { stdio: "inherit" });

	console.log(`[vendor] 完成 → dist/ (${version})`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
