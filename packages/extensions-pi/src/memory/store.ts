/**
 * 存储层：records.jsonl（明文）+ vectors.f32（Float32 拼接）+ meta.json。
 *
 * 为什么向量不进 jsonl：512 维 float 转 base64 每条要 2.7KB，2000 条就是 5.4MB 的
 * 垃圾字符串。单独一个二进制文件按同序拼接，读一次 mmap 式的整块就行。
 *
 * 为什么不做向量库：实测 2000 条暴力余弦 1ms、10000 条 10ms。这个量级下 faiss /
 * Qdrant / Chroma 全是负担。
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { agentDir } from "../agent-dir.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord } from "./types.ts";

export const MEMORY_DIR =
	process.env.PI_MEMORY_DIR ?? join(agentDir(), "memory");
const RECORDS = "records.jsonl";
const VECTORS = "vectors.f32";
const META = "meta.json";
const LOCK = ".lock";

export function memoryPaths(dir = MEMORY_DIR) {
	return {
		dir,
		records: join(dir, RECORDS),
		vectors: join(dir, VECTORS),
		meta: join(dir, META),
		lock: join(dir, LOCK),
	};
}

function ensureDir(dir = MEMORY_DIR): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 极简排他锁：抢不到就返回 false，绝不死等（记忆是加分项，不值得阻塞会话）。 */
function withLock<T>(fn: () => T, dir = MEMORY_DIR): T | undefined {
	ensureDir(dir);
	const p = memoryPaths(dir).lock;
	try {
		closeSync(openSync(p, "wx", 0o600));
	} catch {
		// 陈旧锁（超过 30s）视为可用
		try {
			if (Date.now() - statSync(p).mtimeMs > 30_000) rmSync(p, { force: true });
			else return undefined;
		} catch {
			return undefined;
		}
	}
	try {
		return fn();
	} finally {
		try {
			rmSync(p, { force: true });
		} catch {
			/* ignore */
		}
	}
}

export function contentHash(project: string, kind: string, title: string, text: string): string {
	return createHash("sha256")
		.update(`${project}\u0000${kind}\u0000${title}\u0000${text}`)
		.digest("hex")
		.slice(0, 32);
}

export interface LoadedStore {
	records: MemoryRecord[];
	vectors: Float32Array;
	dim: number;
}

/** 读全库。向量条数与记录数不一致时按较短的对齐（坏文件不该炸掉整个记忆）。 */
export function loadStore(dir = MEMORY_DIR): LoadedStore {
	const p = memoryPaths(dir);
	if (!existsSync(p.records)) return { records: [], vectors: new Float32Array(0), dim: 0 };

	const records: MemoryRecord[] = [];
	for (const line of readFileSync(p.records, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as MemoryRecord;
			if (parsed && typeof parsed.id === "string") records.push(parsed);
		} catch {
			/* 单行坏掉就跳过，不影响其余 */
		}
	}

	let dim = 0;
	let vectors = new Float32Array(0);
	if (existsSync(p.meta)) {
		try {
			const meta = JSON.parse(readFileSync(p.meta, "utf-8")) as { dim?: number };
			if (typeof meta.dim === "number") dim = meta.dim;
		} catch {
			/* ignore */
		}
	}
	if (dim > 0 && existsSync(p.vectors)) {
		const buf = readFileSync(p.vectors);
		const usable = Math.min(buf.length, records.length * dim * 4);
		const aligned = usable - (usable % (dim * 4));
		vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + aligned));
	}
	return { records, vectors, dim };
}

export interface AppendResult {
	ok: boolean;
	reason?: string;
	record?: MemoryRecord;
}

/**
 * 追加一条记忆。同 hash 已存在则跳过（claude-mem 的 content hash 去重思路）。
 * 返回 ok:false 时调用方应当静默继续——记忆写失败不该打断会话。
 */
export function appendRecord(
	record: MemoryRecord,
	vector: Float32Array,
	dir = MEMORY_DIR,
): AppendResult {
	return (
		withLock(() => {
			const p = memoryPaths(dir);
			const existing = loadStore(dir);
			if (existing.records.some((r) => r.hash === record.hash)) {
				return { ok: false, reason: "duplicate" };
			}

			// 维度变了（换了模型）就整库重建向量：旧向量已经不可比
			const dim = vector.length;
			if (existing.dim !== 0 && existing.dim !== dim) {
				appendFileSync(p.records, `${JSON.stringify(record)}\n`, { mode: 0o600 });
				writeFileSync(p.vectors, Buffer.from(vector.buffer.slice(0)), { mode: 0o600 });
				writeFileSync(p.meta, JSON.stringify({ dim, count: 1 }), { mode: 0o600 });
				return { ok: true, record };
			}

			appendFileSync(p.records, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			appendFileSync(p.vectors, Buffer.from(vector.buffer.slice(0)), { mode: 0o600 });
			writeAtomicSync(p.meta, JSON.stringify({ dim, count: existing.records.length + 1 }));
			return { ok: true, record };
		}, dir) ?? { ok: false, reason: "locked" }
	);
}

/** meta.json 写原子化：先写临时文件再 rename，避免半个 JSON。 */
function writeAtomicSync(path: string, data: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, data, { mode: 0o600 });
	renameSync(tmp, path);
}

/** 项目名：cwd 的最后两段，够区分又不至于太长。 */
export function projectKey(cwd: string): string {
	const parts = cwd.split("/").filter(Boolean);
	return parts.slice(-2).join("/") || cwd;
}
