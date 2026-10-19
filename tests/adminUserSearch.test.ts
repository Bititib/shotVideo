import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { contents, users, tiers } from '../server/db/schema.js';
import { AdminService } from '../server/services/adminService.js';

beforeEach(() => {
  db.delete(contents).run();
  db.delete(users).run();
  db.delete(tiers).run();
  db.insert(tiers).values([
    { id: 1, name: 'free', displayName: '免费用户' },
    { id: 2, name: 'pro', displayName: '专业会员' },
  ]).run();
  db.insert(users).values([
    { id: 1, username: '张小明', email: 'alice@example.invalid', tierId: 1, isActive: 1 },
    { id: 2, username: '小明工作室', email: 'studio@other.invalid', tierId: 2, isActive: 1 },
    { id: 3, username: 'Bob', email: 'xiaoming@example.invalid', tierId: 1, isActive: 0 },
    { id: 4, username: 'xiaoming', email: 'four@other.invalid', tierId: 1, isActive: 1 },
  ].map((user, index) => ({ ...user, passwordHash: 'test', createdAt: `2026-10-16 10:00:0${index}` }))).run();
});
afterAll(() => sqlite.close());

describe('administrator customer search', () => {
  it('matches partial Chinese usernames and trims the keyword', () => {
    const result = AdminService.getUsers({ page: 1, pageSize: 15, search: ' 小明 ' });
    expect(result.items.map(user => user.id)).toEqual([2, 1]);
    expect(result.total).toBe(2);
  });

  it('matches partial email addresses without case sensitivity', () => {
    const result = AdminService.getUsers({ page: 1, pageSize: 15, search: '@EXAMPLE' });
    expect(result.items.map(user => user.id)).toEqual([3, 1]);
    expect(result.total).toBe(2);
  });

  it('searches both fields while keeping tier and status filters in effect', () => {
    const unfiltered = AdminService.getUsers({ page: 1, pageSize: 15, search: 'xiaoming' });
    expect(unfiltered.items.map(user => user.id)).toEqual([4, 3]);
    const filtered = AdminService.getUsers({ page: 1, pageSize: 15, search: 'xiaoming', tierId: 1, isActive: 1 });
    expect(filtered.items.map(user => user.id)).toEqual([4]);
    expect(filtered.total).toBe(1);
    expect(AdminService.getUsers({ page: 1, pageSize: 15, search: '小明', tierId: 1, isActive: 1 }).items.map(user => user.id)).toEqual([1]);
  });

  it('paginates matching customers with a consistent filtered total', () => {
    const first = AdminService.getUsers({ page: 1, pageSize: 1, search: '小明' });
    const second = AdminService.getUsers({ page: 2, pageSize: 1, search: '小明' });
    expect(first.items.map(user => user.id)).toEqual([2]);
    expect(second.items.map(user => user.id)).toEqual([1]);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
  });

  it('returns an empty result for a missing customer', () => {
    expect(AdminService.getUsers({ page: 1, pageSize: 15, search: '不存在的客户' })).toMatchObject({ items: [], total: 0 });
  });

  it('does not filter the list for a blank keyword', () => {
    const result = AdminService.getUsers({ page: 1, pageSize: 15, search: '   ' });
    expect(result.items).toHaveLength(4);
    expect(result.total).toBe(4);
  });

  it('counts all video tasks from the current Beijing day instead of usage logs', () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const previousBeijingDay = String(sqlite.prepare(
      "SELECT datetime('now', '+8 hours', 'start of day', '-8 hours', '-1 second')",
    ).pluck().get());
    db.insert(contents).values([
      { userId: 1, type: 'video', title: 'completed video', status: 'completed', createdAt: now },
      { userId: 1, type: 'video', title: 'failed video', status: 'failed', createdAt: now },
      { userId: 1, type: 'image', title: 'image does not count', status: 'completed', createdAt: now },
      { userId: 1, type: 'video', title: 'previous Beijing day', status: 'completed', createdAt: previousBeijingDay },
      { userId: 2, type: 'video', title: 'other user', status: 'completed', createdAt: now },
    ]).run();

    const result = AdminService.getUsers({ page: 1, pageSize: 15, search: '张小明' });
    expect(result.items[0]).toMatchObject({ id: 1, usedToday: 2, videoTasksToday: 2 });
  });
});
