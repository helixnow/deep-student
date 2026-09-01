import React from 'react';
import { VoiceInputSettingsSection } from './VoiceInputSettingsSection';
import type { VoiceInputAssignedModel } from '@/voice-input/types';

interface VoiceInputTabProps {
  voiceInputAssignedModel: VoiceInputAssignedModel;
}

/**
 * 语音听写独立设置页（2026-09 自常规页拆出，防止常规页过长）。
 * VoiceInputSettingsSection 自带 GroupTitle 标题，无需 embedded。
 */
export const VoiceInputTab: React.FC<VoiceInputTabProps> = ({ voiceInputAssignedModel }) => {
  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <VoiceInputSettingsSection assignedModel={voiceInputAssignedModel} />
    </div>
  );
};

export default VoiceInputTab;
