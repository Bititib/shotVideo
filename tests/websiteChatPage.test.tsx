// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChatPage from '../client/src/pages/ChatPage';
import { useAuthStore } from '../client/src/stores/authStore';
import type { ChatTurn } from '../shared/websiteChat';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('opens the login modal from the chat page', () => {
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, showLoginModal: false });
  render(<MemoryRouter><ChatPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '登录后开始对话' }));
  expect(useAuthStore.getState().showLoginModal).toBe(true);
});

it('renders streamed text before the turn completes and reopens saved history', async () => {
  localStorage.setItem('token', 'test-session');
  const profile = { id: 1, username: 'test' } as NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
  useAuthStore.setState({ user: profile, isAuthenticated: true, isLoading: false });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let history: Array<{ id: string; title: string; updatedAt: number }> = [];
  let turns: ChatTurn[] = [];
  let payload!: Pick<ChatTurn, 'question' | 'model'> & { requestId: string };
  let id = '';
  const requests = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/chat/models') return Response.json([{ id: 'test-model', name: 'test-model' }]);
    if (path === '/api/chat/conversations') return Response.json(history);
    if (path === '/api/auth/profile') return Response.json(profile);
    if (options?.method === 'POST') {
      id = path.split('/').at(-2)!;
      payload = JSON.parse(String(options.body));
      const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json(turns);
  });
  vi.stubGlobal('fetch', requests);
  render(<MemoryRouter><ChatPage /></MemoryRouter>);
  await screen.findByRole('option', { name: 'test-model' });
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '你好' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(payload).toMatchObject({ model: 'test-model', question: '你好', create: true });

  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode('data: {"delta":"你好，"}\n\n'));
  await screen.findByText('你好，');
  expect(screen.getByText('正在回复…')).toBeTruthy();

  history = [{ id, title: '你好', updatedAt: 1 }];
  turns = [{ id: payload.requestId, model: payload.model, question: payload.question, answer: '你好，很高兴见到你。', status: 'complete', error: null }];
  controller.enqueue(encoder.encode('data: ' + JSON.stringify({ turn: turns[0] }) + '\n\n'));
  controller.close();
  await screen.findByText(turns[0].answer);
  const saved = await screen.findByRole('button', { name: '你好' });
  fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  expect(screen.queryByText(turns[0].answer)).toBeNull();
  fireEvent.click(saved);
  await screen.findByText(turns[0].answer);
  expect(requests.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it('queues an attachment and sends it without requiring a text prompt', async () => {
  localStorage.setItem('token', 'test-session');
  const profile = { id: 1, username: 'test' } as NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
  useAuthStore.setState({ user: profile, isAuthenticated: true, isLoading: false });
  let uploaded: FormData | undefined;
  const requests = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/chat/models') return Response.json([{ id: 'test-model', name: 'test-model' }]);
    if (path === '/api/auth/me') return Response.json(profile);
    if (options?.method === 'POST') {
      uploaded = options.body as FormData;
      return Response.json({ id: uploaded.get('requestId'), model: 'test-model', question: '', answer: '已读',
        status: 'complete', error: null, attachments: [{ name: 'notes.pdf', kind: 'document' }] });
    }
    return Response.json([]);
  });
  vi.stubGlobal('fetch', requests);
  const { container } = render(<MemoryRouter><ChatPage /></MemoryRouter>);
  await screen.findByRole('option', { name: 'test-model' });
  expect(screen.getByRole('button', { name: '添加图片或文档' })).toBeTruthy();
  const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
  fireEvent.change(picker, { target: { files: [new File(['image'], 'draft.png', { type: 'image/png' })] } });
  expect(screen.getByText('请选择支持看图的模型')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '移除 draft.png' }));
  fireEvent.change(picker, { target: { files: [new File(['document'], 'notes.pdf', { type: 'application/pdf' })] } });
  expect(screen.getByText('notes.pdf')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(uploaded?.get('question')).toBe('');
  expect((uploaded?.get('attachments') as File).name).toBe('notes.pdf');
});
