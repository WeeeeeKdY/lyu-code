/**
 * 检索：纯 JS 暴力余弦（无向量库）+ 词汇重叠门。
 *
 * ## 为什么必须有「词汇重叠门」
 *
 * 实测 `bge-small-zh-v1.5`（512 维 q8）在这批中文技术短文本上的余弦分布：
 *
 *   相关问题 top: 0.684 / 0.641 / 0.783 / 0.681 / 0.475
 *   无关问题 top: 0.508 / 0.271 / 0.552 / 0.601 / 0.357
 *   记录之间底噪: 0.42 ~ 0.61
 *
 * 无关的 "react 的 useEffect 依赖数组怎么填" 拿到 0.601，**比相关问题的 0.475 还高**。
 * 也就是说：在这个模型 + 这个语料上，绝对余弦阈值既会漏召回又会误注入，
 * 任何单一阈值都分不开。（这也是 reranker 存在的理由，但 1.1GB 我们不要。）
 *
 * 所以改成分工：
 *   - **向量只负责排序**（相对顺序是对的：相关的 4/5 都排第一）
 *   - **词汇重叠负责准入**（技术记忆里几乎总有字面锚点：端口号、文件名、标识符、
 *     报错文本、专有名词）
 *
 * 代价：纯语义同义改写（"plannotator 什么时候弹" ↔ "送审阈值是 800 字符"）会漏。
 * 但漏掉记忆只是少了个提示，误注入错误记忆会直接把 agent 带歪——不对称，选精确。
 */

import { cosine } from "./embed.ts";
import type { LoadedStore } from "./store.ts";
import type { MemoryRecord } from "./types.ts";

export interface Hit {
	record: MemoryRecord;
	score: number;
	/** 词汇重叠命中数，0 表示只靠向量进来的 */
	overlap: number;
}

export interface SearchOptions {
	/** 同项目加分，0 表示不加权 */
	projectBoost?: number;
	/** 低于这个分数直接丢（仅排序后截断用，不是准入条件） */
	minScore?: number;
	limit?: number;
	/** 本次会话已注入过的 id，避免同一轮反复推同一条 */
	excludeIds?: Set<string>;
	project?: string;
	/** 原始查询文本。给了才做词汇门；不给就纯向量（测试/调试用） */
	queryText?: string;
	/** 强制要求词汇重叠，默认 queryText 有值时开启 */
	requireLexical?: boolean;
	/** 余弦高到这个程度可以免词汇门（实测几乎不会触发，留作后路） */
	bypassLexicalAbove?: number;
}

export const DEFAULT_PROJECT_BOOST = 0.12;
export const DEFAULT_MIN_SCORE = 0.35;
export const DEFAULT_LIMIT = 5;
export const DEFAULT_BYPASS_LEXICAL = 0.82;

/** 高频疑问词造出来的 bigram，命中它们不算线索。 */
const STOP_BIGRAMS = new Set([
	"什么", "怎么", "怎样", "如何", "哪个", "哪些", "多少", "是否", "是不", "不是",
	"可以", "我们", "你们", "这个", "那个", "这些", "那些", "一下", "帮我", "能不",
	"需要", "应该", "现在", "还是", "或者", "以及", "因为", "所以", "但是", "如果",
	"时候", "地方", "东西", "问题", "一个", "有没", "没有", "知道", "告诉", "看看",
]);

const CJK = /\p{Script=Han}/u;

/**
 * 抽线索词：拉丁标识符（>=3 字符）+ 汉字 bigram（去停用 bigram）。
 *
 * 为什么用 bigram 而不是分词：中文没有空格，引分词器要多背一个词典依赖；
 * bigram 对「端口号/端口」这类技术词足够准，且零依赖、永不失败。
 */
export function tokens(text: string): Set<string> {
	const out = new Set<string>();
	const lower = text.toLowerCase();

	for (const word of lower.match(/[a-z0-9][a-z0-9_.\-/]{2,}/g) ?? []) {
		out.add(word);
	}

	// 按非汉字切段，段内取相邻两字
	for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
		for (let i = 0; i + 1 < run.length; i++) {
			const bigram = run.slice(i, i + 2);
			if (!STOP_BIGRAMS.has(bigram)) out.add(bigram);
		}
	}
	return out;
}

/** 查询与记录共享的线索词个数。 */
export function lexicalOverlap(record: MemoryRecord, queryText: string): number {
	const queryTokens = tokens(queryText);
	if (queryTokens.size === 0) return 0;
	const recordTokens = tokens(`${record.title}\n${record.text}\n${record.files.join(" ")}`);
	let shared = 0;
	for (const token of queryTokens) if (recordTokens.has(token)) shared++;
	return shared;
}

export function searchMemory(
	store: LoadedStore,
	queryVector: Float32Array,
	options: SearchOptions = {},
): Hit[] {
	const {
		projectBoost = DEFAULT_PROJECT_BOOST,
		minScore = DEFAULT_MIN_SCORE,
		limit = DEFAULT_LIMIT,
		excludeIds,
		project,
		queryText,
		requireLexical = queryText !== undefined,
		bypassLexicalAbove = DEFAULT_BYPASS_LEXICAL,
	} = options;

	const dim = store.dim;
	if (dim === 0 || queryVector.length !== dim) return [];

	const count = Math.min(store.records.length, Math.floor(store.vectors.length / dim));
	const hits: Hit[] = [];
	for (let i = 0; i < count; i++) {
		const record = store.records[i];
		if (excludeIds?.has(record.id)) continue;

		let score = cosine(store.vectors, queryVector, i * dim, dim);
		if (project && record.project === project) score += projectBoost;
		if (score < minScore) continue;

		const overlap = queryText === undefined ? 0 : lexicalOverlap(record, queryText);
		if (requireLexical && overlap === 0 && score < bypassLexicalAbove) continue;

		hits.push({ record, score, overlap });
	}

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}

/** 没有向量时的兜底：只看词汇重叠。够粗糙，但比「什么都不记得」强。 */
export function keywordSearch(
	store: LoadedStore,
	query: string,
	options: SearchOptions = {},
): Hit[] {
	const { limit = DEFAULT_LIMIT, excludeIds } = options;
	const queryTokens = tokens(query);
	if (queryTokens.size === 0) return [];

	const hits: Hit[] = [];
	for (const record of store.records) {
		if (excludeIds?.has(record.id)) continue;
		const overlap = lexicalOverlap(record, query);
		if (overlap === 0) continue;
		hits.push({ record, score: overlap / queryTokens.size, overlap });
	}
	hits.sort((a, b) => b.score - a.score || b.overlap - a.overlap);
	return hits.slice(0, limit);
}

export { CJK };
