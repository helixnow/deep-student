import React from 'react';

/** Official renderers retain their existing boundaries; only community contributions use this. */
export class CommunityContentBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: unknown) {
    console.error('[ui-content] Community contribution failed:', error);
  }

  render() { return this.state.failed ? this.props.fallback ?? null : this.props.children; }
}
