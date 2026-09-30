/** Validate before importing the database or starting any recovery workers. */
export function validateProductionConfig(config: NodeJS.ProcessEnv) {
  if (config.NODE_ENV !== 'production') return;
  const errors: string[] = [];
  if (!config.JWT_SECRET || config.JWT_SECRET.length < 32 || /dev-secret|change.?me|example/i.test(config.JWT_SECRET)) errors.push('JWT_SECRET 必须为至少 32 字符的随机密钥');
  if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD.length < 12 || /^(admin123|password)/i.test(config.ADMIN_PASSWORD)) errors.push('ADMIN_PASSWORD 必须设置为至少 12 字符的强密码');
  const httpsOrigin = (value: string) => { try { const u = new URL(value); return u.protocol === 'https:' && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };
  if (!config.BACKEND_URL || !httpsOrigin(config.BACKEND_URL)) errors.push('BACKEND_URL 必须是站点 HTTPS 地址');
  if (!config.ALLOWED_ORIGINS || !config.ALLOWED_ORIGINS.split(',').every(v => httpsOrigin(v.trim()))) errors.push('ALLOWED_ORIGINS 必须明确指定允许的 HTTPS 网站来源');
  if (errors.length) throw new Error(`生产配置不完整：${errors.join('；')}`);
}
