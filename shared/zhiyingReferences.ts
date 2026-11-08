/** Zhiying's own mention editor emits Chinese, one-based per-kind names.
 * Fullblood line 1/2 submit that plain text, not HM @Image/@Audio tokens.
 * Legacy ref_N images are local zero-based placeholders, not provider syntax.
 */
export function zhiyingReferenceMentions(prompt: string) {
  return Array.from(prompt.matchAll(/\[ref_(\d+)\.(?:jpg|jpeg|png|webp)\]|(?:参考)?[@＠]?(图片|视频|音频)[ \t]*(\d+)(?!\d)|(?<![\w@])@(\d+)(?![\w])/g), match => ({
    start: match.index!, text: match[0],
    kind: (match[1] !== undefined || match[4] !== undefined ? '图片' : match[2]) as '图片' | '视频' | '音频',
    index: match[1] !== undefined ? Number(match[1]) + 1 : Number(match[3] ?? match[4]),
  }));
}

export function normalizeZhiyingReferencePrompt(prompt: string): string {
  let result = prompt;
  for (const ref of zhiyingReferenceMentions(prompt).reverse()) {
    result = result.slice(0, ref.start) + ref.kind + ref.index + result.slice(ref.start + ref.text.length);
  }
  return result;
}
