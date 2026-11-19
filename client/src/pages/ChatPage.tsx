import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, MessageCircle, Plus, Trash2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { chatApi, streamChatTurn } from '../api/chat';
import { useAuthStore } from '../stores/authStore';
import type { ChatConversation, ChatModel, ChatTurn } from '../../../shared/websiteChat';

const button = 'rounded-lg px-3 py-2 text-sm text-[var(--earth-ink)] hover:bg-[var(--earth-primary-soft)] disabled:cursor-not-allowed disabled:opacity-40';

export default function ChatPage() {
  const { user, isAuthenticated, isLoading, openLoginModal } = useAuthStore();
  if (isLoading) return <p className="p-8 text-[var(--earth-muted)]" role="status">正在载入对话…</p>;
  if (!isAuthenticated || !user) return (
    <section className="mx-auto max-w-xl p-8 text-center">
      <h1 className="mb-5 text-2xl font-semibold">大模型对话</h1>
      <button type="button" className="rounded-lg bg-[var(--earth-primary)] px-4 py-2 font-medium text-[var(--earth-surface-raised)]" onClick={openLoginModal}>登录后开始对话</button>
    </section>
  );
  return <ChatWorkspace key={user.id} />;
}

function ChatWorkspace() {
  const [params, setParams] = useSearchParams();
  const activeId = params.get('conversation');
  const [models, setModels] = useState<ChatModel[] | null>(null);
  const [history, setHistory] = useState<ChatConversation[]>([]);
  const [view, setView] = useState<{ id: string; turns: ChatTurn[] }>();
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [recovering, setRecovering] = useState<string>();
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const turns = activeId && activeId === view?.id ? view.turns : [];
  const running = turns.some(turn => turn.status === 'running');

  useEffect(() => {
    const controller = new AbortController();
    const report = (failure: Error) => { if (!controller.signal.aborted) setError(failure.message); };
    void chatApi.models(controller.signal).then(list => {
      if (controller.signal.aborted) return;
      setModels(list);
      setModel(current => list.some(item => item.id === current) ? current : list[0]?.id || '');
    }).catch(report);
    void chatApi.conversations(controller.signal).then(list => {
      if (!controller.signal.aborted) setHistory(list);
    }).catch(report);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!activeId || sending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const list = await chatApi.turns(activeId, controller.signal);
        if (controller.signal.aborted) return;
        setView({ id: activeId, turns: list });
        if (list.some(turn => turn.status === 'running')) timer = setTimeout(refresh, 1500);
        else if (recovering === activeId) {
          setRecovering(undefined);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          if ((failure as { status?: number }).status === 404) {
            setRecovering(undefined);
            setView(undefined);
            setError('未找到这段对话，可以从历史记录切换或开启新对话。');
          } else {
            setError((failure as Error).message);
            timer = setTimeout(refresh, 4000);
          }
        }
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeId, sending, reload, recovering]);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const box = transcript.current;
    if (follow.current && box) box.scrollTop = box.scrollHeight;
  }, [view]);

  function open(id?: string) {
    setError('');
    setRecovering(undefined);
    setInput('');
    follow.current = true;
    setParams(id ? { conversation: id } : {});
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = input.trim();
    if (!question || !model || running || request.current || deleting || (activeId && activeId !== view?.id)) return;

    const id = activeId || crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    request.current = controller;
    setSending(true);
    setError('');
    setInput('');
    follow.current = true;
    const optimistic: ChatTurn = { id: requestId, model, question, answer: '', status: 'running', error: null };
    setView({ id, turns: [...turns, optimistic] });
    if (!activeId) setParams({ conversation: id });

    const update = (change: (turn: ChatTurn) => ChatTurn) => setView(current => current?.id === id
      ? { id, turns: current.turns.map(turn => turn.id === requestId ? change(turn) : turn) } : current);
    try {
      const turn = await streamChatTurn(id, { requestId, model, question, create: !activeId },
        delta => update(current => ({ ...current, answer: current.answer + delta })), controller.signal);
      update(() => turn);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        setView({ id, turns });
        if (!activeId) setParams({}, { replace: true });
        setInput(question);
        setError((failure as Error).message);
      } else {
        setRecovering(id);
        setError('回复连接已中断，正在从历史记录核对原请求。');
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) {
        setSending(false);
        setReload(value => value + 1);
        void useAuthStore.getState().checkAuth();
      }
    }
  }

  async function remove() {
    if (!activeId || !window.confirm('删除这段对话及其消息？')) return;
    setDeleting(true);
    try {
      await chatApi.remove(activeId);
      setHistory(current => current.filter(item => item.id !== activeId));
      open();
    } catch (failure) { setError((failure as Error).message); }
    finally { setDeleting(false); }
  }

  return (
    <section className="mx-auto grid w-full max-w-[1400px] gap-4 px-3 py-4 md:grid-cols-[220px_minmax(0,1fr)] md:px-6">
      <aside className="min-w-0 rounded-2xl border border-[var(--earth-line)] bg-[var(--earth-surface)] p-3" aria-label="对话历史">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="pl-2 text-sm font-medium text-[var(--earth-muted)]">对话历史</h2>
          <button type="button" className={button} disabled={sending || deleting} onClick={() => open()}><Plus className="mr-1 inline size-4" />新对话</button>
        </div>
        <div className="flex max-h-40 gap-1 overflow-auto md:max-h-[65vh] md:flex-col">
          {history.map(item => <button key={item.id} type="button" title={item.title} aria-current={activeId === item.id ? 'true' : undefined}
            className={button + ' max-w-52 shrink-0 truncate text-left aria-[current=true]:bg-[var(--earth-primary-soft)] aria-[current=true]:text-[var(--earth-primary)]'}
            disabled={sending || deleting} onClick={() => open(item.id)}>{item.title}</button>)}
          {!history.length && <p className="px-2 py-2 text-xs text-[var(--earth-muted)]">暂无历史对话</p>}
        </div>
      </aside>

      <div className="flex min-h-[62dvh] min-w-0 flex-col rounded-2xl border border-[var(--earth-line)] bg-[var(--earth-surface-raised)] md:h-[calc(100dvh-3rem)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--earth-line)] px-4 py-4 md:px-6">
          <h1 className="text-lg font-semibold text-[var(--earth-ink)]">大模型对话</h1>
          <div className="flex min-w-0 items-center gap-2">
            <select aria-label="对话模型" className="max-w-56 rounded-lg border border-[var(--earth-line-strong)] bg-[var(--earth-surface-raised)] px-2 py-2 text-sm text-[var(--earth-ink)]"
              value={model} disabled={!models?.length || sending || deleting} onChange={event => setModel(event.target.value)}>
              {!models?.length && <option value="">{models ? '暂无可用模型' : '正在加载模型…'}</option>}
              {models?.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
            {activeId && <button type="button" className={button} aria-label="删除当前对话" disabled={sending || running || deleting || activeId !== view?.id} onClick={remove}><Trash2 className="size-4" /></button>}
          </div>
        </header>

        <div ref={transcript} className="max-h-[58dvh] min-h-60 flex-1 space-y-5 overflow-y-auto px-4 py-5 md:max-h-none md:px-8" aria-label="对话消息"
          onScroll={() => { const box = transcript.current; if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 72; }}>
          {!turns.length && <div className="grid justify-items-center gap-3 py-12 text-[var(--earth-muted)]">
            <MessageCircle aria-hidden="true" className="size-8 text-[var(--earth-primary)]" />
            <p>{activeId && activeId !== view?.id ? '正在读取对话…' : '输入消息，开始对话'}</p>
          </div>}
          {turns.map(turn => <article key={turn.id} className="mx-auto max-w-3xl space-y-4">
            <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--earth-primary-soft)] px-4 py-3 text-[var(--earth-ink)]">{turn.question}</p>
            <div className="space-y-2 rounded-2xl border border-[var(--earth-line)] bg-[var(--earth-surface)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--earth-primary)]">{turn.model}</p>
              {turn.answer && <p className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--earth-ink)]">{turn.answer}</p>}
              {turn.status === 'running' && <p role="status" className="text-xs text-[var(--earth-muted)]">正在回复…</p>}
              {turn.error && <p className="text-sm text-[var(--earth-primary)]" role="status">{turn.status === 'review' ? '待核实 · ' : ''}{turn.error}</p>}
            </div>
          </article>)}
        </div>

        <form onSubmit={send} className="border-t border-[var(--earth-line)] px-4 py-3 md:px-6">
          {error && <p role="alert" className="mb-2 text-sm text-[var(--earth-danger)]">{error} <button type="button" className="underline" onClick={() => { setError(''); setReload(value => value + 1); }}>刷新</button></p>}
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-[var(--earth-line-strong)] bg-[var(--earth-surface-raised)] p-2 focus-within:border-[var(--earth-focus)]">
            <textarea aria-label="消息" placeholder="输入消息" className="min-w-0 flex-1 resize-y bg-transparent px-2 py-2 text-sm text-[var(--earth-ink)] outline-none"
              rows={2} maxLength={16_000} value={input} onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }} />
            <button type="submit" aria-label="发送消息" className="rounded-lg bg-[var(--earth-primary)] p-2.5 text-[var(--earth-surface-raised)] disabled:opacity-35"
              disabled={!model || !input.trim() || running || sending || deleting || Boolean(activeId && activeId !== view?.id)}><ArrowUp className="size-5" /></button>
          </div>
          <p className="mx-auto mt-2 max-w-3xl text-xs text-[var(--earth-muted)]">按 Token 用量从账户余额计费 · Shift + Enter 换行</p>
        </form>
      </div>
    </section>
  );
}
