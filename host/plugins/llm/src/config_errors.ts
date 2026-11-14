export class ConfigError extends Error {
  readonly kind: 'database' | 'configuration' | 'validation';
  constructor(kind: 'database' | 'configuration' | 'validation', message: string) {
    super(message); this.name = 'ConfigError'; this.kind = kind;
  }
}
export function databaseError(message: string): ConfigError { return new ConfigError('database', message); }
export function configurationError(message: string): ConfigError { return new ConfigError('configuration', message); }
export function validationError(message: string): ConfigError { return new ConfigError('validation', message); }
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
