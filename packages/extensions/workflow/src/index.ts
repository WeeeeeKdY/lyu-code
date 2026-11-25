/**
 * Workflow Extension for lyu-code
 *
 * /workflow — 打开本地前端页面，可视化编排多 agent 工作流
 *
 * 架构：
 *   - 命令启动本地 HTTP 服务（默认 18789）+ WebSocket
 *   - serve frontend/dist/ 下的静态文件
 *   - WebSocket 通道让前端和 Pi 通信
 *   - 前端发指令（addNode, connect, run, stop, ...）
 *   - 扩展执行操作，回传状态和结果
 *
 * 用法：
 *   /workflow        — 打开编辑器
 *   /workflow stop   — 关闭服务
 *
 * 人机协同（节点 agent 中途提问）：
 *   浏览器 UI ──ws run:answer──▶ 本服务 ──HTTP 200──▶ 子进程 ask_user 工具
 *        ▲                          │                            │
 *        └──ws run:needInput────────┘        agent 在同一个 session 里继续
 *   - 子进程（guard 扩展）拿 WORKFLOW_ASK_URL 打到 /api/ask，长轮询等回答
 *   - run 状态置 paused（编排暂停，节点仍 running），答完自动回 running
 *   - 超时 / 中止 / 子进程死掉 / 没人看页面 都会收敛，不会留下悬挂请求
 *
 * 环境变量：
 *   WORKFLOW_ASK_TIMEOUT_MS  单个提问的等待上限（默认 10 分钟）
 *   WORKFLOW_NODE_TIMEOUT_MS 单个节点的硬上限（默认 60 分钟）
 *   LYU_WORKFLOW_NO_OPEN=1   不自动打开浏览器（测试/无头）
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RUNS_DIR,
  flushAll as flushRunHistory,
  listRuns,
  observeRun,
  readRun,
  startRun,
  type ObservableState,
} from "./run-history.js";

const DEFAULT_PORT = 18789;

// ─── Workflow 数据模型 ─────────────────────────────────────────────

interface WorkflowNode {
  id: string;
  type: "input" | "agent" | "if" | "for" | "output";
  label: string;
  config: {
    // agent
    systemPrompt?: string;
    model?: string;
    tools?: string[];            // 白名单模式：只允许这些工具
    disabledTools?: string[];    // 黑名单模式：禁用这些工具
    customTools?: CustomTool[];  // 通过 extension 注册的自定义工具
    extensions?: string[];       // 额外加载到本节点子进程的 pi 扩展（路径，支持 ~）
    mcpConfig?: string;          // MCP 配置文件路径（支持 ~）；不给就用 ~/.pi/agent/mcp.json
    maxLoops?: number;
    maxTokens?: number;
    // if: declarative condition; legacy JS expressions are rejected
    condition?: string;
    conditionOperator?: "contains" | "not_contains" | "equals" | "not_equals" | "is_empty" | "is_not_empty";
    conditionValue?: string;
    // for
    loopCount?: number;         // 循环次数（静态）
    loopExpr?: string;          // legacy; no longer executed
    breakCondition?: string;    // legacy; no longer executed
    loopBodyNodeIds?: string[]; // 循环体内节点 ID（子图）
  };
  position: { x: number; y: number };
}

interface CustomTool {
  name: string;
  description: string;
  type: "extension" | "builtin" | "mcp";
  source?: string;  // extension 名 / MCP server 名
  schema?: Record<string, unknown>;  // JSON Schema for parameters
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;           // e.g. "true" / "false" for if-node 分支
  sourcePort?: string;     // "out" | "true" | "false" | "body" | "done"
}

interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  globalMaxLoops: number;
  maxUpstreamLength: number; // 单个上游输出最大字符数，0=不限
  createdAt: number;
  updatedAt: number;
}

/** 节点 agent 抛给用户的问题（展示在浏览器 UI 里等待回答） */
interface PendingAskInfo {
  askId: string;
  nodeId: string;
  nodeLabel: string;
  question: string;
  options: string[];
  iteration?: number;
  askedAt: number;
}

/** /api/ask 上挂起的长轮询请求 */
interface PendingAsk extends PendingAskInfo {
  workflowId: string;
  res: http.ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface AskAnswer {
  answer?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

interface RunState {
  status: "idle" | "running" | "paused" | "error" | "done";
  currentStep?: string;
  finalOutput?: string;
  error?: string;
  iteration: number;
  pendingAsks?: PendingAskInfo[];
  results: Record<string, {
    status: "pending" | "running" | "done" | "error" | "skipped";
    output?: string;
    error?: string;
    iterations?: number;
    asks?: { question: string; answer: string; timedOut?: boolean }[];
  }>;
}

// ─── 简易 WebSocket (RFC 6455, 最小实现) ──────────────────────────

function wsAcceptKey(key: string): string {
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

interface WsClient {
  socket: import("node:stream").Duplex & { destroy: () => void };
  send: (data: string) => void;
}

// ─── 全局状态 ──────────────────────────────────────────────────────

let server: http.Server | null = null;
let port = DEFAULT_PORT;
let piRef: ExtensionAPI | null = null;

const workflows = new Map<string, Workflow>();
const runStates = new Map<string, RunState>();
const runControllers = new Map<string, AbortController>();
const wsClients: WsClient[] = [];
const registeredCustomTools = new Map<string, CustomTool>();
const savedWorkflowDir = path.join(os.homedir(), ".pi", "agent", "workflows");

// 提问通道：runId -> 本次运行的调用令牌（防止本机其它进程乱答）
const runTokens = new Map<string, string>();
// askId -> 在途的长轮询请求
const pendingAsks = new Map<string, PendingAsk>();

const ASK_TIMEOUT_MS = Number(process.env.WORKFLOW_ASK_TIMEOUT_MS) || 10 * 60_000;
// 单个 agent 节点的硬上限；等待用户回答时子进程本身不设超时
const NODE_TIMEOUT_MS = Number(process.env.WORKFLOW_NODE_TIMEOUT_MS) || 60 * 60_000;

function savedPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("无效的工作流 ID");
  return path.join(savedWorkflowDir, `${id}.json`);
}

function listSavedWorkflows() {
  if (!fs.existsSync(savedWorkflowDir)) return [];
  return fs.readdirSync(savedWorkflowDir).filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(name))
    .map(name => {
      try {
        const wf = JSON.parse(fs.readFileSync(path.join(savedWorkflowDir, name), "utf8")) as Workflow;
        return { id: wf.id, name: wf.name, updatedAt: wf.updatedAt };
      } catch { return null; }
    }).filter((item): item is { id: string; name: string; updatedAt: number } => item !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── 广播 ──────────────────────────────────────────────────────────

function broadcast(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  for (const c of wsClients) {
    try { c.send(msg); } catch { /* ignore */ }
  }
  // 运行历史：引擎每次状态变化都从这个出口流出去，观察者挂在这里就够了，
  // 不用在每个分支里埋点（以后加新节点类型也不会漏记）。
  if (type === "run:state") {
    const payload = data as { workflowId?: string; state?: ObservableState } | null;
    if (payload?.workflowId && payload.state) observeRun(payload.workflowId, payload.state);
  }
}

// ─── 前端静态文件 ──────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

function getFrontendDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(thisDir, "..", "frontend", "dist");
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
  const frontendDir = getFrontendDir();
  const url = new URL(req.url ?? "/", "http://localhost");
  let urlPath = url.pathname;

  // API 路由
  if (urlPath.startsWith("/api/")) {
    handleApi(req, res, urlPath, url);
    return;
  }

  // 静态文件
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.resolve(frontendDir, `.${urlPath}`);

  try {
    if (filePath !== frontendDir && !filePath.startsWith(frontendDir + path.sep)) { res.writeHead(403); res.end(); return; }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not file");
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": (MIME[ext] || "application/octet-stream") + "; charset=utf-8" });
    res.end(fs.readFileSync(filePath));
  } catch {
    // SPA fallback
    try {
      const fallback = path.join(frontendDir, "index.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(fallback));
    } catch {
      res.writeHead(404);
      res.end("Not found — put frontend files in frontend/dist/");
    }
  }
}

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, url: URL) {
  const ok = (d: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };

  if (urlPath === "/api/workflows") {
    ok([...workflows.values()].map(w => ({ id: w.id, name: w.name, nodeCount: w.nodes.length, globalMaxLoops: w.globalMaxLoops })));
  } else if (urlPath === "/api/status") {
    ok({ ok: true, workflows: workflows.size, clients: wsClients.length, pendingAsks: pendingAsks.size });
  } else if (urlPath === "/api/runs") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
    ok({ runs: listRuns(limit), dir: RUNS_DIR });
  } else if (urlPath.startsWith("/api/runs/")) {
    const run = readRun(decodeURIComponent(urlPath.slice("/api/runs/".length)));
    if (!run) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no such run" }));
      return;
    }
    ok(run);
  } else if (urlPath === "/api/ask") {
    void handleAsk(req, res, url);
  } else {
    ok({ error: "not found" });
  }
}

