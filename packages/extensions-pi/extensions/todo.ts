/**
 * todo 工具：让 agent 把计划显式写出来，并在每轮开始时看到自己的进度。
 *
 * 借鉴 `@zhushanwen/pi-todo` 两条硬教训：
 *  1. **schema 必须扁平 `Type.Object`**，`action` 用字面量而不是顶层 union。
 *     顶层 union 会被严格的 OpenAI 兼容网关 400 拒掉**整个会话**。
 *  2. 必填项在 handler 里手工校验，别指望 schema 的 required 一定被网关尊重。
 *
 * 状态只放内存 + 一个插件作用域的 Map：todo 是「本轮工作的脚手架」，
 * 跨会话恢复它意义不大（真需要跨会话的东西应该写进记忆）。
 */

import { Type } from "typebox";

type Status = "pending" | "in_progress" | "done";

interface Todo {
	id: number;
	text: string;
	status: Status;
}

const ICON: Record<Status, string> = { pending: "○", in_progress: "◐", done: "●" };

export default function todoExtension(pi: any) {
	let todos: Todo[] = [];
	let nextId = 1;

	const summary = (): string => {
		if (todos.length === 0) return "";
		const done = todos.filter((t) => t.status === "done").length;
		return `${done}/${todos.length} 完成`;
	};

	const render = (): string =>
		todos.map((t) => `${ICON[t.status]} ${t.id}. ${t.text}`).join("\n");

	const syncStatus = (ctx: any): void => {
		try {
			const text = summary();
			ctx?.ui?.setStatus?.("todo", text || undefined);
		} catch {
			/* 状态栏失败不影响功能 */
		}
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		todos = [];
		nextId = 1;
		syncStatus(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "任务清单",
		description: [
			"维护当前任务的分步计划。多步任务开工前先 add 出来，做完一步就 update 成 done。",
			"action=list 查看；add 新增（text 必填）；update 改状态（id + status 必填）；",
			"delete 删一条（id 必填）；clear 清空。",
		].join(" "),
		promptSnippet: "todo: 维护多步任务的分步计划",
		parameters: Type.Object({
			action: Type.String({ description: "list | add | update | delete | clear" }),
			text: Type.Optional(Type.String({ description: "add 时的任务描述" })),
			id: Type.Optional(Type.Number({ description: "update / delete 时的任务编号" })),
			status: Type.Optional(Type.String({ description: "pending | in_progress | done" })),
		}),
		async execute(
			_toolCallId: string,
			params: { action: string; text?: string; id?: number; status?: string },
			ctx?: any,
		) {
			const action = String(params?.action ?? "").trim();
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				isError: true,
			});

			if (action === "list") {
				return {
					content: [
						{
							type: "text",
							text:
								todos.length === 0
									? "清单是空的。多步任务建议先 add 出来。"
									: `${summary()}\n${render()}`,
						},
					],
				};
			}

			if (action === "add") {
				const text = String(params?.text ?? "").trim();
				if (!text) return fail("add 需要 text。");
				const todo: Todo = { id: nextId++, text, status: "pending" };
				todos.push(todo);
				syncStatus(ctx);
				return {
					content: [{ type: "text", text: `已添加 #${todo.id}：${todo.text}\n${summary()}` }],
				};
			}

			if (action === "update") {
				const id = Number(params?.id);
				if (!Number.isFinite(id)) return fail("update 需要 id。");
				const status = String(params?.status ?? "").trim() as Status;
				if (!["pending", "in_progress", "done"].includes(status)) {
					return fail("status 只能是 pending / in_progress / done。");
				}
				const todo = todos.find((t) => t.id === id);
				if (!todo) return fail(`没有 #${id}。先 action=list 看看。`);
				todo.status = status;
				syncStatus(ctx);
				return {
					content: [{ type: "text", text: `#${id} → ${status}\n${summary()}` }],
				};
			}

			if (action === "delete") {
				const id = Number(params?.id);
				if (!Number.isFinite(id)) return fail("delete 需要 id。");
				const before = todos.length;
				todos = todos.filter((t) => t.id !== id);
				if (todos.length === before) return fail(`没有 #${id}。`);
				syncStatus(ctx);
				return { content: [{ type: "text", text: `已删除 #${id}。\n${summary()}` }] };
			}

			if (action === "clear") {
				todos = [];
				syncStatus(ctx);
				return { content: [{ type: "text", text: "清单已清空。" }] };
			}

			return fail(`不认识的 action：${action}。可用 list / add / update / delete / clear。`);
		},
	});

	// 每轮开始把清单塞给模型：它自己写的计划，别指望它记得
	pi.on("before_agent_start", async () => {
		if (todos.length === 0) return;
		const undone = todos.filter((t) => t.status !== "done");
		if (undone.length === 0) return;
		return {
			message: {
				customType: "todo-context",
				content: `当前任务清单（${summary()}）：\n${render()}`,
				display: false,
			},
		};
	});
}
