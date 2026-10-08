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
import { URL } from "node:url";

const DEFAULT_PORT = 18789;

// ─── Workflow 数据模型 ─────────────────────────────────────────────

interface WorkflowNode {
  id: string;
  type: "agent";
  label: string;
  config: {
    systemPrompt?: string;
    model?: string;
    tools?: string[];
    maxLoops?: number;
    maxTokens?: number;
  };
  position: { x: number; y: number };
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  globalMaxLoops: number;
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
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-5AB5DC828B12").digest("base64");
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
  }
}

// ─── Workflow 执行引擎 ─────────────────────────────────────────────

async function runWorkflow(wf: Workflow, state: RunState): Promise<void> {
  const sorted = topoSort(wf.nodes, wf.edges);

  for (let iter = 0; iter < wf.globalMaxLoops; iter++) {
    state.iteration = iter + 1;
    broadcast("run:state", { workflowId: wf.id, state });

    for (const node of sorted) {
      const ns = state.results[node.id];
      if (!ns) continue;
      ns.status = "running";
      state.currentStep = node.id;
      broadcast("run:state", { workflowId: wf.id, state });

      // 收集上游输出
      const upstream = wf.edges
        .filter(e => e.target === node.id)
        .map(e => state.results[e.source]?.output ?? "")
        .filter(Boolean)
        .join("\n\n");

      // 通过 Pi 驱动 agent
      if (piRef) {
        const prompt = upstream
          ? `[上游输入]\n${upstream}\n\n[请处理以上输入并输出结果]`
          : node.config.systemPrompt ?? "请开始工作";
        piRef.sendUserMessage(prompt, { deliverAs: "followUp" });
      }

      // 等待一小段时间让 Pi 处理（实际结果由 agent_end 事件回填）
      await new Promise(r => setTimeout(r, 500));

      ns.status = "done";
      ns.iterations = (ns.iterations ?? 0) + 1;
      broadcast("run:state", { workflowId: wf.id, state });
    }

    // 无回边则不循环
    const hasBack = wf.edges.some(e => {
      const si = sorted.findIndex(n => n.id === e.source);
      const ti = sorted.findIndex(n => n.id === e.target);
      return ti <= si;
    });
    if (!hasBack) break;
  }

  state.status = "done";
  state.currentStep = undefined;
  broadcast("run:state", { workflowId: wf.id, state });
}

function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const deg = new Map(nodes.map(n => [n.id, 0]));
  const adj = new Map(nodes.map(n => [n.id, [] as string[]]));
  for (const e of edges) { adj.get(e.source)?.push(e.target); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }

  const q: string[] = [];
  for (const [id, d] of deg) if (d === 0) q.push(id);

  const result: WorkflowNode[] = [];
  while (q.length) {
    const id = q.shift()!;
    const n = nodeMap.get(id);
    if (n) result.push(n);
    for (const next of adj.get(id) ?? []) {
      const d = (deg.get(next) ?? 1) - 1;
      deg.set(next, d);
      if (d === 0) q.push(next);
    }
  }
  for (const n of nodes) if (!result.find(r => r.id === n.id)) result.push(n);
  return result;
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
        try { require("node:child_process").execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch { /* ok */ }

        pi.sendMessage({
          customType: "workflow",
          content: `Workflow editor: ${url}`,
          display: true,
          details: { url, port: actualPort },
        });
      } else {
        const url = `http://127.0.0.1:${port}`;
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        try { require("node:child_process").execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch { /* ok */ }
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
