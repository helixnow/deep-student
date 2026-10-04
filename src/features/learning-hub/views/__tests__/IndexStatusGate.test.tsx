import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('../IndexStatusView', () => ({ default: () => <p>full index status</p> }));

import { IndexStatusGate } from '../IndexStatusGate';
import { resetEmbeddingReadinessForTests } from '../../embeddingReadiness';
import { EmbeddingReadinessBanner } from '../../components/EmbeddingReadinessBanner';

afterEach(cleanup);
beforeEach(() => {
  resetEmbeddingReadinessForTests();
  invokeMock.mockReset();
});

describe('IndexStatusGate', () => {
  it('replaces the index status page with a keyword-search note when the build has no vector index', async () => {
    invokeMock.mockResolvedValue({ ready: false, reason: 'no embedding model', vectorIndexAvailable: false });
    render(<><IndexStatusGate /><EmbeddingReadinessBanner /></>);
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.queryByText('full index status')).not.toBeInTheDocument();
    // Configuring an embedding model would not help on this build: no "configure" banner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the full index status page when the vector index is compiled in', async () => {
    invokeMock.mockResolvedValue({ ready: true, vectorIndexAvailable: true });
    render(<IndexStatusGate />);
    expect(await screen.findByText('full index status')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('treats an older backend without the flag as vector-capable', async () => {
    invokeMock.mockResolvedValue({ ready: true });
    render(<IndexStatusGate />);
    expect(await screen.findByText('full index status')).toBeInTheDocument();
  });
});
