/** Run with vitest.plugin-manager-host.config.ts: real Node Host and DOM UI in the same test process. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor, within, fireEvent } from '@testing-library/react';
import { createTestHost } from '../../../../host/kernel/testing';
import { loadStartupProfile } from '../../../../host/kernel/profile';
import { UserProfileStore } from '../../../../host/kernel/profile-store';
import { CommunityConsentLedger } from '../../../../host/kernel/community-consent';
import { PluginAdmin } from '../../../../host/kernel/plugin-admin';
import { PluginPackages } from '../../../../host/kernel/plugin-packages';
import { createNodeFiles } from '../../../../host/platform/files';
import { MemoryZipSink, ZipWriter } from '../../../../host/platform/zip/core';
import { nodeZipCodec } from '../../../../host/platform/zip/node/file';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { HostPluginManagerAdapter, MANAGER_COMMANDS } from '../host-adapter';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});

const ID = 'example.web-search';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));

async function packageExample(root: string): Promise<string> {
  const source = join(repo, 'examples/plugins/community-web-search');
  // Build the actual example; only its kernel SDK import stays external to preserve Host schema identity.
  // esbuild's native helper requires a native Node realm, not JSDOM's Uint8Array identity.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild';
    const result = await build({ entryPoints: [${JSON.stringify(join(source, 'index.ts'))}], bundle: true, platform: 'node',
      format: 'esm', write: false, plugins: [{ name: 'host-sdk', setup(build) {
        build.onResolve({ filter: /host\\/kernel\\/api\\.ts$/ }, () => ({ path: ${JSON.stringify(pathToFileURL(join(repo, 'host/kernel/api.ts')).href)}, external: true }));
      } }] });
    process.stdout.write(result.outputFiles[0].text);
  `], { cwd: repo, encoding: 'utf8' });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  manifest.deepStudent.host = './index.mjs';
  const sink = new MemoryZipSink();
  const zip = new ZipWriter(sink, { codec: nodeZipCodec });
  await zip.addBytes('package.json', JSON.stringify(manifest));
  await zip.addBytes('index.mjs', output);
  await zip.finish();
  const archive = join(root, 'community-web-search.dsplugin');
  await writeFile(archive, sink.bytes());
  return archive;
}

describe('plugin manager UI with a real Host', () => {
  it('installs the bundled example, consents, enables, configures, disables and uninstalls its real profile entry', async () => {
    const screen = within(document.body);
    // Outside host/: moduleOrigin correctly classifies extracted packages as community code.
    const tmp = resolve(repo, '.tmp');
    await mkdir(tmp, { recursive: true });
    const root = await mkdtemp(join(tmp, 'w35-ui-host-'));
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    const official = join(root, 'official.profile.json');
    const profile = join(dataDir, 'plugins/user.profile.json');
    await writeFile(official, JSON.stringify({ plugins: [] }));
    await writeFile(profile, JSON.stringify({ extends: 'official', plugins: [] }));
    const archive = await packageExample(root);
    // 与应用当前版本一致，否则示例插件的 engines.deepStudent（^0.20）会被判 ENGINE_INCOMPATIBLE。
    const host = await createTestHost({ app: { dataDir, version: '0.20.0' },
      provide: { storage: {}, paths: {}, log: {} } }); // required core-service markers; this example uses none
    const ui = new UiKernel();
    const ledger = new CommunityConsentLedger(dataDir);
    const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
    const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
    const store = new UserProfileStore(profile, official);
    new PluginAdmin({ runtime: host.runtime, store, official, consent: ledger, files, packages }).register();
    await loadStartupProfile(host.runtime, { official, userProfile: profile, platform: 'desktop' });
    const calls: string[] = [];
    const adapter = new HostPluginManagerAdapter({ platform: 'desktop', choosePackage: async () => archive,
      async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
        calls.push(command);
        const result = await host.invoke<T>(command, args);
        if (command === MANAGER_COMMANDS.consent) {
          expect((await ledger.evaluate({ id: ID, version: '1.0.0', permissions: [] })).matched).toBe(true);
          expect(host.runtime.get(ID)).toBeUndefined(); // consent alone never imports/enables code
        }
        ui.hostStatus.update(host.runtime.uiManifestV2());
        return result;
      },
    });
    const controller = new PluginManagerController(adapter);
    let view: ReturnType<typeof render> | undefined;
    try {
      // Obtain exactly the owner's production hostStatus handle, not a fake status implementation.
      let Panel = () => <></>;
      await ui.install(defineUiPlugin({ meta: { id: 'dstu.ui.manager-e2e' }, apply(ctx) {
        const realStatus = ctx.ui.hostStatus;
        Panel = () => <PluginManagerPanel controller={controller} uiStatus={realStatus} errorBudget={ui.errors} />;
      } }), { origin: 'builtin' });
      view = render(<UiKernelProvider kernel={ui}><Panel /></UiKernelProvider>);
      const user = {
        click: async (element: Element) => { fireEvent.click(element); },
        clear: async (element: Element) => { fireEvent.change(element, { target: { value: '' } }); },
        type: async (element: Element, value: string) => { fireEvent.change(element, { target: { value } }); },
      };
      expect(await screen.findByTestId('plugin-manager-empty')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '安装离线插件' }));
      const consentDialog = await screen.findByRole('dialog');
      expect(within(consentDialog).getByTestId('plugin-consent-id')).toHaveTextContent(ID);
      expect(within(consentDialog).getByTestId('plugin-consent-version')).toHaveTextContent('1.0.0');
      expect(host.runtime.get(ID)).toBeUndefined();
      expect((await packages.list())[0]).toMatchObject({ id: ID, enabled: false });
      expect((await store.read()).file.plugins[0]).toMatchObject({ id: ID, disabled: true });
      expect((await ledger.evaluate({ id: ID, version: '1.0.0', permissions: [] })).matched).toBe(false);

      await user.click(within(consentDialog).getByRole('button', { name: '同意并重载' }));
      await waitFor(() => expect(screen.queryByTestId('plugin-consent-id')).toBeNull());
      await waitFor(() => expect(host.runtime.get(ID)).toBeDefined());
      await waitFor(() => expect(screen.getByRole('switch', { name: `启用 ${ID}` })).toBeChecked());
      expect(calls.indexOf(MANAGER_COMMANDS.consent)).toBeLessThan(calls.indexOf(MANAGER_COMMANDS.setEnabled));
      expect((await packages.list())[0]?.enabled).toBe(true);
      expect((await store.read()).file.plugins[0].disabled).toBeUndefined();

      await user.click(screen.getByRole('button', { name: `查看 ${ID} 的详情` }));
      await user.click(screen.getByRole('button', { name: '更改信任档位' }));
      const trustConfirmation = screen.getByRole('alertdialog');
      expect(trustConfirmation).toHaveTextContent('与应用同进程执行');
      expect((await ledger.evaluate({ id: ID, version: '1.0.0', permissions: [] })).trust).toBe('restricted');
      await user.click(within(trustConfirmation).getByRole('button', { name: '确认' }));
      await waitFor(() => expect(host.runtime.get(ID)).toBeUndefined());
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect((await ledger.evaluate({ id: ID, version: '1.0.0', permissions: [] })).trust).toBe('full');
      const details = screen.getByRole('dialog');
      await user.click(within(details).getByRole('button', { name: '启动插件' }));
      const enableConfirmation = screen.getByRole('alertdialog');
      expect(host.runtime.get(ID)).toBeUndefined();
      await user.click(within(enableConfirmation).getByRole('button', { name: '确认' }));
      await waitFor(() => expect(host.runtime.get(ID)).toBeDefined());
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await user.click(within(details).getByRole('button', { name: `配置 ${ID}` }));
      const form = await screen.findByTestId('plugin-config-form');
      const label = within(form).getByLabelText('写进 result.provider 与 usage.provider');
      await user.clear(label);
      await user.type(label, 'configured-through-ui');
      await user.click(within(form).getByRole('button', { name: '保存' }));
      await waitFor(() => expect(host.runtime.get(ID)?.config).toMatchObject({ label: 'configured-through-ui' }));
      await waitFor(() => expect(within(form).getByRole('button', { name: '保存' })).toBeEnabled());
      expect((await store.read()).file.plugins[0].config).toMatchObject({ label: 'configured-through-ui' });
      const service = host.ctx.get('exampleWebSearch')!;
      expect(await service.doSearch({ query: 'profile', top_k: 1 } as never)).toMatchObject({
        result: { provider: 'configured-through-ui' },
      });
      await user.click(within(form).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByTestId('plugin-config-form')).toBeNull());

      await user.click(screen.getByRole('switch', { name: `启用 ${ID}` }));
      await waitFor(() => expect(host.runtime.get(ID)).toBeUndefined());
      await waitFor(() => expect(screen.getByRole('switch', { name: `启用 ${ID}` })).not.toBeChecked());
      expect(host.ctx.get('exampleWebSearch')).toBeUndefined();
      expect((await packages.list())[0]?.enabled).toBe(false);
      expect((await store.read()).file.plugins[0]).toMatchObject({ id: ID, disabled: true, config: { label: 'configured-through-ui' } });

      await user.click(screen.getByRole('button', { name: `查看 ${ID} 的详情` }));
      await user.click(screen.getByRole('button', { name: `卸载 ${ID}` }));
      const confirmation = await screen.findByRole('alertdialog');
      await user.click(within(confirmation).getByRole('button', { name: '卸载' }));
      await waitFor(() => expect(screen.getByTestId('plugin-manager-empty')).toBeInTheDocument());
      expect(await packages.list()).toEqual([]);
      expect((await store.read()).file.plugins).toEqual([]);
      expect(host.runtime.get(ID)).toBeUndefined();
      expect(new Set(calls)).toEqual(new Set(Object.values(MANAGER_COMMANDS)));
    } finally {
      view?.unmount();
      controller.dispose();
      await ui.dispose();
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
