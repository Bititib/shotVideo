import { parseMediaReferences, renderMediaReferences, MEDIA_REFERENCE_LABELS } from './mediaReferences.js';
/** Compatibility facade: the shared engine owns parsing and rendering. */
export function zhiyingReferenceMentions(prompt:string) {
  return parseMediaReferences(prompt).map(ref=>({...ref,kind:MEDIA_REFERENCE_LABELS[ref.kind]}));
}
export const normalizeZhiyingReferencePrompt = renderMediaReferences;
