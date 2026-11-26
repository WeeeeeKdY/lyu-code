/**
 * 成本与用量统计。
 *
 * pi 在 `assistantMsg.usage.cost.total` 里带每一轮的花费，但没有累积视图。
 * 这个扩展做三件事：
 *   1. `message_end` 累加本次会话的 token 与花费，显示在状态栏
 *   2. `/stats` 看本次会话 + 当日合计（按天落盘 `<agentDir>/stats.json`）
 *   3. 超过 `PI_DAILY_BUDGET`（美元）时提醒一次 —— 只提醒，不熔断
 *
 * 为什么只提醒不熔断：熔断会让人在关键任务中途被掐断，比花钱更难受。
 * 先把数字摆出来，让人自己决定。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../src/agent-dir.ts";

interface DayTotals {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
}

const STATS_PATH = join(agentDir(), "stats.json");

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function emptyDay(): DayTotals {
	return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
}

function loadStats(): Record<string, DayTotals> {
	try {
		if (!existsSync(STATS_PATH)) return {};
		return JSON.parse(readFileSync(STATS_PATH, "utf-8")) as Record<string, DayTotals>;
	} catch {
		return {};
	}
}

function saveStats(stats: Record<string, DayTotals>): void {
	try {
		mkdirSync(agentDir(), { recursive: true });
		writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), { mode: 0o600 });
	} catch {
		/* 统计写不进去不该影响会话 */
	}
}

const fmt = (n: number): string => (n >= 1 ? n.toFixed(2) : n.toFixed(4));
const kilo = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function statsExtension(pi: any) {
	let session: DayTotals = emptyDay();
	let warned = false;
	const budget = Number(process.env.PI_DAILY_BUDGET ?? "0");

	pi.on("session_start", async () => {
		session = emptyDay();
		warned = false;
	});

	pi.on("message_end", async (event: any, ctx: any) => {
		try {
			const message = event?.message;
			if (!message || message.role !== "assistant") return;
			const usage = message.usage;
			if (!usage) return;

			session.input += Number(usage.input ?? usage.inputTokens ?? 0);
			session.output += Number(usage.output ?? usage.outputTokens ?? 0);
			session.cacheRead += Number(usage.cacheRead ?? usage.cache_read_input_tokens ?? 0);
			session.cacheWrite += Number(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0);
			session.cost += Number(usage.cost?.total ?? 0);
			session.turns += 1;

			const stats = loadStats();
			const key = today();
			const day = stats[key] ?? emptyDay();
			day.input += Number(usage.input ?? 0);
			day.output += Number(usage.output ?? 0);
			day.cacheRead += Number(usage.cacheRead ?? 0);
			day.cacheWrite += Number(usage.cacheWrite ?? 0);
			day.cost += Number(usage.cost?.total ?? 0);
			day.turns += 1;
			stats[key] = day;
			saveStats(stats);

			ctx?.ui?.setStatus?.("cost", `$${fmt(session.cost)} · ${kilo(session.input + session.output)} tok`);

			if (budget > 0 && !warned && day.cost >= budget) {
				warned = true;
				ctx?.ui?.notify?.(
					`今日已花 $${fmt(day.cost)}，超过预算 $${fmt(budget)}。不会中断会话，自己看着办。`,
					"warning",
				);
			}
		} catch {
			/* 统计失败静默 */
		}
	});

	pi.registerCommand("stats", {
		description: "用量：/stats [days]",
		async handler(args: string, ctx: any) {
			const emit = (text: string): void => {
				const ui = ctx?.ui;
				if (typeof ui?.notify === "function") ui.notify(text);
				else if (typeof ui?.print === "function") ui.print(text);
				else console.log(text);
			};
			const days = Math.min(Math.max(Number(String(args ?? "").trim()) || 7, 1), 90);
			const stats = loadStats();
			const keys = Object.keys(stats).sort().slice(-days);

			const hasTokens = session.input + session.output + session.cacheRead > 0;
			// 有些 provider（如内部网关）不报价格，cost 恒为 0。
			// 直接显示 $0.0000 会让人以为免费，必须说清楚。
			const priced = session.cost > 0;
			const costText = priced
				? `$${fmt(session.cost)}`
				: hasTokens
					? "$0（该模型未配置价格，只有 token 数可信）"
					: "$0";
			const lines = [
				`本次会话：${costText} · ${session.turns} 轮 · in ${kilo(session.input)} / out ${kilo(session.output)} / cache r${kilo(session.cacheRead)} w${kilo(session.cacheWrite)}`,
				"",
				"最近几天：",
			];
			if (keys.length === 0) {
				lines.push("  （还没有记录）");
			} else {
				let total = 0;
				for (const key of keys) {
					const day = stats[key];
					total += day.cost;
					lines.push(
						`  ${key}  $${fmt(day.cost).padStart(8)}  ${String(day.turns).padStart(4)} 轮  in ${kilo(day.input)} / out ${kilo(day.output)}`,
					);
				}
				lines.push(`  合计 $${fmt(total)}`);
			}
			if (budget > 0) lines.push("", `日预算 $${fmt(budget)}（PI_DAILY_BUDGET）`);
			emit(lines.join("\n"));
		},
	});
}
