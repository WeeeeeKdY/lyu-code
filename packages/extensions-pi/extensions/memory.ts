/**
 * pi 记忆系统扩展。
 *
 * 设计取舍（详见 docs/memory-system-todo.md）：
 *   - 会话结束落一条 + `remember` 显式记 + 纯 embedding 检索注入。
 *   - 不做常驻 observer（claude-mem 每个工具调用跑一遍模型，贵到要开订阅）。
 *   - 不做向量库（2000 条暴力余弦 1ms）。
 *   - 任何环节失败都静默降级，绝不打断会话。
 *
 * 注入用 `message` 而不是改 systemPrompt：systemPrompt 一变，KV 缓存前缀全失效，
 * 每轮多花一次完整 prefill 的钱。往对话尾部追加消息不破坏前缀缓存。
 */

import { Type } from "typebox";
import { captureFromMessages, makeNote } from "../src/memory/capture.ts";
import { describeEmbedderProblem, embed, embedMany, isEmbedderReady, readyWithin, warmup } from "../src/memory/embed.ts";
import { formatHitsForHuman, formatMemoryBlock } from "../src/memory/format.ts";
import { keywordSearch, searchMemory, type Hit } from "../src/memory/search.ts";
import { appendRecord, loadStore, projectKey } from "../src/memory/store.ts";
import type { MemoryRecord } from "../src/memory/types.ts";

/** 会话空闲多久后落盘。太短会把中间态也记下来，太长进程被杀就丢了。 */
const CAPTURE_DEBOUNCE_MS = 20_000;
/** 首轮等嵌入器加载的上限。缓存命中约 250ms。 */
const WAIT_FOR_EMBEDDER_MS = 600;
/** 子代理会带 PI_MEMORY_MODE=off：它们不该重复注入记忆，也不该写记忆。 */
const DISABLED = process.env.PI_MEMORY_MODE === "off";

/** 因为嵌入器不可用而没存下来的条数。用来在 /memory 里说真话。 */
let skippedWrites = 0;

interface SessionState {
	sessionId?: string;
	cwd: string;
	project: string;
	/** 本会话已注入的 id，避免同一轮反复推同一条 */
	injected: Set<string>;
	/** 最近一次 agent_end 的完整消息，落盘时用 */
	lastMessages: unknown[];
	lastPrompt: string;
	captureTimer: ReturnType<typeof setTimeout> | undefined;
	captured: boolean;
	/** 本会话是否已经报过「嵌入器坏了」，避免每轮都弹一次 */
	embedderWarned: boolean;
}

function logError(where: string, err: unknown): void {
	// 只在显式调试时出声，正常运行一声不吭
	if (process.env.PI_MEMORY_DEBUG !== "1") return;
	console.error(`[memory] ${where}: ${err instanceof Error ? err.message : String(err)}`);
}

/** 写一条记忆：嵌入 + 落盘。全程 try/catch，失败就只是「没记住」。 */
async function persist(record: MemoryRecord | null): Promise<boolean> {
	if (!record) return false;
	if (process.env.PI_MEMORY_MODE === "off") return false;
	try {
		const vector = await embed(`${record.title}\n${record.text}`);
		if (!vector) {
			// 没向量就是没存下来——计数，不要装作记住了
			skippedWrites++;
			return false;
		}
		const result = appendRecord(record, vector);
		return result.ok;
	} catch (err) {
		logError("persist", err);
		return false;
	}
}

