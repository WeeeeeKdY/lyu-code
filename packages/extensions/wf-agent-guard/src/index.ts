/**
 * WF Agent Guard Extension — Workflow 子进程的 per-agent 工具隔离守卫
 *
 * 被 workflow 引擎 spawn 的 `lyu --print` 子进程加载。
 * 读取环境变量 WORKFLOW_TOOLS_WHITELIST / WORKFLOW_TOOLS_BLACKLIST，
 * 在 agent 启动前通过 setActiveTools() 真正限制可用工具集。
 *
 * 用法（由 workflow 引擎自动构造，无需用户手动操作）:
 *   WORKFLOW_TOOLS_WHITELIST=read,bash,edit \
 *   lyu --print --no-extensions -e /path/to/wf-agent-guard "prompt"
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const wfAgentGuardExtension: ExtensionFactory = (pi) => {
  const whitelist = process.env.WORKFLOW_TOOLS_WHITELIST?.trim();
  const blacklist = process.env.WORKFLOW_TOOLS_BLACKLIST?.trim();

  if (!whitelist && !blacklist) {
    // 没有工具限制，跳过
    return;
  }

  // before_agent_start 事件：在 LLM 调用前拦截，设置工具集
  pi.on("before_agent_start", () => {
    const currentTools = pi.getActiveTools();

    if (whitelist) {
      // 白名单模式：只保留白名单里的工具
      const allowed = whitelist.split(",").map(s => s.trim()).filter(Boolean);
      pi.setActiveTools(allowed);
      console.error(`[wf-agent-guard] Whitelist: ${allowed.join(", ")}`);
    } else if (blacklist) {
      // 黑名单模式：移除黑名单里的工具
      const blocked = new Set(blacklist.split(",").map(s => s.trim()).filter(Boolean));
      const kept = currentTools.filter(t => !blocked.has(t));
      pi.setActiveTools(kept);
      console.error(`[wf-agent-guard] Blacklist removed: ${[...blocked].join(", ")}, kept: ${kept.join(", ")}`);
    }
  });
};

export default wfAgentGuardExtension;
