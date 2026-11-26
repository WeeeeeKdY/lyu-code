/**
 * 从会话消息里确定性抽取一条记忆 —— 不调模型。
 *
 * 为什么不调模型：成本。claude-mem 每个工具调用跑一遍 observer，重到它自己要开
 * 订阅收费。我们一个会话最多落一条，且优先从会话已有的结构里拿：
 *   - 标题：第一条用户消息（他到底想干什么）
 *   - 正文：最后一条有内容的 assistant 文本（通常是结论）
 *   - 文件：所有工具调用里出现的路径
 *
 * 需要更好的摘要时再挂模型（`complete()` 已验证扩展可用），但默认不开。
 */

import { clampText, oneLine, type MemoryKind } from "./types.ts";
import { contentHash, projectKey } from "./store.ts";
import type { MemoryRecord } from "./types.ts";

/** 只认我们关心的字段，避免把 pi 的完整消息类型搬进来。 */
interface LooseMessage {
	role?: string;
	content?: unknown;
}

interface LoosePart {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	input?: Record<string, unknown>;
}

function partsOf(message: LooseMessage): LoosePart[] {
	const content = message.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content.filter((p): p is LoosePart => typeof p === "object" && p !== null);
	return [];
}

function textOf(message: LooseMessage): string {
	return partsOf(message)
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n")
		.trim();
}

const PATH_KEYS = ["path", "file_path", "filePath", "pattern", "target", "file"];

function filesOf(messages: LooseMessage[]): string[] {
	const seen = new Set<string>();
	for (const message of messages) {
		for (const part of partsOf(message)) {
			if (part.type !== "toolCall" || !part.input) continue;
			for (const key of PATH_KEYS) {
				const value = part.input[key];
				if (typeof value === "string" && value.includes("/")) seen.add(value);
			}
		}
	}
	return [...seen].slice(0, 20);
}

export interface CaptureOptions {
	cwd: string;
	sessionId?: string;
	kind?: MemoryKind;
	now?: number;
}

/**
 * 从一段消息里抽记忆。抽不出有用东西时返回 null（空会话不入库）。
 */
export function captureFromMessages(
	messages: LooseMessage[],
	options: CaptureOptions,
): MemoryRecord | null {
	const userTexts: string[] = [];
	let lastAssistant = "";
	for (const message of messages) {
		if (message.role === "user") {
			const text = textOf(message);
			if (text) userTexts.push(text);
		} else if (message.role === "assistant") {
			const text = textOf(message);
			if (text) lastAssistant = text;
		}
	}
	if (userTexts.length === 0) return null;

	const title = oneLine(userTexts[0]);
	const body = clampText(lastAssistant || userTexts[userTexts.length - 1]);
	if (!title || !body) return null;

	const files = filesOf(messages);
	// 低价值会话不入库：一轮问一句、回一句「OK」的会话记下来只会污染检索。
	// 但碰过文件的会话即使回答很短也值得留（它就是「改了这个仓库」的凭证）。
	const MIN_ASSISTANT_CHARS = 40;
	if (files.length === 0 && lastAssistant.length < MIN_ASSISTANT_CHARS) return null;

	const project = projectKey(options.cwd);
	const kind = options.kind ?? "session";
	const createdAt = options.now ?? Date.now();
	return {
		id: `m-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		project,
		kind,
		title,
		text: body,
		files,
		createdAt,
		sessionId: options.sessionId,
		hash: contentHash(project, kind, title, body),
	};
}

/** 显式记一条（`remember` 工具 / `/memory add`）。 */
export function makeNote(
	text: string,
	options: CaptureOptions & { title?: string },
): MemoryRecord | null {
	const body = clampText(text);
	if (!body) return null;
	const project = projectKey(options.cwd);
	const title = oneLine(options.title ?? text);
	const kind = options.kind ?? "note";
	const createdAt = options.now ?? Date.now();
	return {
		id: `m-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		project,
		kind,
		title,
		text: body,
		files: [],
		createdAt,
		sessionId: options.sessionId,
		hash: contentHash(project, kind, title, body),
	};
}
