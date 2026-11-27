#!/usr/bin/env node
/**
 * 品牌自检：数清楚 dist 里还剩多少上游身份，并且只承认一个基线。
 *
 * 为什么要有这一步：补丁表能保证「该改的改到了」，但保证不了「上游没有偷偷多加一处」。
 * 升级 vendored 版本时，上游完全可能新增第二个 pi.dev 调用点，而补丁照样全绿 ——
 * 那种情况下装出去的产品会一边说自己叫 lyu、一边往别人家报数据。
 *
 * 判据分两层：
 *   1. 必须为零的串（MUST_BE_ZERO）：我们明确替换掉的出口。不为零 = 补丁漏了。
 *   2. 有基线的串：数量必须与基线一致，动了就要人说一句。
 *      变多 = 上游新增了耦合（要评估）；变少 = 我们的补丁生效了（可以 --update）。
 *
 * 用法：
 *   node scripts/brand-check.mjs            # 比对基线，不一致就退 1
 *   node scripts/brand-check.mjs --update   # 重写基线（改动必须是有意的）
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const baselinePath = join(root, "scripts", "brand-baseline.json");
const update = process.argv.includes("--update");

if (!existsSync(distDir)) {
	console.error("[brand] 没有 dist/，先跑 vendor");
	process.exit(1);
}

/** 我们替换掉的出站地址。这些一个都不许再出现。 */
const MUST_BE_ZERO = [
	"https://pi.dev/api/latest-version",
	"https://pi.dev/changelog",
	'"Download from: https://github.com/earendil-works/pi/releases/latest"',
];

/** 有基线、允许存在但数量不许乱动的串 —— 它们代表"这块还不是我们的"。 */
const TRACKED = [
	"pi.dev",
	"earendil-works",
	"pi-coding-agent",
	"pi-mono",
	"PI_",
	"Welcome back",
];

const files = readdirSync(distDir, { recursive: true }).filter((f) => typeof f === "string" && /\.(js|md|json)$/.test(f));
const texts = files.map((rel) => [rel, readFileSync(join(distDir, rel), "utf8")]);

const counts = {};
const where = {};
for (const token of TRACKED) {
	counts[token] = 0;
}
for (const [rel, text] of texts) {
	for (const token of TRACKED) {
		const n = text.split(token).length - 1;
		if (n > 0) {
			counts[token] += n;
			(where[token] ??= []).push(`${rel}×${n}`);
		}
	}
}

const violations = [];
for (const needle of MUST_BE_ZERO) {
	const total = texts.reduce((sum, [, text]) => sum + text.split(needle).length - 1, 0);
	if (total > 0) violations.push(`必须为零却出现 ${total} 次：${needle}`);
}

if (update) {
	writeFileSync(baselinePath, `${JSON.stringify(counts, null, "\t")}\n`);
	console.log(`[brand] 基线已更新 → scripts/brand-baseline.json`);
	for (const [token, n] of Object.entries(counts)) console.log(`[brand]   ${token}: ${n}`);
	process.exit(violations.length > 0 ? 1 : 0);
}

if (!existsSync(baselinePath)) {
	console.error("[brand] 没有基线文件。先跑 node scripts/brand-check.mjs --update 并把结果提交");
	process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const drift = [];
for (const token of TRACKED) {
	const now = counts[token] ?? 0;
	const was = baseline[token] ?? 0;
	if (now !== was) drift.push(`  ${token}: 基线 ${was} → 现在 ${now}${now > was ? "（上游新增了耦合，要评估）" : "（我们的补丁生效了，可 --update）"}`);
}

for (const v of violations) console.error(`[brand] ✗ ${v}`);
for (const d of drift) console.error(`[brand] ✗ ${d}`);

if (violations.length > 0 || drift.length > 0) {
	console.error("[brand] 基线里的分布（供定位）：");
	for (const [token, list] of Object.entries(where)) {
		if (list.length === 0) continue;
		console.error(`  ${token}:`);
		for (const item of list) console.error(`    ${item}`);
	}
	console.error("[brand] 中止：要么补上补丁，要么确认改动是有意的再 --update。");
	process.exit(1);
}

console.log(
	`[brand] 通过。仍带上游身份的串：${TRACKED.map((t) => `${t}=${counts[t]}`).join(" ")}（数字见 scripts/brand-baseline.json）`,
);
