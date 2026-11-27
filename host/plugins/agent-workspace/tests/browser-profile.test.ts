import { describe, expect, it } from 'vitest';
import {
  AgentProfileResolver,
  BROWSER_PROFILE_ID,
} from '../api.ts';
import { ApprovalManager } from '../src/approval-manager.ts';
import { parseCustomAgentProfile } from '../src/workspace/custom-agents.ts';
import { BROWSER_PROFILE_ID as PORTABLE_BROWSER_PROFILE_ID } from '../portable.ts';
import {
  BROWSER_PROFILE_ID as ORCHESTRATION_BROWSER_PROFILE_ID,
  builtInAgentProfile,
  resolveAgentProfile,
} from '../../agent-orchestration/api.ts';
import { BROWSER_WORKER_TOOL_NAMES } from '../../browser/api.ts';
import { lookupToolDescriptor } from '../../../kernel/agent-tool-descriptors.ts';

const FORBIDDEN_PRIVILEGED_TOOLS = [
  'builtin-local_shell_execute',
  'builtin-local_shell_preflight',
  'local_shell_execute',
  'builtin-workspace_write',
  'builtin-note_set',
  'builtin-note_append',
  'builtin-note_delete',
  'builtin-dstu_delete',
  'builtin-dstu_purge',
  'builtin-settings_set',
  'builtin-model_assignments_set',
  'builtin-model_profile_add',
  'builtin-memory_write',
  'builtin-memory_export_all',
];

