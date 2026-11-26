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
 *   WORKFLOW_MAX_CONCURRENT  同时跑几个工作流（默认 3，超出的排队）
 *   WORKFLOW_AUTH_TOKEN      开令牌门禁并指定令牌；接口与 WS 都必须带它
 *   WORKFLOW_REQUIRE_TOKEN=1 开令牌门禁，令牌用端口文件里那把（0600，本用户可读）
 *
 * 安全边界：只监听 127.0.0.1；Host 必须是自己（挡 DNS rebinding）；带 Origin 的
 * 请求必须来自编辑器自己的源（挡网页对本机端口的跨站 WS/表单）。这三条默认生效，
 * 足以挡住「随便打开一个网页就被驱动我的 agent」。令牌是额外的、可选的第四层，
 * 用于本机还有别的用户/别的进程的场景——开了之后 Lyu 的固定地址按钮拿不到令牌，
 * 需要改用 /workflow 给出的链接。
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
/**
 * 端口只有一个来源。
 *
 * 桌面端和隔离测试都要能指定别的端口，而硬编两处必然漂移 —— 所以统一从这里读，
 * 别处只许引用 `port` 变量。
 */
const CONFIGURED_PORT =
  Number(process.env.WORKFLOW_PORT ?? process.env.LYU_WORKFLOW_PORT) || DEFAULT_PORT;

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
  status: "idle" | "queued" | "running" | "paused" | "error" | "done";
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
let port = CONFIGURED_PORT;
let piRef: ExtensionAPI | null = null;

const workflows = new Map<string, Workflow>();
const runStates = new Map<string, RunState>();
const runControllers = new Map<string, AbortController>();

/**
 * 并发上限与等待队列。
 *
 * 每个 workflow 各有自己的 RunState，本来就能并行；但没有上限时「连点五个运行」
 * 会同时拉起一堆 agent 子进程，谁也看不清进度，机器也可能被打满。超过上限的
 * 明确标成 queued 排进队列，等有运行结束时按顺序放行 —— 状态是用户看得见的，
 * 而不是静默丢弃。
 */
const MAX_CONCURRENT_RUNS = Math.max(1, Number(process.env.WORKFLOW_MAX_CONCURRENT ?? 3) || 3);
interface QueuedRun { wf: Workflow; state: RunState; input: string }
const runQueue: QueuedRun[] = [];

/**
 * 已占用的槽位数。
 *
 * 不能用「扫 runStates 里 status 是 running 的个数」来算：launchRun 把状态改成
 * running 之后，自己就会被数进去，于是永远判断成超限，再把同一个任务重新入队，
 * 死循环直到 OOM（真踩过）。槽位必须是显式计数。
 */
let activeRuns = 0;

function activeRunCount(): number {
  return activeRuns;
}

/** 有空位就把队头的放进来。launchRun 会自己加槽位，所以这里不预占。 */
function drainRunQueue(): void {
  while (runQueue.length && activeRuns < MAX_CONCURRENT_RUNS) {
    const job = runQueue.shift()!;
    launchRun(job.wf, job.state, job.input);
  }
}
const wsClients: WsClient[] = [];
const registeredCustomTools = new Map<string, CustomTool>();
const savedWorkflowDir = path.join(os.homedir(), ".pi", "agent", "workflows");

// 提问通道：runId -> 本次运行的调用令牌（防止本机其它进程乱答）
const runTokens = new Map<string, string>();
// askId -> 在途的长轮询请求
const pendingAsks = new Map<string, PendingAsk>();

const STREAM_THROTTLE_MS = 200;
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

/** Host 必须是我们自己：挡 DNS rebinding（evil.com 解析到 127.0.0.1 也能过网络层）。 */
function hostPinned(req: http.IncomingMessage): boolean {
  return req.headers.host === `127.0.0.1:${port}`;
}

/**
 * 浏览器发来的请求，Origin 必须是编辑器自己的源——否则任意网页都能对本机端口发
 * WebSocket / 表单 POST（WS 完全不受 CORS 约束，这是最现实的一条攻击面）。
 * curl、子进程、Electron 里的 iframe 都不带或带自己的源，按规则放行/拒绝。
 */
