#!/bin/bash
# 测试用假 agent：不调 LLM，直接把 $WF_TEST_MODE 指定的行为打出来
#   ask      -> 调 /api/ask 提问并等待回答（模拟 ask_user 工具）
#   plain    -> 只输出文本，不提问
#   hangup   -> 提问后立刻退出（模拟子进程被杀）
set -u

MODE="${WF_TEST_MODE:-ask}"

case "$MODE" in
  plain)
    echo "PLAIN_OUTPUT 没有提问"
    ;;
  hangup)
    node -e '
      (async () => {
        await fetch(process.env.WORKFLOW_ASK_URL, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: "会中断的提问", nodeId: process.env.WORKFLOW_NODE_ID, nodeLabel: process.env.WORKFLOW_NODE_LABEL }) })
          .catch(() => {});
        process.exit(9); // 提问挂起时直接死掉
      })();
    '
    ;;
  *)
    node -e '
      (async () => {
        const url = process.env.WORKFLOW_ASK_URL;
        if (!url) { console.log("NO_ASK_URL"); return; }
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: "生成的目标数据库选哪个？",
            options: ["Postgres", "SQLite"],
            nodeId: process.env.WORKFLOW_NODE_ID,
            nodeLabel: process.env.WORKFLOW_NODE_LABEL,
            iteration: Number(process.env.WORKFLOW_ITERATION || 0),
          }),
        });
        const data = await res.json();
        console.log("ASK_RESULT=" + JSON.stringify(data));
      })().catch(e => { console.log("ASK_ERROR=" + e.message); process.exit(1); });
    '
    ;;
esac
