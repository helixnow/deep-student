import React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const base = 'w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30 resize-y';

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className = '', ...props },
  ref,
) {
  return <textarea ref={ref} className={`${base} border-[hsl(var(--border))] ${className}`} {...props} />;
});

export default Textarea;

