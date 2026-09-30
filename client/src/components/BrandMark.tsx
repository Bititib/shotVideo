/** Shared brand artwork; decorative beside the visible brand name. */
export default function BrandMark({ size = 36 }: { size?: number }) {
  return <img src="/brand/lingxu-mascot.png?v=3" alt="" aria-hidden="true" width={size} height={size}
    draggable={false} style={{ width: size, height: size, maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', flexShrink: 0 }} />;
}
