export function Swatch({ hex, alpha = 255, size = 13 }: { hex: string; alpha?: number; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-[2px] ring-1 ring-inset ring-white/12"
      style={{
        width: size,
        height: size,
        background: hex,
        opacity: alpha < 255 ? 0.55 : 1,
      }}
    />
  );
}
