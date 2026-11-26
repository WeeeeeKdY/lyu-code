#!/usr/bin/env node
/**
 * lyu 的启动器。
 *
 * 它只干一件事：让本机装着的扩展被引擎认知，然后把控制权交给引擎。
 * 引擎本身在 ../dist（随包发布），身份由 package.json 的 piConfig 决定 ——
 * 所以用户装完之后只有一个 `lyu` 命令，没有 `pi`。
 *
 * 为什么扩展要在启动时注册，而不是把 .ts 拷到 ~/.lyu/agent/extensions/：
 * 拷过去之后扩展就脱离了 node_modules，它 import 的第三方包（比如记忆系统要的
 * @huggingface/transformers）解析不到，会静默失效 —— 实测过，就是这个下场。
 * 注册成「包」之后，依赖从扩展包自己的 node_modules 解析，才是对的。
 *
 * 扩展不在本包里，在 @lyu/extensions 里（A-2 拆包）。为什么拆：引擎运行时依赖那 4 个
 * host 模块，而扩展被要求把它们写成 peerDependencies: "*"（否则会装出重复副本、绕过
 * 扩展加载器）。同一个 package.json 既当宿主又当扩展，必然冲突，引擎每次启动都会警告。
 *
 * 任何失败都不拦启动：注册不了也要让人能用，但要在 stderr 说一声，别装作没事。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveExtensionsPackage } from "./extensions-package.js";

function agentDir() {
	for (const key of ["LYU_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR"]) {
		if (process.env[key]) return process.env[key];
	}
	return join(homedir(), ".lyu", "agent");
}

function ensureRegistered(packageRoot) {
	const dir = agentDir();
	const file = join(dir, "settings.json");
	let settings = {};
	if (existsSync(file)) {
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch (err) {
			console.error(`[lyu] ${file} 不是合法 JSON，扩展包未注册：${err.message}`);
			return;
		}
	}
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const hit = packages.some((entry) =>
		typeof entry === "string"
			? resolve(dir, entry) === packageRoot
			: entry?.source && resolve(dir, entry.source) === packageRoot,
	);
	if (hit) return;
	try {
		settings.packages = [...packages, packageRoot];
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	} catch (err) {
		console.error(`[lyu] 无法注册扩展包到 ${file}：${err.message}`);
	}
}

const found = resolveExtensionsPackage();
if ("error" in found) {
	console.error(`[lyu] 找不到扩展包 @lyu/extensions：${found.error.message}`);
	console.error("[lyu] 引擎照常启动，但记忆/守卫/统计这些扩展不会有。重新 npm install 一次能修好。");
} else {
	ensureRegistered(found.root);
}

await import("../dist/bundle/cli.js");
