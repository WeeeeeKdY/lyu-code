/**
 * A thin wrapper over the `plannotator annotate` CLI.
 *
 * The CLI is the only programmable door into the review UI: the pi extension
 * API has no `invokeTool`, and opening a browser session over HTTP would mean
 * re-implementing the handshake. `annotate --gate --json --result-file` is the
 * documented automation contract — it opens the page, blocks until the reader
 * decides, then publishes a JSON outcome to the result file.
 *
 * Blocking is fine as long as nobody awaits it inside a hook: callers start it
 * and walk away, and a late outcome comes back through a callback. Every exit
 * path here is non-throwing, because a review that cannot open must never cost
 * the reader their turn.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { exec } from "./exec.ts";

export interface AnnotateRequest {
	/** Markdown file to review. */
	file: string;
	/** Shown as the page title. */
	title?: string;
	/** Give up (and kill the browser session) after this long. */
	timeoutMs: number;
	/** Binary override; otherwise resolved from PATH and the usual install spots. */
	command?: string;
	cwd?: string;
}

export interface AnnotateOutcome {
	/** The reader submitted something worth acting on. */
	hasFeedback: boolean;
	feedback: string;
	approved: boolean;
	/** The page was closed with nothing to send — discard silently. */
	nothingToSend: boolean;
	/** The wait ran out; the session was killed. */
	timedOut: boolean;
	/** Set when the CLI could not be started or the page failed. */
	error?: string;
}

const EMPTY: AnnotateOutcome = {
	hasFeedback: false,
	feedback: "",
	approved: false,
	nothingToSend: false,
	timedOut: false,
};

/** Install locations worth checking when PATH is thin (launchd, GUI-spawned pi). */
const CANDIDATES = [join(homedir(), ".local", "bin", "plannotator"), "/opt/homebrew/bin/plannotator", "/usr/local/bin/plannotator"];

let cachedBinary: string | undefined | null = null;

/**
 * Absolute path of the CLI, or undefined when it is not installed.
 *
 * Cached because the answer cannot change mid-session and the hook that calls
 * this runs on every turn.
 */
export function plannotatorBin(command?: string): string | undefined {
	if (command) return command;
	if (cachedBinary !== null) return cachedBinary;

	const envBin = process.env.PI_PLANNOTATOR_BIN;
	if (envBin) {
		cachedBinary = envBin;
		return cachedBinary;
	}

	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "plannotator");
		if (existsSync(candidate)) {
			cachedBinary = candidate;
			return cachedBinary;
		}
	}
	cachedBinary = CANDIDATES.find((candidate) => existsSync(candidate));
	return cachedBinary ?? undefined;
}

/** Reset the binary cache (tests, and `/plannotator-auto status` after an install). */
export function resetBinaryCache(): void {
	cachedBinary = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an outcome out of whatever the CLI published: the result file first,
 * then a JSON line on stdout, then plain stdout as a last resort.
 */
export function parseOutcome(raw: string, exitCode: number | null): AnnotateOutcome {
	const json = parseJsonRecord(raw);
	if (!json) {
		const text = raw.trim();
		return {
			...EMPTY,
			hasFeedback: text.length > 0 && exitCode === 0,
			feedback: text.length > 0 && exitCode === 0 ? text : "",
		};
	}

	const feedback = typeof json.feedback === "string" ? json.feedback.trim() : "";
	const nothingToSend = json.nothingToSend === true;
	const approved = json.approved === true;
	const hasFeedback = feedback.length > 0 && !nothingToSend;
	return { hasFeedback, feedback: hasFeedback ? feedback : "", approved, nothingToSend, timedOut: false };
}

/** Last JSON object in the text (the CLI prints progress lines before it). */
function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
	const text = raw.trim();
	if (!text) return undefined;
	const candidates = [text];
	const lines = text.split("\n").filter((line) => line.trim().startsWith("{"));
	candidates.push(...lines.reverse());
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (isRecord(parsed)) return parsed;
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

/**
 * Open the review page and wait for the reader.
 *
 * Never rejects. A missing binary, a startup failure, a timeout and a page
 * closed without a decision all resolve to an outcome with `hasFeedback: false`.
 */
export async function annotateAndWait(request: AnnotateRequest): Promise<AnnotateOutcome> {
	const bin = plannotatorBin(request.command);
	if (!bin || !existsSync(request.file)) return { ...EMPTY, error: bin ? "missing file" : "plannotator not installed" };

	const resultFile = join(tmpdir(), `plannotator-auto-${randomUUID()}.json`);
	const args = ["annotate", request.file, "--gate", "--json", "--result-file", resultFile];
	if (request.title) args.push("--title", request.title);

	try {
		const result = await exec(bin, args, { timeoutMs: request.timeoutMs, cwd: request.cwd });

		// The result file is the authoritative record; stdout is the fallback.
		let published = "";
		try {
			if (existsSync(resultFile)) published = readFileSync(resultFile, "utf-8");
		} catch {
			/* fall through to stdout */
		}

		if (result.timedOut) return { ...EMPTY, timedOut: true };
		if (!published && result.code === 2) return { ...EMPTY, error: result.stderr.slice(0, 400) || "gate failed" };

		const outcome = parseOutcome(published || result.stdout, result.code);
		return outcome;
	} catch (error) {
		return { ...EMPTY, error: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			rmSync(resultFile, { force: true });
		} catch {
			/* ignore */
		}
	}
}
