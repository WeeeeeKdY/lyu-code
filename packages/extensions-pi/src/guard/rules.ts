/**
 * 危险命令判定。
 *
 * 为什么需要这个：pi 的 `bash` 工具默认无审批直通。`core/trust-manager.ts` 只管
 * 「要不要读 AGENTS.md」；全库 grep `rm -rf|dangerous` 零命中；没有沙箱。
 * 也就是说 agent 一句 `rm -rf ~` 就能执行。
 *
 * 分级思路（不追求穷尽，追求「不会误伤」）：
 *   - **deny**：几乎没有正当用途、且不可逆的（rm 根目录/家目录、mkfs、fork bomb）
 *   - **ask**：有可能是正当意图但不可逆（rm 具体路径、git push --force、git reset --hard）
 *   - **allow**：其余一切
 *
 * 每条规则都带 id 和理由，审计日志里能看出是「哪条规则、因为什么」拦的。
 */

export type GuardLevel = "allow" | "ask" | "deny";

export interface Verdict {
	level: GuardLevel;
	/** 规则 id，便于审计与豁免 */
	rule: string;
	/** 给人看的一句话理由 */
	why: string;
}

const ALLOW: Verdict = { level: "allow", rule: "none", why: "" };

function ask(rule: string, why: string): Verdict {
	return { level: "ask", rule, why };
}

function deny(rule: string, why: string): Verdict {
	return { level: "deny", rule, why };
}

