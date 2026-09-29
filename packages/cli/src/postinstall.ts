#!/usr/bin/env node
/**
 * postinstall.js — 安装后品牌补丁
 *
 * 核心策略：Pi 的 config.js 在启动时读取自己的 package.json：
 *   piConfigName = pkg.piConfig?.name
 *   APP_NAME = piConfigName || "pi"
 *   APP_TITLE = piConfigName ? APP_NAME : "π"
 *
 * 所以只需在 pi-coding-agent 的 package.json 中设置
 * piConfig.name = "lyu-code"，Pi 就会自动把所有品牌标识
 * （APP_NAME、APP_TITLE、终端标题、欢迎语等）都变成 lyu-code。
 *
 * 作为兜底，同时对 bundle chunks 做文本替换 patch，
 * 防止某些场景下 package.json 未被读取（如 Bun binary）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const BRAND_NAME = "lyu-code";

// ─── 1. package.json piConfig.name 补丁（首选方案） ───────────────────

function patchPiConfigName(piDir: string): boolean {
  const pkgPath = path.join(piDir, "package.json");
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    if (pkg.piConfig?.name === BRAND_NAME) return false; // 已经 patch 过

    if (!pkg.piConfig) pkg.piConfig = {};
    pkg.piConfig.name = BRAND_NAME;

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[lyu-code:postinstall] Failed to patch piConfig in ${pkgPath}:`, e);
    return false;
  }
}

// ─── 2. Bundle chunks 文本替换补丁（兜底方案） ────────────────────────

const FILES_TO_PATCH = [
  "dist/bundle/chunks/chunk-OJP47DM6.js",
  "dist/bundle/cli-runtime.js",
  "dist/bundle/rpc-entry.js",
];

/** Pi 源码中硬编码的品牌字符串 → 替换为 Lyu-code 版本 */
const TEXT_REPLACEMENTS: [string, string][] = [
  // 品牌常量
  ["piConfigName=pkg.piConfig?.name", `piConfigName="${BRAND_NAME}"`],

  // 环境标识
  ['AI_AGENT="pi"', `AI_AGENT="${BRAND_NAME}"`],

  // TUI 启动画面 onboarding 文本
  [
    "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
    `${BRAND_NAME} can explain its own features. Ask it how to use or extend ${BRAND_NAME}.`,
  ],
];

function patchChunk(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, "utf-8");
  let modified = false;

  for (const [from, to] of TEXT_REPLACEMENTS) {
    if (content.includes(from)) {
      content = content.replaceAll(from, to);
      modified = true;
    }
  }

  // process.title 覆盖（cli-runtime.js）
  if (content.includes("process.title=APP_NAME,process.env.PI_CODING_AGENT") && !content.includes("process.env.LYU_CODE")) {
    content = content.replace(
      "process.title=APP_NAME,process.env.PI_CODING_AGENT",
      `process.title=APP_NAME,process.env.LYU_CODE&&(process.title="${BRAND_NAME}"),process.env.PI_CODING_AGENT`
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, content, "utf-8");
  }
  return modified;
}

// ─── 查找 Pi 安装目录 ────────────────────────────────────────────────

function findPiDistDirs(): string[] {
  const candidates: string[] = [];

  const thisDir = import.meta.dirname ?? path.dirname(import.meta.url.replace("file://", ""));
  for (const base of [thisDir, path.resolve(thisDir, "..")]) {
    const direct = path.join(base, "node_modules/@earendil-works/pi-coding-agent");
    if (fs.existsSync(path.join(direct, "dist"))) candidates.push(direct);
  }

  // pnpm .pnpm 目录
  for (const base of [thisDir, path.resolve(thisDir, "..")]) {
    const pnpmDir = path.join(base, "node_modules/.pnpm");
    if (fs.existsSync(pnpmDir)) {
      try {
        const entries = fs.readdirSync(pnpmDir).filter((e) => e.startsWith("@earendil-works+pi-coding-agent"));
        for (const entry of entries) {
          candidates.push(path.join(pnpmDir, entry, "node_modules/@earendil-works/pi-coding-agent"));
        }
      } catch { /* ignore */ }
    }
  }

  // npm global 安装
  const npmGlobal = path.resolve(process.execPath, "../lib/node_modules/lyu-code/node_modules/@earendil-works/pi-coding-agent");
  if (fs.existsSync(path.join(npmGlobal, "dist"))) candidates.push(npmGlobal);

  return candidates.filter((d) => fs.existsSync(path.join(d, "dist")));
}

// ─── 主流程 ──────────────────────────────────────────────────────────

function main() {
  const piDirs = findPiDistDirs();
  if (piDirs.length === 0) {
    console.log("[lyu-code:postinstall] Pi dist not found, skipping brand patch");
    return;
  }

  for (const piDir of piDirs) {
    // 首选：package.json piConfig.name
    const configPatched = patchPiConfigName(piDir);

    // 兜底：bundle chunks 文本替换
    let chunksPatched = 0;
    for (const relPath of FILES_TO_PATCH) {
      if (patchChunk(path.join(piDir, relPath))) {
        chunksPatched++;
      }
    }

    if (configPatched || chunksPatched > 0) {
      const parts: string[] = [];
      if (configPatched) parts.push("piConfig.name");
      if (chunksPatched > 0) parts.push(`${chunksPatched} chunk(s)`);
      console.log(`[lyu-code:postinstall] Branded → "${BRAND_NAME}" (${parts.join(" + ")})`);
    } else {
      console.log(`[lyu-code:postinstall] Already branded → "${BRAND_NAME}"`);
    }
  }
}

main();
