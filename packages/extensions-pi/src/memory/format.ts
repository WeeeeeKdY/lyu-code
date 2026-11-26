/**
 * 注入块的渲染与预算。
 *
 * 教训来自 claude-mem：注入块必须自己量长度，不能假设「写出去就到了」。它们的
 * hook stdout 超 10000 字符就被整块落盘只剩 2KB 预览，而 hook 仍然报成功。
 * 我们这里按字符硬裁，且**整条丢、绝不切一半**，保证块永远是良构的。
 */

import type { Hit } from "./search.ts";

/** 整个注入块的上限（字符）。约 400 token，够放 5 条一句话记忆。 */
export const MAX_BLOCK_CHARS = 1600;
/** 单条记忆最多占多少字符，超了就截断正文（标题永远保留）。 */
export const MAX_ITEM_CHARS = 320;

export interface FormatOptions {
	maxBlockChars?: number;
	maxItemChars?: number;
}

function relTime(ts: number, now = Date.now()): string {
	const days = Math.floor((now - ts) / 86_400_000);
	if (days <= 0) return "今天";
	if (days === 1) return "昨天";
	if (days < 30) return `${days}天前`;
	if (days < 365) return `${Math.floor(days / 30)}个月前`;
	return `${Math.floor(days / 365)}年前`;
}

function renderItem(hit: Hit, maxItemChars: number, now: number): string {
	const { record } = hit;
	const head = `- [${relTime(record.createdAt, now)}·${record.kind}] ${record.title}`;
	const body = record.text.trim();
	if (!body) return head;
	const bullet = `${head}\n  ${body.replace(/\n+/g, " ")}`;
	if (bullet.length <= maxItemChars) return bullet;
	return `${head}\n  ${body.replace(/\n+/g, " ").slice(0, Math.max(0, maxItemChars - head.length - 4))}…`;
}

/**
 * 渲染注入块。放不下就一条条丢最旧的（hits 已按相关度排序，从尾部丢）。
 * 返回空串表示「不值得注入」。
 */
export function formatMemoryBlock(
	hits: Hit[],
	options: FormatOptions = {},
	now = Date.now(),
): string {
	const maxBlockChars = options.maxBlockChars ?? MAX_BLOCK_CHARS;
	const maxItemChars = options.maxItemChars ?? MAX_ITEM_CHARS;
	if (hits.length === 0) return "";

	const header = "## 记忆（来自以往会话，仅供参考）";
	// 按条数平分预算：否则 5 条各自吃满 maxItemChars 就装不进 maxBlockChars，
	// 最后只能丢掉一条——宁可每条短一点，也别少记一条。
	const perItem = Math.max(
		80,
		Math.min(maxItemChars, Math.floor((maxBlockChars - header.length - hits.length) / hits.length)),
	);
	let items = hits.map((h) => renderItem(h, perItem, now));
	while (items.length > 0) {
		const block = `${header}\n${items.join("\n")}`;
		if (block.length <= maxBlockChars) return block;
		items = items.slice(0, -1);
	}
	return "";
}

/** 给 `/memory search` 的人读渲染。 */
export function formatHitsForHuman(hits: Hit[], now = Date.now()): string {
	if (hits.length === 0) return "没有命中。";
	const lines: string[] = [];
	for (const hit of hits) {
		lines.push(`${hit.score.toFixed(3)}  ${relTime(hit.record.createdAt, now)}·${hit.record.kind}  ${hit.record.title}`);
		if (hit.record.files.length > 0) lines.push(`        ${hit.record.files.slice(0, 4).join("  ")}`);
	}
	return lines.join("\n");
}
