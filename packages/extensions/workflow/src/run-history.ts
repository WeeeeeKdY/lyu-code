/**
 * 运行历史。
 *
 * 引擎把每次运行的状态放在内存 Map 里，服务一重启（或 Lyu 一关）就没影了，
 * 于是「昨天那次为什么失败」「那个节点跑了多久」这类问题无从查起。这里把状态
 * 落到磁盘，目录结构和工作流定义分开：
 *
 *   ~/.pi/agent/workflow-runs/<runId>/run.json
 *
 * 写入策略是「观察者」而不是「引擎每处埋点」：引擎每次广播 run:state 时喂给
 * observe()，这里自己比对前后两次状态，得出每个节点的起止时间和耗时。这样
 * 引擎加新节点类型也不会漏记录。
 *
 * 写入是节流的（默认 500ms 合并一次），收尾状态立即落盘并且标 finishedAt。
 * 文件权限 0600、目录 0700：节点输出里可能有代码和密钥。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNS_DIR = path.join(os.homedir(), ".pi", "agent", "workflow-runs");

/** 只留最近多少次运行，避免目录无限长。 */
const MAX_RUNS = 200;
/** 单个节点输出落盘上限，超出截断（agent 输出可能非常大）。 */
const MAX_FIELD = 20_000;
const WRITE_THROTTLE_MS = 500;
const TERMINAL_STATUSES = new Set(["done", "error", "paused", "idle"]);

export interface RunNodeRecord {
  status: string;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  iterations?: number;
  asks?: { question: string; answer: string; timedOut?: boolean }[];
}

export interface RunRecord {
  runId: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  input: string;
  finalOutput?: string;
  error?: string;
  iteration?: number;
  /** 出错时正在跑哪个节点：引擎把错误记在 run 上，不往节点里写，
   *  不补这一步就分不清「哪个节点挂了」，重试也就无从下手。 */
  currentStep?: string;
  nodeLabels: Record<string, string>;
  nodes: Record<string, RunNodeRecord>;
  /** 运行当时的定义快照：复盘时要看的是「当时那个版本」，不是现在磁盘上的。 */
  workflowSnapshot?: unknown;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  nodeCount: number;
  failedNodes: string[];
  error?: string;
}

/** 引擎状态里我们关心的部分（结构化类型，避免和 index.ts 循环依赖）。 */
export interface ObservableState {
  status: string;
  finalOutput?: string;
  error?: string;
  iteration?: number;
  currentStep?: string;
  results: Record<
    string,
    {
      status: string;
      output?: string;
      error?: string;
      iterations?: number;
      asks?: { question: string; answer: string; timedOut?: boolean }[];
    }
  >;
}

interface ActiveRun {
  record: RunRecord;
  timer: NodeJS.Timeout | null;
  dirty: boolean;
}

/** workflowId → 当前这次运行；一个工作流同时只允许跑一个。 */
const active = new Map<string, ActiveRun>();

function clip(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text.length <= MAX_FIELD) return text;
  return `${text.slice(0, MAX_FIELD)}\n…[截断，共 ${text.length} 字]`;
}

function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 落盘一次。原子写 + 合并节流，避免高频状态把磁盘打满。 */
function persist(entry: ActiveRun): void {
  const record = entry.record;
  record.updatedAt = Date.now();
  try {
    const dir = runDir(record.runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(dir, "run.json"), JSON.stringify(record, null, 2));
    entry.dirty = false;
  } catch (err) {
    // 历史落盘失败不能拖垮正在跑的引擎，但要在服务日志里留证据。
    process.stderr.write(`[workflow] 运行历史写入失败 ${record.runId}: ${String(err)}\n`);
  }
}

function schedule(entry: ActiveRun): void {
  entry.dirty = true;
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.dirty) persist(entry);
  }, WRITE_THROTTLE_MS);
  // 定时器不该拖住进程退出。
  entry.timer.unref?.();
}

function flush(entry: ActiveRun): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  persist(entry);
}

/** 开一次新运行；返回 runId。 */
export function startRun(params: {
  runId: string;
  workflowId: string;
  workflowName?: string;
  input: string;
  nodeLabels: Record<string, string>;
  workflowSnapshot?: unknown;
}): string {
  const now = Date.now();
  const entry: ActiveRun = {
    record: {
      runId: params.runId,
      workflowId: params.workflowId,
      workflowName: params.workflowName,
      status: "running",
      startedAt: now,
      updatedAt: now,
      input: clip(params.input) ?? "",
      nodeLabels: params.nodeLabels,
      nodes: {},
      workflowSnapshot: params.workflowSnapshot,
    },
    timer: null,
    dirty: false,
  };
  active.set(params.workflowId, entry);
  flush(entry);
  prune();
  return params.runId;
}

