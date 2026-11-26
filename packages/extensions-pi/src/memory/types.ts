/**
 * 记忆记录的结构。
 *
 * 借了 claude-mem 的 observation 思路（结构化字段而非自由文本），但砍到够用：
 * 它们有 8 个字段，我们只留 6 个——标题、正文、涉及文件、类型、时间、项目。
 */

export type MemoryKind = "session" | "note" | "decision" | "pitfall";

export interface MemoryRecord {
	/** 稳定 id，形如 m-<base36 时间>-<6 位随机> */
	id: string;
	/** 捕获时的 cwd，用于同项目加权 */
	project: string;
	kind: MemoryKind;
	/** 一行标题，检索结果里展示的就是它 */
	title: string;
	/** 正文，几百字以内 */
	text: string;
	/** 涉及的文件（相对或绝对路径） */
	files: string[];
	createdAt: number;
	/** 来源会话 id，可选 */
	sessionId?: string;
	/** 内容哈希，用于去重 */
	hash: string;
}

export const MAX_TITLE = 200;
export const MAX_TEXT = 2000;
export const MAX_FILES = 20;

/** 把任意字符串压成单行并截断。 */
export function oneLine(text: string, max = MAX_TITLE): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clampText(text: string, max = MAX_TEXT): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
