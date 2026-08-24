import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import type { AlertBlockProps } from '../schema';

export function AlertBlock({ variant, title, description }: AlertBlockProps) {
  const titleId = React.useId();
  return (
    <Alert variant={variant} role="alert" aria-labelledby={titleId}>
      <AlertTitle id={titleId}>{title}</AlertTitle>
      {description ? <AlertDescription>{description}</AlertDescription> : null}
    </Alert>
  );
}
