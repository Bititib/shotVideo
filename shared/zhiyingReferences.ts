/** User-selected unified @Image/@Video/@Audio format; preserve @ end-to-end.
 * Chinese/legacy input remains compatible. This is an explicit platform format
 * choice, not evidence of upstream voice-reference effectiveness.
 */
export function zhiyingReferenceMentions(prompt: string) {
  return Array.from(prompt.matchAll(/\[ref_(\d+)\.(?:jpg|jpeg|png|webp)\]|(?:参考)?[@＠]?(图片|视频|音频)[ \t]*(\d+)(?!\d)|(?<![\w@])@(\d+)(?![\w])|@(Image|Video|Audio)(\d+)(?!\d)/g), match => ({
    start: match.index!, text: match[0],
    kind: (match[1] !== undefined || match[4] !== undefined ? '图片' : match[2] || ({Image:'图片',Video:'视频',Audio:'音频'} as Record<string,string>)[match[5]]) as '图片' | '视频' | '音频',
    index: match[1] !== undefined ? Number(match[1]) + 1 : Number(match[3] ?? match[4] ?? match[6]),
  }));
}

export function normalizeZhiyingReferencePrompt(prompt: string): string {
  let result = prompt;
  for (const ref of zhiyingReferenceMentions(prompt).reverse()) {
    result = result.slice(0, ref.start) + '@' + ({图片:'Image',视频:'Video',音频:'Audio'}[ref.kind]) + ref.index + result.slice(ref.start + ref.text.length);
  }
  return result;
}
