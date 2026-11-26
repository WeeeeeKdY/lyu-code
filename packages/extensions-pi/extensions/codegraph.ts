/**
 * pi-codegraph — automatic code-graph context for pi.
 *
 * Replaces what Claude Code gets from its PostToolUse/PreToolUse hook scripts
 * (~/.claude/hooks/gitnexus, cbm-code-discovery-gate) with an extension, since
 * pi has no shell-hook layer:
 *
 *   search results (grep/find/bash)  → GitNexus augment + codebase-memory symbols
 *   edit/write results               → gitnexus impact (blast radius)
 *   after git commit/merge/rebase    → stale index reminder
 *   start of each turn               → short code-discovery protocol in the system prompt
 *   before edit/write (opt-in)       → block high-risk edits
 *
 * Every hook degrades silently: a missing binary, a timeout, an unindexed repo
 * or a malformed payload results in "no extra context", never a failed turn.
 */

import type { CtxLike, PiApi, ToolCallEventLike, ToolResultEventLike } from "../src/pi-types.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { cbmBin, gitnexusBin, type ResolvedTargets, TargetResolver } from "../src/targets.ts";
import {
	formatImpactBlock,
	formatSearchContext,
	formatStaleBlock,
	protocolSnippet,
} from "../src/format.ts";
import { augment, impact, status } from "../src/gitnexus.ts";
import { searchSymbols } from "../src/codebase-memory.ts";
import {
	isGitMutation,
	queryFromBash,
	queryFromPattern,
	symbolsFromText,
	textFromToolInput,
} from "../src/query.ts";

interface Stats {
	injections: number;
	chars: number;
	impacts: number;
	lastSkip?: string;
}

function isSearchTool(toolName: string): boolean {
	return toolName === "grep" || toolName === "find" || toolName === "bash" || toolName === "read";
}

function queryFor(event: ToolResultEventLike, config: Config): string | undefined {
	const input = event.input ?? {};
	switch (event.toolName) {
		case "grep":
			return config.search.grep ? queryFromPattern(input.pattern ?? input.query) : undefined;
		case "find":
			return config.search.find ? queryFromPattern(input.pattern ?? input.glob) : undefined;
		case "bash":
			if (!config.search.bashSearch) return undefined;
			return typeof input.command === "string" ? queryFromBash(input.command) : undefined;
		case "read":
			if (!config.search.read) return undefined;
			return typeof input.path === "string" ? queryFromPattern(input.path) : undefined;
		default:
			return undefined;
	}
}

