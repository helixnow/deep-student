import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

const base = 'w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30';

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', invalid, ...props },
  ref,
) {
  const border = invalid ? 'border-red-400' : 'border-[hsl(var(--border))]';
  return <input ref={ref} className={`${base} ${border} ${className}`} {...props} />;
});

export default Input;

