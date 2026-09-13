/** A 4xx the UI can show as-is; anything else thrown is a 500. */
export class Rejection extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
  }
}
