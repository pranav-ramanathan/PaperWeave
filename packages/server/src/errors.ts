/** An error the caller caused or may be told about. Anything else is a bug and stays a 500. */
export class AppError extends Error {
  /** `unavailable`: something outside this service that it needed did not answer. */
  code: 'not_found' | 'permission_denied' | 'invalid_input' | 'conflict' | 'unavailable';
  constructor(code: AppError['code'], message: string) {
    super(message);
    this.code = code;
  }
  get status() {
    return {
      not_found: 404,
      permission_denied: 403,
      invalid_input: 400,
      conflict: 409,
      unavailable: 503,
    }[this.code];
  }
}
