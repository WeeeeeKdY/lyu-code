/**
 * 嵌入层：`Xenova/bge-small-zh-v1.5`，q8 onnx，512 维。
 *
 * 实测（M4 Pro，node 24，cpu 后端）：
 *   模型体积 23MB / 缓存冷启动 120ms / 单条 query 1.5ms / 120 条入库 229ms
 *
 * 三条硬规矩：
 *   1. 懒加载 + 单例。第一次真正要嵌入时才加载，加载慢不许挡住会话。
 *   2. 任何失败都返回 null，调用方降级为「没有记忆」，绝不抛断轮次。
 *   3. 模型下载不是每轮都试：失败后记一个退避时间点。
 */

import { join } from "node:path";
import { MEMORY_DIR } from "./store.ts";

export const MODEL_ID = process.env.PI_MEMORY_MODEL ?? "Xenova/bge-small-zh-v1.5";
export const MODEL_DIM = 512;
const CACHE_DIR = process.env.PI_MEMORY_MODEL_DIR ?? join(MEMORY_DIR, "models");
/** 加载失败后多久再试，避免每次调用都卡在同一个错误上。 */
const RETRY_AFTER_MS = 5 * 60_000;

type Embedder = (texts: string[], opts: Record<string, unknown>) => Promise<{ dims: number[]; data: Float32Array }>;

let embedderPromise: Promise<Embedder | null> | null = null;
/** 只有真正加载成功的那个引用会被设上——供同步就绪检查用。 */
let readyEmbedder: Embedder | null = null;
let failedAt = 0;
let lastError: string | undefined;

/**
 * 同步就绪检查。`before_agent_start` 里必须用它而不是 await ——
 * 冷启动 120ms、首次下载 10s，绝不能让注入把这一轮卡住。
 */
export function isEmbedderReady(): boolean {
	return readyEmbedder !== null;
}

export function embedderState(): { ready: boolean; loading: boolean; error?: string } {
	return {
		ready: readyEmbedder !== null,
		loading: embedderPromise !== null && readyEmbedder === null && failedAt === 0,
		error: lastError,
	};
}

/**
 * 把底层错误翻译成「能照着做」的一句话。纯函数，方便单测。
 *
 * 为什么要这个：检索降级本身是对的（永远不打断会话），但**静默**降级会骗人 ——
 * 扩展一声不响地不工作，用户只会觉得「记忆坏了」却毫无线索。实测在依赖缺失时
 * 就是这个下场：`require.resolve` 直接 MODULE_NOT_FOUND，一句日志都没有。
 */
export function explainEmbedderError(msg: string): string {
	if (/Cannot find (module|package)|MODULE_NOT_FOUND/i.test(msg)) {
		return "缺依赖 @huggingface/transformers（在扩展所在目录 npm install）";
	}
	if (/allowRemoteModels|not found locally|no such file/i.test(msg)) {
		return "本地没有模型缓存且禁止下载（PI_MEMORY_OFFLINE=1），先跑 npm run memory:fetch";
	}
	if (/ENOTFOUND|EAI_AGAIN|fetch failed|ETIMEDOUT|network/i.test(msg)) {
		return "模型下不来：网络不可达，可先 npm run memory:fetch 预下载";
	}
	return msg.split("\n")[0]?.slice(0, 200) || "未知错误";
}

/** 嵌入器当前坏在哪；没坏返回 undefined。 */
export function describeEmbedderProblem(): string | undefined {
	if (!lastError) return undefined;
	return explainEmbedderError(lastError);
}

/** 惰性拿嵌入器。拿不到就 null（含无网络、缺依赖、模型下不来）。 */
export async function getEmbedder(): Promise<Embedder | null> {
	if (failedAt !== 0 && Date.now() - failedAt < RETRY_AFTER_MS) return null;
	if (embedderPromise) return embedderPromise;

	embedderPromise = (async () => {
		try {
			const mod = (await import("@huggingface/transformers")) as unknown as {
				pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
				env: Record<string, unknown>;
			};
			// cacheDir 必须在 pipeline() 之前设，否则默认写到 cwd
			mod.env.cacheDir = CACHE_DIR;
			if (process.env.PI_MEMORY_OFFLINE === "1") mod.env.allowRemoteModels = false;
			const pipe = (await mod.pipeline("feature-extraction", MODEL_ID, { dtype: "q8" })) as Embedder;
			lastError = undefined;
			readyEmbedder = pipe;
			return pipe;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			failedAt = Date.now();
			return null;
		}
	})();
	return embedderPromise;
}

/** 后台预热：会话启动时调一次，失败无所谓。 */
export function warmup(): void {
	void getEmbedder().catch(() => undefined);
}

/**
 * 有界等待：最多等 `ms` 毫秒，超时就当没就绪。
 *
 * 为什么需要它：`pi --print` 是单轮会话，`session_start` 的预热和
 * `before_agent_start` 几乎同时发生。纯「没就绪就跳过」会让首轮永远拿不到记忆。
 * 缓存命中的加载约 250ms，所以给一个小上限就够；真加载不了（无网络/没装依赖）
 * 会走 failedAt 退避，后续轮次立即返回 false，不会再白白等。
 */
export async function readyWithin(ms: number): Promise<boolean> {
	if (readyEmbedder) return true;
	const pending = getEmbedder();
	await Promise.race([
		pending,
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			timer.unref?.();
		}),
	]);
	return readyEmbedder !== null;
}

/** 归一化后的向量；失败返回 null。 */
export async function embed(text: string): Promise<Float32Array | null> {
	const out = await embedMany([text]);
	return out ? out[0] : null;
}

export async function embedMany(texts: string[]): Promise<Float32Array[] | null> {
	if (texts.length === 0) return [];
	const pipe = await getEmbedder();
	if (!pipe) return null;
	readyEmbedder = pipe;
	try {
		const res = await pipe(texts, { pooling: "cls", normalize: true });
		const dims = res.dims;
		const dim = dims[dims.length - 1];
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i++) {
			out.push(res.data.slice(i * dim, (i + 1) * dim));
		}
		return out;
	} catch (err) {
		lastError = err instanceof Error ? err.message : String(err);
		return null;
	}
}

/**
 * 库向量与 query 的余弦。`offset` 是 **库向量** 在整块 Float32Array 里的起始下标
 * （query 永远只有 dim 长，偏移加在它上面会越界变成 undefined → NaN）。
 */
export function cosine(
	bank: Float32Array,
	query: Float32Array,
	offset = 0,
	dim = query.length,
): number {
	let sum = 0;
	for (let i = 0; i < dim; i++) sum += bank[offset + i] * query[i];
	return sum;
}
