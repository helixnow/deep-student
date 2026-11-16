import { describe, expect, it } from 'vitest';

import { SERVICE_NAMES, declaredCapabilities } from '../../../../host/plugins/plugin-workshop/src/declared';
import zh from '../../../locales/zh-CN/plugin_manager.json';
import { permissionLines } from '../permissions';
import { t } from './i18nMock';

// What the user consented to on the workshop confirmation card must be what the manager lists afterwards.
describe('workshop confirmation lines cover every permission in the manager\'s words', () => {
  const agentTools = [{ name: 'lookup', title: '查课表', description: 'd' }, { name: 'drop', title: '退课', description: 'd' }];
  const services = ['pluginModel', 'storage', 'settings', ...Object.keys(SERVICE_NAMES), 'someNewService'];
  const permissions = ['agent:tools', 'net:calendar.example.edu.cn', 'net:b.example.org', ...services.map((name) => `service:${name}`)];
  const declared = declaredCapabilities({ id: 'workshop.plugin-x', permissions, agentTools });
  const manager = permissionLines(permissions, agentTools as never, t);

  it.each(permissions)('%s has a plain-language line on the card that the manager also shows', (permission) => {
    const lines = manager.filter((line) => line.raw === permission);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.text).not.toBe(permission);
      expect(declared).toContain(line.text);
    }
  });

  it('the card says nothing the manager would not list', () => {
    expect(new Set(declared)).toEqual(new Set(manager.map((line) => line.text)));
  });

  it('the Host knows every service name the manager has a human name for', () => {
    expect(Object.keys(SERVICE_NAMES).sort()).toEqual(Object.keys(zh.permission.serviceNames).sort());
    for (const [name, human] of Object.entries(SERVICE_NAMES)) expect(human).toBe((zh.permission.serviceNames as Record<string, string>)[name]);
  });
});
