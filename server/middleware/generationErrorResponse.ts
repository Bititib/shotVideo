import type { RequestHandler } from 'express';
import { publicGenerationError } from '../../shared/generationMessages.js';

/** Outbound JSON only: no changes to saved diagnostics, task state, or billing. */
export const generationErrorResponse: RequestHandler = (_req, res, next) => {
  const json = res.json;
  res.json = function (body: any) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const result = { ...body };
      for (const field of ['error', 'error_message', 'failure_reason']) {
        if (!result[field]) continue;
        if (field === 'error' && typeof result[field] === 'object' && !Array.isArray(result[field])) {
          const original = result[field];
          result[field] = { message: publicGenerationError(original) };
          // Preserve the API's error schema, without echoing arbitrary config/input.
          for (const key of ['type', 'code']) {
            if (typeof original[key] === 'string' && /^[\w.-]{1,100}$/.test(original[key]) && publicGenerationError(original[key]) === original[key]) result[field][key] = original[key];
          }
        } else result[field] = publicGenerationError(result[field]);
      }
      if (res.statusCode >= 400 && result.message) result.message = publicGenerationError(result.message);
      body = result;
    }
    return json.call(this, body);
  };
  next();
};
