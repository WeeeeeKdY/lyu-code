/**
 * Context Manager Extension — 上下文窗口管理
 *
 * P1 Extension。在上下文使用率高时注入提醒，建议 agent 主动 compact。
 * Pi 自带 compaction，这个 Extension 做的是在"即将满"时提前提醒。
 */

import type {
  ExtensionFactory,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// ─── 阈值 ──────────────────────────────────────────────────────

const WARN_PERCENT = 75;
const CRITICAL_PERCENT = 90;
let lastWarnedAt = 0;

// ─── Extension ────────────────────────────────────────────────

const contextManagerExtension: ExtensionFactory = (pi) => {
  pi.on("turn_start", () => {
    lastWarnedAt = 0;
  });

  pi.on("message_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage) return;

    const percent = (usage as any).percent ?? 0;
    if (percent === 0) return;

    const now = Date.now();
    if (now - lastWarnedAt < 30_000) return;

    if (percent >= CRITICAL_PERCENT) {
      lastWarnedAt = now;
      ctx.ui.notify(
        `🔴 上下文已使用 ${Math.round(percent)}%，即将达到上限。强烈建议执行 /compact 压缩上下文。`
      );
    } else if (percent >= WARN_PERCENT) {
      lastWarnedAt = now;
      ctx.ui.notify(
        `🟡 上下文已使用 ${Math.round(percent)}%，建议适时 /compact 压缩。`
      );
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const usage = ctx.getContextUsage();
    const percent = (usage as any)?.percent ?? 0;

    let hint = "";
    if (percent >= CRITICAL_PERCENT) {
      hint = "\n\n⚠️ **上下文已接近上限**。优先执行 compact 或精简对话，避免信息丢失。";
    } else if (percent >= WARN_PERCENT) {
      hint = "\n\n💡 上下文使用率较高，回答时注意简洁，避免重复引用长文件。";
    }

    if (hint) {
      return { systemPrompt: event.systemPrompt + hint };
    }
  });

  pi.registerCommand("compact", {
    description: "压缩上下文以释放 token 空间",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.compact();
      ctx.ui.notify("📦 正在压缩上下文...");
    },
  });
};

export default contextManagerExtension;
