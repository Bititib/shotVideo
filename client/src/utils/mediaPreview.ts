/** Only our own media routes support previews. Keep signatures/query parameters. */
export function mediaPreviewUrl(source: string, kind: 'image' | 'poster'): string | undefined {
  if (!source || /^(data:|blob:)/i.test(source)) return undefined;
  try {
    const url = new URL(source, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/(?:uploads\/|api\/uploads\/|api\/media\/[^/]+$)/.test(url.pathname)) return undefined;
    url.searchParams.set('preview', kind);
    return url.pathname + url.search;
  } catch { return undefined; }
}
