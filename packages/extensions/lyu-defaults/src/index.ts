/**
 * Lyu-code 默认 Extension
 *
 * 演示 Pi Extension 的完整能力：
 * 1. 注册自定义工具（lyu_review：代码审查工具）
 * 2. 订阅生命周期事件（before_agent_start：注入品牌 prompt）
 * 3. 注册 slash 命令（/review）
 * 4. 审计 edit/write 操作
 */

import type {
  ExtensionFactory,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── 品牌标识 ────────────────────────────────────────────────────

const LYU_SYSTEM_PROMPT = `你是 Lyu-code，一个基于 Pi 构建的高效编程助手。
你遵循以下原则：
- 先理解再动手：修改代码前先通读相关上下文
- 最小变更：每次只改必须改的，不大面积重构
- 验证闭环：改完跑测试，确认不引入新问题
- 中文沟通，代码用英文`;

// ─── Extension 工厂函数 ──────────────────────────────────────────

const lyuDefaultsExtension: ExtensionFactory = (pi: ExtensionAPI) => {

  // ─── 自定义工具：lyu_review ──────────────────────────────────

  const reviewTool: ToolDefinition = {
    name: "lyu_review",
    label: "Review Code",
    description:
      "审查当前工作区的代码变更。检查代码风格、潜在 bug、性能问题，并给出改进建议。",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "要审查的文件路径（相对于工作区根目录）。省略则审查所有变更文件。",
        })
      ),
      focus: Type.Optional(
        Type.String({
          description: "审查重点：style | correctness | performance | security",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { path, focus = "correctness" } = params as { path?: string; focus?: string };

      // 用 pi.exec 跑 git diff（pi 是闭包捕获的 ExtensionAPI）
      const { stdout, stderr, code } = await pi.exec("git", [
        "diff",
        "--name-only",
        "HEAD",
      ]);

      if (code !== 0) {
        return {
          content: [{ type: "text" as const, text: `无法获取变更列表: ${stderr}` }],
          details: undefined,
          isError: true,
        };
      }

      const changedFiles = stdout.trim().split("\n").filter(Boolean);
      if (changedFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: "没有检测到代码变更。请先修改代码再审查。" }],
          details: undefined,
        };
      }

      const target = path ? [path] : changedFiles;
      const fileList = target.map((f: string) => `- \`${f}\``).join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `🔍 代码审查报告\n\n**审查范围**: ${focus}\n**变更文件**:\n${fileList}\n\n请基于以上文件列表，使用 \`read\` 和 \`grep\` 工具逐文件审查代码，重点关注 ${focus} 方面的问题。`,
          },
        ],
        details: undefined,
      };
    },
  };

  // 1. 注入品牌 system prompt
  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + LYU_SYSTEM_PROMPT,
    };
  });

  // 2. 注册自定义工具
  pi.registerTool(reviewTool);

  // 3. 注册 slash 命令
  pi.registerCommand("review", {
    description: "审查当前代码变更",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // 命令只是快捷入口，实际让 agent 调 lyu_review 工具
      ctx.ui.notify("🔍 启动代码审查...");
      pi.sendUserMessage("使用 lyu_review 工具审查代码变更，重点: correctness");
    },
  });

  // 4. 在工具执行后做审计日志
  pi.on("tool_result", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      // 可以在这里做审计、通知、后处理等
      // 目前只做静默观察
    }
  });

  // 5. 上下文使用率提醒
  pi.on("message_end", (event) => {
    // 可以检查 context usage 并在快满时触发 compact
    // Pi 自带 compaction，这里可以做额外策略
  });
};

export default lyuDefaultsExtension;
