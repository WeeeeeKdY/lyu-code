/**
 * Workflow Extension for lyu-code
 *
 * /workflow — 打开本地前端页面，可视化编排多 agent 工作流
 *
 * 架构：
 *   - 命令启动本地 HTTP 服务（默认 18789）+ WebSocket
 *   - serve frontend/dist/ 下的静态文件（用户自行提供）
 *   - WebSocket 通道让前端和 Pi 通信
 *   - 前端发指令（addNode, connect, run, stop, ...）
 *   - 扩展执行操作，回传状态和结果
 *
 * 用法：
 *   /workflow        — 打开编辑器
 *   /workflow stop   — 关闭服务
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync, execFile } from "node:child_process";
import { URL } from "node:url";

const DEFAULT_PORT = 18789;

// ─── Workflow 数据模型 ─────────────────────────────────────────────

interface WorkflowNode {
  id: string;
  type: "agent" | "if" | "for";
  label: string;
  config: {
    // agent
    systemPrompt?: string;
    model?: string;
    tools?: string[];            // 白名单模式：只允许这些工具
    disabledTools?: string[];    // 黑名单模式：禁用这些工具
    customTools?: CustomTool[];  // 通过 extension 注册的自定义工具
    maxLoops?: number;
    maxTokens?: number;
    // if
    condition?: string;         // JS 表达式，可引用 $input（上游输出）
    // for
    loopCount?: number;         // 循环次数（静态）
    loopExpr?: string;          // 动态表达式，可引用 $input
    breakCondition?: string;    // break 条件表达式
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

interface RunState {
  status: "idle" | "running" | "paused" | "error" | "done";
  currentStep?: string;
  iteration: number;
  results: Record<string, {
    status: "pending" | "running" | "done" | "error";
    output?: string;
    error?: string;
    iterations?: number;
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
const wsClients: WsClient[] = [];
const registeredCustomTools = new Map<string, CustomTool>();

// ─── 广播 ──────────────────────────────────────────────────────────

function broadcast(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  for (const c of wsClients) {
    try { c.send(msg); } catch { /* ignore */ }
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
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  return path.join(thisDir, "..", "frontend", "dist");
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const frontendDir = getFrontendDir();
  let urlPath = new URL(req.url ?? "/", "http://localhost").pathname;

  // API 路由
  if (urlPath.startsWith("/api/")) {
    handleApi(req, res, urlPath);
    return;
  }

  // 静态文件
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(frontendDir, urlPath);

  try {
    if (!filePath.startsWith(frontendDir)) { res.writeHead(403); res.end(); return; }
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

function handleApi(_req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  const ok = (d: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };

  if (urlPath === "/api/workflows") {
    ok([...workflows.values()].map(w => ({ id: w.id, name: w.name, nodeCount: w.nodes.length, globalMaxLoops: w.globalMaxLoops })));
  } else if (urlPath === "/api/status") {
    ok({ ok: true, workflows: workflows.size, clients: wsClients.length });
  } else {
    ok({ error: "not found" });
  }
}

// ─── WebSocket 消息处理 ────────────────────────────────────────────

function handleWsMessage(raw: string) {
  let msg: { type: string; data?: any; id?: string };
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case "workflow:create": {
      const wf: Workflow = {
        id: msg.data?.id ?? `wf-${Date.now()}`,
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
      if (wf) { Object.assign(wf, msg.data, { updatedAt: Date.now() }); broadcast("workflow:updated", wf); }
      break;
    }

    case "workflow:delete": {
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
      const state = runStates.get(wfId);
      if (!wf || !state || state.status === "running") break;

      state.status = "running";
      state.iteration = 0;
      state.results = {};
      for (const n of wf.nodes) state.results[n.id] = { status: "pending" };
      broadcast("run:state", { workflowId: wfId, state });

      runWorkflow(wf, state).catch(err => {
        state.status = "error";
        broadcast("run:state", { workflowId: wfId, state, error: String(err) });
      });
      break;
    }

    case "workflow:stop": {
      const state = runStates.get(msg.data?.workflowId);
      if (state) { state.status = "idle"; broadcast("run:state", { workflowId: msg.data?.workflowId, state }); }
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
}

// ─── Workflow 执行引擎 ─────────────────────────────────────────────

async function runWorkflow(wf: Workflow, state: RunState): Promise<void> {
  const layers = topoLayers(wf.nodes, wf.edges);

  for (let iter = 0; iter < wf.globalMaxLoops; iter++) {
    state.iteration = iter + 1;
    broadcast("run:state", { workflowId: wf.id, state });

    for (const layer of layers) {
      if (state.status !== "running") break;

      // 同一层内：非 agent 节点串行（if/for 有分支副作用），agent 节点并行
      const nonAgentNodes = layer.filter(n => n.type !== "agent");
      const agentNodes = layer.filter(n => n.type === "agent");

      // 先串行执行 if/for 节点
      for (const node of nonAgentNodes) {
        if (state.status !== "running") break;
        await executeNode(node, wf, state);
      }

      // 再并行执行同层的 agent 节点
      if (agentNodes.length > 0 && state.status === "running") {
        const agentPromises = agentNodes.map(async (node) => {
          const ns = state.results[node.id];
          if (!ns) return;
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
        });
        await Promise.all(agentPromises);
      }
    }

    // 无回边则不循环
    const hasBack = wf.edges.some(e => {
      const allNodes = layers.flat();
      const si = allNodes.findIndex(n => n.id === e.source);
      const ti = allNodes.findIndex(n => n.id === e.target);
      return ti <= si;
    });
    if (!hasBack) break;
  }

  state.status = "done";
  state.currentStep = undefined;
  broadcast("run:state", { workflowId: wf.id, state });
}

/** 收集上游输出，JSON 包层带来源标识，截断过长输出 */
function collectUpstream(nodeId: string, wf: Workflow, state: RunState): string {
  const incomingEdges = wf.edges.filter(e => e.target === nodeId);
  if (incomingEdges.length === 0) return "";

  const maxLen = wf.maxUpstreamLength || 0; // 0 = 不限

  const sources = incomingEdges.map(e => {
    const sourceNode = wf.nodes.find(n => n.id === e.source);
    const rawOutput = state.results[e.source]?.output ?? "";
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

/** 执行单个节点（if/for/agent），串行调用 */
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
    const branch = evalCondition(node.config.condition ?? "true", upstream);
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
    if (node.config.loopExpr) {
      try { count = evalCondition(node.config.loopExpr, upstream) ? (parseInt(String(evalCondition(node.config.loopExpr, upstream))) || count) : count; } catch { /* keep default */ }
    }

    const bodyIds = node.config.loopBodyNodeIds ?? [];
    const bodyNodes = allNodes.filter(n => bodyIds.includes(n.id));
    let broke = false;

    for (let li = 0; li < count; li++) {
      if (state.status !== "running") break;
      if (node.config.breakCondition) {
        const shouldBreak = evalCondition(node.config.breakCondition, upstream);
        if (shouldBreak) { broke = true; break; }
      }
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
  // workflow 扩展在 packages/extensions/workflow/，guard 在同级的 wf-agent-guard/
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const candidate = path.resolve(thisDir, "..", "wf-agent-guard", "dist", "index.js");
  try {
    fs.accessSync(candidate);
    guardExtPath = candidate;
  } catch {
    // 尝试从 npm 全局安装找
    try {
      const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
      const npmCandidate = path.join(npmRoot, "lyu-extension-wf-agent-guard", "dist", "index.js");
      fs.accessSync(npmCandidate);
      guardExtPath = npmCandidate;
    } catch {
      guardExtPath = ""; // 标记为找不到，不再重试
    }
  }
  return guardExtPath || "";
}

/** 用独立子进程执行 agent 节点 */
async function executeAgentNode(node: WorkflowNode, upstream: string): Promise<string> {
  // 构造 prompt
  const toolInfo = buildToolInfo(node);
  const basePrompt = upstream
    ? `[上游输入(JSON)]\n${upstream}\n\n上游输入是 JSON 数组，每个元素包含 sourceLabel(来源节点名)、sourcePort(来源端口)、output(输出内容)。请根据上游输入完成任务。`
    : node.config.systemPrompt ?? "请开始工作";
  const prompt = toolInfo ? `${toolInfo}\n\n${basePrompt}` : basePrompt;

  // 确定可执行命令名
  let cmdName = "pi";
  try { execSync("which lyu 2>/dev/null", { stdio: "pipe" }); cmdName = "lyu"; } catch { /* fallback to pi */ }

  // 构造命令行参数
  const args: string[] = ["--print", "--no-extensions"];

  // 指定 model（如果节点配了）
  if (node.config.model) {
    args.push("--model", node.config.model);
  }

  // 加载 guard 扩展（实现 per-agent 工具隔离）
  const guardPath = findGuardExtPath();
  if (guardPath) {
    args.push("--extension", guardPath);
  }

  // 添加 prompt
  args.push(prompt);

  // 构造环境变量（传递工具限制给 guard 扩展）
  const envExtra: Record<string, string> = {};
  const whitelist = (node.config.tools as string[] | undefined);
  const blacklist = (node.config.disabledTools as string[] | undefined);
  if (whitelist && whitelist.length > 0) envExtra.WORKFLOW_TOOLS_WHITELIST = whitelist.join(",");
  if (blacklist && blacklist.length > 0) envExtra.WORKFLOW_TOOLS_BLACKLIST = blacklist.join(",");

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${node.label} timed out (120s)`));
    }, 120_000);

    execFile(cmdName, args, {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...envExtra },
    }, (err, stdout, stderr) => {
      clearTimeout(timeout);
      if (err) {
        const output = stdout?.trim() || stderr?.trim() || err.message;
        resolve(output);
      } else {
        resolve(stdout?.trim() || "(no output)");
      }
    });
  });
}

/** 根据节点工具配置，构造工具约束提示 */
function buildToolInfo(node: WorkflowNode): string {
  const parts: string[] = [];

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

/** 安全地执行条件表达式 */
function evalCondition(expr: string, input: string): boolean {
  try {
    const fn = new Function("$input", `"use strict"; return (${expr});`);
    const result = fn(input);
    return !!result;
  } catch {
    return false;
  }
}

function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const layers = topoLayers(nodes, edges);
  return layers.flat();
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
    // 如果没有入度为 0 的节点，说明有环，把剩余节点全放进当前层
    if (ready.length === 0) {
      for (const id of remaining) {
        const n = nodeMap.get(id);
        if (n) layer.push(n);
      }
      if (layer.length > 0) layers.push(layer);
      break;
    }
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

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(serveStatic);

    // WebSocket upgrade (简易实现)
    server.on("upgrade", (req, socket, head) => {
      if (!(req.url ?? "/").startsWith("/ws")) { socket.destroy(); return; }

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

      // 接收帧（简易：只处理小 text 帧）
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        // 解析 text frame
        if (buf.length < 2) return;
        const opcode = buf[0]! & 0x0f;
        const masked = !!(buf[1]! & 0x80);
        let payloadLen = buf[1]! & 0x7f;
        let offset = 2;
        if (payloadLen === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); offset = 4; }
        else if (payloadLen === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (masked) offset += 4;
        if (buf.length < offset + payloadLen) return;

        let payload = buf.subarray(offset, offset + payloadLen);
        if (masked) {
          const mask = buf.subarray(offset - 4, offset);
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
        }

        buf = buf.subarray(offset + payloadLen);

        if (opcode === 0x1) { // text
          handleWsMessage(payload.toString("utf-8"));
        } else if (opcode === 0x8) { // close
          const idx = wsClients.indexOf(client);
          if (idx >= 0) wsClients.splice(idx, 1);
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
  for (const c of wsClients) try { c.socket.destroy(); } catch { /* ok */ }
  wsClients.length = 0;
  server?.close();
  server = null;
}

// ─── 扩展入口 ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.registerCommand("workflow", {
    description: "Open workflow editor — visually compose multi-agent pipelines",
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      if (args.trim() === "stop") {
        stopServer();
        pi.sendMessage({ customType: "workflow", content: "Workflow server stopped", display: true });
        return;
      }

      if (!server) {
        const actualPort = await startServer();
        const url = `http://127.0.0.1:${actualPort}`;

        // 打开浏览器
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        try { execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch { /* ok */ }

        pi.sendMessage({
          customType: "workflow",
          content: `Workflow editor: ${url}`,
          display: true,
          details: { url, port: actualPort },
        });
      } else {
        const url = `http://127.0.0.1:${port}`;
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        try { execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch { /* ok */ }
      }
    },
  });

  // agent_end 事件回填节点结果
  pi.on("agent_end", (event: AgentEndEvent) => {
    for (const [wfId, state] of runStates) {
      if (state.status !== "running" || !state.currentStep) continue;
      const lastMsg = event.messages[event.messages.length - 1];
      if (lastMsg?.role === "assistant") {
        const content = lastMsg.content;
        const text = Array.isArray(content)
          ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
          : typeof content === "string" ? content : "";
        const ns = state.results[state.currentStep];
        if (ns) ns.output = text;
        broadcast("run:nodeResult", { workflowId: wfId, nodeId: state.currentStep, output: text });
      }
    }
  });

  console.error("[workflow] Extension loaded — /workflow to open editor");
}
