import React from 'react';
import { ProfilerPanel } from '@/features/chat/dev/playground/ProfilerPanel';

export interface MarkdownStreamingProfilerPluginProps {
  visible: boolean;
  isActive: boolean;
  isActivated: boolean;
  onClose: () => void;
}

const MarkdownStreamingProfilerPlugin: React.FC<MarkdownStreamingProfilerPluginProps> = ({
  isActivated,
}) => {
  if (!isActivated) {
    return (
      <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>
        Activate this plugin to start collecting Markdown streaming metrics.
      </div>
    );
  }
  return <ProfilerPanel embedded />;
};

export default MarkdownStreamingProfilerPlugin;
