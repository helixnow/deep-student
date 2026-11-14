import type { CodexAuthErrorDto } from '../../api.ts';

export type CodexAuthErrorKind = 'LoginBusy' | 'AttemptNotFound' | 'Cancelled' | 'Timeout' | 'CallbackBind'
  | 'InvalidState' | 'MissingAuthorizationCode' | 'AuthorizationDenied' | 'Network' | 'OAuthRejected'
  | 'MalformedResponse' | 'ResponseTooLarge' | 'MissingAccountId' | 'AccountChanged' | 'SignedOut'
  | 'ReauthenticationRequired' | 'CredentialStore' | 'InvalidHeader' | 'InvalidRequestBody';
export interface CodexAuthErrorDetail {
  stage?: string;
  code?: string;
  permanent?: boolean;
  reauthRequired?: boolean;
  field?: string;
  reason?: string;
}
const definitions: Record<CodexAuthErrorKind, [string, string]> = {
  LoginBusy: ['login_busy', 'another Codex login is already in progress'],
  AttemptNotFound: ['attempt_not_found', 'Codex login attempt was not found'],
  Cancelled: ['cancelled', 'Codex login was cancelled'], Timeout: ['timeout', 'Codex login timed out'],
  CallbackBind: ['callback_bind_failed', 'failed to bind the local OAuth callback listener'],
  InvalidState: ['invalid_state', 'OAuth callback state did not match'],
  MissingAuthorizationCode: ['missing_authorization_code', 'OAuth callback did not contain an authorization code'],
  AuthorizationDenied: ['authorization_denied', 'authorization was denied: '],
  Network: ['network_error', 'OAuth network request failed during '],
  OAuthRejected: ['oauth_rejected', 'OAuth server rejected '],
  MalformedResponse: ['malformed_response', 'OAuth response was malformed: '],
  ResponseTooLarge: ['response_too_large', 'OAuth response exceeded the size limit during '],
  MissingAccountId: ['missing_account_id', 'OAuth token did not contain a ChatGPT account id'],
  AccountChanged: ['account_changed', 'OAuth refresh returned a different ChatGPT account'],
  SignedOut: ['signed_out', 'Codex credentials are not available'],
  ReauthenticationRequired: ['reauthentication_required', 'Codex credentials must be renewed by signing in again'],
  CredentialStore: ['credential_store_failed', 'Codex credential storage failed'],
  InvalidHeader: ['invalid_header', 'Codex request headers could not be constructed'],
  InvalidRequestBody: ['invalid_request_body', 'Codex request body is invalid: '],
};
export class CodexAuthError extends Error {
  readonly kind: CodexAuthErrorKind;
  readonly detail: CodexAuthErrorDetail;
  constructor(kind: CodexAuthErrorKind, detail: CodexAuthErrorDetail = {}) {
    const suffix = kind === 'AuthorizationDenied' ? detail.code : kind === 'OAuthRejected' ? `${detail.stage}: ${detail.code}`
      : kind === 'Network' || kind === 'ResponseTooLarge' ? detail.stage
        : kind === 'MalformedResponse' ? detail.field : kind === 'InvalidRequestBody' ? detail.reason : '';
    super(definitions[kind][1] + (suffix ?? ''));
    this.name = 'CodexAuthError'; this.kind = kind; this.detail = detail;
  }
  code(): string { return definitions[this.kind][0]; }
  class(): CodexAuthErrorDto['class'] {
    switch (this.kind) {
      case 'Cancelled': return 'cancelled';
      case 'Timeout': case 'Network': return 'transient';
      case 'InvalidState': return 'security';
      case 'ReauthenticationRequired': case 'AccountChanged': return 'reauthentication_required';
      case 'OAuthRejected': return this.detail.reauthRequired ? 'reauthentication_required' : this.detail.permanent === false ? 'transient' : 'permanent';
      default: return 'permanent';
    }
  }
  toDto(): CodexAuthErrorDto { return { code: this.code(), message: this.message, class: this.class() }; }
}
