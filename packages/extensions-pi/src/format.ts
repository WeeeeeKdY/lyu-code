/**
 * Block formatting. Everything injected is prefixed with `[codegraph]` and kept
 * short: this text lands in the model's context on every hit, so brevity beats
 * completeness. The model can always call the engine itself for depth.
 */

import { clip } from "./exec.ts";
import type { GraphSymbol } from "./codebase-memory.ts";
import type { ImpactReport } from "./gitnexus.ts";
import type { ResolvedTargets } from "./targets.ts";

export const MARKER = "[codegraph]";

function shortPath(path: string | undefined): string {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 2) return path;
	return `…/${parts.slice(-2).join("/")}`;
}

function squeezeGitNexus(raw: string, max: number): string {
	const cleaned = raw
		.replace(/^\[GitNexus\]\s*/i, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^\d+\s+related symbols found:?$/i.test(line))
		.join("; ");
	return clip(cleaned, max);
}

export interface SearchFormatInput {
	query: string;
	gitnexusText?: string;
	symbols?: GraphSymbol[];
	gitnexusMax: number;
	cbmMax: number;
}

export function formatSearchContext(input: SearchFormatInput): string | undefined {
	const lines: string[] = [];
	const source: string[] = [];

	if (input.gitnexusText) {
		const text = squeezeGitNexus(input.gitnexusText, input.gitnexusMax);
		if (text) {
			lines.push(`GitNexus flows/symbols: ${text}`);
			source.push("gitnexus");
		}
	}

	if (input.symbols && input.symbols.length > 0) {
		const rendered = input.symbols
			.slice(0, 8)
			.map((symbol) => {
				const location = symbol.filePath
					? `${shortPath(symbol.filePath)}${symbol.startLine ? `:${symbol.startLine}` : ""}`
					: "";
				const refs = symbol.inDegree > 0 ? ` ←${symbol.inDegree}` : "";
				return `${symbol.name} (${symbol.label}${location ? `, ${location}` : ""}${refs})`;
			})
			.join("; ");
		lines.push(`codebase-memory symbols: ${clip(rendered, input.cbmMax)}`);
		source.push("codebase-memory");
	}

	if (lines.length === 0) return undefined;

	return [
		`${MARKER} graph context for "${input.query}" (${source.join(" + ")}; files on disk remain the source of truth)`,
		...lines.map((line) => `- ${line}`),
	].join("\n");
}

export function formatImpact(report: ImpactReport, maxChars: number): string | undefined {
	const callers = report.directCallers.slice(0, 6).map((caller) => caller.name).join(", ");
	const head = `${report.symbol} (${report.symbolType ?? "symbol"}${report.filePath ? `, ${shortPath(report.filePath)}` : ""}) → risk ${report.risk}, ${report.impactedCount} upstream (${report.direct} direct, ${report.processesAffected} processes, ${report.modulesAffected} modules)`;
	const details: string[] = [];
	if (callers) details.push(`direct callers: ${callers}`);
	if (report.processes.length > 0) details.push(`processes: ${report.processes.slice(0, 4).join(", ")}`);
	const body = details.length > 0 ? `${head}\n  ${details.join("\n  ")}` : head;
	return clip(body, maxChars);
}

export function formatImpactBlock(reports: ImpactReport[], maxChars: number): string | undefined {
	const rendered = reports
		.map((report) => formatImpact(report, maxChars))
		.filter((line): line is string => Boolean(line));
	if (rendered.length === 0) return undefined;
	return [`${MARKER} blast radius (gitnexus impact)`, ...rendered.map((line) => `- ${line}`)].join("\n");
}

export function formatStaleBlock(raw: string): string {
	const summary = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /indexed commit|current commit|status/i.test(line))
		.join("; ");
	return `${MARKER} index may be stale after this git operation${summary ? ` (${clip(summary, 160)})` : ""}. Reindexing keeps graph context accurate: \`gitnexus analyze\` in GitNexus, \`index_repository\` for codebase-memory.`;
}

export function protocolSnippet(targets: ResolvedTargets): string {
	const engines: string[] = [];
	if (targets.gitnexus) engines.push(`GitNexus repo "${targets.gitnexus.name}"`);
	if (targets.cbm) engines.push(`codebase-memory project "${targets.cbm.name}"`);
	if (engines.length === 0) return "";

	return [
		`## Code graph (auto, ${MARKER})`,
		`This repo is indexed: ${engines.join(" and ")}.`,
		"Your search results and edits receive appended graph context automatically — no need to call these tools just to get it.",
		"Ask for depth explicitly when it matters:",
		"- `gitnexus impact <symbol> -r <repo>` before changing a shared symbol.",
		"- `gitnexus context <symbol>` for callers/callees/processes.",
		"- `codebase-memory-mcp cli search_graph '{\"project\":\"<project>\",\"name_pattern\":\"<pattern>\"}'` for symbol lookup.",
		"- `gitnexus query \"<concept>\"` for execution flows instead of grepping.",
		"Prefer graph results for structure, and read files before editing them.",
	].join("\n");
}
