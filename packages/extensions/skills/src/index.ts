/**
 * Skills Extension — Skill 发现与注入
 *
 * P0 Extension。做两件事：
 * 1. 在 before_agent_start 时把 Skill 目录渲染进 system prompt
 * 2. 注册 /skills 命令查看可用 Skills
 *
 * Pi 自带 loadSkills，我们只是在 prompt 层做桥接。
 */

import type {
  ExtensionFactory,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadSkills,
  formatSkillsForPrompt,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ─── 缓存 ──────────────────────────────────────────────────────

let cachedSkills: Skill[] | null = null;
let cachedCwd: string | null = null;

function getSkills(cwd: string): Skill[] {
  if (cachedCwd === cwd && cachedSkills) return cachedSkills;

  const agentDir = path.join(process.env.HOME ?? "~", ".pi", "agent");

  try {
    const result: LoadSkillsResult = loadSkills({
      cwd,
      agentDir,
      skillPaths: [],
      includeDefaults: true,
    });
    cachedSkills = result.skills;
  } catch {
    cachedSkills = [];
  }

  cachedCwd = cwd;
  return cachedSkills;
}

// ─── Extension ────────────────────────────────────────────────

const skillsExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event, ctx) => {
    const skills = getSkills(ctx.cwd);
    if (skills.length === 0) return;

    const catalog = formatSkillsForPrompt(skills);
    return {
      systemPrompt: event.systemPrompt + "\n\n## 可用 Skills\n\n" + catalog,
    };
  });

  pi.registerCommand("skills", {
    description: "查看当前可用的 Skills",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const skills = getSkills(ctx.cwd);
      if (skills.length === 0) {
        ctx.ui.notify("没有找到 Skill。把 Skill 文件放在 .pi/skills/ 目录下。");
        return;
      }
      const list = skills
        .map((s, i) => `${i + 1}. **${s.name}** — ${s.description ?? "无描述"}`)
        .join("\n");
      ctx.ui.notify(`可用 Skills:\n${list}`);
    },
  });

  pi.on("session_start", () => {
    cachedSkills = null;
    cachedCwd = null;
  });
};

export default skillsExtension;
