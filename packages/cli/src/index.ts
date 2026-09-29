#!/usr/bin/env node
/**
 * Lyu-code CLI entry point.
 *
 * 薄壳：直接委托给 Pi 的 coding-agent main()。
 * Extension 通过 Pi 原生的文件系统发现机制加载（.pi/extensions/）。
 */

// 设置进程标题和环境标记
process.title = "lyu-code";
process.env.PI_CODING_AGENT = "true";
// Pi 内部会用这个环境变量识别自己的运行时
process.env.LYU_CODE = "true";

import { main } from "@earendil-works/pi-coding-agent";

// 直接启动 Pi 的 main，传入命令行参数
// Pi 会自动：
//   1. 解析 CLI 参数（--continue, --session, --model 等）
//   2. 加载 ~/.pi/agent/ 下的全局配置
//   3. 发现 .pi/extensions/ 下的 Extension
//   4. 启动 TUI / headless / ACP 模式
main(process.argv.slice(2));