function originTrusted(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function tokenOk(given: unknown): boolean {
  if (!authToken) return true;   // 没开令牌门禁
  if (typeof given !== "string" || given.length !== authToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(authToken));
}

/** 节点子进程用的接口，自带每个 run 的令牌，不吃全局门禁令牌。 */
function isNodeEndpoint(urlPath: string): boolean {
  return urlPath === "/api/ask" || urlPath === "/api/progress";
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!hostPinned(req) || !originTrusted(req)) { res.writeHead(403); res.end(); return; }
  const frontendDir = getFrontendDir();
  const url = new URL(req.url ?? "/", "http://localhost");
  let urlPath = url.pathname;
  // 令牌只管接口：静态壳子（index.html）放开，否则页面自己加载资源时又得带令牌。
  // 读不到内容这件事由「不发 CORS 头」保证，写操作走 WS，WS 同样要令牌。
  const needsToken = urlPath.startsWith("/api/") && !isNodeEndpoint(urlPath);
  if (needsToken && !tokenOk(req.headers["x-workflow-token"] ?? url.searchParams.get("token"))) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("缺少或错误的令牌：用 /workflow 打开编辑器（链接里带令牌）");
    return;
  }

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
  } else if (urlPath === "/api/progress") {
    void handleProgress(req, res, url);
  } else if (urlPath === "/api/pending" || urlPath === "/api/answer") {
    void handleAskBridge(req, res, urlPath === "/api/answer");
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

/**
 * 节点进度缓冲：wfId → nodeId → 最近若干行。
 *
 * 为什么需要它：`lyu --print` 把整段回复攒到最后一次打印，节点 stdout 在跑的过程中
 * 是空的，页面上只能看到整体 RUNNING。真正的过程信号来自节点里的 guard 扩展上报的
 * 工具调用（见 wf-agent-guard 的 registerProgress）。
 */
const progressLines = new Map<string, Map<string, string[]>>();
const MAX_PROGRESS_LINES = 40;

function clearProgress(wfId: string) {
  progressLines.delete(wfId);
}

async function handleProgress(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const wfId = url.searchParams.get("wf") ?? "";
  const token = url.searchParams.get("token") ?? "";
  // 进度是锦上添花，鉴权失败直接吞掉，不要给子进程任何错误反馈让它分心。
  if (!wfId || !token || token !== runTokens.get(wfId) || !runStates.has(wfId)) {
    res.writeHead(204).end();
    return;
  }

  let body: { line?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(204).end();
    return;
  }
  const line = String(body.line ?? "").slice(0, 400);
  const nodeId = url.searchParams.get("node") ?? "";
  if (!line || !nodeId) {
    res.writeHead(204).end();
    return;
  }

  let perRun = progressLines.get(wfId);
  if (!perRun) { perRun = new Map(); progressLines.set(wfId, perRun); }
  const lines = perRun.get(nodeId) ?? [];
  lines.push(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${line}`);
  if (lines.length > MAX_PROGRESS_LINES) lines.splice(0, lines.length - MAX_PROGRESS_LINES);
  perRun.set(nodeId, lines);

  broadcast("run:nodeOutput", {
    workflowId: wfId,
    nodeId,
    nodeLabel: url.searchParams.get("label") ?? nodeId,
    tail: lines.join("\n"),
  });
  res.writeHead(204).end();
}

/**
 * 终端通道的 HTTP 桥：列挂着的提问 / 回答一个提问。
 *
 * 只在本机监听，但额外要求端口文件里的令牌。没有令牌的请求一律 403，
 * 免得任何一个本机进程都能替你回答 agent 的确认。
 */
async function handleAskBridge(req: http.IncomingMessage, res: http.ServerResponse, isAnswer: boolean) {
  const unauthorized = () => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
  };
  if (req.headers["x-workflow-token"] !== answerToken) return unauthorized();

  if (!isAnswer) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ asks: [...pendingAsks.values()].map(askInfo) }));
    return;
  }

  let body: { askId?: string; answer?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad body" }));
    return;
  }
  const ask = pendingAsks.get(String(body.askId ?? ""));
  if (!ask) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no such ask" }));
    return;
  }
  settleAsk(ask, { answer: String(body.answer ?? "") });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
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

  // 没人在看页面：不再直接让 agent 自己拿主意（那就等于提问功能只在开着编辑器时存在），
  // 改成把问题推到本会话并挂在 /workflow ask 里，从终端回答。
  if (wsClients.length === 0) {
    process.stderr.write(`[workflow] 无页面连接，提问转终端通道：${question.slice(0, 80)}\n`);
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

  // 终端通道的通知：不阻塞、不抢焦点，只是让人知道有事要答。
  if (wsClients.length === 0) {
    try {
      piRef?.sendMessage({
        customType: "workflow",
        display: true,
        content:
          `❓ 节点「${ask.nodeLabel}」需要你确认：\n${ask.question.slice(0, 500)}\n\n` +
          `回复：/workflow answer ${ask.askId} <你的回答>\n` +
          `（${Math.round(ASK_TIMEOUT_MS / 60000)} 分钟内不答则超时，agent 会基于假设继续）`,
      });
    } catch { /* 通知失败不能拖垮提问本身 */ }
  }

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
      // 以前这里直接 break：点「运行」没反应，用户只能猜。现在说清楚为什么没跑。
      if (!wf) {
        broadcast("workflow:error", { message: "找不到这个工作流（可能已被删除或尚未保存）" });
        break;
      }
      if (runStates.get(wfId)?.status === "running") {
        broadcast("workflow:error", { message: "这个工作流正在运行，等它结束或先停止" });
        break;
      }
      if (runStates.get(wfId)?.status === "paused") {
        broadcast("workflow:error", { message: "这个工作流正卡在提问上：先在页面上或 /workflow ask 里回答，或停止后再重跑" });
        break;
      }

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
      const queuedAt = runQueue.findIndex(job => job.wf.id === wfId);
      if (queuedAt >= 0) runQueue.splice(queuedAt, 1);   // 排队中的也要能撤掉
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
  // 已经到并发上限：排队，别把状态显示成 running 骗人。
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    state.status = "queued";
    runStates.set(wf.id, state);
    runQueue.push({ wf, state, input });
    broadcast("run:state", { workflowId: wf.id, state });
    process.stderr.write(`[workflow] ${wf.name} 排队中（已有 ${activeRuns} 个在跑）\n`);
    return;
  }

  activeRuns++;
  state.status = "running";
  const controller = new AbortController();
  runStates.set(wf.id, state);
  runControllers.set(wf.id, controller);
  runTokens.set(wf.id, crypto.randomBytes(16).toString("hex"));
  clearProgress(wf.id);   // 新一轮的进度不要接着上一轮的尾巴
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
    clearProgress(wf.id);
    activeRuns = Math.max(0, activeRuns - 1);
    drainRunQueue();   // 腾出位置给排队的
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
    // 未编译直接加载（引擎支持 .ts 扩展）时走这条：src/ 与 dist/ 都在包根下一层，
    // 所以上面那条对 dist/ 成立、这条对 src/ 成立，两条都留着不需要分支。
    path.resolve(distDir, "..", "..", "wf-agent-guard", "src", "index.ts"),
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

  const cmdName = process.env.LYU_WORKFLOW_AGENT_COMMAND || "lyu";
  // 每个节点是独立的临时会话；仅加载本包的工具守卫。
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
    envExtra.WORKFLOW_PROGRESS_URL =
      `http://127.0.0.1:${port}/api/progress?wf=${encodeURIComponent(runCtx.workflowId)}&token=${runToken}` +
      `&node=${encodeURIComponent(node.id)}&label=${encodeURIComponent(node.label)}`;
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

    // 节点级流式：长节点（上限 60 分钟）在跑的时候，界面上只有整体 IDLE/RUNNING，
    // 分不清是在干活还是卡住了。这里把 stdout 的尾部快照推给页面：推的是「尾部」
    // 而不是增量，丢一帧无害，重连也能立刻看到现状。
    let streamTimer: NodeJS.Timeout | null = null;
    const streamOutput = () => {
      streamTimer = null;
      const workflowId = runCtx?.workflowId;
      if (!workflowId || !stdout) return;
      broadcast("run:nodeOutput", {
        workflowId,
        nodeId: node.id,
        nodeLabel: node.label,
        tail: stdout.slice(-4000),
      });
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUT) stdout += chunk.toString("utf-8");
      if (!streamTimer) streamTimer = setTimeout(streamOutput, STREAM_THROTTLE_MS);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUT) stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      finish(() => reject(new Error(`Agent ${node.label} 无法启动: ${err.message}`)));
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
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
  // 想开门禁但没显式给令牌时，用端口文件里那把（0600，只有本用户读得到）。
  if (process.env.WORKFLOW_REQUIRE_TOKEN === "1" && !authToken) authToken = answerToken;
  return new Promise((resolve, reject) => {
    server = http.createServer(serveStatic);

    // WebSocket upgrade (简易实现)
    server.on("upgrade", (req, socket, head) => {
      const rawUrl = req.url ?? "";
      const wsUrl = new URL(rawUrl, `http://127.0.0.1:${port}`);
      if (!hostPinned(req) || !originTrusted(req) || wsUrl.pathname !== "/ws" ||
          !tokenOk(wsUrl.searchParams.get("token"))) {
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

/**
 * 可选的门禁令牌。
 *
 * 默认空：编辑器只监听 127.0.0.1，靠 Host + Origin 校验挡住远程访问和网页跨站。
 * 设了 WORKFLOW_AUTH_TOKEN（或 WORKFLOW_REQUIRE_TOKEN=1 用端口文件里的令牌）之后，
 * 所有页面/接口都要带令牌，用于「本机还有别的用户/别的进程不该操作我的 agent」的场景。
 * 节点用的 /api/ask、/api/progress 例外：它们带的是每个 run 自己的随机令牌。
 */
let authToken = process.env.WORKFLOW_AUTH_TOKEN ?? "";

/**
 * 引擎的配置目录。
 *
 * 引擎按 `${APP_NAME}_CODING_AGENT_DIR` 命名环境变量，`pi` 与 `lyu` 两个产品都认；
 * 都没设时按「文件系统里真实存在的那个」探测，最后才回退旧路径。
 * 与 extensions-pi 的同名实现保持同一优先级 —— 两个包各自独立发布，不能互相 import。
 */
function agentDirPath(): string {
  for (const key of ["LYU_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR"]) {
    const value = process.env[key];
    if (value) return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
  }
  const lyu = path.join(os.homedir(), ".lyu", "agent");
  if (fs.existsSync(lyu)) return lyu;
  return path.join(os.homedir(), ".pi", "agent");
}

// 服务地址落盘，供 Lyu 等外部 UI 读取（纯诊断/便利，写入失败不影响运行）
const PORT_FILE = path.join(agentDirPath(), "workflow-server.json");

/**
 * 跨会话回答提问用的令牌。
 *
 * 工作流服务单例：A 会话起的服务，B 会话会用 adopt 方式连上来。提问挂在 A 的内存里，
 * 所以要能从 B 里回答就得走 HTTP。端口文件已经是 0600、只在本机，令牌写在里面
 * 作为「同一用户」之外的一层区分：其他本机进程拿不到令牌就不能替你作答。
 */
const answerToken = crypto.randomBytes(24).toString("hex");

function writePortFile(actualPort: number) {
  // 隔离运行的实例（测试）是临时的，不该改写这个指针：否则指向一个随时会退出的
  // 端口，别的会话和 Lyu 读到的都是假地址。
  if (process.env.LYU_WORKFLOW_ISOLATED === "1") return;
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
    fs.writeFileSync(PORT_FILE, JSON.stringify({
      port: actualPort,
      url: `http://127.0.0.1:${actualPort}`,
      pid: process.pid,
      token: answerToken,
      updatedAt: Date.now(),
    }, null, 2));
    // mode 只在创建时生效；文件已存在时会被忽略，所以要显式收紧到 0600。
    fs.chmodSync(PORT_FILE, 0o600);
  } catch { /* ok */ }
}

function clearPortFile() {
  try { fs.unlinkSync(PORT_FILE); } catch { /* ok */ }
}

interface PortFileInfo {
  port: number;
  url: string;
  pid: number;
  token?: string;
}

function readPortFile(): PortFileInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(PORT_FILE, "utf8")) as PortFileInfo;
    return typeof parsed?.port === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** 所有挂着的提问：本进程一份，若是别的会话起的服务，再从那边拉一份。 */
async function collectPendingAsks(): Promise<PendingAskInfo[]> {
  const local = [...pendingAsks.values()].map(askInfo);
  const info = readPortFile();
  if (!info?.token || info.pid === process.pid) return local;
  try {
    const res = await fetch(`${info.url}/api/pending`, {
      headers: { "x-workflow-token": info.token },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return local;
    const data = (await res.json()) as { asks?: PendingAskInfo[] };
    return [...local, ...(data.asks ?? [])];
  } catch {
    return local;
  }
}

/** 回答一个提问：本地直接结掉，否则转给拥有服务的那个会话。 */
async function answerAsk(askId: string, answer: string): Promise<boolean> {
  const local = pendingAsks.get(askId);
  if (local) {
    settleAsk(local, { answer });
    return true;
  }
  const info = readPortFile();
  if (!info?.token || info.pid === process.pid) return false;
  try {
    const res = await fetch(`${info.url}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-workflow-token": info.token },
      body: JSON.stringify({ askId, answer }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 同一台机器上可能有多个 pi 会话，但编辑器只应该有一个。
 * 已经有服务占着默认端口时直接沿用，不要另起一个各管各的 workflows 表。
 */
async function probeExistingServer(): Promise<number | null> {
  if (process.env.LYU_WORKFLOW_ISOLATED === "1") return null;
  try {
    const res = await fetch(`http://127.0.0.1:${CONFIGURED_PORT}/api/status`, {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return null;
    const body = await res.json() as { ok?: boolean };
    return body?.ok ? CONFIGURED_PORT : null;
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
  // 这里原来写的是 DEFAULT_PORT，把上面刚算好的配置值重置掉了 —— 于是 WORKFLOW_PORT
  // 永远不生效，而默认端口被占时会默默顺延到下一个，外部 UI 拿到的是个猜不到的地址。
  port = CONFIGURED_PORT;
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

      // /workflow ask —— 看当前挂着的提问；/workflow answer <askId> <回答> —— 从终端回答。
      // 提问原本只能从编辑器页面答，关掉页面就等于没有提问能力。
      if (/^ask\b/.test(args.trim()) || args.trim().startsWith("answer")) {
        const trimmed = args.trim();
        if (trimmed.startsWith("answer")) {
          const match = /^answer\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
          if (!match) {
            pi.sendMessage({ customType: "workflow", content: "用法：/workflow answer <askId> <回答>", display: true });
            return;
          }
          const askId = match[1] ?? "";
          const answer = match[2] ?? "";
          const done = await answerAsk(askId, answer.trim());
          pi.sendMessage({
            customType: "workflow",
            content: done ? `已作答：${askId}` : `没有这条提问（或服务属于另一个会话且不可达）：${askId}`,
            display: true,
          });
          return;
        }

        const asks = await collectPendingAsks();
        const content = !asks.length
          ? "当前没有待回答的提问"
          : [
              `待回答 ${asks.length} 条：`,
              ...asks.map(ask => {
                const age = Math.round((Date.now() - ask.askedAt) / 1000);
                const options = ask.options.length ? `\n     选项: ${ask.options.join(" / ")}` : "";
                return `• [${ask.nodeLabel}] ${ask.question}${options}\n     ${ask.askId}（已等 ${age}s）\n     回答：/workflow answer ${ask.askId} <你的回答>`;
              }),
            ].join("\n");
        pi.sendMessage({ customType: "workflow", content, display: true });
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
      openBrowser(authToken ? `${url}/?token=${authToken}` : url);

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
