import { expect, it } from 'vitest';
import { balanceInput, balanceUpdate } from '../client/src/utils/balance';

it('formats raw balances without sending a rounded amount on unrelated edits', () => {
  const draft = { balance: 9.999166999999999 };
  expect(balanceInput(draft.balance)).toBe('10.00');
  expect(balanceUpdate(draft)).toEqual({});
  expect(draft.balance).toBe(9.999166999999999);
});
it('keeps editable input and accepts zero instead of converting it to unlimited', () => {
  expect(balanceInput('1.')).toBe('1.');
  expect(balanceUpdate({ balance: '0', balanceChanged: true }, true)).toEqual({ balance: 0 });
  expect(balanceUpdate({ balance: -1, isNew: true }, true)).toEqual({ balance: -1 });
  expect(balanceUpdate({ balance: '12.50', balanceChanged: true })).toEqual({ balance: 12.5 });
});
it('rejects empty, nonnumeric and invalid negative amounts', () => {
  for (const balance of ['', 'invalid', Infinity, -2]) {
    expect(() => balanceUpdate({ balance, balanceChanged: true }, true)).toThrow();
  }
  expect(() => balanceUpdate({ balance: -1, balanceChanged: true })).toThrow();
});
