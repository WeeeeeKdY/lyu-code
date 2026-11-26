#!/usr/bin/env bash
#
# Lyu Code 安装脚本
#
# 装四样东西：
#   1. 引擎        lyu-code（内嵌 pi 1.5.2 的 dist，打补丁后以 lyu 的身份运行）
#   2. 扩展        @lyu/extensions（记忆 / 守卫 / 统计 / todo / subagent / codegraph / plannotator）
#   3. gitnexus    MCP 代码图谱服务（第三方，abhigyanpatwari/gitnexus）
#   4. codebase-memory-mcp  MCP 代码记忆（第三方）
#
# 用法：
#   ./install.sh                      # 自动选源，装最新版
#   ./install.sh --from git           # 强制从源码构建（npm 上还没发的版本走这条）
#   ./install.sh --version 0.2.0      # 指定版本
#   ./install.sh --skip-mcp           # 只装 lyu，不装两个 MCP 工具
#   ./install.sh --dry-run            # 只打印要做什么，一个字节都不改
#
# 它不会碰 ~/.pi：`pi` 和 `lyu` 两个引擎各用各的配置目录，互不干扰。
#
# 退出码：0 成功，非 0 失败。任何一步失败都会说清楚哪一步、为什么，不静默降级。

set -euo pipefail

APP_PACKAGE="lyu-code"
APP_BIN="lyu"
EXT_PACKAGE="@lyu/extensions"
REPO_URL="${LYU_REPO:-https://github.com/WeeeeeKdY/lyu-code.git}"
RAW_BASE="${LYU_RAW:-https://raw.githubusercontent.com/WeeeeeKdY/lyu-code/main}"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19

VERSION="latest"
FROM="auto"
WITH_MCP=1
DRY_RUN=0
KEEP_SRC=0
PREFIX=""
AGENT_DIR="${LYU_CODING_AGENT_DIR:-$HOME/.lyu/agent}"

# ---------------------------------------------------------------- 输出

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	C_DIM=$'\033[2m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
	C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_B=""; C_0=""
fi

AGENT_ENV="$(printf '%s' "$APP_BIN" | tr '[:lower:]' '[:upper:]')_CODING_AGENT_DIR"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d/6] %s%s\n' "$C_B" "$STEP" "$*" "$C_0"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
okd()  { if [ "$DRY_RUN" = 1 ]; then info "[dry-run] $*"; else ok "$*"; fi; }
info() { printf '  %s·%s %s\n' "$C_DIM" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_0" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n' "$C_ERR" "$C_0" "$*" >&2; exit 1; }

run() {
	if [ "$DRY_RUN" = 1 ]; then
		printf '  %s[dry-run] %s%s\n' "$C_DIM" "$*" "$C_0"
	else
		"$@"
	fi
}

usage() {
	cat <<'USAGE'
Lyu Code 安装脚本

  ./install.sh                     自动选源，装最新版
  ./install.sh --from git          强制从源码构建
  ./install.sh --version 0.2.0     指定版本
  ./install.sh --skip-mcp          只装 lyu，不装两个 MCP 工具
  ./install.sh --dry-run           只打印要做什么，一个字节都不改
  ./install.sh --prefix ~/.local   装到指定 npm 前缀（不用 sudo）
  ./install.sh --agent-dir <dir>   配置目录（默认 ~/.lyu/agent）
  ./install.sh --keep-src          保留源码克隆目录，方便排查

它不会碰 ~/.pi：pi 和 lyu 两个引擎各用各的配置目录。
USAGE
	exit 0
}

# ---------------------------------------------------------------- 参数

while [ $# -gt 0 ]; do
	case "$1" in
		--version)   VERSION="${2:?--version 需要一个版本号}"; shift 2 ;;
		--from)      FROM="${2:?--from 需要 auto|npm|git}"; shift 2 ;;
		--skip-mcp)  WITH_MCP=0; shift ;;
		--agent-dir) AGENT_DIR="${2:?--agent-dir 需要一个路径}"; shift 2 ;;
		--prefix)    PREFIX="${2:?--prefix 需要一个路径}"; shift 2 ;;
		--keep-src)  KEEP_SRC=1; shift ;;
		--dry-run)   DRY_RUN=1; shift ;;
		-h|--help)   usage ;;
		*) die "不认识的参数：$1（--help 看用法）" ;;
	esac
done

case "$FROM" in auto|npm|git) ;; *) die "--from 只能是 auto / npm / git，收到：$FROM" ;; esac

