/**
 * 启动测试的 ACL 构建：真实移动端 profile + 一个注册 `test_rmcp_streamable_http` 的夹具插件 `fixture.acl`。
 * worker-boot.test.ts 只把 host-worker.ts 对 `virtual:dstu-profile/mobile` 的导入换成本模块。
 *
 * 选这个命令是因为它**不在** Rust `allow-application-commands` 里（契约标 `x-rust-registered: false`，
 * 前端未调用），所以无论夹具插件声明并注册它，移动端清单都不会放行——这正是用例要断言的“清单外命令被拒绝”。
 * （`dstu.mobile.compat` 会为所有 Rust 允许、但移动端没有实现的命令注册降级处理函数，
 * 因此不能再用 `browser_get_surface_host_mode` 这类命令做“清单外”夹具；`check_anki_connect_availability`
 * 也不能用：移动端 anki 插件已经注册了它，夹具再注册会冲突。）
 */
import profile from 'virtual:dstu-profile/mobile';
import { definePlugin } from '../../../host/kernel/core.ts';

const fixture = definePlugin({
  meta: { id: 'fixture.acl', commands: ['test_rmcp_streamable_http'], platforms: ['mobile'] },
  apply(ctx) {
    ctx.commands.register('test_rmcp_streamable_http', () => 'fixture-value');
  },
});

export default [...profile, { id: 'fixture.acl', module: 'mobile/tests/boot/acl-fixture-profile.ts', plugin: fixture }];
