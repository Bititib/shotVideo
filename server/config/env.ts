import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const env = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@admin.com',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  GROK2API_BASE_URL: process.env.GROK2API_BASE_URL || '',
  GROK2API_API_KEY: process.env.GROK2API_API_KEY || '',
};

/**
 * 获取所有可用的 Gemini API Key
 * 支持两种配置方式：
 *   GEMINI_API_KEYS=key1,key2,key3   （推荐，逗号分隔）
 *   GEMINI_API_KEY=single_key         （向后兼容）
 */
export function getApiKeys(): string[] {
  const multiKeys = process.env.GEMINI_API_KEYS || '';
  if (multiKeys) {
    return multiKeys.split(',').map(k => k.trim()).filter(Boolean);
  }
  return env.GEMINI_API_KEY ? [env.GEMINI_API_KEY] : [];
}

/** 轮询计数器 */
let _keyIndex = 0;

/** 从 Key 池中轮询获取一个 API Key */
export function getNextApiKey(): string {
  const keys = getApiKeys();
  if (keys.length === 0) throw new Error('未配置 GEMINI_API_KEY 或 GEMINI_API_KEYS');
  const key = keys[_keyIndex % keys.length];
  _keyIndex++;
  return key;
}
