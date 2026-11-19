import { api } from './client';
import { getAuthSession, invalidateAuthSession } from './authSession';
import type { ChatConversation, ChatEvent, ChatModel, ChatTurn } from '../../../shared/websiteChat';

export const chatApi = {
  models: (signal?: AbortSignal) => api.get<ChatModel[]>('/chat/models', { signal }),
  conversations: (signal?: AbortSignal) => api.get<ChatConversation[]>('/chat/conversations', { signal }),
  turns: (id: string, signal?: AbortSignal) => api.get<ChatTurn[]>('/chat/conversations/' + encodeURIComponent(id), { signal }),
  remove: (id: string) => api.delete('/chat/conversations/' + encodeURIComponent(id)),
};

export async function streamChatTurn(
  id: string,
  input: { requestId: string; model: string; question: string; create: boolean; files?: File[] },
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<ChatTurn> {
  const session = getAuthSession();
  const { files, ...fields } = input;
  const headers: Record<string, string> = { Authorization: 'Bearer ' + session.token };
  let body: string | FormData;
  if (files?.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    for (const file of files) form.append('attachments', file);
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(fields);
  }
  const response = await fetch('/api/chat/conversations/' + encodeURIComponent(id) + '/turns', {
    method: 'POST',
    headers, body, signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401) invalidateAuthSession(session);
    throw Object.assign(new Error(body?.error || '发送失败（HTTP ' + response.status + '）'), { status: response.status });
  }
  if (response.headers.get('content-type')?.includes('application/json')) return response.json();
  if (!response.body) throw new Error('未收到回复流');

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let turn: ChatTurn | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      const frames = pending.split('\n\n');
      pending = frames.pop()!;
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6)) as ChatEvent;
        if ('turn' in event) turn = event.turn;
        else onDelta(event.delta);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!turn) throw new Error('回复连接已断开');
  return turn;
}
