/** Canvas numbers are already one-based and ordered within each media kind.
 * The caller supplies its own protocol's names; legacy placeholders are untouched.
 */
export function mapCanvasReferenceMarkers(prompt: string, names: { image: string; video: string; audio: string }): string {
  return prompt.replace(/参考(图片|视频|音频)(\d+)(?!\d)/g, (marker, kind: string, number: string) => {
    const index = Number(number);
    if (!Number.isSafeInteger(index) || index < 1) return marker;
    const name = kind === '图片' ? names.image : kind === '视频' ? names.video : names.audio;
    return `@${name}${index}`;
  });
}
