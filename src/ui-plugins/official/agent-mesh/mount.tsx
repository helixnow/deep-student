import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import {
  ArrowsLeftRight,
  Plug,
  Sparkle,
  TerminalWindow,
} from '@phosphor-icons/react';
import type { SettingsSectionRegistration, SettingsSectionRenderProps } from '@/ui-kernel/contracts/settings';
import type { SurfaceIcon } from '@/ui-kernel/contracts/surfaces';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import {
  connectMeshWorkbenchPlugin,
  useAgentMeshWorkbenchStore,
} from '@/features/agent-mesh';

const LazyMeshSettingsSection = React.lazy(() =>
  import('@/features/agent-mesh/components/MeshSettingsSection').then((m) => ({
    default: m.MeshSettingsSection,
  })),
);

function MeshSettingsSectionSlot(props: SettingsSectionRenderProps) {
  return (
    <React.Suspense fallback={null}>
      <LazyMeshSettingsSection {...props} />
    </React.Suspense>
  );
}
MeshSettingsSectionSlot.displayName = 'MeshSettingsSection';

export const AGENT_MESH_SETTINGS_SECTION_ID = 'agent-mesh';

function parseLeadingMention(text: string): { target: string | null; rest: string } {
  const match = /^\s*@([A-Za-z0-9_-]+)\s*(.*)$/s.exec(text);
  if (!match) return { target: null, rest: text.trim() };
  return { target: match[1] ?? null, rest: (match[2] ?? '').trim() };
}

function pickPreferredExternalHandle(): string {
  const agents = useAgentMeshWorkbenchStore.getState().agents;
  const available = agents.find((a) => a.driver !== 'builtin' && a.available);
  return available ? available.handle : '@claude';
}

export function mountAgentMeshPlugin(ctx: Context): void {
  // 1. Connect `ctx.ui.host` RPC & backend event stream (0 direct `invoke` calls, 0 standalone modal)
  ctx.effect(() => connectMeshWorkbenchPlugin(ctx), 'agent-mesh.host-bridge');

  // 2. Ensure chat slots exist if plugin is mounted into a minimal standalone test kernel
  if (!ctx.ui.slots.definition('chat.composer.commands')) {
    ctx.ui.declareSlot({
      name: 'chat.composer.commands',
      cardinality: 'list',
      description: '聊天输入框斜杠命令',
    });
  }
  if (!ctx.ui.slots.definition('chat.message.actions')) {
    ctx.ui.declareSlot({
      name: 'chat.message.actions',
      cardinality: 'list',
      description: '聊天消息更多操作',
    });
  }

  // 3. Contribute `/swarm` and `/handoff` directly inside the Chat Composer (no separate UI screen)
  ctx.ui.contribute('chat.composer.commands', {
    id: 'swarm',
    order: 10,
    value: {
      name: 'swarm',
      label: '多智能体蜂群协作',
      description: '在当前对话开启主智能体与外部编程 CLI 共享上下文协作',
      icon: Sparkle as SurfaceIcon,
      run: async (composer) => {
        const store = useAgentMeshWorkbenchStore.getState();
        const sessionId = composer.sessionId || store.activeSessionId || 'default-session';
        const goal = composer.input.trim();
        await store.initializeSwarm({ chatSessionId: sessionId, goal });
        if (goal) {
          composer.send(`[蜂群协作目标] ${goal}`);
        } else {
          composer.setInput('@all ');
        }
      },
    },
  });

  ctx.ui.contribute('chat.composer.commands', {
    id: 'handoff',
    order: 20,
    value: {
      name: 'handoff',
      label: '交接给其他编程 CLI',
      description: '释放当前文件租约、保存快照并交给指定 @agent 接续处理',
      icon: ArrowsLeftRight as SurfaceIcon,
      run: async (composer) => {
        const store = useAgentMeshWorkbenchStore.getState();
        const sessionId = composer.sessionId || store.activeSessionId || 'default-session';
        const { target, rest } = parseLeadingMention(composer.input);
        if (target) {
          const members = store.membersBySession[sessionId] ?? [];
          const fromRoster =
            store.workbench.selectedRosterName ??
            members.find((m) => m.rosterName !== target && m.rosterName !== 'deepstudent')?.rosterName ??
            'claude';
          await store.handoffMemberToCli({
            chatSessionId: sessionId,
            fromRosterName: fromRoster,
            targetAgentId: target,
            summary: rest || undefined,
            nextTask: rest || undefined,
          });
          composer.setInput('');
          return;
        }
        const preferred = pickPreferredExternalHandle();
        composer.setInput(rest ? `${preferred} ${rest}` : `${preferred} `);
      },
    },
  });

  // 4. Contribute `"派发给外部编程 CLI"` to `chat.message.actions` — prefill chat composer directly
  ctx.ui.contribute('chat.message.actions', {
    id: 'dispatch-external-cli',
    order: 20,
    value: {
      label: '派发给外部编程 CLI',
      icon: TerminalWindow as SurfaceIcon,
      run: (message) => {
        const preferred = pickPreferredExternalHandle();
        const excerpt = (message.content ?? '').trim();
        const prompt = excerpt ? `${preferred} ${excerpt}` : `${preferred} `;
        dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, {
          content: prompt,
        });
      },
    },
  });

  // 5. Contribute native quiet `编程 CLI` section to `settings.sections` under `integrations`
  const settingsSection: SettingsSectionRegistration = {
    id: AGENT_MESH_SETTINGS_SECTION_ID,
    group: 'integrations',
    order: 55,
    titleKey: 'agentMesh:settings.tabTitle',
    placement: 'main',
    visible: ({ isMobile }) => !isMobile,
    contentVisible: ({ isMobile }) => !isMobile,
    component: MeshSettingsSectionSlot,
    navigation: {
      order: 126,
      legacyGroup: 2,
      icon: TerminalWindow,
      mobileDescriptionKey: 'agentMesh:settings.mobileDescription',
      mobileAccent: 'var(--settings-nav-accent-indigo)',
      category: {
        id: 'integrations',
        titleKey: 'settings:categories.integrations',
        icon: Plug,
        order: 40,
      },
      categoryOrder: 50,
    },
    searchDetails: [
      {
        order: 470,
        labelKey: 'agentMesh:settings.tabTitle',
        keywords: [
          'cli',
          'claude',
          'codex',
          'opencode',
          'pi',
          'swarm',
          'agent',
          '编程',
          '外部编程',
          '蜂群',
        ],
      },
    ],
  };
  ctx.ui.settings.register(settingsSection);
}
