// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AdminCollection from '../client/src/components/AdminCollection';
const items = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}` }));
const props = { name: 'list-regression', items, id: (item: typeof items[number]) => String(item.id),
  columns: [{ title: '编号', sort: (item: typeof items[number]) => item.id, render: (item: typeof items[number]) => item.name }] };
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
it('paginates the list and returns to its first page after changing sort direction', () => {
  render(<AdminCollection {...props} listItem={item => <button>{item.name}</button>} />);
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(24);
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByRole('button', { name: '渠道 30' })).toBeVisible();
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: '升序' }));
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(within(screen.getByRole('list')).getAllByRole('button')[0]).toHaveTextContent('渠道 30');
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(24);
});
it('preserves the existing table and card modes for other management pages', () => {
  render(<AdminCollection {...props}>{rows => <div>{rows.map(item => <button key={item.id}>{item.name}</button>)}</div>}</AdminCollection>);
  expect(screen.getByRole('table')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '卡片' }));
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByRole('button', { name: '渠道 1' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '表格' }));
  expect(screen.getByRole('table')).toBeVisible();
});
