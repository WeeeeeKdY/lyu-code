/**
 * pi-guard：危险操作门禁 + 审计。
 *
 * 四种模式（`PI_GUARD_MODE`）：
 *   - `off`     什么都不做
 *   - `audit`   只记审计日志，不拦（观察期用，先看你平时到底跑什么）
 *   - `ask`     交互模式下弹确认，headless（`--print`、workflow 节点）直接拒绝（默认）
 *   - `strict`  ask 级也直接拒绝，只有 allow 放行
 *
 * **失败一律放行**（fail-open），因为「永不打断会话」优先：门禁自身出 bug
 * 不应该让用户连正常命令都跑不了。要反过来设 `PI_GUARD_FAIL=closed`。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../src/agent-dir.ts";
import { judgeCommand, judgeFilePath, type Verdict } from "../src/guard/rules.ts";

type Mode = "off" | "audit" | "ask" | "strict";

const MODE = (process.env.PI_GUARD_MODE ?? "ask") as Mode;
const FAIL_CLOSED = process.env.PI_GUARD_FAIL === "closed";
const AUDIT_PATH = join(agentDir(), "guard-audit.jsonl");

/** 用户豁免：`~/.pi/agent/guard.json` 里的 `{ "allow": ["rule-id", ...] }` */
function loadAllowlist(): Set<string> {
	const path = join(agentDir(), "guard.json");
	if (!existsSync(path)) return new Set();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { allow?: string[] };
		return new Set(Array.isArray(parsed.allow) ? parsed.allow : []);
	} catch {
		return new Set();
	}
}

function audit(entry: Record<string, unknown>): void {
	if (process.env.PI_GUARD_AUDIT === "0") return;
	try {
		mkdirSync(agentDir(), { recursive: true });
		appendFileSync(
			AUDIT_PATH,
			`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
			{ mode: 0o600 },
		);
	} catch {
		/* 审计失败不该影响执行 */
	}
}

function preview(value: unknown, max = 400): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function guardExtension(pi: any) {
	const allowlist = loadAllowlist();

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (MODE === "off") return;
		try {
			const toolName = String(event?.toolName ?? "");
			const input = event?.input ?? {};

			let verdict: Verdict = { level: "allow", rule: "none", why: "" };
			if (toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				verdict = judgeCommand(command);
			} else if (toolName === "write" || toolName === "edit") {
				const path = typeof input.path === "string" ? input.path : "";
				verdict = judgeFilePath(path, "write");
			} else {
				return;
			}

			if (verdict.level === "allow" || allowlist.has(verdict.rule)) return;

			const summary =
				toolName === "bash" ? preview(input.command) : preview(input.path, 160);

			if (MODE === "audit") {
				audit({
					tool: toolName,
					input: summary,
					level: verdict.level,
					rule: verdict.rule,
					decision: "audit-only",
					cwd: ctx?.cwd,
				});
				return;
			}

			const denyNow =
				verdict.level === "deny" || MODE === "strict" || !ctx?.hasUI;

			if (denyNow) {
				audit({
					tool: toolName,
					input: summary,
					level: verdict.level,
					rule: verdict.rule,
					decision: "blocked",
					cwd: ctx?.cwd,
				});
				ctx?.ui?.notify?.(`pi-guard 已拦截：${verdict.why}`, "warning");
				return {
					block: true,
					reason: [
						`pi-guard 拒绝执行（规则 ${verdict.rule}）：${verdict.why}`,
						`命令：${summary}`,
						`如果确实需要，让用户自己做，或把 "${verdict.rule}" 加进 guard.json 的 allow 列表。`,
						`不要试图绕过这条规则（改写法、换工具、拆成多条）——那属于明知故犯。`,
					].join("\n"),
				};
			}

			// 交互模式：问用户
			const approved = await ctx.ui.confirm(
				"需要确认",
				`${verdict.why}\n\n${summary}`,
			);
			audit({
				tool: toolName,
				input: summary,
				level: verdict.level,
				rule: verdict.rule,
				decision: approved ? "approved" : "rejected-by-user",
				cwd: ctx?.cwd,
			});
			if (!approved) {
				return {
					block: true,
					reason: `用户拒绝执行：${verdict.why}。换个不需要这一步的做法，或问用户想怎么办。`,
				};
			}
			return;
		} catch (err) {
			// 门禁自己出错：默认放行，但记下来
			audit({ error: err instanceof Error ? err.message : String(err), decision: "fail-open" });
			if (FAIL_CLOSED) {
				return { block: true, reason: "pi-guard 内部错误（fail-closed 模式），已阻止执行。" };
			}
			return;
		}
	});

	pi.registerCommand("guard", {
		description: "门禁：/guard [status|audit [n]]",
		async handler(args: string, ctx: any) {
			const emit = (text: string): void => {
				const ui = ctx?.ui;
				if (typeof ui?.notify === "function") ui.notify(text);
				else if (typeof ui?.print === "function") ui.print(text);
				else console.log(text);
			};
			const [, verb, ...rest] = String(args ?? "").trim().split(/\s+/);
			if (verb === "audit") {
				const limit = Number(rest[0]) > 0 ? Number(rest[0]) : 15;
				try {
					const lines = readFileSync(AUDIT_PATH, "utf-8").trim().split("\n").slice(-limit);
					emit(lines.join("\n") || "还没有审计记录。");
				} catch {
					emit("还没有审计记录。");
				}
				return;
			}
			emit(
				[
					`模式：${MODE}${FAIL_CLOSED ? "（fail-closed）" : "（fail-open）"}`,
					`豁免规则：${allowlist.size > 0 ? [...allowlist].join(", ") : "无"}`,
					`审计：${AUDIT_PATH}`,
					`改模式：PI_GUARD_MODE=off|audit|ask|strict`,
				].join("\n"),
			);
		},
	});
}
