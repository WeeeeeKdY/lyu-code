#!/usr/bin/env node
/**
 * postinstall.js — 安装后补丁
 *
 * 将 Pi 编译产物中的 APP_NAME="pi" 替换为 APP_NAME="lyu-code"，
 * 使 TUI 标题栏、启动画面、session 文件名等显示 Lyu-code 品牌。
 *
 * 这和 MiniMax Code 等二次分发项目的做法一致：
 * Pi 的 APP_NAME 是编译时常量，无法通过环境变量覆盖，
 * 只能 patch 编译产物。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const NEW_APP_NAME = "lyu-code";
const FILES_TO_PATCH = [
  // 主 chunk（包含 APP_NAME 定义）
  "dist/bundle/chunks/chunk-OJP47DM6.js",
  // CLI runtime（设 process.title 和 AI_AGENT）
  "dist/bundle/cli-runtime.js",
  // RPC entry
  "dist/bundle/rpc-entry.js",
  // CLI setup
  "dist/cli/setup.js",
  // RPC entry (non-bundle)
  "dist/rpc-entry.js",
];

function findPiDistDir(): string | null {
  // 从当前包的 node_modules 向上找
  const candidates = [
    path.resolve(import.meta.dirname, "node_modules/@earendil-works/pi-coding-agent"),
    path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent"),
  ];

  // 也检查 pnpm 的 .pnpm 目录
  try {
    const pnpmDir = path.resolve(import.meta.dirname, "node_modules/.pnpm");
    if (fs.existsSync(pnpmDir)) {
      const entries = fs.readdirSync(pnpmDir).filter((e) => e.startsWith("@earendil-works+pi-coding-agent"));
      for (const entry of entries) {
        candidates.push(
          path.join(pnpmDir, entry, "node_modules/@earendil-works/pi-coding-agent")
        );
      }
    }
  } catch {
    // ignore
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "dist"))) {
      return dir;
    }
  }
  return null;
}

function patchFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, "utf-8");
  let modified = false;

  // 替换 APP_NAME="pi" → APP_NAME="lyu-code"
  if (content.includes('APP_NAME="pi"')) {
    content = content.replaceAll('APP_NAME="pi"', `APP_NAME="${NEW_APP_NAME}"`);
    modified = true;
  }

  // 替换 AI_AGENT="pi" → AI_AGENT="lyu-code"
  if (content.includes('AI_AGENT="pi"')) {
    content = content.replaceAll('AI_AGENT="pi"', `AI_AGENT="${NEW_APP_NAME}"`);
    modified = true;
  }

  // 替换 process.title=APP_NAME 后追加覆盖（如果 main 里会覆盖 process.title）
  // 对于 cli-runtime.js，需要把 setupCli 里的 process.title=APP_NAME 后面加一行覆盖
  if (content.includes("process.title=APP_NAME") && !content.includes("process.title=APP_NAME,process.env.LYU_CODE")) {
    content = content.replace(
      "process.title=APP_NAME,process.env.PI_CODING_AGENT",
      `process.title=APP_NAME,process.env.LYU_CODE&&(process.title="${NEW_APP_NAME}"),process.env.PI_CODING_AGENT`
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, content, "utf-8");
  }
  return modified;
}

function main() {
  const piDir = findPiDistDir();
  if (!piDir) {
    console.log("[lyu-code:postinstall] Pi dist not found, skipping brand patch");
    return;
  }

  let patched = 0;
  for (const relPath of FILES_TO_PATCH) {
    const filePath = path.join(piDir, relPath);
    if (patchFile(filePath)) {
      patched++;
      console.log(`  ✅ Patched ${relPath}`);
    }
  }

  if (patched > 0) {
    console.log(`[lyu-code:postinstall] Branded ${patched} file(s) → APP_NAME="${NEW_APP_NAME}"`);
  } else {
    console.log("[lyu-code:postinstall] No files) files needed patching (already branded or not found)");
  }
}

main();
