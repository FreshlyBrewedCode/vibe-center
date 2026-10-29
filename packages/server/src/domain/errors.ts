/** An error with an HTTP status; the API turns it into `{ error, hint? }`. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503,
    message: string,
    /** Points the UI at the setting that fixes it, e.g. "harness:claude-code". */
    readonly hint?: string,
  ) {
    super(message);
  }
}
