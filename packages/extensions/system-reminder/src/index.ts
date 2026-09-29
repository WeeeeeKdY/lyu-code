/**
 * System Reminder Extension — 环境信息提醒
 *
 * P1 Extension。在 system prompt 中注入环境上下文：
 * 当前时间、git 分支、OS 信息等，帮助 agent 给出更准确的建议。
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as child_process from "node:child_process";

// ─── 采集环境信息 ──────────────────────────────────────────────

function getEnvInfo(cwd: string): string {
  const lines: string[] = [];

  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  lines.push(`当前时间: ${dateStr} ${timeStr}`);
  lines.push(`操作系统: ${process.platform} ${process.arch}`);

  try {
    const branch = child_process
      .execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      .trim();
    lines.push(`Git 分支: ${branch}`);

    const dirty = child_process
      .execSync("git status --porcelain", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      .trim();
    if (dirty) {
      lines.push(`未提交改动: ${dirty.split("\n").length} 个文件`);
    } else {
      lines.push("工作区: 干净");
    }
  } catch {
    // 不是 git 仓库
  }

  return lines.join("\n");
}

// ─── Extension ────────────────────────────────────────────────

const systemReminderExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event, ctx) => {
    const envInfo = getEnvInfo(ctx.cwd);
    const reminder = `\n<system-reminder>\n环境信息:\n${envInfo}\n</system-reminder>`;
    return {
      systemPrompt: event.systemPrompt + reminder,
    };
  });
};

export default systemReminderExtension;
