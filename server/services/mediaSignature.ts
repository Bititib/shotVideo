import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export function mediaSignature(resource: string, expires: number) {
  return createHmac('sha256',env.JWT_SECRET).update(`media-v1\n${resource}\n${expires}`).digest('hex');
}
export function validMediaSignature(resource: string, expires: unknown, signature: unknown, now = Date.now()) {
  const expiry=Number(expires);
  if (!Number.isSafeInteger(expiry)||expiry<=Math.floor(now/1000)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mediaSignature(resource,expiry),'hex'));
}
export function signedMediaUrl(resource: string, base: string, seconds = 3600) {
  const expires=Math.floor(Date.now()/1000)+seconds;
  return `${base.replace(/\/$/,'')}${resource}?expires=${expires}&signature=${mediaSignature(resource,expires)}`;
}