// ─── 提问通道（节点 agent <-> 浏览器） ────────────────────────────

function askInfo(ask: PendingAsk): PendingAskInfo {
  const { askId, nodeId, nodeLabel, question, options, iteration, askedAt } = ask;
  return { askId, nodeId, nodeLabel, question, options, iteration, askedAt };
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 结束一个在途提问：回写 HTTP、恢复 run 状态、记入节点结果 */
function settleAsk(ask: PendingAsk, answer: AskAnswer) {
  if (ask.settled) return;
  ask.settled = true;
  clearTimeout(ask.timer);
  pendingAsks.delete(ask.askId);

  const state = runStates.get(ask.workflowId);
  if (state) {
    state.pendingAsks = (state.pendingAsks ?? []).filter(a => a.askId !== ask.askId);
    const nodeResult = state.results[ask.nodeId];
    if (nodeResult) {
      nodeResult.asks = [...(nodeResult.asks ?? []), { question: ask.question, answer: answer.answer ?? "", timedOut: answer.timedOut }];
    }
    // 最后一个提问结束后才解除 paused；节点自身的 status 始终保持 running
    if (state.status === "paused" && !state.pendingAsks.length) state.status = "running";
    broadcast("run:state", { workflowId: ask.workflowId, state });
  }

  if (!ask.res.writableEnded) {
    try {
      ask.res.writeHead(200, { "Content-Type": "application/json" });
      ask.res.end(JSON.stringify(answer));
    } catch { /* 客户端已断开，忽略 */ }
  }
}

/** 运行中止 / 服务关闭时，把所有挂起的提问一口气结掉，避免子进程和前端卡死 */
function cancelAsksFor(workflowId: string, answer: AskAnswer = { cancelled: true }) {
  for (const ask of [...pendingAsks.values()]) {
    if (ask.workflowId === workflowId) settleAsk(ask, answer);
  }
}

async function handleAsk(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const wfId = url.searchParams.get("wf") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!wfId || !token || token !== runTokens.get(wfId)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer: "提问通道鉴权失败。请基于合理假设继续，并在结论中标注待确认项。" }));
    return;
  }

  const state = runStates.get(wfId);
  if (!state || (state.status !== "running" && state.status !== "paused")) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: true, answer: "本次运行已结束，提问已失效。请立即停止。" }));
    return;
  }

  let body: { question?: string; options?: unknown; nodeId?: string; nodeLabel?: string; iteration?: number };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer: "提问内容无法解析。请基于合理假设继续。" }));
    return;
  }

  const question = String(body.question ?? "").trim();
  if (!question) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer: "提问内容为空。请基于合理假设继续。" }));
    return;
  }

  // 没人在看：直接告诉 agent 自己拿主意，而不是白等 10 分钟
  if (wsClients.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer: "当前没有打开的工作流页面，无法向用户提问。请基于合理假设继续，并在结论中标注待确认项。" }));
    return;
  }

  const ask: PendingAsk = {
    askId: crypto.randomUUID(),
    workflowId: wfId,
    nodeId: String(body.nodeId ?? state.currentStep ?? ""),
    nodeLabel: String(body.nodeLabel ?? body.nodeId ?? "Agent"),
    question: question.slice(0, 4000),
    options: Array.isArray(body.options) ? body.options.map((o) => String(o).slice(0, 200)).slice(0, 12) : [],
    iteration: typeof body.iteration === "number" ? body.iteration : undefined,
    askedAt: Date.now(),
    res,
    timer: setTimeout(() => { /* 被下面覆盖 */ }, 0),
    settled: false,
  };
  ask.timer = setTimeout(() => settleAsk(ask, { timedOut: true }), ASK_TIMEOUT_MS);
  pendingAsks.set(ask.askId, ask);

  // 整个 run 进入 paused（暂停的是"编排"，节点本身仍在等回答）
  state.status = "paused";
  state.pendingAsks = [...(state.pendingAsks ?? []), askInfo(ask)];
  broadcast("run:needInput", { workflowId: wfId, ...askInfo(ask) });
  broadcast("run:state", { workflowId: wfId, state });

  // 子进程被杀（abort/超时）时 HTTP 连接会断开：及时收敛，别留下悬挂请求
  res.on("close", () => { if (!res.writableEnded) settleAsk(ask, { cancelled: true }); });
}

// ─── WebSocket 消息处理 ────────────────────────────────────────────

