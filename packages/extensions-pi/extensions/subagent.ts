/**
 * spawn_subagent 工具：把独立任务外包给另一个 pi 进程。
 *
 * 什么时候该用：任务需要读很多文件、或会产出大量中间过程，但主会话只关心结论。
 * 什么时候不该用：需要和主会话共享上下文、需要连续多轮与你确认的任务。
 */

import { Type } from "typebox";
import { runSubagent, MAX_DEPTH, depth } from "../src/subagent/run.ts";

export default function subagentExtension(pi: any) {
	pi.registerTool({
		name: "spawn_subagent",
		label: "派子代理",
		description: [
			"把一个独立、自包含的任务交给子代理去做，只拿回结论，过程不占用当前上下文。",
			"适合：探索大量文件、独立调研、可以一次性说清的实现任务。",
			"不适合：需要跟我多轮确认、需要复用我已知上下文的任务。",
			`子代理是全新的 pi 进程，看不到本会话历史，提示词必须自包含。最多嵌套 ${MAX_DEPTH} 层。`,
		].join(" "),
		promptSnippet: "spawn_subagent: 把独立任务外包给子代理，只回收结论",
		parameters: Type.Object({
			prompt: Type.String({
				description: "给子代理的完整任务说明。它看不到当前会话，所有背景都要写清楚。",
			}),
			timeout_seconds: Type.Optional(
				Type.Number({ description: "超时秒数，默认 600，最大 3600" }),
			),
			model: Type.Optional(Type.String({ description: "指定子代理用的模型，留空沿用默认" })),
			no_tools: Type.Optional(
				Type.Boolean({ description: "true 表示不给子代理任何工具，只让它纯推理" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { prompt: string; timeout_seconds?: number; model?: string; no_tools?: boolean },
			ctx?: any,
		) {
			const prompt = String(params?.prompt ?? "").trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "没给任务说明，跳过。" }], isError: true };
			}

			const seconds = Math.min(Math.max(Number(params.timeout_seconds) || 600, 10), 3600);
			const result = await runSubagent({
				prompt,
				model: params.model,
				timeoutMs: seconds * 1000,
				cwd: ctx?.cwd,
				noTools: params.no_tools === true,
			});

			const header = [
				`子代理${result.ok ? "完成" : "失败"}`,
				`耗时 ${(result.durationMs / 1000).toFixed(1)}s`,
				`退出码 ${result.exitCode ?? "null"}`,
				result.error ? `错误：${result.error}` : "",
			]
				.filter(Boolean)
				.join(" · ");

			return {
				content: [
					{
						type: "text",
						text: `${header}\n\n${result.text || "（子代理没有输出）"}`,
					},
				],
				isError: !result.ok,
			};
		},
	});

	pi.registerCommand("subagent", {
		description: "子代理：/subagent <任务说明>",
		async handler(args: string, ctx: any) {
			const emit = (text: string): void => {
				const ui = ctx?.ui;
				if (typeof ui?.notify === "function") ui.notify(text);
				else if (typeof ui?.print === "function") ui.print(text);
				else console.log(text);
			};
			const prompt = String(args ?? "").trim();
			if (!prompt) {
				emit(`当前嵌套层数 ${depth()}/${MAX_DEPTH}。用法：/subagent <任务说明>`);
				return;
			}
			const result = await runSubagent({ prompt, cwd: ctx?.cwd });
			emit(`${result.ok ? "完成" : "失败"}（${(result.durationMs / 1000).toFixed(1)}s）\n\n${result.text || result.error || "（无输出）"}`);
		},
	});
}