/** 节点真正结束的状态。pending 不是结束，早期版本在这里把它当结束，
 *  于是所有节点在第一帧就写上了 finishedAt，耗时算成 0 或负数。 */
const TERMINAL_NODE_STATUSES = new Set(["done", "error", "skipped"]);

/**
 * 喂一次状态快照。
 *
 * 每个节点的开始时间取「第一次看到它 running」的时刻；结束时间取第一次看到
 * 非 running 的时刻，两者相减就是耗时。这样不用改引擎就能有耗时数据。
 */
export function observeRun(workflowId: string, state: ObservableState): void {
  const entry = active.get(workflowId);
  if (!entry) return;
  const record = entry.record;
  const now = Date.now();

  record.status = state.status;
  if (state.error !== undefined) record.error = state.error;
  if (state.finalOutput !== undefined) record.finalOutput = clip(state.finalOutput);
  if (state.iteration !== undefined) record.iteration = state.iteration;
  if (state.currentStep !== undefined) record.currentStep = state.currentStep;

  for (const [nodeId, nodeState] of Object.entries(state.results ?? {})) {
    const previous = record.nodes[nodeId];
    const next: RunNodeRecord = previous ?? { status: nodeState.status };

    if (nodeState.status === "running") {
      if (!next.startedAt) next.startedAt = now;
    } else if (TERMINAL_NODE_STATUSES.has(nodeState.status)) {
      // 只在第一次结束的时候记 finishedAt，重跑同一节点不应该互相覆盖耗时。
      if (!next.finishedAt) {
        next.finishedAt = now;
        if (next.startedAt) next.durationMs = next.finishedAt - next.startedAt;
      }
    }
    next.status = nodeState.status;
    if (nodeState.output !== undefined) next.output = clip(nodeState.output);
    if (nodeState.error !== undefined) next.error = clip(nodeState.error);
    if (nodeState.iterations !== undefined) next.iterations = nodeState.iterations;
    if (nodeState.asks?.length) next.asks = nodeState.asks;

    record.nodes[nodeId] = next;
  }

  if (TERMINAL_STATUSES.has(state.status)) {
    if (!record.finishedAt) record.finishedAt = now;
    if (state.status === "error" && record.currentStep) {
      const current = record.nodes[record.currentStep];
      if (current && current.status === "running") {
        current.status = "error";
        current.error = clip(state.error) ?? current.error;
        current.finishedAt = now;
        if (current.startedAt) current.durationMs = now - current.startedAt;
      }
    }
    flush(entry);
    active.delete(workflowId);
    return;
  }
  schedule(entry);
}

/** 服务关闭/工作流被删时收拾残局：把还在内存里的运行写成 finishedAt=现在。 */
export function flushAll(): void {
  for (const entry of active.values()) flush(entry);
  active.clear();
}

export function listRuns(limit = 20): RunSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const name of entries) {
    const file = path.join(runDir(name), "run.json");
    let record: RunRecord;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
    } catch {
      continue;
    }
    const nodes = Object.values(record.nodes ?? {});
    summaries.push({
      runId: record.runId ?? name,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.finishedAt ? record.finishedAt - record.startedAt : undefined,
      nodeCount: nodes.length,
      failedNodes: Object.entries(record.nodes ?? {})
        .filter(([, node]) => node.status === "error")
        .map(([id, node]) => record.nodeLabels?.[id] ?? id),
      error: record.error,
    });
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries.slice(0, limit);
}

export function readRun(runId: string): RunRecord | null {
  // runId 来自 URL，只允许安全字符，避免 ../ 穿越。
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(runId), "run.json"), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

/** 删掉超出 MAX_RUNS 的最旧运行。 */
export function prune(): void {
  let names: string[];
  try {
    names = fs.readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  const withTime: { name: string; startedAt: number }[] = [];
  for (const name of names) {
    const file = path.join(runDir(name), "run.json");
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
      withTime.push({ name, startedAt: record.startedAt ?? 0 });
    } catch {
      withTime.push({ name, startedAt: 0 });
    }
  }
  if (withTime.length <= MAX_RUNS) return;
  withTime.sort((a, b) => a.startedAt - b.startedAt);
  for (const stale of withTime.slice(0, withTime.length - MAX_RUNS)) {
    try {
      fs.rmSync(runDir(stale.name), { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}
