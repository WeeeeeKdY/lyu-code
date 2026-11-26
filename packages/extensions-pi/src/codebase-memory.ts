/**
 * codebase-memory-mcp adapter.
 *
 * Talks to the CLI (`codebase-memory-mcp cli <tool> <json>`), not the MCP
 * server, so a hook can query the graph without a live MCP session. Output is
 * a log line on stdout followed by JSON, hence `parseJsonLoose`.
 */

import { exec } from "./exec.ts";
import { parseJsonLoose } from "./targets.ts";

export interface GraphSymbol {
	name: string;
	label: string;
	filePath?: string;
	startLine?: number;
	inDegree: number;
	isTest: boolean;
}

interface RawGraphNode {
	name?: string;
	label?: string;
	file_path?: string;
	start_line?: number;
	in_degree?: number;
	is_test?: boolean;
}

interface RawSearchResponse {
	results?: RawGraphNode[];
	total?: number;
	error?: string;
}

/** Code-ish labels only; docs sections and modules are noise for this purpose. */
const CODE_LABELS = new Set([
	"Function",
	"Method",
	"Class",
	"Interface",
	"Struct",
	"Enum",
	"Trait",
	"Impl",
	"Route",
	"Component",
	"Hook",
	"Constructor",
	"Lambda",
]);

const LABEL_PRIORITY: Record<string, number> = {
	Class: 0,
	Interface: 0,
	Struct: 0,
	Enum: 0,
	Trait: 0,
	Function: 1,
	Method: 1,
	Impl: 2,
	Component: 2,
	Hook: 2,
	Route: 3,
	Constructor: 3,
	Lambda: 4,
};

function buildCliArgs(tool: string, payload: Record<string, unknown>): string[] {
	return ["cli", tool, JSON.stringify(payload)];
}

export async function searchSymbols(
	bin: string,
	project: string,
	pattern: string,
	limit: number,
	timeoutMs: number,
): Promise<GraphSymbol[] | undefined> {
	const candidates = limit * 6;
	const result = await exec(bin, buildCliArgs("search_graph", { project, name_pattern: pattern, limit: candidates }), {
		timeoutMs,
	});
	if (!result.ok) return undefined;
	const parsed = parseJsonLoose<RawSearchResponse>(result.stdout);
	if (!parsed || parsed.error || !Array.isArray(parsed.results)) return undefined;

	const mapped: GraphSymbol[] = [];
	for (const node of parsed.results) {
		if (typeof node.name !== "string" || typeof node.label !== "string") continue;
		if (!CODE_LABELS.has(node.label)) continue;
		mapped.push({
			name: node.name,
			label: node.label,
			filePath: node.file_path,
			startLine: node.start_line,
			inDegree: node.in_degree ?? 0,
			isTest: node.is_test === true,
		});
	}

	mapped.sort((a, b) => {
		if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
		const pa = LABEL_PRIORITY[a.label] ?? 9;
		const pb = LABEL_PRIORITY[b.label] ?? 9;
		if (pa !== pb) return pa - pb;
		return b.inDegree - a.inDegree;
	});

	return mapped.slice(0, limit);
}

/** Text search across the indexed corpus (graph-augmented grep). */
export async function searchCode(
	bin: string,
	project: string,
	pattern: string,
	limit: number,
	timeoutMs: number,
): Promise<GraphSymbol[] | undefined> {
	const result = await exec(bin, buildCliArgs("search_code", { project, pattern, limit }), { timeoutMs });
	if (!result.ok) return undefined;
	const parsed = parseJsonLoose<RawSearchResponse>(result.stdout);
	if (!parsed || parsed.error || !Array.isArray(parsed.results)) return undefined;
	return parsed.results
		.filter((n) => typeof n.name === "string")
		.map((n) => ({
			name: n.name as string,
			label: typeof n.label === "string" ? n.label : "Code",
			filePath: n.file_path,
			startLine: n.start_line,
			inDegree: n.in_degree ?? 0,
			isTest: n.is_test === true,
		}));
}