function handleWsMessage(raw: string) {
  let msg: { type: string; data?: any; id?: string };
  try { msg = JSON.parse(raw); } catch { return; }

  try {
    switch (msg.type) {
    case "workflow:create": {
      const existing = runStates.get(msg.data?.id);
      if (existing?.status === "running") throw new Error("运行中不可修改工作流");
      const wf: Workflow = {
        id: msg.data?.id ?? crypto.randomUUID(),
        name: msg.data?.name ?? "Untitled Workflow",
        nodes: msg.data?.nodes ?? [],
        edges: msg.data?.edges ?? [],
        globalMaxLoops: msg.data?.globalMaxLoops ?? 10,
        maxUpstreamLength: msg.data?.maxUpstreamLength ?? 8000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      workflows.set(wf.id, wf);
      runStates.set(wf.id, { status: "idle", iteration: 0, results: {} });
      broadcast("workflow:created", wf);
      break;
    }

    case "workflow:update": {
      const wf = workflows.get(msg.data?.id);
      if (runStates.get(msg.data?.id)?.status === "running") throw new Error("运行中不可修改工作流");
      if (wf) { Object.assign(wf, msg.data, { updatedAt: Date.now() }); broadcast("workflow:updated", wf); }
      break;
    }

    case "workflow:delete": {
      cancelAsksFor(msg.data?.id);
      runControllers.get(msg.data?.id)?.abort();
      runControllers.delete(msg.data?.id);
      workflows.delete(msg.data?.id);
      runStates.delete(msg.data?.id);
      broadcast("workflow:deleted", { id: msg.data?.id });
      break;
    }

    case "node:add": {
      const wf = workflows.get(msg.data?.workflowId);
      if (wf) { wf.nodes.push(msg.data.node); wf.updatedAt = Date.now(); broadcast("workflow:updated", wf); }
      break;
    }

    case "node:update": {
      const wf = workflows.get(msg.data?.workflowId);
      if (wf) { const i = wf.nodes.findIndex(n => n.id === msg.data.node.id); if (i >= 0) { wf.nodes[i] = { ...wf.nodes[i], ...msg.data.node }; wf.updatedAt = Date.now(); broadcast("workflow:updated", wf); } }
      break;
    }

    case "node:remove": {
      const wf = workflows.get(msg.data?.workflowId);
      if (wf) {
        wf.nodes = wf.nodes.filter(n => n.id !== msg.data.nodeId);
        wf.edges = wf.edges.filter(e => e.source !== msg.data.nodeId && e.target !== msg.data.nodeId);
        wf.updatedAt = Date.now();
        broadcast("workflow:updated", wf);
      }
      break;
    }

    case "edge:add": {
      const wf = workflows.get(msg.data?.workflowId);
      if (wf) { wf.edges.push(msg.data.edge); wf.updatedAt = Date.now(); broadcast("workflow:updated", wf); }
      break;
    }

    case "edge:remove": {
      const wf = workflows.get(msg.data?.workflowId);
      if (wf) { wf.edges = wf.edges.filter(e => e.id !== msg.data.edgeId); wf.updatedAt = Date.now(); broadcast("workflow:updated", wf); }
      break;
    }

    case "workflow:run": {
      const wfId = msg.data?.workflowId;
      const wf = workflows.get(wfId);
      if (!wf || runStates.get(wfId)?.status === "running") break;

      validateWorkflow(wf);
      const input = String(msg.data?.input ?? "").trim();
      if (!input) throw new Error("请输入本次运行的用户输入");
      cancelAsksFor(wfId); // 清掉上一次运行残留的悬挂提问
      const state: RunState = { status: "running", iteration: 0, results: {}, pendingAsks: [] };
      for (const n of wf.nodes) state.results[n.id] = { status: "pending" };
      startRun({
        runId: crypto.randomUUID(),
        workflowId: wfId,
        workflowName: wf.name,
        input,
        nodeLabels: Object.fromEntries(wf.nodes.map(n => [n.id, n.label])),
        workflowSnapshot: wf,
      });
      launchRun(wf, state, input);
      break;
    }

    // 续跑/重试：把历史里已成功的节点填回去，从出错节点（或指定节点）往后重算。
    case "workflow:resume": {
      const record = readRun(String(msg.data?.runId ?? ""));
      if (!record) throw new Error("找不到这次运行记录");
      if (runStates.get(record.workflowId)?.status === "running") {
        throw new Error("这个工作流正在运行，先停止再重试");
      }

      // 定义优先用内存里的（用户可能改过），没有就用运行时的快照重建。
      let wf = workflows.get(record.workflowId);
      if (!wf) {
        const snapshot = record.workflowSnapshot as Workflow | undefined;
        if (!snapshot?.nodes || !Array.isArray(snapshot.edges)) {
          throw new Error("运行记录里没有工作流定义，无法重试");
        }
        wf = snapshot;
        workflows.set(wf.id, wf);
        broadcast("workflow:created", wf);
      }
      validateWorkflow(wf);

      const requested = msg.data?.nodeId ? String(msg.data.nodeId) : undefined;
      const startNodeId = requested
        ?? record.currentStep
        ?? Object.keys(record.nodes).find(id => record.nodes[id]?.status === "error")
        ?? Object.keys(record.nodes).find(id => record.nodes[id]?.status !== "done");
      if (!startNodeId || !wf.nodes.some(n => n.id === startNodeId)) {
        throw new Error("不知道该从哪个节点重试");
      }

      const replay = downstreamOf(wf, startNodeId);
      const state: RunState = { status: "running", iteration: 0, results: {}, pendingAsks: [] };
      for (const node of wf.nodes) {
        const saved = record.nodes[node.id];
        const reuse = saved && !replay.has(node.id) && (saved.status === "done" || saved.status === "skipped");
        state.results[node.id] = reuse
          ? {
              status: saved.status === "skipped" ? "skipped" : "done",
              output: saved.output,
              iterations: saved.iterations,
            }
          : { status: "pending" };
      }

      cancelAsksFor(wf.id);
      startRun({
        runId: crypto.randomUUID(),
        workflowId: wf.id,
        workflowName: wf.name,
        input: record.input,
        nodeLabels: Object.fromEntries(wf.nodes.map(n => [n.id, n.label])),
        workflowSnapshot: wf,
        resumedFrom: record.runId,
      });
      launchRun(wf, state, record.input);
      break;
    }

    case "workflow:stop": {
      const wfId = msg.data?.workflowId;
      const state = runStates.get(wfId);
      cancelAsksFor(wfId, { cancelled: true }); // 先把挂着的提问结掉，子进程才会退出
      runControllers.get(wfId)?.abort();
      runControllers.delete(wfId);
      runTokens.delete(wfId);
      if (state) { state.status = "idle"; state.pendingAsks = []; broadcast("run:state", { workflowId: wfId, state }); }
      break;
    }

    case "run:answer": {
      const ask = pendingAsks.get(String(msg.data?.askId ?? ""));
      if (!ask) throw new Error("该提问已失效（可能已超时或运行已结束）");
      settleAsk(ask, { answer: String(msg.data?.answer ?? "") });
      break;
    }

    case "workflow:save": {
      const wf = msg.data?.workflow;
      if (runStates.get(wf?.id)?.status === "running") throw new Error("运行中不可保存工作流");
      if (!wf || typeof wf.name !== "string" || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
        throw new Error("工作流格式无效");
      }
      const id = typeof wf.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wf.id) ? wf.id : crypto.randomUUID();
      const file = savedPath(id);
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Workflow : undefined;
      const saved: Workflow = {
        id, name: wf.name.slice(0, 120), nodes: wf.nodes, edges: wf.edges,
        globalMaxLoops: 1, maxUpstreamLength: wf.maxUpstreamLength ?? 8000,
        createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      validateWorkflow(saved, false);
      fs.mkdirSync(savedWorkflowDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
      workflows.set(id, saved);
      runStates.set(id, { status: "idle", iteration: 0, results: {} });
      broadcast("workflow:saved", { workflow: saved, saved: listSavedWorkflows() });
      break;
    }
    case "workflow:list": {
      broadcast("workflow:list", { saved: listSavedWorkflows() });
      break;
    }
    case "workflow:load": {
      if (runStates.get(msg.data?.id)?.status === "running") throw new Error("运行中不可读取工作流");
      const file = savedPath(String(msg.data?.id ?? ""));
      const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
      validateWorkflow(loaded, false);
      workflows.set(loaded.id, loaded);
      runStates.set(loaded.id, { status: "idle", iteration: 0, results: {} });
      broadcast("workflow:loaded", loaded);
      break;
    }
    case "agent:send": {
      if (piRef) {
        piRef.sendUserMessage(msg.data?.message ?? "", { deliverAs: "followUp" });
      }
      break;
    }

    // ─── 工具管理 ────────────────────────────────
    case "tool:list": {
      const builtinTools = [
        { name: "read", description: "Read file contents", type: "builtin" },
        { name: "write", description: "Write file contents", type: "builtin" },
        { name: "edit", description: "Edit file with exact text replacement", type: "builtin" },
        { name: "bash", description: "Execute bash commands", type: "builtin" },
        { name: "grep", description: "Search files by pattern", type: "builtin" },
        { name: "glob", description: "Find files by glob pattern", type: "builtin" },
        { name: "web_search", description: "Search the web", type: "builtin" },
        { name: "mcp", description: "Call MCP server tools", type: "mcp" },
      ];
      const customTools = [...registeredCustomTools.values()];
      broadcast("tool:list", { builtin: builtinTools, custom: customTools });
      break;
    }

    case "tool:register": {
      const tool: CustomTool = {
        name: msg.data?.name,
        description: msg.data?.description ?? "",
        type: msg.data?.toolType ?? "extension",
        source: msg.data?.source,
        schema: msg.data?.schema,
      };
      if (tool.name) {
        registeredCustomTools.set(tool.name, tool);
        broadcast("tool:registered", tool);
      }
      break;
    }

    case "tool:unregister": {
      registeredCustomTools.delete(msg.data?.name);
      broadcast("tool:unregistered", { name: msg.data?.name });
      break;
    }
    }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    broadcast("workflow:error", { message });
  }
}

// ─── Workflow 执行引擎 ─────────────────────────────────────────────

function validateWorkflow(wf: Workflow, requireExecutable = true): void {
  if (!Array.isArray(wf.nodes) || !Array.isArray(wf.edges) || wf.nodes.length > 200 || wf.edges.length > 500) throw new Error("工作流节点或连线数量无效");
  const ids = new Set(wf.nodes.map(n => n.id));
  if (ids.size !== wf.nodes.length) throw new Error("节点 ID 重复");
  if (wf.nodes.filter(n => n.type === "input").length > 1 || wf.nodes.filter(n => n.type === "output").length > 1) throw new Error("Input 和 Output 节点最多各一个");
  if (requireExecutable && (wf.nodes.filter(n => n.type === "input").length !== 1 || wf.nodes.filter(n => n.type === "output").length !== 1)) throw new Error("请添加且仅添加一个 Input 和一个 Output 节点");
  for (const node of wf.nodes) {
    if (!["input", "agent", "if", "for", "output"].includes(node.type)) throw new Error("未知节点类型");
  }
  for (const edge of wf.edges) {
    const src = wf.nodes.find(n => n.id === edge.source);
    const dst = wf.nodes.find(n => n.id === edge.target);
    if (!src || !dst || src.type === "output" || dst.type === "input") throw new Error("存在无效连线");
    if (dst.type === "output" && edge.sourcePort === "body") throw new Error("For body 端口不能直接连接 Output");
    const port = edge.sourcePort || "out";
    if (!(src.type === "if" ? ["true", "false"] : src.type === "for" ? ["body", "done"] : ["out"]).includes(port)) throw new Error("连线端口无效");
  }
  if (!requireExecutable) return; // 草稿允许未连接、未配置的节点；运行前再做完整校验。
  const inputId = wf.nodes.find(n => n.type === "input")!.id;
  const reachable = new Set([inputId]);
  for (const layer of topoLayers(wf.nodes, wf.edges)) for (const n of layer) {
    if (reachable.has(n.id)) for (const edge of wf.edges.filter(e => e.source === n.id)) reachable.add(edge.target);
  }
  if (reachable.size !== wf.nodes.length) throw new Error("所有节点必须从 Input 可达；请检查悬空节点");
  for (const node of wf.nodes) {
    if (node.type === "if" && (!node.config.conditionOperator || !["contains", "not_contains", "equals", "not_equals", "is_empty", "is_not_empty"].includes(node.config.conditionOperator))) throw new Error(`If 节点 ${node.label} 请重新选择条件，旧表达式已停用`);
    if (node.type === "for") {
      if (!Number.isInteger(node.config.loopCount) || node.config.loopCount! < 1 || node.config.loopCount! > 100) throw new Error("For 循环次数必须为 1–100");
      if (node.config.loopExpr || node.config.breakCondition) throw new Error("旧版 For 表达式已停用，请改为固定循环次数");
      for (const e of wf.edges.filter(e => e.source === node.id && e.sourcePort === "body")) {
        const body = wf.nodes.find(n => n.id === e.target)!;
        if (body.type !== "agent" || wf.edges.some(next => next.source === body.id) || wf.edges.filter(next => next.target === body.id).length !== 1) throw new Error("For 的 body 目前只支持仅由该 For 连接且无后续连线的 Agent；后续流程请连接 done 端口");
      }
    }
  }
  const outputId = wf.nodes.find(n => n.type === "output")!.id;
  if (!wf.edges.some(e => e.target === outputId)) throw new Error("请连接 Output 节点");
  if (!reachable.has(outputId)) throw new Error("Output 必须从 Input 可达");
}

function activeIncoming(nodeId: string, wf: Workflow, state: RunState): WorkflowEdge[] {
  return wf.edges.filter(e => e.target === nodeId && state.results[e.source]?.status === "done" &&
    (wf.nodes.find(n => n.id === e.source)?.type !== "if" || e.sourcePort === state.results[e.source]?.output) &&
    (wf.nodes.find(n => n.id === e.source)?.type !== "for" || e.sourcePort === "done"));
}

function sourceOutput(edge: WorkflowEdge, wf: Workflow, state: RunState): string {
  const source = wf.nodes.find(n => n.id === edge.source);
  if (source?.type !== "if") return state.results[edge.source]?.output ?? "";
  return activeIncoming(source.id, wf, state).map(parent => sourceOutput(parent, wf, state)).join("\n");
}

/** paused 只是"编排在等用户回答"，不等于停止；只有 idle/error/done 才是真的不跑了 */
function isRunLive(state: RunState): boolean {
  return state.status === "running" || state.status === "paused";
}

/**
 * 从某个节点出发、沿边能到达的所有节点（含自己）。
 * 续跑时要重算的就是这些：上游已经成功的节点沿用上次的输出，不重复花钱。
 */
function downstreamOf(wf: Workflow, nodeId: string): Set<string> {
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of wf.edges) {
      if (edge.source !== current || seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return seen;
}

/** 起一次运行：登记 state/abort/token，广播首帧，接上错误处理。首次运行与续跑共用。 */
function launchRun(wf: Workflow, state: RunState, input: string): void {
  const controller = new AbortController();
  runStates.set(wf.id, state);
  runControllers.set(wf.id, controller);
  runTokens.set(wf.id, crypto.randomBytes(16).toString("hex"));
  broadcast("run:state", { workflowId: wf.id, state });

  runWorkflow(wf, state, input, controller.signal).catch(err => {
    if (controller.signal.aborted || !isRunLive(state)) return;
    state.status = "error";
    state.error = String(err);
    controller.abort(); // 一个节点失败时终止同层仍在运行的 Agent。
    broadcast("run:state", { workflowId: wf.id, state });
  }).finally(() => {
    if (runControllers.get(wf.id) === controller) runControllers.delete(wf.id);
    runTokens.delete(wf.id);
  });
}

async function runWorkflow(wf: Workflow, state: RunState, input: string, signal: AbortSignal): Promise<void> {
  const layers = topoLayers(wf.nodes, wf.edges);
  state.iteration = 1;
  for (const layer of layers) {
    if (!isRunLive(state)) return;
    const ready = layer.filter(n => {
      if (state.results[n.id]?.status !== "pending") return false;
      if (wf.edges.some(e => e.sourcePort === "body" && e.target === n.id)) {
        state.results[n.id] = { status: "skipped" };
        return false;
      }
      if (n.type === "input") return true;
      const active = activeIncoming(n.id, wf, state);
      if (active.length) return true;
      state.results[n.id] = { status: "skipped" };
      return false;
    });
    await Promise.all(ready.map(async node => {
      const ns = state.results[node.id]!;
      ns.status = "running";
      state.currentStep = node.id;
      broadcast("run:state", { workflowId: wf.id, state });
      if (node.type === "input") ns.output = input;
      else if (node.type === "agent") ns.output = await executeAgentNode(node, collectUpstream(node.id, wf, state), signal, { workflowId: wf.id, iteration: state.iteration });
      else if (node.type === "if") {
        const value = activeIncoming(node.id, wf, state).map(e => sourceOutput(e, wf, state)).join("\n");
        ns.output = evaluateIf(node, value) ? "true" : "false";
        broadcast("run:ifBranch", { workflowId: wf.id, nodeId: node.id, branch: ns.output === "true" });
      } else if (node.type === "for") {
        const bodyEdges = wf.edges.filter(e => e.source === node.id && e.sourcePort === "body");
        for (let i = 0; i < node.config.loopCount!; i++) {
          if (!isRunLive(state)) return;
          await Promise.all(bodyEdges.map(async e => {
            const body = wf.nodes.find(n => n.id === e.target)!;
            const result = state.results[body.id]!;
            result.status = "running";
            broadcast("run:state", { workflowId: wf.id, state });
            result.output = await executeAgentNode(body, `${collectUpstream(node.id, wf, state)}\n\n循环第 ${i + 1}/${node.config.loopCount} 次`, signal, { workflowId: wf.id, iteration: i + 1 });
            if (signal.aborted) return;
            result.iterations = (result.iterations ?? 0) + 1;
            result.status = "done";
            broadcast("run:state", { workflowId: wf.id, state });
          }));
        }
        ns.output = bodyEdges.length ? bodyEdges.map(e => `${wf.nodes.find(n => n.id === e.target)!.label}: ${state.results[e.target]?.output ?? ""}`).join("\n") : `looped ${node.config.loopCount} times`;
      } else {
        const upstream = activeIncoming(node.id, wf, state);
        ns.output = upstream.length === 1 ? sourceOutput(upstream[0]!, wf, state) : collectUpstream(node.id, wf, state);
        state.finalOutput = ns.output;
      }
      if (signal.aborted) return;
      ns.status = "done";
      broadcast("run:state", { workflowId: wf.id, state });
    }));
  }
  if (!isRunLive(state)) return;
  if (state.results[wf.nodes.find(n => n.type === "output")!.id]?.status !== "done") throw new Error("本次执行未到达 Output 节点；请检查分支连线");
  state.status = "done";
  state.currentStep = undefined;
  broadcast("run:state", { workflowId: wf.id, state });
}

function evaluateIf(node: WorkflowNode, value: string): boolean {
  const expected = node.config.conditionValue ?? "";
  switch (node.config.conditionOperator) {
    case "contains": return value.includes(expected);
    case "not_contains": return !value.includes(expected);
    case "equals": return value === expected;
    case "not_equals": return value !== expected;
    case "is_empty": return value.trim() === "";
    case "is_not_empty": return value.trim() !== "";
    default: throw new Error("未知条件运算符");
  }
}

/** 收集上游输出，JSON 包层带来源标识，截断过长输出 */
function collectUpstream(nodeId: string, wf: Workflow, state: RunState): string {
  const incomingEdges = activeIncoming(nodeId, wf, state);
  if (incomingEdges.length === 0) return "";

  const maxLen = wf.maxUpstreamLength || 0; // 0 = 不限

  const sources = incomingEdges.map(e => {
    const sourceNode = wf.nodes.find(n => n.id === e.source);
    const rawOutput = sourceOutput(e, wf, state);
    const truncated = maxLen > 0 && rawOutput.length > maxLen
      ? rawOutput.slice(0, maxLen) + `\n... [截断: 原文${rawOutput.length}字符, 保留${maxLen}字符]`
      : rawOutput;
    return {
      sourceNodeId: e.source,
      sourceLabel: sourceNode?.label ?? e.source,
      sourcePort: e.sourcePort || "out",
      output: truncated,
    };
  });

  return JSON.stringify(sources, null, 2);
}

/* Legacy executor kept only for compatibility with earlier workflow helpers; the DAG runner uses evaluateIf. */
async function executeNode(node: WorkflowNode, wf: Workflow, state: RunState): Promise<void> {
  const ns = state.results[node.id];
  if (!ns) return;
  const allNodes = wf.nodes;

  // ─── IF 节点 ────────────────────────────────
  if (node.type === "if") {
    ns.status = "running";
    state.currentStep = node.id;
    broadcast("run:state", { workflowId: wf.id, state });

    const upstream = collectUpstream(node.id, wf, state);
    const branch = evaluateIf(node, upstream);
    ns.output = String(branch);
    ns.status = "done";
    broadcast("run:state", { workflowId: wf.id, state });
    broadcast("run:ifBranch", { workflowId: wf.id, nodeId: node.id, branch });

    const portName = branch ? "true" : "false";
    const activeTargets = wf.edges
      .filter(e => e.source === node.id && (e.sourcePort === portName || (!e.sourcePort && e.label === portName)))
      .map(e => e.target);
    for (const n of allNodes) {
      if (activeTargets.includes(n.id)) continue;
      const inActive = wf.edges.some(e => e.source === node.id && e.target === n.id && (e.sourcePort !== portName && (e.sourcePort || e.label) !== portName));
      if (inActive) state.results[n.id] = { status: "done" as const, output: "[skipped]" };
    }
    return;
  }

  // ─── FOR 节点 ───────────────────────────────
  if (node.type === "for") {
    ns.status = "running";
    state.currentStep = node.id;
    broadcast("run:state", { workflowId: wf.id, state });

    const upstream = collectUpstream(node.id, wf, state);
    let count = node.config.loopCount ?? 1;
    if (node.config.loopExpr) throw new Error("旧版动态循环表达式已停用");

    const bodyIds = node.config.loopBodyNodeIds ?? [];
    const bodyNodes = allNodes.filter(n => bodyIds.includes(n.id));
    let broke = false;

    for (let li = 0; li < count; li++) {
      if (state.status !== "running") break;
      if (node.config.breakCondition) throw new Error("旧版循环终止表达式已停用");
      for (const bodyNode of bodyNodes) {
        if (state.status !== "running") break;
        const bns = state.results[bodyNode.id];
        if (!bns) continue;
        bns.status = "running";
        state.currentStep = bodyNode.id;
        broadcast("run:state", { workflowId: wf.id, state });

        const bodyUpstream = collectUpstream(bodyNode.id, wf, state);
        bns.output = await executeAgentNode(bodyNode, bodyUpstream);

        bns.status = "done";
        bns.iterations = (bns.iterations ?? 0) + 1;
        broadcast("run:state", { workflowId: wf.id, state });
      }
    }

    ns.output = `looped ${count} times${broke ? " (break)" : ""}`;
    ns.status = "done";
    ns.iterations = count;
    broadcast("run:state", { workflowId: wf.id, state });
    return;
  }

  // ─── AGENT 节点 ─────────────────────────────
  ns.status = "running";
  state.currentStep = node.id;
  broadcast("run:state", { workflowId: wf.id, state });

  const upstream = collectUpstream(node.id, wf, state);
  try {
    ns.output = await executeAgentNode(node, upstream);
    ns.status = "done";
  } catch (err) {
    ns.output = `Error: ${err}`;
    ns.status = "error";
  }
  ns.iterations = (ns.iterations ?? 0) + 1;
  broadcast("run:state", { workflowId: wf.id, state });
}

// guard 扩展的绝对路径（在 workflow 扩展目录的兄弟目录）
let guardExtPath: string | null = null;

function findGuardExtPath(): string {
  if (guardExtPath) return guardExtPath;
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(distDir, "agent-guard.js"),
    path.resolve(distDir, "..", "..", "wf-agent-guard", "dist", "index.js"),
  ];
  const candidate = candidates.find(file => fs.existsSync(file));
  if (!candidate) throw new Error("缺少工作流工具守卫扩展；拒绝无隔离执行");
  guardExtPath = candidate;
  return candidate;
}

/**
 * 节点额外的 pi 扩展。
 *
 * 节点子进程是 `--no-extensions` 起的，好处是结果可复现：不会因为本机恰好装了
 * 什么扩展而改变行为。代价是 codegraph 这类「给 agent 喂上下文」的扩展也进不去，
 * 于是节点里的 agent 看不见代码图。这里开一个显式白名单：只有点名要的扩展会被
 * 加上 `--extension`，其余仍然按 `--no-extensions` 隔离。
 *
 * 来源有两个，节点自己的配置优先，环境变量作为全局默认：
 *   - node.config.extensions
 *   - WORKFLOW_NODE_EXTENSIONS（逗号分隔）
 * 路径写错直接报错，而不是悄悄少加载一个扩展——静默降级会让人以为上下文生效了。
 */
function resolveNodeExtensions(node: WorkflowNode, extra: string[] = []): string[] {
  const fromEnv = (process.env.WORKFLOW_NODE_EXTENSIONS ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
  const requested = [...(node.config.extensions ?? []), ...extra, ...fromEnv];
  const resolved: string[] = [];
  for (const raw of requested) {
    const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
    if (resolved.includes(absolute)) continue;
    if (!fs.existsSync(absolute)) {
      throw new Error(`节点 ${node.label} 要加载的扩展不存在：${raw}`);
    }
    resolved.push(absolute);
  }
  return resolved;
}

/**
 * 找到 MCP 适配器扩展。
 *
 * `--mcp-config` 不是 pi 核心的旗标，而是 `pi-mcp-adapter` 扩展注册的（pi --help 里
 * 列在「Extension CLI Flags」下）。节点默认 `--no-extensions`，所以要让 MCP 工具真的
 * 能用，光传配置文件不够，必须把这个适配器也显式加载进来，否则子进程直接报
 * Unknown option: --mcp-config。
 */
function findMcpAdapterPath(): string | null {
  const candidates = [
    process.env.WORKFLOW_MCP_ADAPTER,
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "dist", "index.js"),
  ].filter((item): item is string => Boolean(item));
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

/**
 * 节点声明的自定义工具，按类型落到真实的执行通道上。
 *
 * 以前这里直接抛「拒绝以假工具运行」：自定义工具只是前端的一个标签，没有执行器，
 * 让节点带着一个假工具跑等于骗 agent。现在三类各自有真实通道：
 *   - builtin：pi 自带工具，无需注入，只需在白名单里放行；
 *   - extension：由扩展注册，把扩展加载进来就行（路径同节点扩展白名单）；
 *   - mcp：真正的问题在配置，所以校验服务器名确实存在，并把 `--mcp-config` 透传给子进程。
 * 只有确实兑现不了的时候才报错，且报错要告诉人下一步怎么做。
 */
function resolveCustomTools(node: WorkflowNode): { extensions: string[]; mcpConfig?: string; adapter?: string } {
  const tools = node.config.customTools ?? [];
  const extensions: string[] = [];
  const wantedServers: string[] = [];

  for (const tool of tools) {
    if (tool.type === "builtin") continue;
    if (tool.type === "extension") {
      if (!tool.source) throw new Error(`节点 ${node.label} 的工具 ${tool.name} 没填扩展来源`);
      extensions.push(tool.source);
      continue;
    }
    if (tool.type === "mcp") {
      if (!tool.source) throw new Error(`节点 ${node.label} 的工具 ${tool.name} 没填 MCP 服务器名`);
      wantedServers.push(tool.source);
      continue;
    }
    throw new Error(`节点 ${node.label} 的工具 ${tool.name} 类型未知：${String(tool.type)}`);
  }

  if (!wantedServers.length) return { extensions };

  const configured = node.config.mcpConfig
    ?? process.env.WORKFLOW_MCP_CONFIG
    ?? path.join(os.homedir(), ".pi", "agent", "mcp.json");
  const mcpConfig = configured.startsWith("~")
    ? path.join(os.homedir(), configured.slice(1))
    : path.resolve(configured);

  let servers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpConfig, "utf8")) as {
      mcpServers?: Record<string, unknown>;
      servers?: Record<string, unknown>;
    };
    servers = parsed.mcpServers ?? parsed.servers ?? {};
  } catch {
    throw new Error(
      `节点 ${node.label} 要用 MCP 工具，但读不到 MCP 配置 ${mcpConfig}；先用 \`pi mcp add ${wantedServers[0]} ...\` 配置，或在节点里填 MCP 配置路径`,
    );
  }

  const missing = wantedServers.filter(name => !(name in servers));
  if (missing.length) {
    throw new Error(
      `节点 ${node.label} 的 MCP 服务器不在 ${mcpConfig} 里：${missing.join(", ")}；用 \`pi mcp add ${missing[0]} ...\` 添加，或改工具的来源`,
    );
  }

  const adapter = findMcpAdapterPath();
  if (!adapter) {
    throw new Error(
      `节点 ${node.label} 要用 MCP 工具，但找不到 pi-mcp-adapter（--mcp-config 是它注册的）；先 \`pi install npm:pi-mcp-adapter\` 或用 WORKFLOW_MCP_ADAPTER 指定路径`,
    );
  }
  return { extensions, mcpConfig, adapter };
}

