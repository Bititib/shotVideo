import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ArrowUp, ChevronDown, FileText, Image as ImageIcon, MessageCircle, Plus, Trash2, Upload, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { chatApi, streamChatTurn } from '../api/chat';
import { useAuthStore } from '../stores/authStore';
import { chatAttachmentAccept, chatAttachmentLimit, chatAttachmentMaxBytes, chatImageExtension, type ChatAttachment, type ChatConversation, type ChatModel, type ChatTurn } from '../../../shared/websiteChat';
import './ChatPage.css';

const button = 'rounded-lg px-3 py-2 text-sm text-[var(--earth-ink)] hover:bg-[var(--earth-primary-soft)] disabled:cursor-not-allowed disabled:opacity-40';
const describeAttachment = (file: File): ChatAttachment => ({ name: file.name, kind: chatImageExtension.test(file.name) ? 'image' : 'document' });
const hasDraggedFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

function ReplyText({ answer, animate, running, onReveal }: {
  answer: string;
  animate: boolean;
  running: boolean;
  onReveal: () => void;
}) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    if (!animate) return;
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const change = () => setReducedMotion(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [animate]);

  const type = animate && !reducedMotion;
  const characters = useMemo(() => type ? Array.from(answer) : [], [type, answer]);
  const [revealed, setRevealed] = useState(0);
  const available = useRef(0);
  useLayoutEffect(() => { available.current = characters.length; }, [characters.length]);

  const pending = type && revealed < characters.length;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      setRevealed(current => Math.min(available.current, current + Math.max(1, Math.ceil((available.current - current) / 32))));
    }, 24);
    return () => window.clearTimeout(timer);
  }, [pending, revealed]);

  const text = type ? characters.slice(0, revealed).join('') : answer;
  useLayoutEffect(() => { if (type) onReveal(); }, [type, text, onReveal]);
  const showCursor = type && Boolean(text) && (pending || running);
  return <>
    {text && <p className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--earth-ink)]">
      {text}{showCursor && <span className="chat-reply-cursor" aria-hidden="true" />}
    </p>}
    {running && <p role="status" className={text ? 'sr-only' : 'text-xs text-[var(--earth-muted)]'}>正在回复…</p>}
  </>;
}

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
  const [files, setFiles] = useState<File[]>([]);
  const filePicker = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [sending, setSending] = useState(false);
  const [typingTurnId, setTypingTurnId] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [recovering, setRecovering] = useState<string>();
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const turns = activeId && activeId === view?.id ? view.turns : [];
  const running = turns.some(turn => turn.status === 'running');
  const attachmentPickerDisabled = sending || deleting || files.length >= chatAttachmentLimit;
  const hasImages = files.some(file => chatImageExtension.test(file.name)) || turns.some(turn =>
    turn.status === 'complete' && turn.attachments?.some(item => item.kind === 'image'));
  const modelCannotSeeImages = hasImages && !models?.find(item => item.id === model)?.imageInput;

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
  const scrollToLatest = useCallback(() => {
    const box = transcript.current;
    if (follow.current && box) box.scrollTop = box.scrollHeight;
  }, []);
  useEffect(() => { scrollToLatest(); }, [view, scrollToLatest]);

  function open(id?: string) {
    setError('');
    setRecovering(undefined);
    setTypingTurnId(undefined);
    setInput('');
    setFiles([]);
    follow.current = true;
    setParams(id ? { conversation: id } : {});
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = input.trim();
    if ((!question && !files.length) || !model || modelCannotSeeImages || running || request.current || deleting || (activeId && activeId !== view?.id)) return;

    const id = activeId || crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    request.current = controller;
    setSending(true);
    setTypingTurnId(requestId);
    setError('');
    setInput('');
    setFiles([]);
    follow.current = true;
    const optimistic: ChatTurn = { id: requestId, model, question, answer: '', status: 'running', error: null, attachments: files.map(describeAttachment) };
    setView({ id, turns: [...turns, optimistic] });
    if (!activeId) setParams({ conversation: id });

    const update = (change: (turn: ChatTurn) => ChatTurn) => setView(current => current?.id === id
      ? { id, turns: current.turns.map(turn => turn.id === requestId ? change(turn) : turn) } : current);
    try {
      const turn = await streamChatTurn(id, { requestId, model, question, create: !activeId, files },
        delta => update(current => ({ ...current, answer: current.answer + delta })), controller.signal);
      update(() => turn);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        setView({ id, turns });
        if (!activeId) setParams({}, { replace: true });
        setInput(question);
        setFiles(files);
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

  function addFiles(selected: File[]) {
    if (!selected.length) return;
    const next = [...files, ...selected];
    if (next.length > chatAttachmentLimit) return setError('每轮最多添加 3 个附件');
    const invalid = selected.find(file => !file.size || file.size > chatAttachmentMaxBytes ||
      !chatAttachmentAccept.split(',').includes('.' + file.name.split('.').at(-1)?.toLowerCase()));
    if (invalid) return setError(`${invalid.name} · 支持 4 MB 以内的 PNG、JPEG、WebP、PDF 和 Word .docx`);
    setFiles(next);
    setError('');
  }

  function enterFileDropArea(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (!attachmentPickerDisabled) setDraggingFiles(true);
  }

  function leaveFileDropArea() {
    if (dragDepth.current && --dragDepth.current === 0) setDraggingFiles(false);
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event) && !event.dataTransfer.files.length) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!sending && !deleting) addFiles(Array.from(event.dataTransfer.files));
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
    <section className="chat-workspace">
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

      <div role="region" aria-label="聊天区" className="chat-panel relative flex min-w-0 flex-col rounded-2xl border border-[var(--earth-line)] bg-[var(--earth-surface-raised)]"
        onDragEnter={enterFileDropArea} onDragLeave={leaveFileDropArea} onDrop={dropFiles} onDragOver={event => {
          if (!hasDraggedFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = attachmentPickerDisabled ? 'none' : 'copy';
        }}>
        {draggingFiles && !attachmentPickerDisabled && <div className="chat-file-drop-overlay" role="status">
          <Upload aria-hidden="true" className="size-6" /> 松开鼠标添加附件
        </div>}
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--earth-line)] px-4 py-1 md:px-5">
          <h1 className="text-lg font-semibold text-[var(--earth-ink)]">大模型对话</h1>
          {activeId && <button type="button" className={button} aria-label="删除当前对话" disabled={sending || running || deleting || activeId !== view?.id} onClick={remove}><Trash2 className="size-4" /></button>}
        </header>

        <div ref={transcript} className="chat-transcript" aria-label="对话消息"
          onScroll={() => { const box = transcript.current; if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 72; }}>
          <div className="chat-transcript-inner">
            {!turns.length && <div className="chat-empty text-[var(--earth-muted)]">
              <MessageCircle aria-hidden="true" className="size-8 text-[var(--earth-primary)]" />
              <p>{activeId && activeId !== view?.id ? '正在读取对话…' : '输入消息，开始对话'}</p>
            </div>}
            {turns.map(turn => <article key={turn.id} className="min-w-0 space-y-3">
              <div className="ml-auto w-fit max-w-[90%] rounded-2xl bg-[var(--earth-primary-soft)] px-4 py-3 text-[var(--earth-ink)]">
                {turn.attachments?.length ? <ul className="chat-attachment-list">{turn.attachments.map((item, index) => (
                  <li key={index} className="chat-attachment-chip" title={item.name}>{item.kind === 'image' ? <ImageIcon /> : <FileText />}<span>{item.name}</span></li>
                ))}</ul> : null}
                {turn.question && <p className="whitespace-pre-wrap break-words">{turn.question}</p>}
              </div>
              <div className="space-y-2 rounded-2xl border border-[var(--earth-line)] bg-[var(--earth-surface)] px-4 py-3">
                <p className="text-xs font-medium text-[var(--earth-primary)]">{turn.model}</p>
                <ReplyText answer={turn.answer} running={turn.status === 'running'} animate={turn.id === typingTurnId} onReveal={scrollToLatest} />
                {turn.error && <p className="text-sm text-[var(--earth-primary)]" role="status">{turn.status === 'review' ? '待核实 · ' : ''}{turn.error}</p>}
              </div>
            </article>)}
          </div>
        </div>

        <form onSubmit={send} className="chat-composer">
          {error && <p role="alert" className="mb-2 text-sm text-[var(--earth-danger)]">{error} <button type="button" className="underline" onClick={() => { setError(''); setReload(value => value + 1); }}>刷新</button></p>}
          {modelCannotSeeImages && <p role="status" className="mb-2 text-sm text-[var(--earth-danger)]">请选择支持看图的模型</p>}
          {files.length > 0 && <ul className="chat-attachment-list" aria-label="待发送的附件">{files.map((file, index) => (
            <li key={index} className="chat-attachment-chip" title={file.name}>
              {describeAttachment(file).kind === 'image' ? <ImageIcon /> : <FileText />}<span>{file.name}</span>
              <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X /></button>
            </li>
          ))}</ul>}
          <div className="chat-composer-bar">
            <input ref={filePicker} type="file" hidden multiple accept={chatAttachmentAccept} onChange={event => {
              addFiles(Array.from(event.currentTarget.files || []));
              event.currentTarget.value = '';
            }} />
            <button type="button" className="chat-composer-attach" aria-label="添加图片或文档" title="添加图片、PDF 或 Word 文档"
              disabled={attachmentPickerDisabled} onClick={() => filePicker.current?.click()}><Plus className="size-5" /></button>
            <textarea aria-label="消息" placeholder="输入消息" className="chat-composer-input"
              rows={1} maxLength={16_000} value={input} onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }} />
            <div className="chat-composer-model">
              <select aria-label="对话模型" value={model} disabled={!models?.length || sending || deleting} onChange={event => setModel(event.target.value)}>
                {!models?.length && <option value="">{models ? '暂无可用模型' : '加载模型…'}</option>}
                {models?.map(item => <option key={item.id} value={item.id} disabled={hasImages && !item.imageInput}>{item.name}{item.imageInput && hasImages ? ' · 看图' : ''}</option>)}
              </select>
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </div>
            <button type="submit" aria-label="发送消息" className="chat-composer-send"
              disabled={!model || (!input.trim() && !files.length) || modelCannotSeeImages || running || sending || deleting || Boolean(activeId && activeId !== view?.id)}><ArrowUp className="size-5" /></button>
          </div>
          <p className="mt-2.5 text-center text-xs text-[var(--earth-muted)]">按 Token 用量计费</p>
        </form>
      </div>
    </section>
  );
}
