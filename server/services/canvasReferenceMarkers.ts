import { renderMediaReferences, type MediaReferenceKind } from '../../shared/mediaReferences.js';
/** Backward-compatible facade for channel-specific marker casing. */
export function mapCanvasReferenceMarkers(prompt:string,names:Record<MediaReferenceKind,string>):string {
  return renderMediaReferences(prompt,{names,include:ref=>ref.syntax==='canvas' || ref.syntax==='mention' && /^@(Image|Video|Audio)\d/.test(ref.text)});
}
