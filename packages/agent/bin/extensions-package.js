/**
 * 找到 @lyu/extensions 的包根 + 里面某个源文件。
 *
 * 为什么要单独一个模块：引擎在 bin/lyu.js 里要拿包根去注册，bin/lyu-init.js 要拿源文件去跑，
 * 两处都得指向「同一个、已经从 npm 解析好的」位置，不能各写一份相对路径 —— 装到全局以后
 * 相对路径和源码树的形状是不一样的。
 *
 * 解析不到返回 undefined，由调用方决定怎么喊 —— 这里不替它决定，也不吞掉原因。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @returns {{ root: string } | { error: Error }} */
export function resolveExtensionsPackage() {
	try {
		return { root: dirname(fileURLToPath(import.meta.resolve("@lyu/extensions/package.json"))) };
	} catch (error) {
		return { error };
	}
}

export function extensionsEntry(root, ...segments) {
	return join(root, ...segments);
}
