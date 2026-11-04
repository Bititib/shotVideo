import type { RequestHandler } from 'express';
import { publicApiDiagnostics } from '../services/publicApiDiagnostics.js';

/** User API boundary only; saved diagnostics and admin responses are untouched. */
export function publicApiErrorResponse(privateNames: () => readonly string[]): RequestHandler {
  return (_req, res, next) => {
    const json = res.json;
    res.json = function (body: any) {
      return json.call(this, publicApiDiagnostics(body, privateNames()));
    };
    next();
  };
}