/** 把复合命令拆成单条，逐个判定（`a && b | c` 里任何一段危险就整体危险）。 */
export function splitSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\||\n|\$\(/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * 剥掉引号里的内容再判。
 *
 * 否则 `grep -rn "rm -rf /" docs/` 会被当成 rm 命令拦下来——搜危险字符串
 * 是正经需求，误伤会让门禁变得没法用。真正执行的东西反而是 `bash -c "..."`，
 * 那种单独递归判（见 judgeCommand）。
 */
function stripQuoted(segment: string): string {
	return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** 这些前缀不改变「实际执行的命令是什么」。 */
const PREFIXES = new Set(["sudo", "command", "nohup", "time", "env", "builtin", "exec"]);

/** 取该段实际执行的命令名（跳过 sudo / VAR=val 这类前缀）。 */
function commandOf(segment: string): string {
	const tokens = stripQuoted(segment).trim().split(/\s+/);
	for (const token of tokens) {
		if (!token) continue;
		if (PREFIXES.has(token)) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // VAR=val
		return token;
	}
	return "";
}

/** 提取 rm 的目标路径。 */
function rmTargets(segment: string): string[] | null {
	const match = segment.match(/(?:^|[\s;&|])rm\s+((?:-[a-zA-Z]+\s+)*)(.*)$/);
	if (!match) return null;
	const rest = match[2] ?? "";
	return rest
		.split(/\s+/)
		.map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
		.filter((t) => t && !t.startsWith("-"));
}

/** 这些目标等价于「把家/根/整个仓库删掉」。 */
const CATASTROPHIC_TARGETS = new Set(["/", "/*", "~", "~/", "$HOME", "*", ".*", ".", "..", "/*/*"]);

function judgeRm(segment: string): Verdict | null {
	if (commandOf(segment) !== "rm") return null;
	const targets = rmTargets(segment);
	if (targets === null) return null;
	if (targets.length === 0) return null;

	// 只有递归删除才值得问：`rm /tmp/a.txt` 爆炸半径就一个文件，
	// 每次都弹窗只会让人把门禁关掉。
	const recursive = /(^|\s)-[a-zA-Z]*[rR]/.test(segment);

	for (const target of targets) {
		const normalized = target.replace(/\/+$/, "") || "/";
		if (CATASTROPHIC_TARGETS.has(target) || CATASTROPHIC_TARGETS.has(normalized)) {
			return deny("rm-catastrophic", `rm 的目标是 ${target}——这会把根目录/家目录/整个目录删掉`);
		}
		if (/^\/(etc|usr|bin|sbin|System|Library|opt)(\/|$)/.test(target)) {
			return deny("rm-system", `rm 的目标在系统目录 ${target}`);
		}
	}

	if (!recursive) return null;
	return ask("rm-destructive", `递归删除 ${targets.join(" ")}，删了就回不来`);
}

interface Rule {
	id: string;
	level: GuardLevel;
	why: string;
	test: RegExp | ((segment: string) => boolean);
}

/** 按顺序匹配，deny 优先。 */
const RULES: Rule[] = [
	// ---- deny：不可逆且几乎无正当用途
	{ id: "fork-bomb", level: "deny", why: "fork bomb 会把机器打死", test: /:\s*\(\s*\)\s*\{.*\|.*&/ },
	{ id: "mkfs", level: "deny", why: "格式化文件系统", test: /\bmkfs(\.\w+)?\b/ },
	{ id: "dd-device", level: "deny", why: "直写块设备会毁掉磁盘", test: /\bdd\b[^|]*\bof=\/dev\// },
	{ id: "redirect-device", level: "deny", why: "重定向覆盖块设备", test: />\s*\/dev\/(sd|disk|nvme|rdisk)/ },
	{ id: "power", level: "deny", why: "关机/重启会中断一切", test: /(^|[\s;&|])(shutdown|reboot|halt)\b/ },
	{ id: "history-wipe", level: "deny", why: "清空命令历史会抹掉审计痕迹", test: /\bhistory\s+-c\b|>\s*~?\/?\.\w*history/ },
	{ id: "chmod-root", level: "deny", why: "把根目录权限改成 777", test: /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\/(\s|$)/ },
	{ id: "git-force-main", level: "deny", why: "强推主分支会覆盖别人的提交", test: /\bgit\s+push\b[^|]*(--force\b|-f\b)[^|]*\b(main|master)\b/ },
	{ id: "kill-init", level: "deny", why: "杀 PID 1 会拖垮系统", test: /\bkill\s+(-9\s+)?1(\s|$)/ },

	// ---- ask：可能正当，但不可逆，想清楚再说
	{ id: "sudo", level: "ask", why: "提权执行", test: /(^|[\s;&|])sudo\b/ },
	{ id: "git-push-force", level: "ask", why: "强推会改写远端历史", test: /\bgit\s+push\b[^|]*(--force\b|--force-with-lease\b|-f\b)/ },
	{ id: "git-reset-hard", level: "ask", why: "硬重置会丢掉未提交的改动", test: /\bgit\s+reset\s+--hard\b/ },
	{ id: "git-clean", level: "ask", why: "clean -fd 会删掉未跟踪文件", test: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/ },
	{ id: "git-checkout-dot", level: "ask", why: "丢弃工作区改动", test: /\bgit\s+(checkout|restore)\s+(\.|--\s+\.)/ },
	{ id: "git-branch-D", level: "ask", why: "强删分支", test: /\bgit\s+branch\s+-D\b/ },
	{ id: "curl-pipe-shell", level: "ask", why: "把网络内容直接喂给 shell，等于执行未知代码", test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/ },
	{ id: "publish", level: "ask", why: "发布到 npm 后不可撤回（24 小时窗口外）", test: /\b(npm|pnpm|yarn)\s+publish\b/ },
	{ id: "chmod-777", level: "ask", why: "777 权限过宽", test: /\bchmod\s+(-[a-zA-Z]+\s+)?777\b/ },
	{ id: "truncate-secrets", level: "ask", why: "覆盖 SSH / 云凭据目录", test: />\s*~?\/?\.(ssh|aws|gnupg|config\/gh)\// },
	{ id: "write-etc", level: "ask", why: "写系统配置目录", test: />\s*\/etc\// },
];

/** 公式枚举：这些规则依赖 `|` / `;` 这类操作符，必须在**整条命令**上判，拆开就看不见了。 */
const OPERATOR_RULES: Rule[] = [
	{ id: "fork-bomb", level: "deny", why: "fork bomb 会把机器打死", test: /:\s*\(\s*\)\s*\{[\s\S]*\|[\s\S]*&/ },
	{
		id: "curl-pipe-shell",
		level: "ask",
		why: "把网络内容直接喂给 shell，等于执行未知代码",
		test: /\b(curl|wget)\b[^|]*\|[\s\S]*\b(sudo\s+)?(ba|z|k)?sh\b/,
	},
];

export function judgeCommandSegment(segment: string): Verdict {
	const rm = judgeRm(segment);
	if (rm) return rm;

	const sanitized = stripQuoted(segment);
	let best: Verdict = ALLOW;
	for (const rule of RULES) {
		const hit =
			typeof rule.test === "function" ? rule.test(sanitized) : rule.test.test(sanitized);
		if (!hit) continue;
		const verdict: Verdict = { level: rule.level, rule: rule.id, why: rule.why };
		if (verdict.level === "deny") return verdict;
		if (verdict.level === "ask") best = verdict;
	}
	return best;
}

/** `bash -c "..."` / `sh -c '...'` 里的内容要递归判。 */
function innerShellCommand(segment: string): string | null {
	const match = segment.match(/(?:^|[\s;&|])(?:ba|z|k)?sh\s+-c\s+(['"])([\s\S]*?)\1/);
	return match ? match[2] : null;
}

/** 整条命令里最严重的判定。 */
export function judgeCommand(command: string): Verdict {
	const whole = stripQuoted(command);

	// 先在整条上过一遍「操作符依赖型」规则
	for (const rule of OPERATOR_RULES) {
		const test = rule.test as RegExp;
		if (test.test(whole)) return { level: rule.level, rule: rule.id, why: rule.why };
	}

	const segments = splitSegments(command);
	let result: Verdict = ALLOW;
	for (const segment of segments) {
		const inner = innerShellCommand(segment);
		if (inner) {
			const nested = judgeCommand(inner);
			if (nested.level === "deny") return nested;
			if (nested.level === "ask") result = nested;
		}
		const verdict = judgeCommandSegment(segment);
		if (verdict.level === "deny") return verdict;
		if (verdict.level === "ask") result = verdict;
	}
	return result;
}

/** 敏感文件：读可以，写要问。 */
const SENSITIVE_PATH =
	/(^|\/)(\.env(\.[\w.-]+)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials|\.git-credentials)$|\.ssh\/|\.aws\/|\.gnupg\//;

export function judgeFilePath(path: string, action: "read" | "write"): Verdict {
	if (!SENSITIVE_PATH.test(path)) return ALLOW;
	if (action === "read") return ALLOW;
	return ask("write-secret", `${path} 看起来是凭据/环境变量文件，写入容易泄密或泄露密钥`);
}
