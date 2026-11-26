/**
 * Configuration: defaults, then `~/.pi/agent/codegraph.json`, then
 * `<project-root>/.pi/codegraph.json` (project wins). Environment can hard
 * disable via `PI_CODEGRAPH_DISABLED=1`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GateMode = "off" | "high" | "medium";

export interface EngineConfig {
	enabled: boolean;
	/** Binary override; otherwise auto-detected. */
	command?: string;
	timeoutMs: number;
	maxChars: number;
}

export interface Config {
	enabled: boolean;
	/** Block an edit/write whose target symbol has at least this blast radius risk. */
	gate: GateMode;
	/** Inject graph context into tool results for these tools. */
	search: {
		grep: boolean;
		find: boolean;
		bashSearch: boolean;
		read: boolean;
	};
	gitnexus: EngineConfig & { depth: number };
	codebaseMemory: EngineConfig & { limit: number };
	edit: {
		/** Append blast-radius reports after edit/write. */
		enabled: boolean;
		maxSymbols: number;
		maxChars: number;
	};
	/** Remind about stale indexes after git mutations. */
	staleReminder: boolean;
	/** Append a short code-discovery protocol to the system prompt. */
	protocol: boolean;
	/** Stop injecting once this many characters of graph context were added in a session. */
	maxSessionChars: number;
	/** Skip repeating the same graph block within a session. */
	dedupe: boolean;
}

