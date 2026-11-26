/**
 * Minimal structural types for the pi extension API.
 *
 * Deliberately *not* imported from `@earendil-works/pi-coding-agent`: type-only
 * imports are erased at load time, but keeping these local means the package
 * typechecks and loads with zero dependencies and never breaks on a pi version
 * bump. Only the fields this extension actually touches are declared.
 */

export type TextBlock = { type: "text"; text: string };
export type AnyBlock = TextBlock | { type: string; [key: string]: unknown };

export interface ToolResultEventLike {
	type: "tool_result";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: AnyBlock[];
	isError: boolean;
	details?: unknown;
}

export interface ToolCallEventLike {
	type: "tool_call";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

export interface BeforeAgentStartEventLike {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

export interface UiLike {
	notify?(message: string, type?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
}

export interface CtxLike {
	cwd: string;
	hasUI?: boolean;
	ui?: UiLike;
}

export interface ToolResultHookResult {
	content?: AnyBlock[];
}

export interface ToolCallHookResult {
	block?: boolean;
	reason?: string;
}

export interface BeforeAgentStartHookResult {
	systemPrompt?: string;
}

export interface CommandOptions {
	description?: string;
	handler: (args: string, ctx: CtxLike) => Promise<void> | void;
}

export interface PiApi {
	on(
		event: "tool_result",
		handler: (event: ToolResultEventLike, ctx: CtxLike) => Promise<ToolResultHookResult | void>,
	): void;
	on(
		event: "tool_call",
		handler: (event: ToolCallEventLike, ctx: CtxLike) => Promise<ToolCallHookResult | void>,
	): void;
	on(
		event: "before_agent_start",
		handler: (event: BeforeAgentStartEventLike, ctx: CtxLike) => Promise<BeforeAgentStartHookResult | void>,
	): void;
	on(event: "session_start", handler: (event: { reason?: string }, ctx: CtxLike) => Promise<void> | void): void;
	registerCommand?(name: string, options: CommandOptions): void;
	getFlag?(name: string): boolean | string | undefined;
}

// ── plannotator-auto: the events and calls that extension needs ─────────────

export interface AgentMessageLike {
	role?: string;
	content?: AnyBlock[] | string;
}

export interface AgentEndEventLike {
	type: "agent_end";
	messages: AgentMessageLike[];
}

export interface InputEventLike {
	type: "input";
	text: string;
	source?: "interactive" | "rpc" | "extension";
}

export interface PiAutoApi {
	on(
		event: "agent_end",
		handler: (event: AgentEndEventLike, ctx: CtxLike) => Promise<void> | void,
	): void;
	on(event: "input", handler: (event: InputEventLike, ctx: CtxLike) => { action: "continue" } | void): void;
	on(event: "session_start", handler: (event: { reason?: string }, ctx: CtxLike) => Promise<void> | void): void;
	registerCommand?(name: string, options: CommandOptions): void;
	/** Always starts a turn. */
	sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
	getFlag?(name: string): boolean | string | undefined;
}
