import { describe, it, expect } from 'vitest';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';

function build(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`0 FILE f${i}.ldr`);
    parts.push(`1 4 0 0 0 1 0 0 0 1 0 0 0 1 f${i + 1}.ldr`);
    parts.push(`1 4 0 0 0 1 0 0 0 1 0 0 0 1 f${i + 1}.ldr`);
  }
  parts.push(`0 FILE f${n}.ldr`);
  parts.push(`0 // terminal`);
  return parts.join('\n') + '\n';
}

describe('repro', () => {
  it('measures', () => {
    for (const n of [14, 16, 18, 20]) {
      const src = build(n);
      const doc = parseLDraw(src, { sourceName: 'bomb.mpd' });
      const t0 = Date.now();
      const r = resolveModel(doc);
      const ms = Date.now() - t0;
      require("fs").appendFileSync("/tmp/claude-0/-home-user-lego-moc/ff80e26e-0187-501b-bc53-f64ef0dafcdf/scratchpad/out.txt", `N=${n} bytes=${src.length} ms=${ms} instances=${r.instances.length} truncated=${r.truncated} files=${doc.files.length} warnings=${doc.warnings.length}\n`);
    }
    expect(true).toBe(true);
  }, 300000);
});