export default function codegraphExtension(pi: PiApi): void {
	let config: Config = loadConfig(process.cwd());
	let enabled = true;
	const resolver = new TargetResolver(() => config.codebaseMemory.command);
	const stats: Stats = { injections: 0, chars: 0, impacts: 0 };
	const seen = new Set<string>();

	const gnBin = () => gitnexusBin(config.gitnexus.command);
	const memBin = () => cbmBin(config.codebaseMemory.command);

	function budgetAllows(block: string): boolean {
		if (config.maxSessionChars > 0 && stats.chars + block.length > config.maxSessionChars) {
			stats.lastSkip = `session budget spent (${stats.chars}/${config.maxSessionChars} chars)`;
			return false;
		}
		return true;
	}

	function record(block: string, key?: string): void {
		stats.injections++;
		stats.chars += block.length;
		if (config.dedupe && key) seen.add(key);
	}

	function appendContent(event: ToolResultEventLike, block: string): { content: typeof event.content } {
		return { content: [...(event.content ?? []), { type: "text", text: block }] };
	}

	async function searchBlock(
		event: ToolResultEventLike,
		ctx: CtxLike,
		targets: ResolvedTargets,
	): Promise<string | undefined> {
		const query = queryFor(event, config);
		if (!query) return undefined;

		const key = `search:${targets.gitnexus?.name ?? targets.cbm?.name ?? "-"}:${query}`;
		if (config.dedupe && seen.has(key)) {
			stats.lastSkip = `already injected for "${query}"`;
			return undefined;
		}

		const [gitnexusText, symbols] = await Promise.all([
			config.gitnexus.enabled && targets.gitnexus
				? augment(gnBin(), query, targets.gitnexus.path, config.gitnexus.timeoutMs)
				: Promise.resolve(undefined),
			config.codebaseMemory.enabled && targets.cbm
				? searchSymbols(
						memBin(),
						targets.cbm.name,
						query,
						Math.max(1, config.codebaseMemory.limit),
						config.codebaseMemory.timeoutMs,
					)
				: Promise.resolve(undefined),
		]);

		const block = formatSearchContext({
			query,
			gitnexusText,
			symbols,
			gitnexusMax: config.gitnexus.maxChars,
			cbmMax: config.codebaseMemory.maxChars,
		});
		if (!block) return undefined;
		record(block, key);
		return block;
	}

	async function impactBlockFor(
		event: ToolResultEventLike,
		ctx: CtxLike,
		targets: ResolvedTargets,
	): Promise<string | undefined> {
		if (!config.edit.enabled || !config.gitnexus.enabled || !targets.gitnexus) return undefined;
		const text = textFromToolInput(event.toolName, event.input ?? {});
		if (!text) return undefined;
		const symbols = symbolsFromText(text, Math.max(1, config.edit.maxSymbols));
		if (symbols.length === 0) return undefined;

		const reports = await Promise.all(
			symbols.map((symbol) =>
				impact(
					gnBin(),
					symbol,
					targets.gitnexus?.name as string,
					config.gitnexus.depth,
					targets.gitnexus?.path as string,
					config.gitnexus.timeoutMs,
				),
			),
		);
		const usable = reports.filter((report): report is NonNullable<typeof report> => Boolean(report));
		if (usable.length === 0) return undefined;
		stats.impacts += usable.length;
		const block = formatImpactBlock(usable, config.edit.maxChars);
		if (!block) return undefined;
		record(block);
		return block;
	}

	async function staleBlockFor(
		event: ToolResultEventLike,
		ctx: CtxLike,
		targets: ResolvedTargets,
	): Promise<string | undefined> {
		if (!config.staleReminder || !targets.gitnexus) return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!isGitMutation(command)) return undefined;
		if (config.dedupe && seen.has("stale")) return undefined;

		const indexStatus = await status(gnBin(), targets.gitnexus.path, config.gitnexus.timeoutMs);
		if (!indexStatus || indexStatus.upToDate) return undefined;
		const block = formatStaleBlock(indexStatus.raw);
		record(block, "stale");
		return block;
	}

	// ---------------------------------------------------------------------
	// Events
	// ---------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		try {
			config = loadConfig(ctx.cwd);
			resolver.invalidate();
			seen.clear();
			stats.chars = 0;
			stats.injections = 0;
			stats.impacts = 0;
		} catch {
			/* keep defaults */
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!enabled || !config.enabled || !config.protocol) return;
			const targets = await resolver.resolve(ctx.cwd);
			const snippet = protocolSnippet(targets);
			if (!snippet) return;
			if (event.systemPrompt.includes("## Code graph (auto")) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${snippet}` };
		} catch {
			return;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (!enabled || !config.enabled) return;
			if (event.isError) return;
			if (!isSearchTool(event.toolName) && event.toolName !== "edit" && event.toolName !== "write") return;

			const targets = await resolver.resolve(ctx.cwd);
			if (!targets.gitnexus && !targets.cbm) return;

			let block: string | undefined;
			if (event.toolName === "edit" || event.toolName === "write") {
				block = await impactBlockFor(event, ctx, targets);
			} else if (event.toolName === "bash") {
				block = (await staleBlockFor(event, ctx, targets)) ?? (await searchBlock(event, ctx, targets));
			} else {
				block = await searchBlock(event, ctx, targets);
			}

			if (!block) return;
			if (!budgetAllows(block)) return;
			return appendContent(event, block);
		} catch {
			return;
		}
	});

	pi.on("tool_call", async (event: ToolCallEventLike, ctx) => {
		try {
			if (!enabled || !config.enabled || config.gate === "off") return;
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			const targets = await resolver.resolve(ctx.cwd);
			if (!targets.gitnexus || !config.gitnexus.enabled) return;

			const symbols = symbolsFromText(textFromToolInput(event.toolName, event.input ?? {}), config.edit.maxSymbols);
			if (symbols.length === 0) return;

			const blocking =
				config.gate === "high" ? new Set(["HIGH", "CRITICAL"]) : new Set(["MEDIUM", "HIGH", "CRITICAL"]);

			for (const symbol of symbols) {
				const report = await impact(
					gnBin(),
					symbol,
					targets.gitnexus.name,
					config.gitnexus.depth,
					targets.gitnexus.path,
					config.gitnexus.timeoutMs,
				);
				if (!report || !blocking.has(report.risk)) continue;
				stats.impacts++;
				return {
					block: true,
					reason: `codegraph gate: editing "${report.symbol}" is ${report.risk} risk — ${report.impactedCount} upstream symbols (${report.direct} direct) in ${report.modulesAffected} module(s). Review with \`gitnexus impact ${report.symbol} -r ${targets.gitnexus.name}\` before editing, then retry (or set gate:"off" / /codegraph off).`,
				};
			}
			return;
		} catch {
			return;
		}
	});

	// ---------------------------------------------------------------------
	// Command: /codegraph [on|off|reload|status]
	// ---------------------------------------------------------------------

	pi.registerCommand?.("codegraph", {
		description: "Show or toggle automatic code-graph context (on|off|reload|status)",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase();
			if (action === "on" || action === "off") {
				enabled = action === "on";
				ctx.ui?.notify?.(`codegraph ${enabled ? "enabled" : "disabled"} for this session`, "info");
				return;
			}
			if (action === "reload") {
				config = loadConfig(ctx.cwd);
				resolver.invalidate();
				ctx.ui?.notify?.("codegraph config reloaded", "info");
				return;
			}

			let lines: string[];
			try {
				const targets = await resolver.resolve(ctx.cwd);
				lines = [
					`state: ${enabled && config.enabled ? "on" : "off"}${config.gate !== "off" ? ` (gate: ${config.gate})` : ""}`,
					`gitnexus: ${targets.gitnexus ? `repo "${targets.gitnexus.name}"` : "no index for this repo"}`,
					`codebase-memory: ${targets.cbm ? `project "${targets.cbm.name}"` : "no index for this repo"}`,
					`injected: ${stats.injections} block(s), ${stats.chars} chars${stats.impacts > 0 ? `, ${stats.impacts} impact report(s)` : ""}`,
				];
				if (stats.lastSkip) lines.push(`last skip: ${stats.lastSkip}`);
			} catch (error) {
				lines = [`codegraph status failed: ${error instanceof Error ? error.message : String(error)}`];
			}
			ctx.ui?.notify?.(lines.join("\n"), "info");
		},
	});
}
