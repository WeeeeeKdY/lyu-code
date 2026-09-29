/**
 * Tool Output Budget Extension — 工具输出预算控制
 *
 * P2 Extension。当工具输出过长时自动截断，防止上下文被撑爆。
 * 检测 tool_result 中的长文本，超过阈值时返回截断后的 content。
 */

import type { ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";

// ─── 配置 ──────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 30_000;
const TRUNCATE_TO = 15_000;
const MAX_OUTPUT_LINES = 500;
const TRUNCATE_LINES_TO = 250;

// ─── 截断逻辑 ──────────────────────────────────────────────────

function truncateText(text: string): string | null {
  if (text.length > MAX_OUTPUT_CHARS) {
    const head = text.slice(0, TRUNCATE_TO);
    return `${head}\n\n... [输出已截断: 原始 ${text.length.toLocaleString()} 字符，保留 ${TRUNCATE_TO.toLocaleString()} 字符] ...`;
  }

  const lines = text.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    const kept = lines.slice(0, TRUNCATE_LINES_TO);
    return `${kept.join("\n")}\n\n... [输出已截断: 原始 ${lines.length} 行，保留 ${TRUNCATE_LINES_TO} 行] ...`;
  }

  return null;
}

// ─── Extension ────────────────────────────────────────────────

const toolOutputBudgetExtension: ExtensionFactory = (pi) => {
  pi.on("tool_result", (event: ToolResultEvent) => {
    // 遍历所有文本内容块，检查是否需要截断
    let modified = false;
    const newContent = event.content.map((block) => {
      if (block.type !== "text") return block;

      const truncated = truncateText(block.text);
      if (truncated) {
        modified = true;
        return { ...block, text: truncated };
      }
      return block;
    });

    if (modified) {
      // 返回 ToolResultEventResult 来修改内容
      return { content: newContent };
    }
  });
};

export default toolOutputBudgetExtension;
