import type React from 'react';

export interface RegisteredArtifactRendererProps {
  content: string;
  widgetId?: string;
  title?: string;
}

export type CustomArtifactRendererKind = 'openui' | 'generative-ui';

const rendererRegistry = new Map<
  CustomArtifactRendererKind,
  React.ComponentType<RegisteredArtifactRendererProps>
>();

const registryListeners = new Set<() => void>();

export function registerArtifactRenderer(
  kind: CustomArtifactRendererKind,
  component: React.ComponentType<RegisteredArtifactRendererProps>,
): void {
  const prev = rendererRegistry.get(kind);
  rendererRegistry.set(kind, component);
  if (prev !== component) {
    for (const listener of registryListeners) {
      listener();
    }
  }
}

export function getArtifactRenderer(
  kind: CustomArtifactRendererKind,
): React.ComponentType<RegisteredArtifactRendererProps> | null {
  return rendererRegistry.get(kind) ?? null;
}

export function subscribeArtifactRendererRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}
