/** An intentionally bounded error: no credentials, remote body, or transport cause. */
export class PersonalApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, code = 'INVALID_ARGUMENT', status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'PersonalApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
