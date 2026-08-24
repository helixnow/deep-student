import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import type { AlertBlockProps } from '../schema';

export function AlertBlock({ variant, title, description }: AlertBlockProps) {
  return (
    <Alert variant={variant}>
      <AlertTitle>{title}</AlertTitle>
      {description ? <AlertDescription>{description}</AlertDescription> : null}
    </Alert>
  );
}
