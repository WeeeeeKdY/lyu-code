# NOTICE — 第三方代码与改动声明

本包（`lyu-code`）内含第三方代码。这份文件把「用了谁的、改了什么」写清楚，
不是可选项：MIT 要求随分发保留版权声明，而改动记录是为了让下游能判断信任边界。

## 1. 内含的上游代码

`dist/`、`docs/`、`schemas/` 来自以下 npm 包的发布产物：

| 项目 | 版本 | 许可证 | 版权 |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.5.2 | MIT | Copyright (c) 2026 Earendil Inc. |

取件方式见 `scripts/vendor.mjs`：`npm pack` 后解包，把 `dist/` `docs/` `schemas/`
原样拷入，然后按补丁表改少数几处（见下节）。**我们不分叉上游源码树**，
也不另行维护引擎实现；上游的修复靠更换 `package.json` 里的 `vendor.piCLI` 版本获得。

上游包的 MIT 许可证全文：

```
MIT License

Copyright (c) 2026 Earendil Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 我们对它做了什么

补丁全部定义在 `scripts/vendor.mjs` 的 `PATCHES` 里，可逐条对照。分两类：

### 2.1 换品牌（`kind: "brand"`）

只把写死的 `pi` 换成从 `APP_NAME` 派生的值。把 `piConfig.name` 设回 `"pi"` 时，
这些补丁的结果与上游逐字节等价 —— 也就是说这一类没有改变任何行为。

- `header-wordmark` —— TUI 横幅字标：上游把 `P` 和 `i` 两个字母写死在函数里
- `header-hint-copy` —— 横幅下那句自我介绍

### 2.2 换行为（`kind: "policy"`）

这一类**有意不追求与上游等价**，因为原行为指向的是上游自己的基础设施。
每条都留了环境变量出口，也都在这里显式声明：

| 改动 | 上游原本的行为 | 现在 | 可否改回 |
| --- | --- | --- | --- |
| 发布源 | 向 `pi.dev/api/latest-version` 查最新版 | 向 npm 上的 `lyu-code` 查 | `LYU_LATEST_VERSION_URL` |
| 安装遥测 | 启动时向 `pi.dev/api/report-install` 报一条记录 | **已移除**，不再发出任何请求 | 不支持，这是有意移除 |
| 更新日志链接 | 「有新版本」提示链到 `pi.dev/changelog` | 链到本仓 releases | `LYU_CHANGELOG_URL` |
| 下载提示 | 装不上更新时指向上游 `pi` 的 releases | 指向本仓 releases | `LYU_DOWNLOAD_URL` |
| 安装脚本提示 | 提示里给的是 `curl -fsSL https://pi.dev/install.sh \| sh` | 指向本仓的安装说明 | 不支持 |

改发布源的实际效果：`lyu update` 不会再 `npm i -g` 把上游 `pi` 装回来。
`lyu-code` 与上游包名不同，因此上游那套「先卸旧包再装新包」的分支也不会被触发；
当发布源里的版本不高于当前版本时，它打印的是 already up to date，不会降级。

## 3. 仍然是上游的服务（已知、未改）

以下能力指向上游托管的服务。它们只在用户主动使用时触发，或者在我们这种装法下根本走不到。
这里列出来是为了不制造误解 —— 包括 `scripts/brand-baseline.json` 里那 62 处 `pi.dev` 的去向：

- `/share` 会话分享的查看页默认 `https://pi.dev/session/`（4 处，可用 `PI_SHARE_VIEWER_URL` 覆盖）。
  我们没有自己的查看器，所以保留默认值而不是把功能做成坏的。
- 模型网关 `radius.pi.dev`（36 处）—— 上游托管的中转服务，属于 provider 配置的一部分。
- OAuth 客户端元数据 `https://pi.dev/oauth`（2 处）—— 登录流程里的 client metadata 地址。
- 主题文件的 JSON Schema 地址 `pi.dev/schemas/theme.schema.json`（2 处）—— 只是给编辑器的校验提示。
- bun 单文件版的自更新源 `pi.dev/api/installer/releases`（2 处）—— 只有存在 `managed-install.json`
  标记时才会用到，而我们的分发形态（npm 全局安装）从不会创建它，属于走不到的分支。
- 部分报错与迁移提示里链到上游仓库的文档和 issue —— 那里确实是相关行为的定义处。
- `pi.dev/api/report-install` 的字符串仍留在 dist 里，但它所在的函数已被补丁改成立即返回，
  是死代码。之所以不删字符串，是因为删了会掩盖「这个函数原来干过什么」，而 NOTICE 应该让这事看得见。

## 4. 不在本包内的第三方程序

`gitnexus`、`codebase-memory-mcp` 由 `install.sh` 单独从 npm 全局安装，
是独立程序，不随本包分发，各自遵循其自身许可证。
