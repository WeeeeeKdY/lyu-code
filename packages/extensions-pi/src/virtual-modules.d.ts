/**
 * pi 在运行时通过 jiti 的 virtualModules 注入这些模块（见
 * packages/coding-agent/src/core/extensions/loader.ts 的 VIRTUAL_MODULES），
 * 所以扩展可以直接 import，但 tsc 在编译期找不到它们——这里补上声明。
 *
 * 类型故意放宽：真正的 schema 校验发生在 pi 运行时。
 */

declare module "typebox" {
	export const Type: {
		Object: (props: Record<string, unknown>, options?: Record<string, unknown>) => any;
		String: (options?: Record<string, unknown>) => any;
		Number: (options?: Record<string, unknown>) => any;
		Boolean: (options?: Record<string, unknown>) => any;
		Optional: (schema: unknown) => any;
		Array: (schema: unknown, options?: Record<string, unknown>) => any;
		Literal: (value: unknown) => any;
		Union: (schemas: unknown[]) => any;
	};
	export type TSchema = any;
	export type Static<T> = any;
}