/** 用独立子进程执行 agent 节点 */
async function executeAgentNode(
  node: WorkflowNode,
  upstream: string,
  signal?: AbortSignal,
  runCtx?: { workflowId: string; iteration?: number },
): Promise<string> {
  // 构造 prompt
  const toolInfo = buildToolInfo(node, Boolean(runCtx && runTokens.has(runCtx.workflowId)));
  const basePrompt = `${node.config.systemPrompt || "请根据输入完成任务"}\n\n${upstream ? `[上游输入]\n${upstream}` : ""}`;
  const prompt = toolInfo ? `${toolInfo}\n\n${basePrompt}` : basePrompt;

  if (node.config.customTools?.length) {
    // 校验提前做：不能等子进程跑起来才发现工具根本不存在。
    resolveCustomTools(node);
  }

  const cmdName = process.env.LYU_WORKFLOW_AGENT_COMMAND || "pi";
  // 每个节点是独立的临时 Pi 会话；仅加载本包的工具守卫。
  const args: string[] = ["--print", "--no-session", "--no-extensions"];

  // 指定 model（如果节点配了）
  if (node.config.model) {
    args.push("--model", node.config.model);
  }

  // 加载 guard 扩展（实现 per-agent 工具隔离）
  args.push("--extension", findGuardExtPath());

  // 节点点名的扩展（codegraph 之类），仍然受 --no-extensions 约束，只放行这些。
  // 自定义工具里的 extension 类型也走同一条路。
  const customTools = resolveCustomTools(node);
  for (const extensionPath of resolveNodeExtensions(node, customTools.extensions)) {
    args.push("--extension", extensionPath);
    process.stderr.write(`[workflow] ${node.label} +extension ${extensionPath}\n`);
  }

  // MCP：服务器已经在配置里校验过了，这里把适配器和配置文件一起透传到子进程。
  if (customTools.mcpConfig && customTools.adapter) {
    args.push("--extension", customTools.adapter);
    args.push("--mcp-config", customTools.mcpConfig);
    process.stderr.write(`[workflow] ${node.label} mcp-config ${customTools.mcpConfig}\n`);
  }

  // 添加 prompt
  args.push(prompt);

  // 构造环境变量（传递工具限制给 guard 扩展）
  const envExtra: Record<string, string> = {};
  const whitelist = (node.config.tools as string[] | undefined);
  const blacklist = (node.config.disabledTools as string[] | undefined);
  if (whitelist && whitelist.length > 0) {
    // 白名单模式下，自定义工具也必须被放行，否则声明了也用不了。
    const withCustom = [...whitelist, ...(node.config.customTools ?? []).map(tool => tool.name)];
    envExtra.WORKFLOW_TOOLS_WHITELIST = [...new Set(withCustom)].join(",");
  }
  if (blacklist && blacklist.length > 0) envExtra.WORKFLOW_TOOLS_BLACKLIST = blacklist.join(",");

  // 提问通道：把本次 run 的 /api/ask 地址 + 节点身份传给子进程，
  // guard 扩展据此注册 ask_user 工具（ask_user 总会例外放行，不受白名单影响）
  const runToken = runCtx ? runTokens.get(runCtx.workflowId) : undefined;
  if (runCtx && runToken) {
    envExtra.WORKFLOW_ASK_URL =
      `http://127.0.0.1:${port}/api/ask?wf=${encodeURIComponent(runCtx.workflowId)}&token=${runToken}`;
    envExtra.WORKFLOW_NODE_ID = node.id;
    envExtra.WORKFLOW_NODE_LABEL = node.label;
    if (runCtx.iteration !== undefined) envExtra.WORKFLOW_ITERATION = String(runCtx.iteration);
  }

  return new Promise<string>((resolve, reject) => {
    // 必须用 spawn + stdin=ignore：execFile 会给子进程一条永不关闭的 stdin 管道，
    // pi --print 在管道上等 EOF，于是永远不退出（假 agent 的 shell 脚本不读 stdin，掩盖了这个 bug）。
    const child = spawn(cmdName, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...envExtra },
    });

    const MAX_OUT = 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    // 节点可能长时间停在 ask_user 上等人，不能用短超时；这里是硬上限兜底。
    // 提问本身的超时由 ASK_TIMEOUT_MS 控制。
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Agent ${node.label} 超时（${Math.round(NODE_TIMEOUT_MS / 1000)}s）`)));
    }, NODE_TIMEOUT_MS);

    const onAbort = () => { child.kill("SIGKILL"); finish(() => reject(new Error(`Agent ${node.label} 已中止`))); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUT) stdout += chunk.toString("utf-8");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUT) stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      finish(() => reject(new Error(`Agent ${node.label} 无法启动: ${err.message}`)));
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) finish(() => resolve(stdout.trim()));
      else finish(() => reject(new Error(`Agent ${node.label} 执行失败 (exit ${code}): ${(stderr || stdout).trim().slice(0, 1500)}`)));
    });
  });
}

/** 根据节点工具配置，构造工具约束提示 */
function buildToolInfo(node: WorkflowNode, askEnabled: boolean): string {
  const parts: string[] = [];

  if (askEnabled) {
    parts.push("[提问] 信息不足、需要在多个方案间取舍或即将做不可逆操作时，必须调用 ask_user 工具向用户提问并等待回答；不要靠猜测继续，也不要把问题当作最终输出。");
  }

  if (node.config.tools && node.config.tools.length > 0) {
    parts.push(`[工具白名单] 你只能使用以下工具: ${node.config.tools.join(", ")}. 禁止使用其他任何工具.`);
  }
  if (node.config.disabledTools && node.config.disabledTools.length > 0) {
    parts.push(`[工具黑名单] 你被禁止使用以下工具: ${node.config.disabledTools.join(", ")}.`);
  }
  if (node.config.customTools && node.config.customTools.length > 0) {
    const toolDescs = node.config.customTools.map(t =>
      `- ${t.name} (${t.type}${t.source ? ` from ${t.source}` : ""}): ${t.description}`
    ).join("\n");
    parts.push(`[自定义工具]\n${toolDescs}`);
  }

  return parts.join("\n\n");
}

/** 拓扑分层：同一层内无相互依赖，可并行执行 */
function topoLayers(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[][] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const deg = new Map(nodes.map(n => [n.id, 0]));
  const adj = new Map(nodes.map(n => [n.id, [] as string[]]));
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }

  const layers: WorkflowNode[][] = [];
  let remaining = new Set(nodes.map(n => n.id));

  while (remaining.size > 0) {
    // 找到所有入度为 0 的节点 → 本层
    const layer: WorkflowNode[] = [];
    const ready: string[] = [];
    for (const id of remaining) {
      if ((deg.get(id) ?? 0) === 0) ready.push(id);
    }
    if (ready.length === 0) throw new Error("工作流存在环路；请用 For 节点表达循环，不要把连线接回上游");
    for (const id of ready) {
      const n = nodeMap.get(id);
      if (n) layer.push(n);
      remaining.delete(id);
      // 减少下游入度
      for (const next of adj.get(id) ?? []) {
        deg.set(next, (deg.get(next) ?? 1) - 1);
      }
    }
    if (layer.length > 0) layers.push(layer);
  }

  return layers;
}

// ─── 启停 ──────────────────────────────────────────────────────────

/** 打开浏览器；测试/无头环境下用 LYU_WORKFLOW_NO_OPEN=1 跳过 */
function openBrowser(url: string) {
  if (process.env.LYU_WORKFLOW_NO_OPEN === "1") return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch { /* ok */ }
}

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(serveStatic);

    // WebSocket upgrade (简易实现)
    server.on("upgrade", (req, socket, head) => {
      const expectedOrigin = `http://127.0.0.1:${port}`;
      if (req.headers.host !== `127.0.0.1:${port}` ||
          (req.headers.origin && req.headers.origin !== expectedOrigin) || req.url !== "/ws") {
        socket.destroy();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      if (!key) { socket.destroy(); return; }

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
      );

      const client: WsClient = {
        socket,
        send(data: string) {
          try {
            // 简易：发 text frame (opcode 0x1), 无掩码, 不分片
            const buf = Buffer.from(data, "utf-8");
            const len = buf.length;
            const frames: Buffer[] = [];
            if (len < 126) {
              frames.push(Buffer.from([0x81, len]));
            } else if (len < 65536) {
              const h = Buffer.alloc(4);
              h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2);
              frames.push(h);
            } else {
              const h = Buffer.alloc(10);
              h[0] = 0x81; h[1] = 127;
              h.writeBigUInt64BE(BigInt(len), 2);
              frames.push(h);
            }
            frames.push(buf);
            socket.write(Buffer.concat(frames));
          } catch { /* 客户端已断开，忽略 EPIPE 等 */ }
        },
      };

      wsClients.push(client);

      let buf = Buffer.from(head);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const opcode = buf[0]! & 0x0f;
          const masked = !!(buf[1]! & 0x80);
          let payloadLen = buf[1]! & 0x7f;
          let offset = 2;
          if (payloadLen === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); offset = 4; }
          else if (payloadLen === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
          if (!masked || payloadLen > 1024 * 1024) { socket.destroy(); return; }
          if (buf.length < offset + 4 + payloadLen) return;
          const mask = buf.subarray(offset, offset + 4);
          offset += 4;
          const payload = Buffer.from(buf.subarray(offset, offset + payloadLen).map((b, i) => b ^ mask[i % 4]!));
          buf = buf.subarray(offset + payloadLen);
          if (opcode === 0x1) handleWsMessage(payload.toString("utf-8"));
          else if (opcode === 0x8) { socket.end(); return; }
          else if (opcode === 0x9) {
            const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
            socket.write(pong);
          }
        }
      });

      socket.on("close", () => {
        const idx = wsClients.indexOf(client);
        if (idx >= 0) wsClients.splice(idx, 1);
      });

      // 吞掉网络错误（ECONNRESET / EPIPE 等），避免未捕获异常崩溃
      socket.on("error", (err: any) => {
        const idx = wsClients.indexOf(client);
        if (idx >= 0) wsClients.splice(idx, 1);
        // 不需要 log，客户端断开是正常行为
      });

      // 发送初始状态
      client.send(JSON.stringify({
        type: "connected",
        data: { workflows: [...workflows.values()], port },
      }));

      // 页面刷新/断线重连：把仍在等待回答的提问补发一次，避免"问题丢了但节点还挂着"
      for (const ask of pendingAsks.values()) {
        client.send(JSON.stringify({
          type: "run:needInput",
          data: { workflowId: ask.workflowId, ...askInfo(ask) },
        }));
      }
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") { port++; server!.listen(port, "127.0.0.1"); }
      else reject(err);
    });

    server.on("listening", () => resolve(port));
    server.listen(port, "127.0.0.1");
  });
}

