#!/usr/bin/env node
/**
 * postinstall.js — 安装后品牌补丁
 *
 * 将 Pi 编译产物中的品牌标识替换为 Lyu-code：
 * 1. piConfigName="lyu-code" — 使 APP_NAME 和 APP_TITLE 都是 "lyu-code"
 * 2. AI_AGENT="lyu-code" — 标识 agent 类型
 *
 * Pi 的品牌逻辑（编译时 bake 进 bundle）：
 *   piConfigName = pkg.piConfig?.name   // 从 package.json 读
 *   APP_NAME = piConfigName || "pi"     // 默认 "pi"
 *   APP_TITLE = piConfigName ? APP_NAME : "π"  // 默认 "π" 符号
 *
 * 没有 piConfig.name 时，APP_NAME="pi" 且 APP_TITLE="π"，
 * 所以必须 patch piConfigName 而不仅仅是 APP_NAME。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const BRAND_NAME = "lyu-code";
const FILES_TO_PATCH = [
  "dist/bundle/chunks/chunk-OJP47DM6.js",
  "dist/bundle/cli-runtime.js",
  "dist/bundle/rpc-entry.js",
];

function findPiDistDirs(): string[] {
  const candidates: string[] = [];

  // 从当前包的 node_modules 向上找
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

  // npm global
  const npmGlobal = path.resolve(process.execPath, "../lib/node_modules/lyu-code/node_modules/@earendil-works/pi-coding-agent");
  if (fs.existsSync(path.join(npmGlobal, "dist"))) candidates.push(npmGlobal);

  return candidates.filter((d) => fs.existsSync(path.join(d, "dist")));
}

function patchFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, "utf-8");
  let modified = false;

  // 核心补丁：piConfigName=pkg.piConfig?.name → piConfigName="lyu-code"
  // 这会让 APP_NAME = "lyu-code", APP_TITLE = "lyu-code"（不再显示 "π"）
  if (content.includes("piConfigName=pkg.piConfig?.name")) {
    content = content.replace(
      /piConfigName=pkg\.piConfig\?\.name/g,
      `piConfigName="${BRAND_NAME}"`
    );
    modified = true;
  }

  // 补丁：AI_AGENT="pi" → AI_AGENT="lyu-code"
  if (content.includes('AI_AGENT="pi"')) {
    content = content.replaceAll('AI_AGENT="pi"', `AI_AGENT="${BRAND_NAME}"`);
    modified = true;
  }

  // 补丁：process.title 覆盖（cli-runtime.js）
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
      const filePath = path.join(piDir, relPath);
      if (patchFile(filePath)) {
        patched++;
      }
    }
    if (patched > 0) {
      console.log(`[lyu-code:postinstall] Branded ${patched} file(s) in ${piDir} → "${BRAND_NAME}"`);
    }
  }
}

main();
