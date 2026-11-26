/**
 * Repo/project resolution: which GitNexus index and which codebase-memory
 * project covers the current working directory?
 *
 * Both engines key their data by absolute path, so the deepest indexed root
 * that is an ancestor of cwd wins. Results are cached; a miss is cached too
 * (that is the common case for unindexed repos).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import { join } from "node:path";
import { exec } from "./exec.ts";

export interface GitNexusRepo {
	name: string;
	path: string;
}

export interface CbmProject {
	name: string;
	rootPath: string;
}

export interface ResolvedTargets {
	cwd: string;
	gitnexus?: GitNexusRepo;
	cbm?: CbmProject;
}

const CACHE_TTL_MS = 30_000;

export function isUnder(child: string, parent: string): boolean {
	if (child === parent) return true;
	const withSep = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(withSep);
}

function deepest<T>(items: T[], rootOf: (item: T) => string, cwd: string): T | undefined {
	let best: T | undefined;
	let bestLen = -1;
	for (const item of items) {
		const root = rootOf(item);
		if (!root) continue;
		if (isUnder(cwd, root) && root.length > bestLen) {
			best = item;
			bestLen = root.length;
		}
	}
	return best;
}

/** Read GitNexus' global registry (`~/.gitnexus/registry.json`). */
function readGitNexusRegistry(): GitNexusRepo[] {
	const candidates = [
		process.env.GITNEXUS_HOME ? join(process.env.GITNEXUS_HOME, "registry.json") : undefined,
		join(homedir(), ".gitnexus", "registry.json"),
	].filter((p): p is string => Boolean(p));

	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf-8"));
			const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.repos) ? parsed.repos : [];
			const repos: GitNexusRepo[] = [];
			for (const entry of list) {
				if (!entry || typeof entry !== "object") continue;
				const name = typeof entry.name === "string" ? entry.name : undefined;
				const repoPath = typeof entry.path === "string" ? entry.path : undefined;
				if (name && repoPath) repos.push({ name, path: repoPath });
			}
			return repos;
		} catch {
			/* try next candidate */
		}
	}
	return [];
}

export function gitnexusRepoFor(cwd: string): GitNexusRepo | undefined {
	const repos = readGitNexusRegistry();
	return deepest(repos, (r) => r.path, cwd);
}

/** Parse the first JSON object found in mixed CLI output (log lines + JSON). */
export function parseJsonLoose<T = unknown>(raw: string): T | undefined {
	const start = raw.indexOf("{");
	if (start === -1) return undefined;
	try {
		return JSON.parse(raw.slice(start)) as T;
	} catch {
		// Fall back: find the last balanced object by trimming trailing lines.
		const end = raw.lastIndexOf("}");
		if (end > start) {
			try {
				return JSON.parse(raw.slice(start, end + 1)) as T;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

function resolveCbmBin(configCommand?: string): string | undefined {
	if (process.env.PI_CBM_BIN) return process.env.PI_CBM_BIN;
	if (configCommand) return configCommand;
	const local = join(homedir(), ".local", "bin", "codebase-memory-mcp");
	if (existsSync(local)) return local;
	return "codebase-memory-mcp";
}

export function cbmBin(configCommand?: string): string {
	return resolveCbmBin(configCommand) ?? "codebase-memory-mcp";
}

export function gitnexusBin(configCommand?: string): string {
	return process.env.PI_GITNEXUS_BIN || configCommand || "gitnexus";
}

/** Ask codebase-memory-mcp for its indexed projects. */
async function listCbmProjects(configCommand?: string, timeoutMs = 6000): Promise<CbmProject[]> {
	const result = await exec(cbmBin(configCommand), ["cli", "list_projects", "{}"], {
		timeoutMs,
		cwd: homedir(),
	});
	if (!result.ok) return [];
	const parsed = parseJsonLoose<{ projects?: Array<{ name?: string; root_path?: string }> }>(result.stdout);
	if (!parsed?.projects) return [];
	const projects: CbmProject[] = [];
	for (const p of parsed.projects) {
		if (typeof p.name === "string" && typeof p.root_path === "string") {
			projects.push({ name: p.name, rootPath: p.root_path });
		}
	}
	return projects;
}

export class TargetResolver {
	private cache?: { at: number; cwd: string; value: ResolvedTargets };
	private cbmProjects?: { at: number; value: CbmProject[] };

	constructor(private readonly cbmCommand: () => string | undefined) {}

	invalidate(): void {
		this.cache = undefined;
		this.cbmProjects = undefined;
	}

	async resolve(cwd: string): Promise<ResolvedTargets> {
		if (this.cache && this.cache.cwd === cwd && Date.now() - this.cache.at < CACHE_TTL_MS) {
			return this.cache.value;
		}

		const value: ResolvedTargets = { cwd };
		value.gitnexus = gitnexusRepoFor(cwd);

		if (!this.cbmProjects || Date.now() - this.cbmProjects.at > CACHE_TTL_MS) {
			this.cbmProjects = { at: Date.now(), value: await listCbmProjects(this.cbmCommand()) };
		}
		value.cbm = deepest(this.cbmProjects.value, (p) => p.rootPath, cwd);

		this.cache = { at: Date.now(), cwd, value };
		return value;
	}
}