function stopServer() {
  for (const ask of [...pendingAsks.values()]) settleAsk(ask, { cancelled: true });
  pendingAsks.clear();
  runTokens.clear();
  for (const controller of runControllers.values()) controller.abort();
  runControllers.clear();
  for (const [wfId, state] of runStates) {
    if (state.status === "running" || state.status === "paused") {
      state.status = "idle";
      // 服务关停等于这次运行结束了：先把终态喂给历史，再收尾落盘。
      observeRun(wfId, state);
    }
  }
  flushRunHistory();
  for (const c of wsClients) try { c.socket.destroy(); } catch { /* ok */ }
  wsClients.length = 0;
  server?.close();
  server = null;
  adoptedPort = null;
}

// 服务地址落盘，供 Lyu 等外部 UI 读取（纯诊断/便利，写入失败不影响运行）
const PORT_FILE = path.join(os.homedir(), ".pi", "agent", "workflow-server.json");

function writePortFile(actualPort: number) {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
    fs.writeFileSync(PORT_FILE, JSON.stringify({
      port: actualPort,
      url: `http://127.0.0.1:${actualPort}`,
      pid: process.pid,
      updatedAt: Date.now(),
    }, null, 2));
  } catch { /* ok */ }
}

function clearPortFile() {
  try { fs.unlinkSync(PORT_FILE); } catch { /* ok */ }
}

