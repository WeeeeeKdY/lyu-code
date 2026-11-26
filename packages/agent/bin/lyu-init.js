#!/usr/bin/env node
/**
 * lyu init —— 在项目里建 .lyu/ 配置。
 *
 * 真正的实现在 @lyu/extensions 的 src/init.ts 里。为什么不直接把它写进 package.json 的 bin：
 * 装了之后这个文件在 node_modules 下面，而 node 明确拒绝给 node_modules 里的 .ts 剥类型
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）—— 直接把 .ts 当 bin，用户一跑就是报错。
 * 所以这里用 jiti（引擎自己的依赖，本来就在）转一道，源码树里跑和全局装完跑是一样的。
 *
 * 失败必须说一声：init 建不出配置不是小事，不能悄悄退出 0。
 */
import { createJiti } from "jiti";
import { extensionsEntry, resolveExtensionsPackage } from "./extensions-package.js";

const found = resolveExtensionsPackage();
if ("error" in found) {
	console.error("[lyu] 找不到 @lyu/extensions，lyu init 跑不了：" + found.error.message);
	console.error("[lyu] 这个包应该随 lyu 一起装好；如果你是手工拼的安装，重新 npm install 一次。");
	process.exit(1);
}

const entry = extensionsEntry(found.root, "src", "init.ts");
try {
	const jiti = createJiti(import.meta.url);
	await jiti.import(entry);
} catch (error) {
	console.error("[lyu] lyu init 崩了：" + (error instanceof Error ? error.message : String(error)));
	process.exit(1);
}
