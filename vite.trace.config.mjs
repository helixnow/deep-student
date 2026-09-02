/**
 * 一次性分析配置：找出重型库被谁静态拖进 demo 入口图
 * 用法：npx vite build --config vite.trace.config.mjs
 */
import demoConfig from "./vite.demo.config.ts";

const HEAVY = ["@milkdown", "@xyflow", "recharts", "mermaid", "echarts", "pptx-preview", "exceljs", "docx-preview", "heic2any", "mcpService"];

const tracePlugin = {
  name: "trace-heavy-imports",
  apply: "build",
  generateBundle(_options, bundle) {
    const reported = new Set();
    // 从入口向下走静态 importedIds，记录首个踏入 heavy 包的 src 模块
    const entries = [...this.getModuleIds()].filter((id) => {
      const info = this.getModuleInfo(id);
      return info?.isEntry || /src[\/]App\.tsx$/.test(id);
    });
    const seen = new Set();
    const walk = (id, parentSrc) => {
      if (seen.has(id)) return;
      seen.add(id);
      const info = this.getModuleInfo(id);
      if (!info) return;
      const heavy = HEAVY.find((h) => id.includes(h));
      if (heavy && id.includes("node_modules")) {
        if (!reported.has(heavy)) {
          reported.add(heavy);
          console.log(`[static-heavy] ${heavy}  <==直接引入者==  ${(parentSrc || id).replace(/.*\/src\//, "src/").slice(0, 130)}`);
        }
        return; // 不下钻 heavy 包内部
      }
      const next = [...(info.importedIds || []), ...(info.implicitlyLoadedIds || [])];
      for (const n of next) walk(n, id.includes("node_modules") ? parentSrc : id);
    };
    for (const e of entries) walk(e, null);
    if (!reported.size) console.log("[trace] 入口静态图内无重型库");

    // 第二部分：App chunk 对 heavy chunk 的静态 import 边，符号级归因
    const chunks = bundle;
    for (const [fileName, chunk] of Object.entries(chunks)) {
      if (chunk.type !== "chunk" || !/(^|\/)(App|init|demo)-/.test(fileName)) continue;
      for (const imp of chunk.imports || []) {
        const heavy = HEAVY.find((h) => imp.includes(h));
        if (!heavy) continue;
        const key = `${fileName.split("-")[0]}->${heavy}`;
        if (reported.has(key)) continue;
        reported.add(key);
        // 该 chunk 内直接静态 import 此 heavy 包的 src 模块
        const mods = chunk.moduleIds || [];
        const culprits = mods.filter((m) => {
          const mi = this.getModuleInfo(m);
          return (mi?.importedIds || []).some(
            (x) => x.includes("node_modules") && x.includes(heavy),
          );
        });
        console.log(`\n[chunk-edge] ${fileName.split("/").pop().split("-")[0]} => ${imp.split("/").pop()}`);
        for (const c of culprits.slice(0, 8)) console.log("   *", c.replace(/.*\/(src|node_modules)\//, "$1/").slice(0, 140));
      }
    }
    // 第三部分：每个 vendor-heavy chunk 里实际装了哪些包、多大
    for (const [fileName, chunk] of Object.entries(chunks)) {
      if (chunk.type !== "chunk" || !/vendor-(mermaid|milkdown|xyflow|recharts)/.test(fileName)) continue;
      const pkgs = new Map();
      for (const m of chunk.moduleIds || []) {
        const mm = m.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/@][^/]*)/);
        const key = mm ? mm[1] : m.replace(/.*\/src\//, "src/");
        pkgs.set(key, (pkgs.get(key) || 0) + 1);
      }
      const total = [...(chunk.moduleIds || [])].reduce((s, m) => {
        try { return s + (this.getModuleInfo(m)?.code?.length || 0); } catch { return s; }
      }, 0);
      console.log(`\n[vendor-content] ${fileName.split("/").pop()}  源码总量约 ${Math.round(total / 1024)}KB`);
      for (const [p, n] of [...pkgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        console.log(`   ${n}× ${p}`);
      }
    }
    // 第四部分：打印 demo 入口 chunk 的全部 src 模块（排查谁在入口里引了重库）
    for (const [fileName, chunk] of Object.entries(chunks)) {
      if (chunk.type !== "chunk" || !/(^|\/)demo-/.test(fileName)) continue;
      const srcMods = (chunk.moduleIds || [])
        .filter((m) => !m.includes("node_modules"))
        .map((m) => m.replace(/.*\/src\//, "src/"));
      console.log(`\n[demo-chunk-modules] 共 ${srcMods.length} 个 src 模块:`);
      for (const m of srcMods.sort()) console.log("   #", m.slice(0, 120));
    }
  },
};

export default async (env) => {
  const cfg = typeof demoConfig === "function" ? await demoConfig(env) : demoConfig;
  return {
    ...cfg,
    logLevel: "error",
    plugins: [...(cfg.plugins ?? []), tracePlugin],
  };
};
