// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { newDocument, newNode, type Workspace } from '../client/src/canvas/model';
import { useAuthStore } from '../client/src/stores/authStore';
import { loadWorkspace, saveWorkspace } from '../client/src/canvas/storage';
import { fetchCloudWorkspace, saveCloudWorkspace } from '../client/src/canvas/sync';
import CanvasPage from '../client/src/pages/CanvasPage';

vi.mock('../client/src/canvas/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../client/src/canvas/sync', async original => ({ ...await original<any>(), fetchCloudWorkspace: vi.fn(), saveCloudWorkspace: vi.fn() }));
vi.mock('../client/src/canvas/CanvasStudio', () => ({ default: ({ initial, status, onChange }: any) => <div><output>{status}</output><button onClick={() => onChange({ ...initial, nodes: initial.nodes.map((n: any) => ({ ...n, text: n.text + '改' })) })}>编辑</button></div> }));
let workspace: Workspace;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  useAuthStore.setState({ user: { id: 1 } as any, isLoading: false });
  const doc = newDocument(); doc.nodes = [newNode('text', { x: 0, y: 0 }, '原文')];
  workspace = { version: 2, activeId: doc.id, projects: [doc], cloudRevision: 1, cloudPending: false };
  vi.mocked(loadWorkspace).mockResolvedValue(workspace);
  vi.mocked(fetchCloudWorkspace).mockResolvedValue({ revision: 1, workspace });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
describe('canvas autosave under concurrent edits', () => {
  it('saves newer edits after an in-flight cloud write using the returned revision', async () => {
    let release!: (value: { revision: number }) => void;
    vi.mocked(saveCloudWorkspace).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ revision: 3 });
    await act(async () => { render(<CanvasPage />); });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => { release({ revision: 2 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(vi.mocked(saveCloudWorkspace).mock.calls[1][0].cloudRevision).toBe(2);
    expect(vi.mocked(saveCloudWorkspace).mock.calls[1][0].projects[0].nodes[0].text).toBe('原文改改');
    expect(screen.getByText('已同步到账户')).toBeTruthy();
  });
  it('retains local pending edits when cloud saving fails', async () => {
    vi.mocked(saveCloudWorkspace).mockRejectedValue(new Error('网络暂不可用'));
    await act(async () => { render(<CanvasPage />); });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText('本地已保存 · 网络暂不可用')).toBeTruthy();
    const saved = vi.mocked(saveWorkspace).mock.calls.at(-1)![1];
    expect(saved.projects[0].nodes[0].text).toBe('原文改'); expect(saved.cloudPending).toBe(true);
  });
});