NPM="${NPM:-npm}"

global_root() {
	if [ -n "$PREFIX" ]; then "$NPM" root -g --prefix "$PREFIX"; else "$NPM" root -g; fi
}

TMP=""
cleanup() {
	if [ -n "$TMP" ] && [ -d "$TMP" ] && [ "$KEEP_SRC" = 0 ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1 环境检查

step "环境检查"

command -v node >/dev/null 2>&1 || die "没找到 node。需要 Node.js >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}（引擎依赖 node 的类型剥离能力）"
command -v "$NPM" >/dev/null 2>&1 || die "没找到 npm。装了 Node 通常会带，检查 PATH"

NODE_V="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_V%%.*}"
NODE_REST="${NODE_V#*.}"; NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ] ||
   { [ "$NODE_MAJOR" -eq "$NODE_MIN_MAJOR" ] && [ "$NODE_MINOR" -lt "$NODE_MIN_MINOR" ]; }; then
	die "Node.js 是 ${NODE_V}，太旧。需要 >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}"
fi
ok "node $NODE_V"

if [ "$FROM" = "git" ] || [ "$FROM" = "auto" ]; then
	command -v git >/dev/null 2>&1 || die "没找到 git（从源码安装需要它；也可以试 --from npm）"
	ok "git $(git --version | awk '{print $3}')"
fi

GLOBAL_ROOT="$(global_root)"
GLOBAL_BIN="$(dirname "$(dirname "$GLOBAL_ROOT")")/bin"
info "npm 全局目录：$GLOBAL_ROOT"

case ":$PATH:" in
	*":$GLOBAL_BIN:"*) ok "全局 bin 在 PATH 里（${GLOBAL_BIN}）" ;;
	*) warn "全局 bin 不在 PATH 里：$GLOBAL_BIN —— 装完 \"$APP_BIN\" 可能找不到" ;;
esac

if [ "$(id -u)" = "0" ]; then
	warn "你正在用 root 装。能不用就不用：会装进 /usr/local，之后普通用户升级要 sudo"
fi

# ---------------------------------------------------------------- 版本探测

node_gt() { # 用法: node_gt A B —— A > B 时退出 0
	node -e '
		const p = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0);
		const [a, b] = process.argv.slice(1).map(p);
		for (let i = 0; i < 3; i++) if (a[i] !== (b[i] || 0)) process.exit(a[i] > (b[i] || 0) ? 0 : 1);
		process.exit(1);
	' "$1" "$2"
}

npm_published_version() {
	"$NPM" --fetch-timeout=20000 view "$APP_PACKAGE" version 2>/dev/null || true
}

repo_version() {
	command -v curl >/dev/null 2>&1 || return 1
	curl -fsSL --max-time 20 "$RAW_BASE/packages/agent/package.json" 2>/dev/null |
		node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).version;if(v)console.log(v);else process.exit(1)}catch{process.exit(1)}})'
}

# ---------------------------------------------------------------- 2 装引擎

step "安装引擎 $APP_PACKAGE"

if [ "$FROM" = "auto" ]; then
	if [ "$VERSION" = "latest" ]; then
		PUB="$(npm_published_version)"
		REP="$(repo_version || true)"
		if [ -n "$REP" ] && { [ -z "$PUB" ] || node_gt "$REP" "$PUB"; }; then
			FROM="git"
			warn "npm 上最新是 ${PUB:-（没有发布）}，仓库里是 $REP —— 从源码装，免得装到旧版"
		else
			FROM="npm"
		fi
	else
		if "$NPM" --fetch-timeout=20000 view "$APP_PACKAGE@$VERSION" version >/dev/null 2>&1; then
			FROM="npm"
		else
			FROM="git"
			info "$APP_PACKAGE@$VERSION 还没发布到 npm，从源码构建"
		fi
	fi
fi

SRC=""

if [ "$FROM" = "npm" ]; then
	info "从 npm 装 $APP_PACKAGE@$VERSION"
	[ "$DRY_RUN" = 1 ] || "$NPM" --fetch-timeout=60000 i -g ${PREFIX:+--prefix "$PREFIX"} "$APP_PACKAGE@$VERSION"
	okd "$APP_PACKAGE@$VERSION"
