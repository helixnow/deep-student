import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LatexText } from '../LatexText';

describe('LatexText', () => {
  it('keeps KaTeX sqrt SVG path data intact while converting text newlines', () => {
    const { container } = render(<LatexText content={'第一行\n$\\sqrt{1+x^2}-1$'} />);
    const path = container.querySelector('svg path');
    expect(path).not.toBeNull();
    expect(path!.getAttribute('d')).not.toContain('<br');
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });
});
