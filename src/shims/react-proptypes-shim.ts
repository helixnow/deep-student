// Ensure legacy libraries that expect React.PropTypes can run on React 18+
import React from 'react';
import PropTypes from 'prop-types';

if (!(React as any).PropTypes) {
  (React as any).PropTypes = PropTypes;
}

export {};

