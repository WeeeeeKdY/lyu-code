/**
 * Plan Mode Extension — 先规划再执行
 *
 * P1 Extension。提供 Plan 模式：
 * - 进入后 agent 先出方案，不直接动手改代码
 * - 用户确认后才执行
 * - 适合复杂任务，防止 agent 一上来就乱改
 */

import type {
  ExtensionFactory,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── 状态 ──────────────────────────────────────────────────────

let planModeActive = false;
let currentPlan: string | null = null;

// ─── 工具定义 ──────────────────────────────────────────────────

const planEnterTool: ToolDefinition = {
  name: "lyu_plan",
  label: "Enter Plan Mode",
  description:
    "进入 Plan 模式。写出你的执行计划，等用户确认后再动手。用于复杂任务。",
  parameters: Type.Object({
    plan: Type.String({ description: "执行计划的详细描述" }),
  }),

  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const { plan } = params as { plan: string };
    planModeActive = true;
    currentPlan = plan;
    return {
      content: [
        {
          type: "text" as const,
          text: `📋 **执行计划**\n\n${plan}\n\n---\n请在确认无误后回复"执行"，或提出修改意见。回复"取消"退出 Plan 模式。`,
        },
      ],
      details: undefined,
    };
  },
};

const planExitTool: ToolDefinition = {
  name: "lyu_plan_exit",
  label: "Exit Plan Mode",
  description: "退出 Plan 模式，恢复正常执行。用户确认计划后调用。",
  parameters: Type.Object({
    proceed: Type.Boolean({ description: "true=按计划执行, false=取消" }),
  }),

  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const { proceed } = params as { proceed: boolean };
    if (proceed) {
      const plan = currentPlan;
      planModeActive = false;
      currentPlan = null;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Plan 模式已退出，开始执行。\n\n计划摘要: ${plan?.slice(0, 200) ?? "（无）"}\n\n现在请按照上述计划逐步执行。`,
          },
        ],
        details: undefined,
      };
    }
    planModeActive = false;
    currentPlan = null;
    return {
      content: [{ type: "text" as const, text: "❌ 已取消计划，恢复自由执行模式。" }],
      details: undefined,
    };
  },
};

// ─── Extension ────────────────────────────────────────────────

const planModeExtension: ExtensionFactory = (pi) => {
  pi.registerTool(planEnterTool);
  pi.registerTool(planExitTool);

  pi.on("before_agent_start", (event) => {
    if (planModeActive) {
      const planGuidance = `\n\n**当前处于 Plan 模式。** 在执行任何代码修改之前，先用 lyu_plan 工具写出计划等用户确认。已确认的计划:\n${currentPlan ?? "（等待计划）"}`;
      return {
        systemPrompt: event.systemPrompt + planGuidance,
      };
    }
  });

  pi.registerCommand("plan", {
    description: "进入 Plan 模式（先规划再执行）",
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      if (planModeActive) {
        _ctx.ui.notify("已在 Plan 模式中。完成当前计划后用 /plan-off 退出。");
        return;
      }
      planModeActive = true;
      const task = args || "当前任务";
      pi.sendUserMessage(
        `请使用 lyu_plan 工具制定执行计划。任务: ${task}\n\n记住：先写出完整的执行计划，包括每一步要做什么、改哪些文件、预期效果。不要直接修改任何代码。`
      );
    },
  });

  pi.registerCommand("plan-off", {
    description: "退出 Plan 模式",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      planModeActive = false;
      currentPlan = null;
    },
  });
};

export default planModeExtension;