export default function memoryExtension(pi: any) {
	const state: SessionState = {
		cwd: process.cwd(),
		project: projectKey(process.cwd()),
		injected: new Set(),
		lastMessages: [],
		lastPrompt: "",
		captureTimer: undefined,
		captured: false,
		embedderWarned: false,
	};

	/**
	 * 嵌入器坏了就吭一声——整个会话只吭一次。
	 *
	 * 这里只能 notify，不能抛：记忆是增强功能，它坏了不能让会话停下来。
	 * 但也不能一声不响：静默降级等于骗人。
	 */
	const warnIfBroken = (ctx: any): void => {
		if (DISABLED || state.embedderWarned) return;
		const reason = describeEmbedderProblem();
		if (!reason) return;
		state.embedderWarned = true;
		try {
			ctx?.ui?.notify?.(`记忆检索不可用：${reason}（本次会话不注入记忆，/memory 看详情）`, "warning");
		} catch {
			// notify 本身失败也不能影响会话
		}
		if (process.env.PI_MEMORY_DEBUG === "1") console.error(`[memory] 嵌入器不可用：${reason}`);
	};

	const flushCapture = async (): Promise<void> => {
		if (DISABLED) return;
		if (state.captured) return;
		state.captured = true;
		if (state.captureTimer) {
			clearTimeout(state.captureTimer);
			state.captureTimer = undefined;
		}
		try {
			if (state.lastMessages.length === 0) return;
			const record = captureFromMessages(state.lastMessages as any[], {
				cwd: state.cwd,
				sessionId: state.sessionId,
				kind: "session",
			});
			await persist(record);
		} catch (err) {
			logError("flushCapture", err);
		}
	};

	pi.on("session_start", async (event: any, ctx: any) => {
		try {
			state.cwd = ctx?.cwd ?? process.cwd();
			state.project = projectKey(state.cwd);
			state.sessionId = ctx?.sessionManager?.getSessionId?.() ?? undefined;
			state.injected.clear();
			state.lastMessages = [];
			state.captured = false;
			state.embedderWarned = false;
			// 后台预热嵌入器，别挡住会话启动
			warmup();
		} catch (err) {
			logError("session_start", err);
		}
	});

	pi.on("agent_end", async (event: any) => {
		try {
			// event.messages 是当前分支的完整消息，直接覆盖而不是追加（否则会重复累积）
			if (Array.isArray(event?.messages)) state.lastMessages = event.messages;
			state.captured = false;
			if (state.captureTimer) clearTimeout(state.captureTimer);
			state.captureTimer = setTimeout(() => {
				void flushCapture();
			}, CAPTURE_DEBOUNCE_MS);
			// 定时器不该拽着进程不让退
			state.captureTimer?.unref?.();
		} catch (err) {
			logError("agent_end", err);
		}
	});

	// 压缩点也是记忆点：压缩完细节就没了，先落一份
	pi.on("session_compact", async () => {
		try {
			await flushCapture();
		} catch (err) {
			logError("session_compact", err);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			await flushCapture();
		} catch (err) {
			logError("session_shutdown", err);
		}
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		try {
			const prompt = String(event?.prompt ?? "").trim();
			state.lastPrompt = prompt;
			if (DISABLED || !prompt) return;
			// 嵌入器没准备好就先短等一小会儿（有界，不阻塞），还不行就跳过这一轮
			if (!isEmbedderReady() && !(await readyWithin(WAIT_FOR_EMBEDDER_MS))) {
				warmup();
				warnIfBroken(ctx);
				return;
			}
			const store = loadStore();
			if (store.records.length === 0) return;

			const queryVector = await embed(prompt.slice(0, 2000));
			let hits: Hit[] = [];
			if (queryVector && store.dim === queryVector.length) {
				hits = searchMemory(store, queryVector, {
					project: state.project,
					excludeIds: state.injected,
					queryText: prompt,
				});
			}
			if (hits.length === 0) {
				// 向量不可用时退化为关键词，至少别装作不认识
				hits = keywordSearch(store, prompt, { excludeIds: state.injected, limit: 3 });
			}
			if (hits.length === 0) return;

			const block = formatMemoryBlock(hits);
			if (!block) return;
			if (process.env.PI_MEMORY_DEBUG === "1") {
				// 只算长度不算内容：内容可能含敏感词，不该落日志
				console.error(
					`[memory] 注入 ${hits.length} 条 / ${block.length} 字符：${hits.map((h) => h.score.toFixed(2)).join(",")}`,
				);
				console.error(block);
			}
			for (const hit of hits) state.injected.add(hit.record.id);
			return {
				message: {
					customType: "memory-context",
					content: block,
					display: false,
				},
			};
		} catch (err) {
			logError("before_agent_start", err);
			return;
		}
	});

	pi.registerTool({
		name: "remember",
		label: "记住",
		description:
			"把值得跨会话保留的信息写进长期记忆（用户偏好、项目约定、踩过的坑、做出的决定）。只在确实该记住时调用，不要记流水账。",
		promptSnippet: "remember: 写一条跨会话的长期记忆",
		parameters: Type.Object({
			text: Type.String({ description: "要记住的内容，写成未来能独立看懂的完整句子" }),
			title: Type.Optional(Type.String({ description: "一行标题，留空则截取正文" })),
			kind: Type.Optional(
				Type.String({ description: "类型：note / decision / pitfall，默认 note" }),
			),
		}),
		async execute(_toolCallId: string, params: { text: string; title?: string; kind?: string }) {
			const text = String(params?.text ?? "").trim();
			if (!text) {
				return { content: [{ type: "text", text: "没写内容，跳过。" }], isError: true };
			}
			const kind =
				params.kind === "decision" || params.kind === "pitfall" ? params.kind : "note";
			const record = makeNote(text, {
				cwd: state.cwd,
				sessionId: state.sessionId,
				title: params.title,
				kind,
			});
			const ok = await persist(record);
			return {
				content: [
					{
						type: "text",
						text: ok
							? `已记住：${record?.title ?? text.slice(0, 60)}`
							: "记忆没写成功（嵌入模型不可用或重复内容），不影响当前会话。",
					},
				],
				isError: !ok,
			};
		},
	});

	pi.registerCommand("memory", {
		description: "记忆：/memory [stats|list|search <词>|add <内容>]",
		async handler(args: string, ctx: any) {
			const emit = (text: string): void => {
				const ui = ctx?.ui;
				if (typeof ui?.notify === "function") ui.notify(text);
				else if (typeof ui?.print === "function") ui.print(text);
				else console.log(text);
			};
			try {
				const input = String(args ?? "").trim();
				const [verb, ...rest] = input.split(/\s+/);
				const tail = rest.join(" ").trim();
				const store = loadStore();

				if (!verb || verb === "stats") {
					const ready = isEmbedderReady();
					const problem = describeEmbedderProblem();
					const embedderLine = ready
						? "就绪"
						: problem
							? `不可用 —— ${problem}`
							: "未加载（首次使用会加载）";
					const lines = [
						`记忆库：${store.records.length} 条，维度 ${store.dim || "未建"}`,
						`本项目：${state.project}`,
						`嵌入器：${embedderLine}`,
					];
					if (skippedWrites > 0) {
						lines.push(`本次会话有 ${skippedWrites} 条没存下来（嵌入失败）`);
					}
					emit(lines.join("\n"));
					return;
				}

				if (verb === "list") {
					const recent = [...store.records]
						.sort((a, b) => b.createdAt - a.createdAt)
						.slice(0, 20);
					if (recent.length === 0) {
						emit("记忆库是空的。");
						return;
					}
					emit(
						recent
							.map(
								(r) =>
									`${new Date(r.createdAt).toISOString().slice(0, 10)}  ${r.kind.padEnd(8)}  ${r.title}`,
							)
							.join("\n"),
					);
					return;
				}

				if (verb === "search") {
					if (!tail) {
						emit("用法：/memory search <关键词>");
						return;
					}
					let hits: Hit[] = [];
					const qv = isEmbedderReady() ? await embed(tail) : null;
					if (qv && store.dim === qv.length) {
						hits = searchMemory(store, qv, { project: state.project, queryText: tail });
					}
					if (hits.length === 0) hits = keywordSearch(store, tail, { limit: 5 });
					emit(formatHitsForHuman(hits));
					return;
				}

				if (verb === "add") {
					if (!tail) {
						emit("用法：/memory add <要记住的内容>");
						return;
					}
					const ok = await persist(makeNote(tail, { cwd: state.cwd, kind: "note" }));
					emit(ok ? "已记住。" : "没写成功（嵌入模型不可用或重复）。");
					return;
				}

				emit("用法：/memory [stats|list|search <词>|add <内容>]");
			} catch (err) {
				logError("command", err);
				emit(`记忆命令出错：${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

export { embedMany };
