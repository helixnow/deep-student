declare module '@sentry/browser' {
  export function init(options: any): void;
  export function captureException(err: any, context?: any): void;
  export function getClient(): any;
  export function browserTracingIntegration(options?: any): any;
}

declare module '@sentry/tracing' {
  export class BrowserTracing {
    constructor(opts?: any);
  }
}




