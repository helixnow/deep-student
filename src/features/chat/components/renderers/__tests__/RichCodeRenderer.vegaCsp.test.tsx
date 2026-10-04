import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expressionInterpreter } from 'vega-interpreter';

const embedMock = vi.hoisted(() => vi.fn(async () => ({ finalize: vi.fn() })));
vi.mock('vega-embed', () => ({ default: embedMock }));

import { RichCodeRenderer } from '../RichCodeRenderer';

describe('RichCodeRenderer vega-lite', () => {
  it('embeds with the CSP-safe expression interpreter (release CSP has no unsafe-eval)', async () => {
    const spec = { data: { values: [{ a: 1 }] }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' } } };
    render(<RichCodeRenderer kind="vega-lite" source={JSON.stringify(spec)} />);
    await waitFor(() => expect(embedMock).toHaveBeenCalledTimes(1));
    const options = (embedMock.mock.calls[0] as unknown[])[2];
    expect(options).toMatchObject({ ast: true, expr: expressionInterpreter });
  });
});
