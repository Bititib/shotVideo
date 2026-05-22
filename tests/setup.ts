/**
 * 测试环境通用 setup
 * 在测试运行前初始化数据库（使用内存 SQLite）
 */
import { initDatabase } from '../server/db/seed.js';

// 设置测试环境变量
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_EXPIRES_IN = '1h';
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'test123';
process.env.GEMINI_API_KEY = 'test-key';
process.env.PORT = '0'; // 随机端口
