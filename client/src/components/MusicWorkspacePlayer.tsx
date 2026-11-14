import { useEffect, useState } from 'react';
import { Download, Music2, X } from 'lucide-react';
import { api } from '../api/client';

export type MusicPlayback = { url: string; title: string; subtitle: string };
const musicPath = (url: string) => url.replace(/^\/api\//, '/');

export function MusicDownload({ track }: { track: MusicPlayback }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true);
    setError('');
    try {
      const match = /^\/uploads\/music\/([^/]+)\.mp3$/.exec(track.url);
      const endpoint = match ? '/music/' + encodeURIComponent(match[1]) + '/file' : musicPath(track.url);
      const file = await api.get<Blob>(endpoint, { responseType: 'blob', timeoutMs: 60_000 });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = track.title + '.mp3';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <div>
    <button type="button" className="music-button" onClick={() => void download()} disabled={busy}>
      <Download size={15} aria-hidden="true" />{busy ? '下载中…' : '下载 MP3'}
    </button>
    {error && <p role="alert" className="music-error">{error}</p>}
  </div>;
}

export function MusicWorkspacePlayer({ track, onClose }: { track: MusicPlayback; onClose: () => void; key?: string }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    async function load() {
      try {
        const blob = await api.get<Blob>(musicPath(track.url), {
          responseType: 'blob', timeoutMs: 60_000, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    }
    if (track.url.startsWith('/uploads/')) setSource(track.url);
    else void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [track.url]);

  return <section className="music-player" aria-label="音乐播放器">
    <span className="music-track-icon" aria-hidden="true"><Music2 size={19} /></span>
    <div className="music-player-caption">
      <strong>{track.title}</strong>
      <span>{track.subtitle}</span>
    </div>
    {source
      ? <audio aria-label={track.title} autoPlay controls src={source} onError={() => setError('音频无法播放，请重新打开试听。')} />
      : !error && <span className="music-muted" role="status">正在载入音频…</span>}
    {error && <span className="music-error" role="alert">{error}</span>}
    <button type="button" className="music-button music-icon-button" aria-label="关闭播放器" title="关闭播放器" onClick={onClose}><X size={18} /></button>
  </section>;
}