/**
 * 同一台机器上可能有多个 pi 会话，但编辑器只应该有一个。
 * 已经有服务占着默认端口时直接沿用，不要另起一个各管各的 workflows 表。
 */
async function probeExistingServer(): Promise<number | null> {
  if (process.env.LYU_WORKFLOW_ISOLATED === "1") return null;
  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/status`, {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return null;
    const body = await res.json() as { ok?: boolean };
    return body?.ok ? DEFAULT_PORT : null;
  } catch {
    return null;
  }
}

let adoptedPort: number | null = null;

/** 幂等：已启动则直接返回端口，端口被别人占着则沿用别人的 */
async function ensureServer(): Promise<number> {
  if (server) return port;
  if (adoptedPort) return adoptedPort;
  const existing = await probeExistingServer();
  if (existing !== null) {
    adoptedPort = existing;
    port = existing;
    console.error(`[workflow] 复用已有服务 http://127.0.0.1:${existing}`);
    return existing;
  }
  port = DEFAULT_PORT;
  const actualPort = await startServer();
  writePortFile(actualPort);
  return actualPort;
}

// ─── 扩展入口 ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.registerCommand("workflow", {
    description: "Open workflow editor — visually compose multi-agent pipelines",
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      if (args.trim() === "stop") {
        const owned = server !== null;
        stopServer();
        if (owned) clearPortFile();
        pi.sendMessage({ customType: "workflow", content: "Workflow server stopped", display: true });
        return;
      }

      // /workflow runs [n] —— 看最近几次运行；/workflow show <runId> —— 看一次运行里每个节点干了什么。
      // 运行历史落在 ~/.pi/agent/workflow-runs/，服务重启也在。
      if (args.trim().startsWith("runs") || args.trim().startsWith("show")) {
        const [sub, rest] = args.trim().split(/\s+/);
        if (sub === "runs") {
          const limit = Number(rest) > 0 ? Math.min(Number(rest), 100) : 10;
          const runs = listRuns(limit);
          const content = !runs.length
            ? `还没有运行历史（${RUNS_DIR}）`
            : runs
                .map(run => {
                  const when = new Date(run.startedAt).toLocaleString("zh-CN");
                  const cost = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "进行中";
                  const failed = run.failedNodes.length ? ` 失败节点: ${run.failedNodes.join(", ")}` : "";
                  return `${when}  ${run.status.padEnd(7)} ${cost.padEnd(7)} ${run.workflowName ?? run.workflowId}  ${run.runId}${failed}`;
                })
                .join("\n");
          pi.sendMessage({ customType: "workflow", content, display: true });
          return;
        }
        const run = rest ? readRun(rest) : null;
        if (!run) {
          pi.sendMessage({ customType: "workflow", content: `没有这次运行：${rest ?? "(缺少 runId)"}`, display: true });
          return;
        }
        const lines = [
          `${run.workflowName ?? run.workflowId}  ${run.status}  ${new Date(run.startedAt).toLocaleString("zh-CN")}`,
          `输入: ${run.input.slice(0, 200)}`,
        ];
        for (const [nodeId, node] of Object.entries(run.nodes)) {
          const label = run.nodeLabels[nodeId] ?? nodeId;
          const cost = node.durationMs ? `${(node.durationMs / 1000).toFixed(1)}s` : "-";
          lines.push(`• ${label}: ${node.status} ${cost}${node.error ? ` — ${node.error.slice(0, 120)}` : ""}`);
          if (node.asks?.length) {
            for (const ask of node.asks) lines.push(`    问: ${ask.question.slice(0, 100)} → ${ask.answer.slice(0, 100)}`);
          }
        }
        if (run.finalOutput) lines.push(`输出: ${run.finalOutput.slice(0, 400)}`);
        if (run.error) lines.push(`错误: ${run.error}`);
        pi.sendMessage({ customType: "workflow", content: lines.join("\n"), display: true });
        return;
      }

      const actualPort = await ensureServer();
      const url = `http://127.0.0.1:${actualPort}`;
      openBrowser(url);

      pi.sendMessage({
        customType: "workflow",
        content: `Workflow editor: ${url}`,
        display: true,
        details: { url, port: actualPort },
      });
    },
  });

  console.error("[workflow] Extension loaded — /workflow to open editor");

  // 默认在会话启动时就把服务拉起来：Lyu 的「Workflow」按钮是固定地址，
  // 不能依赖用户先手动敲一次 /workflow。LYU_WORKFLOW_AUTOSTART=0 可关。
  if (process.env.LYU_WORKFLOW_AUTOSTART !== "0" && process.env.LYU_WORKFLOW_ISOLATED !== "1") {
    void ensureServer()
      .then(p => console.error(`[workflow] Server ready http://127.0.0.1:${p}`))
      .catch(e => console.error(`[workflow] Autostart failed: ${e?.message ?? e}`));
  }
}
