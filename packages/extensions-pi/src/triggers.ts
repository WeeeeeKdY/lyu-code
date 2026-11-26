/**
 * When to open a review, and what counts as worth reviewing.
 *
 * Two separate questions, kept here so both are testable without pi:
 *
 *   isTriggerInput()  — should this session get automatic reviews at all?
 *   looksLikePlan()   — is *this* turn's output a proposal someone can annotate?
 *
 * The second one is deliberately conservative: a review page that opens on
 * small talk costs the reader a browser switch and buys nothing, so a turn has
 * to be both long enough and shaped like a document (heading, numbered steps,
 * a table, or a real bullet list).
 */

export interface PlanShape {
	/** Trimmed character count of the prose. */
	chars: number;
	/** Markdown headings at the start of a line. */
	headings: number;
	/** Lines starting with `1.` / `2)` after optional indent. */
	ordered: number;
	/** Lines starting with `-` / `*`. */
	bullets: number;
	/** Markdown table rows. */
	tables: number;
}

/** Escape a literal for use inside a RegExp. */
function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `text` names one of the trigger skills — either as a slash
 * invocation (`/skill:grill-me`), a bare mention (`grill-me`), or with an
 * underscore instead of a dash. Matching is on the whole token so that
 * "grilling" does not fire on "grill".
 */
export function isTriggerInput(text: string, triggers: readonly string[]): boolean {
	if (!text) return false;
	const haystack = text.toLowerCase();
	for (const trigger of triggers) {
		const name = trigger.trim().toLowerCase();
		if (!name) continue;
		const variants = new Set([name, name.replace(/-/g, "_"), name.replace(/-/g, " "), name.replace(/-/g, "")]);
		for (const variant of variants) {
			// The token may sit inside a path-ish skill invocation, so the
			// boundary is anything that is not a letter/digit/dash.
			const pattern = new RegExp(`(^|[^a-z0-9_-])${escapeRegex(variant)}($|[^a-z0-9_-])`);
			if (pattern.test(haystack)) return true;
		}
	}
	return false;
}

/** Measure how document-like a piece of assistant output is. */
export function planSignals(text: string): PlanShape {
	const shape: PlanShape = { chars: text.trim().length, headings: 0, ordered: 0, bullets: 0, tables: 0 };
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (/^#{1,6}\s+\S/.test(line)) shape.headings += 1;
		else if (/^\d+[.)]\s+\S/.test(line)) shape.ordered += 1;
		else if (/^[-*]\s+\S/.test(line)) shape.bullets += 1;
		else if (line.startsWith("|")) shape.tables += 1;
	}
	return shape;
}

export interface PlanRules {
	/** Minimum trimmed length of the turn's output. */
	minChars: number;
	/** Require at least one structural signal (heading/ordered list/table/3 bullets). */
	requireStructure: boolean;
}

/** Whether this turn's output is worth putting in front of a reader. */
export function looksLikePlan(text: string, rules: PlanRules): boolean {
	const shape = planSignals(text);
	if (shape.chars < rules.minChars) return false;
	if (!rules.requireStructure) return true;
	return shape.headings > 0 || shape.ordered >= 2 || shape.tables >= 2 || shape.bullets >= 3;
}
