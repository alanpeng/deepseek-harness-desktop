// Desktop sidecar entry — dsh ships as real node + node_modules, not a
// single packaged exe (see build-sidecar.mjs header for why). The host spawns
// `node entry.mjs` from the bundled dsh-runtime directory; everything dsh
// needs resolves from @deepseek-ai/dsh on the deployed tree.
//
// 0.1.5 起 lib/bin.js 变成 main-module-only（0.1.5-rc.1 与 rc.2 实测一致）：
//     if (import.meta.main) await runCli();  export { runCli }
// 被 import 的模块永远不是 main，所以纯副作用 import 在 0.1.5 上**什么都不跑**：
// 进程静默 exit 0、不监听端口、不打一行日志。壳等满 60s 后报
// "dsh host did not start listening on port ... Last sidecar output: no sidecar
// output captured" 并回滚（0.1.5-rc.2 的生产事故根因）。0.1.2 及更早是顶层
// 直接执行 + export {}，import 即运行。两代兼顾：有导出的 runCli 就调用它，
// 没有则完全依赖 import 的副作用。
const dsh = await import('@deepseek-ai/dsh/lib/bin.js')
if (typeof dsh.runCli === 'function') await dsh.runCli()
