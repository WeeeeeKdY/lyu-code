/**
 * 子代理：把一段独立任务丢给另一个 pi 进程，只把结论拿回来。
 *
 * 为什么需要：pi 是单会话串行的。一个长任务（读 20 个文件、跑一轮改查）会把主会话
 * 的上下文撑爆，压缩之后细节就没了。子代理把「过程」留在它自己那里，主会话只收
 * 摘要 —— 这是上下文隔离，不是并行炫技。
 *
 * 关键实现约束（都是踩过的坑）：
 *   - **prompt 走 argv，不走 stdin**：曾因为 execFile 传 stdin 死等而误判为「模型不响应」。
 *   - **必须 `--no-session`**：否则子代理会污染会话目录，`--resume` 列表里全是垃圾。
 *   - **必须 `--no-extensions` 再显式加回需要的**：继承全部扩展会让子代理也跑记忆注入、
 *     门禁、plannotator，行为和成本都不可控。
 *   - **硬超时**：子进程必须有超时，否则一个卡住的子代理会挂住整个工具调用。
 *   - **防递归**：用 PI_SUBAGENT_DEPTH 限制层数，否则 agent 能自己叫自己直到爆内存。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

export interface SubagentOptions {
	prompt: string;
	/** 覆盖模型，留空沿用子进程默认 */
	model?: string;
	/** 超时毫秒数 */
	timeoutMs?: number;
	/** 工作目录 */
	cwd?: string;
	/** 额外要加载的扩展路径 */
	extensions?: string[];
	/** 关掉全部工具（只让模型纯推理） */
	noTools?: boolean;
}

export interface SubagentResult {
	ok: boolean;
	text: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	error?: string;
}

export const MAX_DEPTH = 2;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function depth(): number {
	const value = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	return Number.isFinite(value) ? value : 0;
}

/** 组装子进程参数。单独抽出来是为了能单测（不真起进程）。 */
export function buildArgs(options: SubagentOptions): string[] {
	const args = ["--print", "--no-session", "--no-extensions"];
	if (options.noTools) args.push("--no-tools");
	if (options.model) args.push("--model", options.model);
	for (const extension of options.extensions ?? []) args.push("--extension", extension);
	args.push(options.prompt);
	return args;
}

export function piBinary(): string {
	return process.env.PI_SUBAGENT_BIN ?? "pi";
}

/**
 * 默认带上 guard：子代理比主会话更该有门禁，它没人盯着。
 *
 * guard 的位置按「本文件在哪」推，而不是写死某个仓库路径 —— 这样扩展装在
 * `~/.pi/agent/extensions/` 还是 `~/.lyu/agent/extensions/` 都找得到。
 */
export function defaultExtensions(): string[] {
	if (process.env.PI_GUARD_MODE === "off") return [];
	const guard = new URL("../../extensions/guard.ts", import.meta.url).pathname;
	return [guard];
}

export async function runSubagent(options: SubagentOptions): Promise<SubagentResult> {
	const started = Date.now();
	if (depth() >= MAX_DEPTH) {
		return {
			ok: false,
			text: "",
			exitCode: null,
			timedOut: false,
			durationMs: 0,
			error: `子代理嵌套层数已达上限 ${MAX_DEPTH}，拒绝继续派生。请直接在主会话里做。`,
		};
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const args = buildArgs(options);

	return await new Promise<SubagentResult>((resolve) => {
		const child = spawn(piBinary(), args, {
			cwd: options.cwd,
			env: {
				...process.env,
				PI_SUBAGENT_DEPTH: String(depth() + 1),
				// 子代理不重复注入记忆，也不弹批注页
				PI_MEMORY_MODE: "off",
				PI_ANNOTATE_DISABLE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref?.();

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				text: "",
				exitCode: null,
				timedOut,
				durationMs: Date.now() - started,
				error: err.message,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			const text = stdout.trim();
			resolve({
				ok: code === 0 && !timedOut && text.length > 0,
				text,
				exitCode: code,
				timedOut,
				durationMs: Date.now() - started,
				error: timedOut
					? `超时 ${timeoutMs}ms，已杀掉子进程`
					: code !== 0
						? `退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 300)}` : ""}`
						: undefined,
			});
		});
	});
}