export const DEFAULTS: Config = {
	enabled: true,
	gate: "off",
	search: { grep: true, find: true, bashSearch: true, read: false },
	gitnexus: { enabled: true, timeoutMs: 4000, maxChars: 1200, depth: 2 },
	codebaseMemory: { enabled: true, timeoutMs: 4000, maxChars: 1000, limit: 6 },
	edit: { enabled: true, maxSymbols: 2, maxChars: 1000 },
	staleReminder: true,
	protocol: true,
	maxSessionChars: 24000,
	dedupe: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shallow-per-section deep merge, ignoring unknown/mistyped values. */
export function mergeConfig(base: Config, patch: unknown): Config {
	if (!isRecord(patch)) return base;
	const out: Config = structuredClone(base);

	const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	const num = (value: unknown, fallback: number) =>
		typeof value === "number" && Number.isFinite(value) ? value : fallback;

	if ("enabled" in patch) out.enabled = bool(patch.enabled, out.enabled);
	if (patch.gate === "off" || patch.gate === "high" || patch.gate === "medium") out.gate = patch.gate;

	if (isRecord(patch.search)) {
		const s = patch.search;
		out.search.grep = bool(s.grep, out.search.grep);
		out.search.find = bool(s.find, out.search.find);
		out.search.bashSearch = bool(s.bashSearch, out.search.bashSearch);
		out.search.read = bool(s.read, out.search.read);
	}

	if (isRecord(patch.gitnexus)) {
		const g = patch.gitnexus;
		out.gitnexus.enabled = bool(g.enabled, out.gitnexus.enabled);
		out.gitnexus.timeoutMs = num(g.timeoutMs, out.gitnexus.timeoutMs);
		out.gitnexus.maxChars = num(g.maxChars, out.gitnexus.maxChars);
		out.gitnexus.depth = num(g.depth, out.gitnexus.depth);
		if (typeof g.command === "string" && g.command.length > 0) out.gitnexus.command = g.command;
	}

	if (isRecord(patch.codebaseMemory)) {
		const c = patch.codebaseMemory;
		out.codebaseMemory.enabled = bool(c.enabled, out.codebaseMemory.enabled);
		out.codebaseMemory.timeoutMs = num(c.timeoutMs, out.codebaseMemory.timeoutMs);
		out.codebaseMemory.maxChars = num(c.maxChars, out.codebaseMemory.maxChars);
		out.codebaseMemory.limit = num(c.limit, out.codebaseMemory.limit);
		if (typeof c.command === "string" && c.command.length > 0) out.codebaseMemory.command = c.command;
	}

	if (isRecord(patch.edit)) {
		const e = patch.edit;
		out.edit.enabled = bool(e.enabled, out.edit.enabled);
		out.edit.maxSymbols = num(e.maxSymbols, out.edit.maxSymbols);
		out.edit.maxChars = num(e.maxChars, out.edit.maxChars);
	}

	out.staleReminder = bool(patch.staleReminder, out.staleReminder);
	out.protocol = bool(patch.protocol, out.protocol);
	out.maxSessionChars = num(patch.maxSessionChars, out.maxSessionChars);
	out.dedupe = bool(patch.dedupe, out.dedupe);
	return out;
}

function readJsonFile(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
}

export function agentDir(): string {
	return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function loadConfig(cwd: string): Config {
	if (process.env.PI_CODEGRAPH_DISABLED === "1" || process.env.PI_CODEGRAPH_DISABLED === "true") {
		return { ...structuredClone(DEFAULTS), enabled: false };
	}

	let config = mergeConfig(DEFAULTS, readJsonFile(join(agentDir(), "codegraph.json")));

	// Explicit override wins over both convention paths (handy for tests and for
	// machine-specific setups that should not live in the repo).
	const override = process.env.PI_CODEGRAPH_CONFIG;
	if (override) {
		const fileConfig = readJsonFile(override);
		if (fileConfig !== undefined) return mergeConfig(config, fileConfig);
	}

	config = mergeConfig(config, readJsonFile(join(cwd, ".pi", "codegraph.json")));
	return config;
}

// ── plannotator-auto ────────────────────────────────────────────────────────
//
// A separate config file from codegraph: the two extensions answer unrelated
// questions, and one shared file would make every key ambiguous.

export interface PlannotatorConfig {
	enabled: boolean;
	/** Skill names whose use arms automatic reviews for the session. */
	triggers: string[];
	/** Minimum length of a turn's output before it is offered for review. */
	minChars: number;
	/** Require a heading, numbered list, table or 3+ bullets. */
	requireStructure: boolean;
	/** Kill the browser session after this long (the CLI otherwise waits forever). */
	timeoutMs: number;
	/** Binary override; otherwise resolved from PATH. */
	command?: string;
}

export const PLANNOTATOR_DEFAULTS: PlannotatorConfig = {
	enabled: true,
	triggers: ["grill-me", "grilling", "grill-with-docs"],
	minChars: 800,
	requireStructure: true,
	timeoutMs: 10 * 60 * 1000,
};

export function mergePlannotatorConfig(base: PlannotatorConfig, patch: unknown): PlannotatorConfig {
	if (!isRecord(patch)) return base;
	const out: PlannotatorConfig = { ...base, triggers: [...base.triggers] };

	if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
	if (Array.isArray(patch.triggers)) {
		const triggers = patch.triggers.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (triggers.length > 0) out.triggers = triggers;
	}
	if (typeof patch.minChars === "number" && Number.isFinite(patch.minChars)) out.minChars = Math.max(0, patch.minChars);
	if (typeof patch.requireStructure === "boolean") out.requireStructure = patch.requireStructure;
	if (typeof patch.timeoutMs === "number" && Number.isFinite(patch.timeoutMs)) out.timeoutMs = Math.max(1000, patch.timeoutMs);
	if (typeof patch.command === "string" && patch.command.length > 0) out.command = patch.command;
	return out;
}

export function loadPlannotatorConfig(cwd: string): PlannotatorConfig {
	if (process.env.PI_PLANNOTATOR_AUTO_DISABLED === "1" || process.env.PI_PLANNOTATOR_AUTO_DISABLED === "true") {
		return { ...PLANNOTATOR_DEFAULTS, triggers: [...PLANNOTATOR_DEFAULTS.triggers], enabled: false };
	}

	let config = mergePlannotatorConfig(PLANNOTATOR_DEFAULTS, readJsonFile(join(agentDir(), "plannotator.json")));
	const override = process.env.PI_PLANNOTATOR_AUTO_CONFIG;
	if (override) {
		const fileConfig = readJsonFile(override);
		if (fileConfig !== undefined) config = mergePlannotatorConfig(config, fileConfig);
	}
	return mergePlannotatorConfig(config, readJsonFile(join(cwd, ".pi", "plannotator.json")));
}
