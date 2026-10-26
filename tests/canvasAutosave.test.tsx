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
vi.mock('../client/src/canvas/CanvasStudio', () => ({ default: ({ initial, status, onChange, onSync }: any) => <div><output>{status}</output><button onClick={() => onChange({ ...initial, nodes: initial.nodes.map((n: any) => ({ ...n, text: n.text + '改' })) })}>编辑</button><button onClick={onSync}>重试保存</button></div> }));
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
  it('lets a guest retry a failed local save without cloud requests', async () => {
    useAuthStore.setState({user:null});
    await act(async () => {render(<CanvasPage/>);});
    vi.mocked(saveWorkspace).mockRejectedValueOnce(new Error('磁盘暂时不可用'));
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    expect(screen.getByText('保存失败 · 请导出备份')).toBeTruthy();
    await act(async () => {fireEvent.click(screen.getByRole('button',{name:'重试保存'}));});
    expect(screen.getByText('已保存到此浏览器')).toBeTruthy();
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)![1].projects[0].nodes[0].text).toBe('原文改');
    expect(saveCloudWorkspace).not.toHaveBeenCalled();
  });
  it('reports a failed local acknowledgement honestly and retries it without resubmitting an already saved cloud version', async () => {
    vi.mocked(saveCloudWorkspace).mockResolvedValue({revision:2});
    await act(async () => {render(<CanvasPage/>);});
    vi.mocked(saveWorkspace).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('存储空间不足'));
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    expect(screen.queryByText(/本地已保存/)).toBeNull();
    expect(screen.getByText(/本地保存失败/)).toBeTruthy();
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {fireEvent.click(screen.getByRole('button',{name:'重试保存'}));});
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(1);
    const saved=vi.mocked(saveWorkspace).mock.calls.at(-1)![1];
    expect(saved).toMatchObject({cloudRevision:2,cloudPending:false});
    expect(saved.projects[0].nodes[0].text).toBe('原文改');
    expect(screen.getByText('已同步到账户')).toBeTruthy();
  });
  it('still uploads newer pending edits when retrying a failed local acknowledgement', async () => {
    vi.mocked(saveCloudWorkspace).mockResolvedValueOnce({revision:2}).mockResolvedValueOnce({revision:3});
    await act(async () => {render(<CanvasPage/>);});
    let fail!: (error: Error) => void;
    vi.mocked(saveWorkspace).mockResolvedValueOnce(undefined).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {fail(new Error('本地写入失败'));});
    expect(screen.getByText(/本地保存失败/)).toBeTruthy();
    await act(async () => {fireEvent.click(screen.getByRole('button',{name:'重试保存'}));});
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveCloudWorkspace).mock.calls[1][0]).toMatchObject({cloudRevision:2,cloudPending:true});
    expect(vi.mocked(saveCloudWorkspace).mock.calls[1][0].projects[0].nodes[0].text).toBe('原文改改');
    expect(screen.getByText('已同步到账户')).toBeTruthy();
  });
  it('cancels the in-flight cloud sync when the workspace unmounts', async () => {
    vi.mocked(saveCloudWorkspace).mockImplementation(() => new Promise(()=>{}));
    let mounted!: ReturnType<typeof render>;
    await act(async () => {mounted=render(<CanvasPage/>);});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    const signal=vi.mocked(saveCloudWorkspace).mock.calls[0][1]!;
    expect(signal.aborted).toBe(false);
    mounted.unmount();
    expect(signal.aborted).toBe(true);
    await act(async()=>{});
  });
  it('settles the saved indicator when edits arrived during the first local write but were included in cloud saving', async () => {
    vi.mocked(saveCloudWorkspace).mockResolvedValue({revision:2});
    await act(async () => {render(<CanvasPage/>);});
    let releaseLocal!: () => void;
    vi.mocked(saveWorkspace).mockImplementationOnce(() => new Promise(resolve => {releaseLocal=resolve;}));
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {releaseLocal();});
    expect(screen.getByText('已同步到账户')).toBeTruthy();
    await act(async () => {await vi.advanceTimersByTimeAsync(6000);});
    expect(screen.getByText('已同步到账户')).toBeTruthy();
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)![1].projects[0].nodes[0].text).toBe('原文改改');
  });
  it('writes a local checkpoint during uninterrupted editing instead of waiting forever for a pause', async () => {
    useAuthStore.setState({user:null});
    await act(async () => { render(<CanvasPage/>); });
    for(let i=0;i<20;i++) {
      fireEvent.click(screen.getByRole('button',{name:'编辑'}));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    }
    expect(saveWorkspace).toHaveBeenCalled();
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)![1].projects[0].nodes[0].text.length).toBeGreaterThan(12);
  });

  it('retains uploaded media URLs when newer edits arrive during cloud upload', async () => {
    const src='data:image/png;base64,YWJj';
    workspace.projects[0].nodes[0]={...newNode('image',{x:0,y:0},'原文'),src,versions:[{id:'v1',src,prompt:'旧提示词',createdAt:0}]};
    let release!: (value: any) => void;
    vi.mocked(saveCloudWorkspace).mockImplementationOnce(() => new Promise(resolve => {release=resolve;})).mockResolvedValueOnce({revision:3});
    await act(async () => {render(<CanvasPage/>);});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    const sent=structuredClone(vi.mocked(saveCloudWorkspace).mock.calls[0][0]);
    sent.projects[0].nodes[0].src='/api/media/durable';
    sent.projects[0].nodes[0].versions![0].src='/api/media/durable';
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {release({revision:2,workspace:sent});});
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    const next=vi.mocked(saveCloudWorkspace).mock.calls[1][0];
    expect(next.projects[0].nodes[0]).toMatchObject({text:'原文改改',src:'/api/media/durable',versions:[{src:'/api/media/durable'}]});
    expect(next.cloudRevision).toBe(2);
  });

  it('schedules newer edits arriving while the cloud acknowledgement is being saved locally', async () => {
    let releaseCloud!: (value: any) => void;
    vi.mocked(saveCloudWorkspace).mockImplementationOnce(() => new Promise(resolve => {releaseCloud=resolve;})).mockResolvedValueOnce({revision:3});
    await act(async () => {render(<CanvasPage/>);});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    let releaseLocal!: () => void;
    vi.mocked(saveWorkspace).mockImplementationOnce(() => new Promise(resolve => {releaseLocal=resolve;}));
    await act(async () => {releaseCloud({revision:2});});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    await act(async () => {releaseLocal();});
    expect(screen.queryByText('已同步到账户')).toBeNull();
    await act(async () => {await vi.advanceTimersByTimeAsync(600);});
    expect(saveCloudWorkspace).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveCloudWorkspace).mock.calls[1][0].projects[0].nodes[0].text).toBe('原文改改');
    expect(screen.getByText('已同步到账户')).toBeTruthy();
  });
  it('finishes local saving without starting a new cloud request after leaving the page', async () => {
    const mounted = render(<CanvasPage />);
    await act(async () => {});
    let release!: () => void;
    vi.mocked(saveWorkspace).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    mounted.unmount();
    await act(async () => { release(); });
    expect(saveCloudWorkspace).not.toHaveBeenCalled();
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)![1].projects[0].nodes[0].text).toBe('原文改');
  });
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
