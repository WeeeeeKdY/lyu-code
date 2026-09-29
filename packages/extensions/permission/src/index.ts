/**
 * Permission Extension — 工具执行权限控制
 *
 * P0 核心安全 Extension。拦截两类风险：
 * 1. 危险命令：rm -rf、curl|sh、sudo 等 → 阻止
 * 2. 网络命令：curl/wget 外网 → 提醒
 *
 * Pi 自带 --mode allow/trust/deny 三档权限，这个 Extension 做的是
 * 在 trust 模式下对特定危险 pattern 做二次确认。
 */

import type {
  ExtensionFactory,
  ExtensionCommandContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

// ─── 危险 pattern 分类 ────────────────────────────────────────────

interface DangerousPattern {
  regex: RegExp;
  reason: string;
  severity: "block" | "confirm";
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // === 高危：默认阻止 ===
  {
    regex: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root.*\s+)\/[^\s]/,
    reason: "递归删除系统目录",
    severity: "block",
  },
  {
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+/,
    reason: "递归强制删除",
    severity: "block",
  },
  {
    regex: /\bdd\s+if=\/dev\/(zero|random|urandom)\s+of=\/dev\/(sd|nvme|disk)/,
    reason: "直接写磁盘设备",
    severity: "block",
  },
  {
    regex: /\bmkfs\.\w+\s+\/dev\//,
    reason: "格式化磁盘",
    severity: "block",
  },
  {
    regex: /:\(\)\{\s*:\|:\&\s*\}/,
    reason: "fork bomb",
    severity: "block",
  },

  // === 中危：需确认 ===
  {
    regex: /\bsudo\b/,
    reason: "使用 sudo 提权执行",
    severity: "confirm",
  },
  {
    regex: /\bcurl\b.*\|\s*(ba)?sh/,
    reason: "从网络下载并执行脚本",
    severity: "confirm",
  },
  {
    regex: /\bwget\b.*\|\s*(ba)?sh/,
    reason: "从网络下载并执行脚本",
    severity: "confirm",
  },
  {
    regex: /\bchmod\s+[0-7]*77[0-7]\s+/,
    reason: "设置过于宽松的权限",
    severity: "confirm",
  },
  {
    regex: /\bgit\s+push\s+--force/,
    reason: "强制推送到远程仓库",
    severity: "confirm",
  },
  {
    regex: /\bgit\s+reset\s+--hard/,
    reason: "硬重置将丢失未提交的改动",
    severity: "confirm",
  },
  {
    regex: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    reason: "强制清理未跟踪文件",
    severity: "confirm",
  },
  {
    regex: /\bdocker\s+(rm|stop|rmi)\s+(-[a-zA-Z]*f|--force)/,
    reason: "强制操作 Docker 容器/镜像",
    severity: "confirm",
  },
  {
    regex: /\bkubectl\s+delete\s+/,
    reason: "删除 Kubernetes 资源",
    severity: "confirm",
  },
];

// ─── 从 tool_call 事件提取命令字符串 ────────────────────────────

function extractCommand(event: ToolCallEvent): string | null {
  // bash 工具的 input.command
  if (event.toolName === "bash" && "command" in event.input) {
    return (event.input as { command?: string }).command ?? null;
  }
  // write 工具写可执行路径
  if (event.toolName === "write" && "path" in event.input) {
    const filePath = (event.input as { path?: string }).path ?? "";
    if (filePath.startsWith("/usr/") || filePath.startsWith("/etc/")) {
      return `write ${filePath}`;
    }
  }
  return null;
}

// ─── 检查命令是否命中危险 pattern ────────────────────────────────

function checkCommand(command: string): DangerousPattern | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.regex.test(command)) {
      return pattern;
    }
  }
  return null;
}

// ─── Extension ────────────────────────────────────────────────

const permissionExtension: ExtensionFactory = (pi) => {
  // 拦截工具调用前的权限检查
  pi.on("tool_call", (event, ctx) => {
    if (!ctx.hasUI) return;

    const command = extractCommand(event);
    if (!command) return;

    const hit = checkCommand(command);
    if (!hit) return;

    if (hit.severity === "block") {
      return {
        block: true,
        reason: `⛔ 安全拦截：${hit.reason}\n命令: \`${command}\`\n如果确实需要执行，请直接在终端中运行。`,
      };
    }

    return {
      block: true,
      reason: `⚠️ 需要确认：${hit.reason}\n命令: \`${command}\`\n如果确认执行，请在终端中直接运行，或设置环境变量 LYU_UNSAFE=1 跳过安全检查。`,
    };
  });

  // 注册 /lyu-permission 命令
  pi.registerCommand("lyu-permission", {
    description: "查看 Lyu-code 权限配置和危险命令规则",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const rules = DANGEROUS_PATTERNS.map(
        (p, i) => `${i + 1}. [${p.severity === "block" ? "⛔ 阻止" : "⚠️ 确认"}] ${p.reason}`
      ).join("\n");
      ctx.ui.notify(`Lyu-code 安全规则:\n${rules}`);
    },
  });
};

export default permissionExtension;
