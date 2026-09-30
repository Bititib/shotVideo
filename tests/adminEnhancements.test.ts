// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminCollection from '../client/src/components/AdminCollection';
import AdminBatch from '../client/src/components/AdminBatch';
import { useEditDraft } from '../client/src/hooks/useEditDraft';
import { startPolling } from '../client/src/utils/polling';
import { scalePricing } from '../client/src/utils/adminPricing';
import { adminApi } from '../client/src/api/admin';
vi.mock('../client/src/api/admin', () => ({ adminApi: { updateModel: vi.fn(), updatePricing: vi.fn(), createPricing: vi.fn() } }));
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const h = React.createElement;

function DraftEditor() {
  const draft = useEditDraft('test', false);
  return h('div', null,
    h('button', { onClick: () => draft.setEdit({ name: 'Original', apiKey: '', apiKeys: [{ apiKey: '' }] }) }, '打开'),
    draft.available && h('button', { onClick: draft.restore }, '恢复'),
    draft.edit && h('div', null,
      h('input', { 'aria-label': '名称', value: draft.edit.name, onChange: e => draft.setEdit({ ...draft.edit, name: e.target.value, apiKey: 'secret', apiKeys: [{ apiKey: 'nested-secret' }] }) }),
      h('button', { onClick: draft.close }, '关闭'),
      h('button', { onClick: () => draft.setEdit(null) }, '保存完成')));
}

describe('draft protection', () => {
  it('warns before discarding edits and restores a sanitized draft after remount', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = render(h(DraftEditor));
    fireEvent.click(screen.getByText('打开'));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Draft' } });
    fireEvent.click(screen.getByText('关闭'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('名称')).toBeTruthy();
    const saved = sessionStorage.getItem('edit-draft:undefined:test')!;
    expect(saved).not.toContain('secret');
    view.unmount(); render(h(DraftEditor)); fireEvent.click(screen.getByText('恢复'));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Draft');
    fireEvent.click(screen.getByText('保存完成'));
    expect(sessionStorage.getItem('edit-draft:undefined:test')).toBeNull();
  });
});

describe('large admin collections', () => {
  it('bounds DOM rows for 2,000 items and shows later rows on scroll', () => {
    const items = Array.from({ length: 2000 }, (_, id) => ({ id, name: `Model ${id}` }));
    render(h(AdminCollection<any>, { name: 'large', items, id: row => String(row.id), columns: [{ title: '名称', sort: row => row.id, render: row => row.name }], children: rows => h('div', null, rows.map(row => h('p', { key: row.id }, row.name))) }));
    expect(screen.getAllByRole('row').length).toBeLessThan(22);
    fireEvent.scroll(screen.getByRole('table').parentElement!, { target: { scrollTop: 64000 } });
    expect(screen.getByText('Model 1000')).toBeTruthy();
    fireEvent.click(screen.getByText('卡片'));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Model 23')).toBeTruthy();
    expect(screen.queryByText('Model 24')).toBeNull();
    fireEvent.click(screen.getByText('下一页'));
    expect(screen.getByText('Model 24')).toBeTruthy();
  });
});

describe('batch changes', () => {
  it('creates independent prices for unconfigured models and invalidates stale previews', async () => {
    vi.mocked(adminApi.createPricing).mockResolvedValue({} as any);
    render(h(AdminBatch, { kind: 'pricing', items: [{ id: null, modelPattern: 'demo', displayName: 'Demo', configured: false, category: 'video' }], onDone: vi.fn() }));
    fireEvent.change(screen.getByLabelText('批量价格操作'), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByLabelText('批量单价'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('预览批量调价'));
    expect(screen.getByText('确认执行')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('批量单价'), { target: { value: '3' } });
    expect(screen.queryByText('确认执行')).toBeNull();
    fireEvent.click(screen.getByText('预览批量调价'));
    fireEvent.click(screen.getByText('确认执行'));
    await waitFor(() => expect(screen.getByText('成功 1 条，失败 0 条')).toBeTruthy());
    expect(adminApi.createPricing).toHaveBeenCalledWith(expect.objectContaining({ modelPattern: 'demo', inputPrice: 3, billingType: 'per_call' }));
  });
  it('preserves units and scales resolution prices with input/output prices', () => {
    expect(scalePricing({ modelPattern: 'video', billingType: 'per_second', inputPrice: 2, outputPrice: 4, extraParams: { category: 'video', '720p': 6 } }, 50)).toMatchObject({ inputPrice: 3, outputPrice: 6, billingType: 'per_second', extraParams: { category: 'video', '720p': 9 } });
    expect(() => scalePricing({}, -101)).toThrow();
  });
  it('requires a preview confirmation and reports partial failures accurately', async () => {
    vi.mocked(adminApi.updateModel).mockResolvedValueOnce({}).mockRejectedValueOnce(Error('permission denied'));
    render(h(AdminBatch, { kind: 'models', items: [{ id: 1, displayName: 'One', isActive: 1 }, { id: 2, displayName: 'Two', isActive: 1 }], onDone: vi.fn() }));
    fireEvent.click(screen.getByText('批量停用'));
    expect(adminApi.updateModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认执行'));
    await waitFor(() => expect(screen.getByText('成功 1 条，失败 1 条')).toBeTruthy());
    expect(screen.getByText('Two：permission denied')).toBeTruthy();
  });
});

describe('shared polling', () => {
  it('does not overlap requests, aborts on dispose, and pauses while hidden', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let finish!: () => void;
    let signal!: AbortSignal;
    const task = vi.fn((value: AbortSignal) => { signal = value; return new Promise<void>(resolve => { finish = resolve; }); });
    const stop = startPolling(task, 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(0);
    visibility.mockReturnValue('hidden'); await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledOnce();
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(task).toHaveBeenCalledTimes(2);
    stop(); expect(signal.aborted).toBe(true); finish();
  });
  it('backs off after a failed request', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const task = vi.fn().mockRejectedValue(Error('offline'));
    const stop = startPolling(task, 100);
    await vi.advanceTimersByTimeAsync(100); expect(task).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(399); expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});
