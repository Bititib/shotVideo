import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, sqlite } from '../server/db/index.js';
import { organizations, users } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { BalanceService } from '../server/services/balanceService.js';

describe('BalanceService source-aware refunds', () => {
  let userId = 0;
  let orgId = 0;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tier = sqlite.prepare('SELECT id FROM tiers ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    const user = db.insert(users).values({
      email: `balance-source-${suffix}@test.com`,
      username: `balance-source-${suffix}`,
      passwordHash: 'test',
      tierId: tier?.id || 1,
      balance: 10,
    }).run();
    userId = Number(user.lastInsertRowid);
    const org = db.insert(organizations).values({
      name: `balance-source-${suffix}`,
      slug: `balance-source-${suffix}`,
      tierId: tier?.id || 1,
      balance: 1,
      ownerId: userId,
    }).run();
    orgId = Number(org.lastInsertRowid);
    db.update(users).set({ orgId }).where(eq(users.id, userId)).run();
  });

  afterEach(() => {
    if (userId) db.update(users).set({ orgId: null }).where(eq(users.id, userId)).run();
    if (orgId) db.delete(organizations).where(eq(organizations.id, orgId)).run();
    if (userId) db.delete(users).where(eq(users.id, userId)).run();
  });

  it('returns a personal-balance deduction to the personal balance', () => {
    const deduction = BalanceService.deductWithSource(userId, 3, 'video');
    expect(deduction).toMatchObject({ balance: 7, source: 'user' });
    expect(BalanceService.getOrgBalance(orgId)).toBe(1);

    BalanceService.refundToSource(userId, 3, deduction!.source, deduction!.orgId, 'video_refund');
    expect(BalanceService.getBalance(userId)).toBe(10);
    expect(BalanceService.getOrgBalance(orgId)).toBe(1);
  });

  it('returns an organization-balance deduction to the same organization', () => {
    db.update(organizations).set({ balance: 10 }).where(eq(organizations.id, orgId)).run();
    const deduction = BalanceService.deductWithSource(userId, 3, 'video');
    expect(deduction).toMatchObject({ balance: 7, source: 'org', orgId });
    expect(BalanceService.getBalance(userId)).toBe(10);

    BalanceService.refundToSource(userId, 3, deduction!.source, deduction!.orgId, 'video_refund');
    expect(BalanceService.getOrgBalance(orgId)).toBe(10);
    expect(BalanceService.getBalance(userId)).toBe(10);
  });
});
