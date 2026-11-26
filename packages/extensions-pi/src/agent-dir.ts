/**
 * 配置目录解析。
 *
 * 同一个扩展要能在两个产品下跑：`pi`（配置在 `~/.pi/agent`）和 `lyu`
 * （配置在 `~/.lyu/agent`）。引擎自己是知道的 —— 它从 package.json 的
 * `piConfig.configDir` 派生 —— 但那个入口是虚拟模块，单测里 import 不到。
 *
 * 所以这里按优先级解析，任何一步失败都往下走，绝不抛：
 *   1. 显式环境变量（引擎也会读，所以设了就是权威）
 *   2. 文件系统里真实存在的那个（装了两个产品时优先 lyu）
 *   3. 默认 `~/.pi/agent`
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 引擎按 `${APP_NAME}_CODING_AGENT_DIR` 命名，两个产品的都认。 */
const ENV_KEYS = ["LYU_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR"];

let cached: string | null = null;

export function agentDir(): string {
	if (cached) return cached;

	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			cached = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
			return cached;
		}
	}

	const lyu = join(homedir(), ".lyu", "agent");
	if (existsSync(lyu)) {
		cached = lyu;
		return cached;
	}

	cached = join(homedir(), ".pi", "agent");
	return cached;
}

/** 单元测试用：清掉缓存，让下次调用重新探测。 */
export function resetAgentDirCache(): void {
	cached = null;
}

/**
 * lyu 自己该写配置的目录（用于 `lyu-init` 这类安装向导）。
 *
 * 与 `agentDir()` 只差一条：**不**回退到 `~/.pi/agent`。`agentDir()` 是给扩展用的，
 * 得跟着用户实际在跑的产品走；但安装向导写的东西必须落在本产品引擎真会读的位置，
 * 否则就是「写了但不生效」。没设环境变量时一律 `~/.lyu/agent`，不存在就建。
 */
export function lyuAgentDir(): string {
	for (const key of ["LYU_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
		const value = process.env[key];
		if (value) return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
	}
	return join(homedir(), ".lyu", "agent");
}

/** 配置目录下的某个文件，顺带保证目录存在。 */
export function agentPath(...segments: string[]): string {
	return join(agentDir(), ...segments);
}