else
	command -v curl >/dev/null 2>&1 || warn "没有 curl，没法先核对仓库版本（继续）"
	TMP="$(mktemp -d)"
	SRC="$TMP/repo"
	info "克隆 $REPO_URL"
	run git clone --depth 1 "$REPO_URL" "$SRC"

	if [ -f "$SRC/packages/agent/package.json" ]; then
		SRC_VER="$(node -p "require('$SRC/packages/agent/package.json').version")"
		info "仓库版本：$SRC_VER"
		if [ "$VERSION" != "latest" ] && [ "$SRC_VER" != "$VERSION" ]; then
			die "要装 ${VERSION}，但主分支上是 ${SRC_VER}。固定版本请用 --version 对应的 tag，或先发版"
		fi
		[ "$VERSION" = "latest" ] && VERSION="$SRC_VER"
	fi

	# npm pack 会触发 prepack → scripts/vendor.mjs：取上游 pi 1.5.2 的 dist、打上品牌补丁。
	# 补丁没命中它会自己中止，这里不用再兜底。
	info "构建（prepack 会 vendored 上游 dist 并打补丁，需要能访问 npm registry）"
	mkdir -p "$TMP/pack"
	if [ "$DRY_RUN" = 1 ]; then
		printf '  %s[dry-run] (cd %s && npm pack ./packages/agent --pack-destination %s)%s\n' "$C_DIM" "$SRC" "$TMP/pack" "$C_0"
	else
		(cd "$SRC" && "$NPM" pack ./packages/agent --pack-destination "$TMP/pack" --loglevel=warn >/dev/null) ||
			die "构建失败。看上面的 npm 输出；补丁没命中通常意味着上游改了代码，要更新 scripts/vendor.mjs"
		TGZ="$(ls "$TMP/pack"/${APP_PACKAGE}-*.tgz 2>/dev/null | head -1)"
		[ -n "$TGZ" ] || die "npm pack 没产出 tgz"
		"$NPM" --fetch-timeout=60000 i -g ${PREFIX:+--prefix "$PREFIX"} "$TGZ" || die "全局安装失败"
	fi
	okd "$APP_PACKAGE@${VERSION}（从源码构建）"
fi

if [ "$DRY_RUN" = 1 ]; then
	BIN_PATH="$GLOBAL_BIN/$APP_BIN"
elif [ -x "$GLOBAL_BIN/$APP_BIN" ]; then
	BIN_PATH="$GLOBAL_BIN/$APP_BIN"
else
	BIN_PATH="$(command -v "$APP_BIN" 2>/dev/null || true)"
fi
okd "可执行文件：${BIN_PATH}"

# ---------------------------------------------------------------- 3 扩展

step "安装扩展 $EXT_PACKAGE"

EXT_DIR="$GLOBAL_ROOT/$APP_PACKAGE/node_modules/$EXT_PACKAGE"

if [ "$DRY_RUN" = 1 ]; then
	info "[dry-run] 检查 ${EXT_DIR}，缺失时从源码树补真实副本"
elif [ -f "$EXT_DIR/package.json" ]; then
	ok "扩展包随引擎装好了：$EXT_DIR"
elif [ -d "$SRC/packages/extensions-pi" ]; then
	# tarball 里的 `@lyu/extensions` 是 file: 依赖，装完会变成断掉的软链。
	# 这里用一份真实副本替掉它：引擎按目录加载，副本与软链行为一致，但不会被删源的tmp带走。
	warn "扩展包是断链（file: 依赖没法随 tarball 走），用源码树补一份真实副本"
	rm -f "$EXT_DIR"
	mkdir -p "$(dirname "$EXT_DIR")"
	cp -R "$SRC/packages/extensions-pi" "$EXT_DIR"
	[ -f "$EXT_DIR/package.json" ] || die "扩展包补不回来，安装不完整"
	# 它自己有运行时依赖（@huggingface/transformers，codegraph 要用），必须真装一遍。
	# peer 依赖全是 type-only（*），--legacy-peer-deps 免得它去拽一整套 pi。
	info "装扩展自己的依赖（@huggingface/transformers 有点大，耐心等）"
	"$NPM" --prefix "$EXT_DIR" install --omit=dev --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1 ||
		die "扩展的依赖装不上。手动跑：$NPM --prefix $EXT_DIR install --omit=dev --legacy-peer-deps"
	[ -d "$EXT_DIR/node_modules/@huggingface/transformers" ] ||
		warn "@huggingface/transformers 没装上，codegraph 扩展会加载失败（其余 6 个不受影响）"
	ok "扩展包已就位：$EXT_DIR"
