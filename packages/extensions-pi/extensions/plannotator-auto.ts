/**
 * plannotator-auto — put the turn's proposal in front of the reader without
 * anyone typing a command.
 *
 * The flow the reader asked for:
 *
 *   /skill:grill-me (or grilling / grill-with-docs)
 *     → arm automatic reviews for this session
 *   agent finishes a turn that is long enough and shaped like a document
 *     → write it to a markdown file and open it in Plannotator
 *   reader annotates and submits
 *     → the annotations arrive as a user message; the agent revises
 *   reader closes the page instead
 *     → discard silently (their call)
 *
 * Two rules keep this from being noisy:
 *
 *   - a revision that exists *because* of a submitted review is not reviewed
 *     again, so a session cannot ping-pong with itself;
 *   - one open page at a time; a second candidate while a page is waiting is
 *     dropped rather than queued.
 *
 * Every handler is wrapped: a missing binary, a dead browser, a timeout or a
 * malformed payload degrades to "no review", never to a broken turn.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, loadPlannotatorConfig, type PlannotatorConfig } from "../src/config.ts";
import type { AgentEndEventLike, AgentMessageLike, CtxLike, InputEventLike, PiAutoApi } from "../src/pi-types.ts";
import { annotateAndWait, plannotatorBin } from "../src/plannotator.ts";
import { isTriggerInput, looksLikePlan } from "../src/triggers.ts";

/** Where reviewed drafts are kept (one file per review, pruned by count). */
function draftsDir(): string {
	return join(agentDir(), "plannotator-auto");
}

/** Plain text of an assistant message, tolerant of the block shapes pi may send. */
export function assistantText(message: AgentMessageLike | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => (block as { text: string }).text)
		.join("\n\n");
}

/** Text of the last assistant message in a finished run. */
export function lastAssistantText(messages: readonly AgentMessageLike[] | undefined): string {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = assistantText(message).trim();
		if (text) return text;
	}
	return "";
}

