export class EmailError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}
