#!/usr/bin/env node
/**
 * postinstall.js — 安装后品牌补丁
 *
 * 将 Pi 编译产物中的品牌标识替换为 Lyu-code：
 * 1. piConfigName="lyu-code" — 使 APP_NAME 和 APP_TITLE 都是 "lyu-code"
 * 2. AI_AGENT="lyu-code" — 标识 agent 类型
 * 3. onboarding 文本 — "Pi can explain..." → "Lyu-code can explain..."
 *
 * Pi 的品牌逻辑（编译时 bake 进 bundle）：
 *   piConfigName = pkg.piConfig?.name
 *   APP_NAME = piConfigName || "pi"
 *   APP_TITLE = piConfigName ? APP_NAME : "π"  ← 那个 π 符号
 *   onboarding = "Pi can explain its own features..."
 */

import * as fs from "node:fs";
import * as path from "node:path";

const BRAND_NAME = "lyu-code";
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

  // Pi 自更新提示中的 "pi" 命令引用
  // （这些在 APP_NAME 已 patch 后会自动变成 "lyu-code"，不需要额外处理）
];

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

function main() {
  const piDirs = findPiDistDirs();
  if (piDirs.length === 0) {
    console.log("[lyu-code:postinstall] Pi dist not found, skipping brand patch");
    return;
  }

  for (const piDir of piDirs) {
    let patched = 0;
    for (const relPath of FILES_TO_PATCH) {
      if (patchChunk(path.join(piDir, relPath))) {
        patched++;
      }
    }
    if (patched > 0) {
      console.log(`[lyu-code:postinstall] Branded ${patched} file(s) → "${BRAND_NAME}"`);
    }
  }
}

main();
