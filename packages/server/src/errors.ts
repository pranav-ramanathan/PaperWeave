/** An error the caller caused or may be told about. Anything else is a bug and stays a 500. */
export class AppError extends Error {
  code: 'not_found' | 'permission_denied' | 'invalid_input' | 'conflict';
  constructor(code: AppError['code'], message: string) {
    super(message);
    this.code = code;
  }
  get status() {
    return { not_found: 404, permission_denied: 403, invalid_input: 400, conflict: 409 }[this.code];
  }
}