/** First heading, used as the page title; falls back to the timestamp. */
function titleFor(text: string, index: number): string {
	const heading = text.split("\n").find((line) => /^#{1,6}\s+\S/.test(line.trim()));
	const cleaned = heading?.trim().replace(/^#{1,6}\s+/, "").slice(0, 80);
	return cleaned && cleaned.length > 0 ? cleaned : `pi turn ${index}`;
}

/** Keep the newest `keep` drafts; a review per turn would otherwise pile up. */
function pruneDrafts(keep = 20): void {
	try {
		const dir = draftsDir();
		const files = readdirSync(dir)
			.map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
			.filter((entry) => entry.name.endsWith(".md"))
			.sort((a, b) => b.mtime - a.mtime);
		for (const stale of files.slice(keep)) rmSync(stale.path, { force: true });
	} catch {
		/* pruning is best-effort */
	}
}

/** Write the draft and return its path, or undefined when the disk says no. */
function writeDraft(text: string, title: string, index: number): string | undefined {
	try {
		const dir = draftsDir();
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(dir, `${stamp}-${index}.md`);
		writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf-8");
		pruneDrafts();
		return path;
	} catch {
		return undefined;
	}
}

/** The message handed back to the agent once the reader submitted. */
export function feedbackMessage(feedback: string, file: string): string {
	return [
		`[plannotator] 批注反馈 —— ${file}`,
		"",
		feedback.trim(),
		"",
		"请按上面的批注修改，改完再说明改了什么。",
	].join("\n");
}

interface State {
	armed: boolean;
	/** A page is open and waiting; drop further candidates. */
	pending: boolean;
	/** The next finished turn is our own revision — do not review it again. */
	justDelivered: boolean;
	reviews: number;
	skipped: string;
	lastText: string;
}

export default function plannotatorAutoExtension(pi: PiAutoApi): void {
	let config: PlannotatorConfig = loadPlannotatorConfig(process.cwd());
	const state: State = { armed: false, pending: false, justDelivered: false, reviews: 0, skipped: "", lastText: "" };

	/** Open a review for `text` and deliver whatever comes back. */
	function review(text: string, ctx: CtxLike, reason: string): void {
		const file = writeDraft(text, titleFor(text, state.reviews + 1), state.reviews + 1);
		if (!file) {
			state.skipped = "could not write the draft file";
			return;
		}

		state.pending = true;
		ctx.ui?.notify?.(`plannotator: 已打开批注页（${reason}）`, "info");

		void annotateAndWait({
			file,
			title: titleFor(text, state.reviews + 1),
			timeoutMs: config.timeoutMs,
			command: config.command,
			cwd: ctx.cwd,
		})
			.then((outcome) => {
				state.pending = false;
				if (outcome.timedOut) {
					state.skipped = "review timed out; page closed";
					return;
				}
				if (!outcome.hasFeedback) {
					// Closed without sending: the reader's call, discard silently.
					state.skipped = "closed with nothing to send";
					return;
				}
				state.reviews += 1;
				state.justDelivered = true;
				pi.sendUserMessage?.(feedbackMessage(outcome.feedback, file), { deliverAs: "followUp" });
			})
			.catch((error: unknown) => {
				state.pending = false;
				state.skipped = error instanceof Error ? error.message : String(error);
			});
	}

	pi.on("session_start", (_event, ctx) => {
		try {
			config = loadPlannotatorConfig(ctx.cwd);
			state.armed = false;
			state.pending = false;
			state.justDelivered = false;
			state.reviews = 0;
			state.skipped = "";
			state.lastText = "";
		} catch {
			/* keep whatever config we had */
		}
	});

	// Arming: the reader said "grill me", so this session wants reviews.
	pi.on("input", (event: InputEventLike) => {
		try {
			if (event.text && isTriggerInput(event.text, config.triggers) && !state.armed) {
				state.armed = true;
			}
		} catch {
			/* never block input */
		}
		return { action: "continue" };
	});

	pi.on("agent_end", (event: AgentEndEventLike, ctx: CtxLike) => {
		try {
			const text = lastAssistantText(event.messages);
			if (text) state.lastText = text;

			if (!config.enabled || !state.armed || state.pending) return;
			// Our own revision after a submitted review: do not bounce it back.
			if (state.justDelivered) {
				state.justDelivered = false;
				return;
			}
			// Print/JSON runs have nobody looking at a browser.
			if (ctx.hasUI === false) return;
			if (!plannotatorBin(config.command)) {
				state.skipped = "plannotator CLI not found";
				return;
			}
			if (!looksLikePlan(text, { minChars: config.minChars, requireStructure: config.requireStructure })) return;

			review(text, ctx, `${text.length} chars`);
		} catch {
			/* a review that cannot start must not fail the turn */
		}
	});

	pi.registerCommand?.("annotate-last", {
		description: "Open the previous answer in Plannotator",
		handler: (_args: string, ctx: CtxLike) => {
			try {
				if (!state.lastText) {
					ctx.ui?.notify?.("还没有可批注的回复", "warning");
					return;
				}
				if (state.pending) {
					ctx.ui?.notify?.("已经有一个批注页在等你了", "warning");
					return;
				}
				review(state.lastText, ctx, "manual");
			} catch (error) {
				ctx.ui?.notify?.(`annotate-last failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand?.("plannotator-auto", {
		description: "Arm/disarm automatic reviews for this session",
		handler: (args: string, ctx: CtxLike) => {
			const action = (args ?? "").trim().toLowerCase();
			if (action === "arm") state.armed = true;
			else if (action === "disarm") state.armed = false;
			else if (action === "off") config = { ...config, enabled: false };
			else if (action === "on") config = { ...config, enabled: true };

			const bin = plannotatorBin(config.command);
			ctx.ui?.notify?.(
				[
					`state: ${config.enabled ? "on" : "off"}${state.armed ? " (armed)" : ""}`,
					`binary: ${bin ?? "not found"}`,
					`triggers: ${config.triggers.join(", ")}`,
					`threshold: ${config.minChars} chars${config.requireStructure ? " + structure" : ""}`,
					`reviews: ${state.reviews}${state.pending ? " (one open)" : ""}`,
					state.skipped ? `last skip: ${state.skipped}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});
}
