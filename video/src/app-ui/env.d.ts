/** 主应用组件里有 process.env.NODE_ENV 判断（webpack 在打包时替换）；本工程不引入 @types/node，只声明用到的部分。 */
declare const process: { env: Record<string, string | undefined> };

/** 主应用按 Vite 写的 import.meta.env / import.meta.glob；打包时由 webpack-override.mjs 处理，这里只补类型。 */
interface ImportMetaEnv {
  readonly [key: string]: string | boolean | undefined;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