else
	die "引擎装好了，但扩展包 $EXT_PACKAGE 没跟进来，而这次不是从源码装的，没法补。
        两条路：把 $EXT_PACKAGE 发到 npm，或用 --from git 从源码装。"
fi

# ---------------------------------------------------------------- 4 MCP 工具

MCP_OK=""
MCP_FAILED=""

if [ "$WITH_MCP" = 1 ]; then
	step "安装 MCP 工具（第三方）"

	# 逐个装，不合成一条命令：npm 一条命令失败会把这一批整个回滚，
	# 结果是"一个网络超时，另一个白装"。
	for tool in gitnexus codebase-memory-mcp; do
		case "$tool" in
			gitnexus) info "gitnexus —— 代码图谱（abhigyanpatwari/gitnexus）" ;;
			*) info "$tool —— 代码记忆" ;;
		esac
		if [ "$DRY_RUN" = 1 ]; then
			printf '  %s[dry-run] %s i -g %s%s\n' "$C_DIM" "$NPM" "$tool" "$C_0"
			MCP_OK="$MCP_OK $tool"
		elif "$NPM" --fetch-timeout=60000 i -g ${PREFIX:+--prefix "$PREFIX"} "$tool" >/dev/null 2>&1; then
			ok "$tool 装好了"
			MCP_OK="$MCP_OK $tool"
		else
			# 这两个是第三方包，装不上多半是网络（codebase-memory-mcp 的 postinstall 要从 GitHub 拉原生运行时）
			warn "$tool 没装上（网络原因居多）。单独重试：$NPM i -g $tool"
			MCP_FAILED="$MCP_FAILED $tool"
		fi
	done
else
	step "跳过 MCP 工具（--skip-mcp）"
fi

# ---------------------------------------------------------------- 5 配置

step "写配置到 $AGENT_DIR"

run mkdir -p "$AGENT_DIR"

if [ "$DRY_RUN" = 1 ]; then
	info "[dry-run] $APP_BIN mcp add gitnexus -- gitnexus mcp"
	info "[dry-run] $APP_BIN mcp add codebase-memory-mcp -- codebase-memory-mcp"
else
	if [ -f "$AGENT_DIR/settings.json" ]; then
		ok "settings.json 已存在，不覆盖（引擎会自动加载依赖里的扩展包）"
	else
		info "settings.json 还不存在，引擎首次启动会自己建"
	fi

	# 引擎自带非交互的 MCP 管理命令，比手写 JSON 稳。
	if [ "$WITH_MCP" = 1 ]; then
		for pair in "gitnexus:gitnexus mcp" "codebase-memory-mcp:codebase-memory-mcp"; do
			name="${pair%%:*}"
			cmd="${pair#*:}"
			case " $MCP_OK " in
				*" $name "*) ;;
				*) info "跳过注册 ${name}（没装上）"; continue ;;
			esac
			# shellcheck disable=SC2086
			if env "$AGENT_ENV=$AGENT_DIR" "$BIN_PATH" mcp add "$name" -- $cmd >/dev/null 2>&1; then
				ok "mcp.json ← ${name}（${cmd}）"
			else
				warn "注册 $name 失败，稍后手动跑：$APP_BIN mcp add $name -- $cmd"
			fi
		done
	fi

	if [ ! -f "$AGENT_DIR/trust.json" ]; then
		warn "trust.json 还没有：首次在某项目里启动会问你是否信任。
         这一问答了「否」，扩展会一个都不加载而且不报错 —— 这是最容易踩的坑。"
	fi
fi

# ---------------------------------------------------------------- 6 自检

step "自检"

if [ "$DRY_RUN" = 1 ]; then
	info "[dry-run] 跳过自检"
