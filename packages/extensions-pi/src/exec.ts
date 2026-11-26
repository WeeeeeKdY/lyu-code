/**
 * Child-process helper. Never rejects: every failure mode (missing binary,
 * non-zero exit, timeout) is reported in the result so callers can degrade
 * silently. Extensions that throw from a `tool_result` hook would break the
 * agent turn, so this contract matters.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	maxBytes?: number;
}

export interface ExecResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	return new Promise<ExecResult>((resolve) => {
		let child: ReturnType<typeof spawn>;
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				env: options.env ? { ...process.env, ...options.env } : process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({
				ok: false,
				code: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
		});

		child.on("error", (error: Error) => {
			finish({
				ok: false,
				code: null,
				stdout,
				stderr,
				timedOut,
				error: error.message,
			});
		});

		child.on("close", (code: number | null) => {
			finish({
				ok: !timedOut && code === 0,
				code,
				stdout,
				stderr,
				timedOut,
			});
		});
	});
}

/** Trim a string to at most `max` characters, appending an ellipsis marker. */
export function clip(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