describe('built-in least-privilege browser subagent profile', () => {
  it('exports consistent BROWSER_PROFILE_ID across agent-workspace and agent-orchestration', () => {
    expect(BROWSER_PROFILE_ID).toBe('browser');
    expect(PORTABLE_BROWSER_PROFILE_ID).toBe('browser');
    expect(ORCHESTRATION_BROWSER_PROFILE_ID).toBe('browser');
  });

  it('resolves browser profile with strict least-privilege permissions and exact 18 browser + 2 web tools', () => {
    const workspaceProfile = AgentProfileResolver.resolve({ profileId: BROWSER_PROFILE_ID });
    const orchestrationProfile = resolveAgentProfile({ profileId: ORCHESTRATION_BROWSER_PROFILE_ID });

    expect(workspaceProfile.id).toBe('browser');
    expect(workspaceProfile.model).toBeNull();
    expect(workspaceProfile.reasoningEffort).toBe('medium');
    expect(workspaceProfile.permissions).toEqual({
      sandbox: 'read_only',
      approvalPolicy: 'inherit',
      networkAccess: true,
    });
    expect(workspaceProfile.contextInheritance).toEqual({ mode: 'last_n_turns', turns: 4 });
    expect(workspaceProfile.skills).toEqual([]);

    const expectedTools = [
      ...BROWSER_WORKER_TOOL_NAMES.filter(tool => tool !== 'builtin-webpage_save'),
      'builtin-web_search',
      'builtin-webpage_save',
    ];
    expect(BROWSER_WORKER_TOOL_NAMES).toHaveLength(19);
    expect(BROWSER_WORKER_TOOL_NAMES).toContain('builtin-webpage_save');
    expect(workspaceProfile.allowedTools).toEqual(expectedTools);
    expect(orchestrationProfile.allowedTools).toEqual(expectedTools);
    expect(workspaceProfile.allowedTools).toContain('builtin-webpage_save');
    expect(workspaceProfile.allowedTools).not.toContain('builtin-index_webpage');
    expect(orchestrationProfile.allowedTools).toContain('builtin-webpage_save');
    expect(orchestrationProfile.allowedTools).not.toContain('builtin-index_webpage');
    expect(orchestrationProfile.permissions).toEqual(workspaceProfile.permissions);
    expect(orchestrationProfile.contextInheritance).toEqual(workspaceProfile.contextInheritance);
    expect(orchestrationProfile.reasoningEffort).toBe('medium');
    expect(builtInAgentProfile('browser')).not.toBeNull();

    // Breaks the Lethal Trifecta: no shell, no local file write, no settings mutation, no secret read.
    for (const forbidden of FORBIDDEN_PRIVILEGED_TOOLS) {
      expect(workspaceProfile.allowedTools, `browser profile must not include ${forbidden}`).not.toContain(forbidden);
      expect(orchestrationProfile.allowedTools, `browser profile must not include ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('registers static descriptors for all 7 newly added browser tools in kernel registry', () => {
    expect(lookupToolDescriptor('browser_hover')).toMatchObject({
      sensitivity: 'Low', readOnly: false, sideEffectClass: 'WriteRemote',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });
    expect(lookupToolDescriptor('browser_press_key')).toMatchObject({
      sensitivity: 'Medium', readOnly: false, sideEffectClass: 'WriteRemote',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });
    expect(lookupToolDescriptor('browser_select_option')).toMatchObject({
      sensitivity: 'Medium', readOnly: false, sideEffectClass: 'WriteRemote',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });
    expect(lookupToolDescriptor('browser_wait_for')).toMatchObject({
      sensitivity: 'Low', readOnly: true, sideEffectClass: 'Read',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });
    expect(lookupToolDescriptor('browser_extract_content')).toMatchObject({
      sensitivity: 'Low', readOnly: true, sideEffectClass: 'Read',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });
    expect(lookupToolDescriptor('browser_tabs')).toMatchObject({
      sensitivity: 'Medium', readOnly: false, sideEffectClass: 'WriteRemote',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });
    expect(lookupToolDescriptor('browser_observe')).toMatchObject({
      sensitivity: 'Low', readOnly: true, sideEffectClass: 'Read',
      grantsScopeHint: 'builtin', headlessAllowed: false, ptcAllowed: false,
    });

    // Every browser worker tool has a registered builtin descriptor.
    for (const tool of BROWSER_WORKER_TOOL_NAMES) {
      const bare = tool.replace(/^builtin-/, '');
      expect(lookupToolDescriptor(bare), `missing descriptor for ${bare}`).toBeDefined();
    }
  });

  it('allows base: browser custom agents to subset browser tools while still stripping privileged tools', () => {
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => { warnings.push(msg); },
      error: () => {},
      debug: () => {},
    };

    const customBrowser = parseCustomAgentProfile(
      [
        '---',
        'name: docs-browser',
        'base: browser',
        'tools: [builtin-browser_open, builtin-browser_snapshot, builtin-webpage_save, builtin-local_shell_execute]',
        '---',
        'Browse documentation pages read-only.',
      ].join('\n'),
      'docs-browser.md',
      logger,
    );

    expect(customBrowser).not.toBeNull();
    expect(customBrowser!.id).toBe('docs-browser');
    expect(customBrowser!.allowedTools).toContain('builtin-browser_open');
    expect(customBrowser!.allowedTools).toContain('builtin-browser_snapshot');
    expect(customBrowser!.allowedTools).toContain('builtin-webpage_save');
    expect(customBrowser!.allowedTools).not.toContain('builtin-browser_click');
    expect(customBrowser!.allowedTools).not.toContain('builtin-local_shell_execute');
    expect(warnings.some(w => w.includes('builtin-local_shell_execute'))).toBe(true);

    // Non-browser bases must NOT gain browser tools via tools: override.
    const customExplorer = parseCustomAgentProfile(
      [
        '---',
        'name: strict-explorer',
        'base: explorer',
        'tools: [builtin-web_search, builtin-browser_open]',
        '---',
        'Read-only explorer.',
      ].join('\n'),
      'strict-explorer.md',
      logger,
    );
    expect(customExplorer).not.toBeNull();
    expect(customExplorer!.allowedTools).toContain('builtin-web_search');
    expect(customExplorer!.allowedTools).not.toContain('builtin-browser_open');
  });

  it('generates clean approval descriptions for coordinate browser_click and extended browser tools', () => {
    expect(ApprovalManager.generateDescription('builtin-browser_click', { element: 'Submit', ref: 'e4' }))
      .toBe('将点击网页元素: Submit (ref=e4)');
    expect(ApprovalManager.generateDescription('builtin-browser_click', { element: 'Canvas button', x: 320, y: 180 }))
      .toBe('将点击网页坐标: Canvas button (320, 180)');
    expect(ApprovalManager.generateDescription('builtin-browser_hover', { element: 'Menu', ref: 'e7' }))
      .toBe('将悬停网页元素: Menu (ref=e7)');
    expect(ApprovalManager.generateDescription('browser_hover', { element: 'Tooltip', x: 100, y: 200 }))
      .toBe('将悬停网页坐标: Tooltip (100, 200)');
    expect(ApprovalManager.generateDescription('builtin-browser_press_key', { key: 'Enter' }))
      .toBe('将向网页发送按键: Enter');
    expect(ApprovalManager.generateDescription('browser_press_key', { key: 'k', modifiers: ['Meta', 'Shift'] }))
      .toBe('将向网页发送按键: Meta+Shift+k');
    expect(ApprovalManager.generateDescription('builtin-browser_select_option', {
      element: 'Language', ref: 'e9', values: ['zh-CN', 'en-US'],
    })).toBe('将在网页下拉框中选择选项: Language (ref=e9, values=zh-CN, en-US)');
    expect(ApprovalManager.generateDescription('builtin-browser_tabs', { action: 'list' }))
      .toBe('将查看浏览器标签页列表');
    expect(ApprovalManager.generateDescription('builtin-browser_tabs', { action: 'new', url: 'https://example.edu' }))
      .toBe('将在浏览器中新建标签页: https://example.edu');
    expect(ApprovalManager.generateDescription('browser_tabs', { action: 'switch', tab_id: 'tab-2' }))
      .toBe('将切换浏览器标签页 (tab_id=tab-2)');
    expect(ApprovalManager.generateDescription('builtin-browser_tabs', { action: 'close', tab_id: 'tab-3' }))
      .toBe('将关闭浏览器标签页 (tab_id=tab-3)');
  });
});