else
	[ -x "$BIN_PATH" ] || die "装完了却找不到可执行的 ${APP_BIN}（预期在 ${GLOBAL_BIN}）"

	INSTALLED="$("$BIN_PATH" --version 2>/dev/null | tail -1)"
	[ -n "$INSTALLED" ] || die "$APP_BIN --version 没有任何输出，装出来的东西不能跑"
	if [ "$VERSION" != "latest" ] && [ "$INSTALLED" != "$VERSION" ]; then
		die "版本对不上：要装 ${VERSION}，实际是 $INSTALLED"
	fi
	ok "$APP_BIN ${INSTALLED}（${BIN_PATH}）"

	# 扩展：用引擎自己的解析器验，不花模型调用。
	if [ -f "$GLOBAL_ROOT/$APP_PACKAGE/bin/extensions-package.js" ]; then
		if node -e "
			import('$GLOBAL_ROOT/$APP_PACKAGE/bin/extensions-package.js').then((m) => {
				const r = m.resolveExtensionsPackage();
				if (r.error) { console.error(r.error.message); process.exit(1); }
				console.log(r.root);
			});
		" >/dev/null 2>&1; then
			ok "引擎能找到扩展包"
		else
			die "引擎报告找不到 $EXT_PACKAGE —— 扩展不会加载"
		fi
	fi

	# 真起一次引擎。扩展加载失败会在 stderr 里报 "Failed to load extension"，
	# 这一步就是为了让那种失败当场暴露，而不是等用户开会话才发现。
	SMOKE="$(env "$AGENT_ENV=$AGENT_DIR" "$BIN_PATH" --help 2>&1 >/dev/null || true)"
	if printf '%s' "$SMOKE" | grep -q "Failed to load extension"; then
		printf '%s\n' "$SMOKE" | grep "Failed to load extension" | sed 's/^/      /' >&2
		die "扩展加载失败（见上）。常见原因：两处注册了同一个扩展、或依赖没装全"
	fi
	if ! env "$AGENT_ENV=$AGENT_DIR" "$BIN_PATH" --help >/dev/null 2>&1; then
		die "引擎起不来：$BIN_PATH --help 退出码非 0"
	fi
	ok "引擎能启动，没有扩展加载失败"

	if [ "$WITH_MCP" = 1 ]; then
		for tool in $MCP_OK; do
			# 只认 $GLOBAL_BIN 里的那一份：PATH 里可能有个更早装的，验它没意义
			if [ -x "$GLOBAL_BIN/$tool" ]; then
				ok "$tool 装好了（$GLOBAL_BIN/$tool）"
			elif command -v "$tool" >/dev/null 2>&1; then
				warn "$tool 不在 $GLOBAL_BIN，PATH 里的那份是别处的"
			else
				warn "$tool 找不到，MCP 会起不来"
			fi
		done
	fi

	# 硬链接到 ~/.pi 的事一次都不该发生，这里只报不改。
	if [ -d "$HOME/.pi/agent" ]; then
		info "没动过 ~/.pi（那是 pi 的配置目录，与 lyu 各用各的）"
	fi
fi

# ---------------------------------------------------------------- 完成

if [ "$DRY_RUN" = 1 ]; then
	printf '\n%s%sdry-run 结束 —— 上面的命令一条都没执行，磁盘没有改动%s\n' "$C_B" "" "$C_0"
	exit 0
fi

cat <<EOF

${C_B}装好了${C_0}

  引擎      $APP_BIN ${VERSION}
  配置目录  $AGENT_DIR
  扩展      $EXT_PACKAGE
$(if [ -n "$MCP_OK" ]; then printf '  MCP      %s（已写进 %s/mcp.json）\n' "$(echo $MCP_OK)" "$AGENT_DIR"; fi)

下一步：

  1. 进任意项目跑 ${C_B}$APP_BIN${C_0}。第一次会问是否信任这个项目 —— 答「是」，否则扩展全不加载。
  2. gitnexus 要先建索引才有东西可查：${C_B}gitnexus analyze .${C_0}
  3. 看装了什么：${C_B}$APP_BIN list${C_0}、${C_B}$APP_BIN mcp list${C_0}

${C_WARN}注意${C_0}：TUI 里那条 "New version ... Run lyu update" 现在还别跟 —— 它指的还是上游 pi 的发布源，
      跟着做会把 pi 装回来。等自更新改指我们自己的源再用。

升级回退：

  重跑本脚本即可升级。回退到旧版：${C_B}${NPM} i -g ${APP_PACKAGE}@<版本>${C_0}
  ${C_DIM}（npm 上当前最新是 0.1.4 —— 那是旧引擎，别用 @latest 升级）${C_0}
EOF

if [ -n "$MCP_FAILED" ]; then
	printf '\n%s没装上的：%s%s\n' "$C_WARN" "$(echo $MCP_FAILED)" "$C_0" >&2
	printf '  lyu 本身是好的，缺的只是 MCP 工具。网络恢复后逐个补：\n' >&2
	for tool in $MCP_FAILED; do printf '    %s i -g %s\n' "$NPM" "$tool" >&2; done
	exit 1
fi
