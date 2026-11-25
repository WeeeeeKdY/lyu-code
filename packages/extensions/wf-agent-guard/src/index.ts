/**
 * WF Agent Guard Extension — Workflow 子进程的 per-agent 工具隔离守卫 + 提问通道
 *
 * 被 workflow 引擎 spawn 的 `lyu --print` 子进程加载。
 *
 * 职责：
 *   1. 读取 WORKFLOW_TOOLS_WHITELIST / WORKFLOW_TOOLS_BLACKLIST，
 *      在 agent 启动前通过 setActiveTools() 真正限制可用工具集。
 *   2. 若存在 WORKFLOW_PROGRESS_URL，把每次工具调用回报给宿主进程。
 *      `lyu --print` 是把整段回复攒在最后一次性打印的（实测首个字节在 8.8s、只有 1 个
 *      chunk），所以光看子进程 stdout 根本拿不到「节点正在干什么」。工具调用是唯一
 *      可靠的过程信号，它就发生在这个扩展里。
 *   3. 若存在 WORKFLOW_ASK_URL（由 workflow 引擎注入），注册 ask_user 工具：
 *      它向宿主进程的 /api/ask 长轮询，把问题发到浏览器 UI，并阻塞等待用户回答。
 *      这样节点 agent 可以在执行中途真正"问人"，而不是把问题当输出文本吐出来。
 *
 * 用法（由 workflow 引擎自动构造，无需用户手动操作）:
 *   WORKFLOW_TOOLS_WHITELIST=read,bash \
 *   WORKFLOW_ASK_URL=http://127.0.0.1:18789/api/ask?wf=..&token=.. \
 *   lyu --print --no-extensions -e /path/to/wf-agent-guard "prompt"
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ASK_TOOL_NAME = "ask_user";

/**
 * 参数 schema 用纯 JSON Schema 表达，避免子进程运行时依赖 typebox 的解析路径
 * （guard 的 dist 会被复制到 workflow/dist 下执行，那里只保证有 typebox 本体）。
 */
const ASK_PARAMS_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "要问用户的问题；请写清背景和你想确认的点" },
    options: {
      type: "array",
      items: { type: "string" },
      description: "可选的建议答案；用户也可以自由输入",
    },
  },
  required: ["question"],
  // 不限制 additionalProperties：模型偶尔会多传字段，没必要因此让整次工具调用校验失败
} as const;

interface AskResponse {
  answer?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function registerAskTool(pi: ExtensionAPI, askUrl: string) {
  pi.registerTool({
    name: ASK_TOOL_NAME,
    label: "Ask User",
    description:
      "向用户提问并等待其回答。当缺少关键信息、需要在多个方案间做取舍、或即将进行不可逆操作时使用。",
    promptSnippet: "Ask the user a question and wait for their answer before continuing",
    promptGuidelines: [
      "Use ask_user whenever required information is missing, a decision belongs to the user, or an irreversible action needs confirmation — ask_user instead of guessing or asking in plain text.",
      "Never end your turn with an unanswered question in plain text; call ask_user and continue after the answer arrives.",
    ],
    // 纯 JSON Schema；类型上放宽以避免运行时依赖 typebox 的 Kind 符号
    parameters: ASK_PARAMS_SCHEMA as any,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
      const question = String(params?.question ?? "").trim();
      const options = Array.isArray(params?.options) ? params.options.map((o: unknown) => String(o)) : [];

      if (!question) return textResult("提问内容为空，未发送给用户。请补充具体问题后重试。");

      let res: Response;
      try {
        res = await fetch(askUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, options }),
          signal: signal as any,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (signal?.aborted) return textResult("运行已被中止，请立即停止。");
        return textResult(`提问通道不可用（${msg}）。请基于合理假设继续，并在结论中标注待确认项。`);
      }

      if (!res.ok) {
        return textResult(`提问通道返回 ${res.status}。请基于合理假设继续，并在结论中标注待确认项。`);
      }

      let data: AskResponse;
      try {
        data = (await res.json()) as AskResponse;
      } catch {
        return textResult("提问通道返回了无法解析的响应。请基于合理假设继续，并在结论中标注待确认项。");
      }

      if (data.cancelled) {
        return textResult("用户已取消本次运行。请立即停止，不要再调用任何工具，直接结束。");
      }
      if (data.timedOut) {
        return textResult("用户未在限时内回答。请基于合理假设继续，并在最终结论中列出待确认项。");
      }
      return textResult(`用户回答：\n${data.answer ?? ""}`);
    },
  });
}

/**
 * 一行摘要：工具调用里最能说明「在干什么」的那个字段。
 * 太长的一律截断，进度是给人扫一眼的，不是审计日志。
 */
function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  const clip = (value: unknown, max = 120) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  if (toolName === "bash") return `$ ${clip(input.command)}`;
  if (toolName === "read" || toolName === "write" || toolName === "edit") return `${toolName} ${clip(input.path)}`;
  if (toolName === "grep" || toolName === "find") return `${toolName} ${clip(input.pattern ?? input.path)}`;
  const hint = input.path ?? input.pattern ?? input.command ?? input.query;
  return hint === undefined ? toolName : `${toolName} ${clip(hint)}`;
}

/** 工具调用 → 宿主 /api/progress。fire-and-forget：进度报不上去不能影响节点执行。 */
function registerProgress(pi: ExtensionAPI, progressUrl: string): void {
  pi.on("tool_call", (event) => {
    const line = summarizeToolCall(event.toolName, (event.input ?? {}) as Record<string, unknown>);
    void fetch(progressUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => { /* 宿主没起来或已结束，忽略 */ });
    return undefined;
  });
}

const wfAgentGuardExtension: ExtensionFactory = (pi) => {
  const askUrl = process.env.WORKFLOW_ASK_URL?.trim();
  const progressUrl = process.env.WORKFLOW_PROGRESS_URL?.trim();
  const whitelist = process.env.WORKFLOW_TOOLS_WHITELIST?.trim();
  const blacklist = process.env.WORKFLOW_TOOLS_BLACKLIST?.trim();

  // 提问通道：只要有地址就注册（不受工具限制影响）
  if (askUrl) registerAskTool(pi, askUrl);

  // 进度通道：只上报，不阻塞、不失败，报不上去就算了
  if (progressUrl) registerProgress(pi, progressUrl);

  if (!whitelist && !blacklist) {
    // 没有工具限制，跳过
    return;
  }

  // before_agent_start 事件：在 LLM 调用前拦截，设置工具集
  pi.on("before_agent_start", () => {
    const currentTools = pi.getActiveTools();

    if (whitelist) {
      // 白名单模式：只保留白名单里的工具；ask_user 由引擎显式放行
      const allowed = whitelist.split(",").map(s => s.trim()).filter(Boolean);
      if (askUrl && !allowed.includes(ASK_TOOL_NAME)) allowed.push(ASK_TOOL_NAME);
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
