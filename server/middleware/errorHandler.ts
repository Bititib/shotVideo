import { Request, Response, NextFunction } from 'express';

/**
 * 全局错误处理中间件
 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error('❌ Server Error:', err);

  const status = err.status || 500;

  // 生产环境不暴露内部错误细节
  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? '服务器内部错误'
    : (err.message || '服务器内部错误');

  res.status(status).json({ error: message });
}
