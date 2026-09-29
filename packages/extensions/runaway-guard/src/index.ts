/**
 * Runaway Guard Extension — 防止无限工具循环
 *
 * P0 Extension。检测两种循环模式：
 * 1. 重复循环：连续 N 次相同工具+相同参数 → 阻断
 * 2. 振荡循环：A→B→A→B 交替 → 阻断
 * 3. 单 turn 调用总数超限 → 阻断
 */

import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";

// ─── 配置 ──────────────────────────────────────────────────────

const MAX_SAME_TOOL_REPEATS = 4;
const MAX_TOOL_CALLS_PER_TURN = 40;
const OSCILLATION_WINDOW = 6;

// ─── 状态 ──────────────────────────────────────────────────────

interface CallRecord {
  toolName: string;
  argsKey: string;
}

let callHistory: CallRecord[] = [];
let totalCallsThisTurn = 0;

function makeArgsKey(input: Record<string, unknown>): string {
  return Object.entries(input)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v).slice(0, 200)}`)
    .join("&");
}

// ─── 循环检测 ──────────────────────────────────────────────────

function detectRepeat(): string | null {
  if (callHistory.length < MAX_SAME_TOOL_REPEATS) return null;
  const last = callHistory[callHistory.length - 1]!;
  const window = callHistory.slice(-MAX_SAME_TOOL_REPEATS);
  if (window.every((c) => c.toolName === last.toolName && c.argsKey === last.argsKey)) {
    return `工具 \`${last.toolName}\` 以相同参数连续调用了 ${MAX_SAME_TOOL_REPEATS} 次，疑似死循环。`;
  }
  return null;
}

function detectOscillation(): string | null {
  if (callHistory.length < OSCILLATION_WINDOW) return null;
  const recent = callHistory.slice(-OSCILLATION_WINDOW);
  for (let period = 1; period <= 2; period++) {
    let isOsc = true;
    for (let i = 0; i < recent.length - period; i++) {
      const curr = recent[i]!;
      const next = recent[i + period]!;
      if (curr.toolName !== next.toolName || curr.argsKey !== next.argsKey) {
        isOsc = false;
        break;
      }
    }
    if (isOsc && period < recent.length - 1) {
      const tools = [...new Set(recent.slice(0, period).map((c) => c.toolName))].join(" → ");
      return `工具调用出现振荡模式: ${tools}，疑似死循环。`;
    }
  }
  return null;
}

// ─── Extension ────────────────────────────────────────────────

const runawayGuardExtension: ExtensionFactory = (pi) => {
  pi.on("turn_start", () => {
    callHistory = [];
    totalCallsThisTurn = 0;
  });

  pi.on("tool_call", (event: ToolCallEvent) => {
    totalCallsThisTurn++;

    const record: CallRecord = {
      toolName: event.toolName,
      argsKey: makeArgsKey(event.input as Record<string, unknown>),
    };
    callHistory.push(record);

    if (totalCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      return {
        block: true,
        reason: `🛑 单轮工具调用超过 ${MAX_TOOL_CALLS_PER_TURN} 次，终止以防无限循环。请重新审视你的策略。`,
      };
    }

    const repeatReason = detectRepeat();
    if (repeatReason) {
      return {
        block: true,
        reason: `🛑 ${repeatReason}\n\n请换一种方式解决问题：\n1. 检查工具参数是否正确\n2. 考虑使用不同的工具或分步执行\n3. 如果问题复杂，先分析再行动`,
      };
    }

    const oscReason = detectOscillation();
    if (oscReason) {
      return {
        block: true,
        reason: `🛑 ${oscReason}\n\n请换一种策略，避免在两个操作间反复切换。`,
      };
    }

    return undefined;
  });
};

export default runawayGuardExtension;
