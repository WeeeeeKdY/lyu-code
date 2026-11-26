/**
 * ask_user 人机协同回归测试（不需要真实 LLM）
 *
 *   node test/ask.e2e.mjs
 *
 * 用 LYU_WORKFLOW_AGENT_COMMAND 指向 test/fake-agent.sh 冒充节点 agent，
 * 覆盖四条路径：
 *   1. 提问 -> WS 广播 -> 前端回答 -> agent 拿到回答继续
 *   2. 无人回答 -> 超时兜底（agent 收到 timedOut，自己拿主意）
 *   3. 普通节点（不提问）不受影响
 *   4. 提问挂起时中止运行 -> 提问立即收敛、run 回到 idle
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createRequire } from "node:module";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(TEST_DIR, "..");
const require = createRequire(path.join(PKG_DIR, "package.json"));
const WebSocket = require("ws");

const FAKE_AGENT = path.join(TEST_DIR, "fake-agent.sh");
fs.chmodSync(FAKE_AGENT, 0o755);

// 必须在本模块 import 之前设置（扩展在加载时读）
process.env.LYU_WORKFLOW_NO_OPEN = "1"; // 别真的弹浏览器
process.env.LYU_WORKFLOW_ISOLATED = "1"; // 不自动启动、不荠用别人的服务
process.env.LYU_WORKFLOW_AGENT_COMMAND = FAKE_AGENT;
process.env.WORKFLOW_ASK_TIMEOUT_MS = "3000";

// ─── 用 stub 启动 workflow 服务 ─────────────────────────────────
const commands = {};
let port = null;
const stubPi = {
  registerCommand: (name, def) => { commands[name] = def; },
  sendMessage: (msg) => { if (msg?.details?.port) port = msg.details.port; },
  sendUserMessage() {},
  registerTool() {},
  on() {},
};

// 注意：这份测试需要一个已编译的 dist/index.js。
//
// 扩展自身现在由引擎直接加载 src/index.ts（pi 的加载器会把源码里的 "./run-history.js"
// 映射到 "./run-history.ts"），但裸 node 不做这个映射，所以直接 import 源码会报
// ERR_MODULE_NOT_FOUND。要恢复这份回归测试，得先把编译链路接回来（需要引擎类型可解析）。
const ext = (await import(path.join(PKG_DIR, "dist/index.js"))).default;
ext(stubPi);
await commands.workflow.handler("", {}); // 注意：会尝试打开浏览器，测试环境里无副作用

for (let i = 0; i < 200 && !port; i++) await new Promise(r => setTimeout(r, 50));
if (!port) throw new Error("workflow 服务未启动");

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const send = (type, data) => ws.send(JSON.stringify({ type, data }));
const api = (p) => fetch(`http://127.0.0.1:${port}${p}`).then(r => r.json());

function makeWorkflow(name) {
  return {
    id: crypto.randomUUID(),
    name,
    nodes: [
      { id: "n-in", type: "input", label: "Input", config: {}, position: { x: 0, y: 0 } },
      { id: "n-agent", type: "agent", label: "Planner", config: { tools: ["read"] }, position: { x: 200, y: 0 } },
      { id: "n-out", type: "output", label: "Output", config: {}, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "n-in", target: "n-agent", sourcePort: "out" },
      { id: "e2", source: "n-agent", target: "n-out", sourcePort: "out" },
    ],
    globalMaxLoops: 10,
    maxUpstreamLength: 8000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── 场景编排 ───────────────────────────────────────────────────
const scenarios = [
  {
    name: "1) 提问 -> 回答 -> agent 继续",
    mode: "ask",
    onAsk: (ask, wfId) => {
      if (!ask.askId || !ask.question || !ask.nodeId || !ask.nodeLabel) throw new Error("提问载荷不完整");
      send("run:answer", { askId: ask.askId, answer: "Postgres" });
    },
    check: (state) => {
      if (!String(state.finalOutput).includes('"answer":"Postgres"')) throw new Error("回答没有回传到 agent");
      const asks = state.results["n-agent"]?.asks;
      if (!asks?.length || asks[0].answer !== "Postgres") throw new Error("节点未记录 Q/A");
    },
  },
  {
    name: "2) 无人回答 -> 超时兜底",
    mode: "ask",
    onAsk: () => { /* 故意不回答 */ },
    check: (state) => {
      if (!String(state.finalOutput).includes('"timedOut":true')) throw new Error("超时路径不对");
    },
  },
  {
    name: "3) 普通节点不受影响",
    mode: "plain",
    onAsk: () => { throw new Error("不该收到提问"); },
    check: (state) => {
      if (!String(state.finalOutput).includes("PLAIN_OUTPUT")) throw new Error("输出不对");
      if (state.results["n-agent"]?.asks) throw new Error("不该记录 asks");
    },
  },
  {
    name: "4) 提问挂起时中止运行",
    mode: "ask",
    onAsk: async (ask, wfId) => {
      send("workflow:stop", { workflowId: wfId });
      await new Promise(r => setTimeout(r, 300));
      const status = await api("/api/status");
      if (status.pendingAsks !== 0) throw new Error("中止后仍残留悬挂提问");
      // 迟到的回答不应炸掉服务
      send("run:answer", { askId: ask.askId, answer: "迟到" });
      await new Promise(r => setTimeout(r, 200));
      await api("/api/status");
      current.askDone = true;
      maybeNext();
    },
    expectIdle: true,
  },
];

let index = -1;
let current = null;

function next() {
  index++;
  current = scenarios[index];
  if (!current) {
    console.log("\n✅ 全部场景通过");
    ws.close();
    process.exit(0);
  }
  process.env.WF_TEST_MODE = current.mode;
  const wf = makeWorkflow(current.name);
  console.log(`\n▶ ${current.name}`);
  send("workflow:create", wf);
  send("workflow:run", { workflowId: wf.id, input: "跑一下" });
}

ws.on("open", next);

/** expectIdle 场景需同时等到「run 回 idle」和「onAsk 内的异步校验跑完」才算结束 */
function maybeNext() {
  if (!current?.expectIdle) return;
  if (current.idleSeen && current.askDone) {
    console.log("  ✓ 中止已收敛，迟到的回答未炸服务");
    next();
  }
}

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  try {
    if (msg.type === "run:needInput") {
      await current.onAsk(msg.data, msg.data.workflowId);
    } else if (msg.type === "run:state") {
      const state = msg.data.state;
      if (current.expectIdle) {
        if (state.status === "idle") { current.idleSeen = true; maybeNext(); }
        else if (state.status === "error") throw new Error(state.error);
      } else if (state.status === "done") {
        current.check(state);
        console.log(`  ✓ ${JSON.stringify(state.finalOutput).slice(0, 90)}`);
        next();
      } else if (state.status === "error") {
        throw new Error(state.error);
      }
    }
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }
});

setTimeout(() => { console.error("❌ 测试超时"); process.exit(1); }, 120_000);
