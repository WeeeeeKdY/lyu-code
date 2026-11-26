/**
 * GitNexus adapter. Every call goes through the CLI in JSON mode; nothing here
 * throws — a failed or timed-out call returns `undefined` and the caller
 * simply injects less context.
 */

import { exec } from "./exec.ts";
import { parseJsonLoose } from "./targets.ts";

export interface ImpactNode {
	name: string;
	filePath?: string;
	relationType?: string;
	confidence?: number;
}

export interface ImpactReport {
	symbol: string;
	symbolType?: string;
	filePath?: string;
	risk: string;
	impactedCount: number;
	direct: number;
	processesAffected: number;
	modulesAffected: number;
	processes: string[];
	directCallers: ImpactNode[];
}

interface RawImpact {
	target?: { name?: string; type?: string; filePath?: string };
	risk?: string;
	impactedCount?: number;
	summary?: { direct?: number; processes_affected?: number; modules_affected?: number };
	affected_processes?: Array<{ name?: string }>;
	byDepth?: Record<string, Array<{ name?: string; filePath?: string; relationType?: string; confidence?: number }>>;
	error?: string;
}

/** Search-pattern augmentation — the same call GitNexus' own agent hooks use. */
export async function augment(
	bin: string,
	query: string,
	root: string,
	timeoutMs: number,
): Promise<string | undefined> {
	const result = await exec(bin, ["augment", query], { cwd: root, timeoutMs });
	if (!result.ok) return undefined;
	// `gitnexus augment` writes its human-readable report to stderr, not stdout.
	const text = `${result.stdout}\n${result.stderr}`.trim();
	return text.length > 0 ? text : undefined;
}

/** Blast radius for a symbol. */
export async function impact(
	bin: string,
	symbol: string,
	repo: string,
	depth: number,
	root: string,
	timeoutMs: number,
): Promise<ImpactReport | undefined> {
	const result = await exec(bin, ["impact", symbol, "-r", repo, "--depth", String(depth)], {
		cwd: root,
		timeoutMs,
	});
	const raw =
		parseJsonLoose<RawImpact>(result.stdout) ??
		parseJsonLoose<RawImpact>(result.stderr);
	if (!raw || raw.error || !raw.target?.name) return undefined;

	const d1 = raw.byDepth?.["1"] ?? [];
	return {
		symbol: raw.target.name,
		symbolType: raw.target.type,
		filePath: raw.target.filePath,
		risk: (raw.risk ?? "UNKNOWN").toUpperCase(),
		impactedCount: raw.impactedCount ?? 0,
		direct: raw.summary?.direct ?? 0,
		processesAffected: raw.summary?.processes_affected ?? 0,
		modulesAffected: raw.summary?.modules_affected ?? 0,
		processes: (raw.affected_processes ?? []).map((p) => p.name).filter((n): n is string => Boolean(n)),
		directCallers: d1
			.filter((n) => Boolean(n.name))
			.map((n) => ({
				name: n.name as string,
				filePath: n.filePath,
				relationType: n.relationType,
				confidence: n.confidence,
			})),
	};
}

export interface IndexStatus {
	upToDate: boolean;
	raw: string;
}

/** `gitnexus status` for the repo containing `root`. */
export async function status(bin: string, root: string, timeoutMs: number): Promise<IndexStatus | undefined> {
	const result = await exec(bin, ["status"], { cwd: root, timeoutMs });
	const text = `${result.stdout}\n${result.stderr}`.trim();
	if (text.length === 0) return undefined;
	const upToDate = /up-to-date|up to date|✅/i.test(text) && !/stale|behind|out-of-date/i.test(text);
	return { upToDate, raw: text };
}
