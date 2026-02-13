declare module '@sentry/browser' {
  export function init(options: any): void;
  export function captureException(err: any, context?: any): void;
}

declare module '@sentry/tracing' {
  export class BrowserTracing {
    constructor(opts?: any);
  }
}




