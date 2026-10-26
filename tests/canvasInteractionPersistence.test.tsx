// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CanvasPage from '../client/src/pages/CanvasPage';
import { newDocument, newNode, type Workspace } from '../client/src/canvas/model';
import { loadWorkspace, saveWorkspace } from '../client/src/canvas/storage';
import { useAuthStore } from '../client/src/stores/authStore';

vi.mock('../client/src/canvas/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn().mockResolvedValue(undefined) }));
let workspace: Workspace;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId = 1; });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  HTMLElement.prototype.setPointerCapture = vi.fn();
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
  const doc = {...newDocument(),nodes:[newNode('text',{x:0,y:0})],view:{x:0,y:0,zoom:1}};
  workspace = {version:2,activeId:doc.id,projects:[doc],cloudPending:false};
  vi.mocked(loadWorkspace).mockResolvedValue(workspace);
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function openWithPendingPan() {
  const mounted = render(<MemoryRouter><CanvasPage /></MemoryRouter>);
  await act(async () => {});
  const stage = screen.getByLabelText('无限画布编辑区');
  fireEvent.pointerDown(stage,{button:1,clientX:10,clientY:10});
  fireEvent.pointerMove(stage,{clientX:110,clientY:60});
  expect(saveWorkspace).not.toHaveBeenCalled();
  return mounted;
}

it.each(['pagehide','beforeunload','unmount'])('persists the pending final viewport on %s before a debounce can run', async finish => {
  const mounted = await openWithPendingPan();
  await act(async () => {
    if(finish === 'unmount') mounted.unmount();
    else window.dispatchEvent(new Event(finish,{cancelable:true}));
  });
  expect(saveWorkspace).toHaveBeenCalled();
  const saved = vi.mocked(saveWorkspace).mock.calls.at(-1)!;
  expect(saved[0]).toBe('guest');
  expect(saved[1].projects[0].view).toEqual({x:100,y:50,zoom:1});
});

it('keeps a pending viewport in its original project when switching and editing another project', async () => {
  workspace.projects[0].title = '画布一';
  const second = {...newDocument('画布二'),nodes:[newNode('text',{x:0,y:0},'第二份')],view:{x:0,y:0,zoom:1}};
  workspace.projects.push(second);
  await openWithPendingPan();
  fireEvent.click(screen.getByRole('button',{name:/灵序 AI.*画布一/}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'画布项目'})).getByRole('button',{name:/画布二/}));
  fireEvent.change(screen.getByLabelText('卡片文字'),{target:{value:'第二份已修改'}});
  await act(async () => {await vi.advanceTimersByTimeAsync(600);});
  const saved = vi.mocked(saveWorkspace).mock.calls.at(-1)![1];
  expect(saved.activeId).toBe(second.id);
  expect(saved.projects[0].view).toEqual({x:100,y:50,zoom:1});
  expect(saved.projects[1]).toMatchObject({view:{x:0,y:0,zoom:1},nodes:[{text:'第二份已修改'}]});
});
