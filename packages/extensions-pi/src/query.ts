/**
 * Turns tool calls into graph queries: which search pattern to enrich, which
 * symbols an edit touches.
 *
 * These are heuristics, not a shell parser: the goal is to avoid asking the
 * graph engine about `TODO`, a path, or a broken regex. Anything ambiguous
 * returns `undefined`, which simply means "no extra context".
 */

const MIN_QUERY_LEN = 3;
const MAX_QUERY_LEN = 120;

/** Tokens that say nothing about code and would just add noise to the graph. */
const NOISE_QUERIES = new Set([
	"true",
	"false",
	"null",
	"undefined",
	"todo",
	"fixme",
	"import",
	"export",
	"require",
	"function",
	"return",
	"const",
	"string",
	"number",
	"object",
	"test",
	"tests",
	"index",
	"src",
	"lib",
	"dist",
]);

function stripRegexNoise(input: string): string {
	let query = input.trim();
	// `\bfoo\b`, `^foo$`, `.*foo`, `\\`
	query = query.replace(/\\[bB]/g, "");
	query = query.replace(/^\.\*/g, "");
	query = query.replace(/\\/g, "");
	query = query.replace(/^\^+/, "").replace(/\$+$/, "");
	return query.trim();
}

export function normalizeQuery(raw: string): string | undefined {
	if (raw.trim().length > MAX_QUERY_LEN) return undefined;
	const query = stripRegexNoise(raw);

	// Pure pattern junk: only metachars, or nothing left after stripping.
	if (query.length < MIN_QUERY_LEN) return undefined;
	if (/^[\^$.|?*+()[\]{}\/\s-]+$/.test(query)) return undefined;
	if (NOISE_QUERIES.has(query.toLowerCase())) return undefined;

	// Compound patterns like `foo|executeNode`: keep the most specific branch.
	if (query.includes("|")) {
		const branches = query
			.split("|")
			.map((part) => part.trim())
			.filter((part) => /^[A-Za-z_$][\w$.-]{2,}$/.test(part));
		if (branches.length === 0) return undefined;
		return branches.reduce((best, current) => (current.length > best.length ? current : best));
	}

	return query;
}

const SEARCH_BINARIES = /\b(rg|ripgrep|ag|ack|grep|git\s+grep)\b/;

function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	let quote: '"' | "'" | null = null;

	for (const char of command) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			quoted = true;
			continue;
		}
		if (/\s/.test(char)) {
			// Keep empty quoted tokens (""): they mean "empty pattern".
			if (current.length > 0 || quoted) tokens.push(current);
			current = "";
			quoted = false;
			continue;
		}
		current += char;
	}
	if (current.length > 0 || quoted) tokens.push(current);
	return tokens;
}

/** Flags whose value is a separate token, so the next token must be skipped. */
const FLAGS_WITH_VALUE = new Set([
	"-e",
	"--regexp",
	"-f",
	"--file",
	"-m",
	"--max-count",
	"-A",
	"--after-context",
	"-B",
	"--before-context",
	"-C",
	"--context",
	"-g",
	"--glob",
	"-t",
	"--type",
	"-T",
	"--type-not",
	"--include",
	"--exclude",
	"--exclude-dir",
]);

/** Extract the search pattern from a shell command, if it is a text search. */
export function queryFromBash(command: string): string | undefined {
	if (!SEARCH_BINARIES.test(command)) return undefined;

	// Skip anything that writes: destructive leading verb, or a real redirect
	// (`2>/dev/null` and `>&2` are fine).
	const leading = command.trim().split(/[\s;|&]+/)[0] ?? "";
	if (/^(rm|mv|cp|dd|truncate|tee|install|ln)$/.test(leading)) return undefined;
	if (/(^|[^\d&])>(?![&=])/.test(command)) return undefined;

	const tokens = tokenizeShell(command);
	const binaryIndex = tokens.findIndex((token) => /(^|\/)(rg|ripgrep|ag|ack|grep)$/.test(token));
	if (binaryIndex === -1) return undefined;

	const rest = tokens.slice(binaryIndex + 1);
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i] as string;
		if (token === "-e" || token === "--regexp") {
			const value = rest[i + 1];
			return value === undefined ? undefined : normalizeQuery(value);
		}
		if (token.startsWith("-")) {
			if (FLAGS_WITH_VALUE.has(token)) i++;
			continue;
		}
		// grep semantics: the first positional argument is the pattern, the rest
		// are paths. Stop here so a directory name is never mistaken for a query.
		return normalizeQuery(token);
	}
	return undefined;
}

export function queryFromPattern(pattern: unknown): string | undefined {
	if (typeof pattern !== "string") return undefined;

	// Glob patterns: keep the longest identifier-looking segment, minus extension.
	if (/[*?{}[\]]/.test(pattern)) {
		const segments = pattern
			.split(/[*?{}[\]\\/]+/)
			.map((segment) => segment.trim())
			.map((segment) => /^([A-Za-z_$][\w$]*)\.[A-Za-z0-9]{1,8}$/.exec(segment)?.[1] ?? segment)
			.filter((segment) => /^[A-Za-z_$][\w$.-]*$/.test(segment))
			.sort((a, b) => b.length - a.length);
		const best = segments[0];
		return best ? normalizeQuery(best) : undefined;
	}

	return normalizeQuery(pattern);
}

/** Definition-site regexes, ordered by how specific they are. */
const DEFINITION_PATTERNS: RegExp[] = [
	/\b(?:export\s+)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)/g,
	/\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
	/\b(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
	/\b(?:export\s+)?(?:type|enum|struct|trait|record)\s+([A-Za-z_$][\w$]*)/g,
	/\bdef\s+([A-Za-z_][\w!?=]*)/g,
	/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/g,
	/\b(?:public|private|protected|internal|static|final|override|virtual|suspend|open)\s+(?:[\w<>[\],.?]+\s+)*([A-Za-z_$][\w$]*)\s*\(/g,
	/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
];

/** Pull candidate symbol names out of an edit/write payload. */
export function symbolsFromText(text: string, limit: number): string[] {
	if (!text) return [];
	const seen = new Set<string>();
	const found: Array<{ name: string; at: number }> = [];

	for (const pattern of DEFINITION_PATTERNS) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
			const name = match[1];
			if (!name || name.length < 3) continue;
			if (NOISE_QUERIES.has(name.toLowerCase())) continue;
			if (seen.has(name)) continue;
			seen.add(name);
			found.push({ name, at: match.index });
		}
	}

	found.sort((a, b) => a.at - b.at);
	return found.slice(0, limit).map((entry) => entry.name);
}

export function textFromToolInput(toolName: string, input: Record<string, unknown>): string {
	const pick = (...keys: string[]): string => {
		for (const key of keys) {
			const value = input[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
		return "";
	};
	if (toolName === "write") return pick("content", "text", "body");
	return pick("newText", "new_string", "new_str", "content", "text");
}

const GIT_MUTATIONS = /\bgit\b[^|;&]*\b(commit|checkout|switch|merge|rebase|reset|pull|cherry-pick|apply|am|stash)\b/;

export function isGitMutation(command: string): boolean {
	return GIT_MUTATIONS.test(command);
}
