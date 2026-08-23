/**
 * Corpus preparation: un-inline part definitions that the parts library already
 * has.
 *
 *   npx tsx scripts/normalize-inlined-parts.ts <in-dir> <out-dir> --parts-library <dir>
 *
 * Why this exists
 * ---------------
 * An MPD may carry its own copy of a part's definition as a `0 FILE 3001.dat`
 * block, so the file renders on a machine without the parts library. It is the
 * normal way to share a self-contained model, and community MOCs use it far
 * more than official-set files do.
 *
 * The LDraw specification says an in-document sub-file takes precedence over a
 * library part of the same name, and `resolveModel` follows that faithfully -
 * which means it descends INTO the inlined part and emits the primitives that
 * make it up (`4-4edge.dat`, `stud.dat`, `4-4cyli.dat`) as if each were a piece
 * you buy. A 490-piece ship becomes "490 parts" of which every single one is a
 * primitive, priced and counted as though it were a brick.
 *
 * That is a defect in the product, not in the files. It is recorded in
 * docs/MOC_VALIDATION.md and is NOT fixed here, because fixing it means
 * changing the resolver.
 *
 * What this does instead is prepare a corpus that measures the right thing:
 * remove an inlined `0 FILE <name>` block when, and only when, the parts
 * library already contains `<name>`. References then resolve to the library
 * part, and the inventory counts pieces. Blocks for genuinely custom parts -
 * the reason official-set files inline anything at all - are left alone, so
 * nothing becomes unresolvable.
 *
 * Everything else in the file is passed through untouched.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { NodePartSource } from '../src/lib/geometry/nodePartSource';
import { ChainedPartSource } from '../src/lib/geometry/partSource';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const inDir = process.argv[2];
const outDir = process.argv[3];
if (!inDir || !outDir || !existsSync(inDir)) {
  console.error('Usage: tsx scripts/normalize-inlined-parts.ts <in-dir> <out-dir> --parts-library <dir>');
  process.exit(1);
}

const partsLibraryArg = arg('--parts-library');
const libraries = [
  ...(partsLibraryArg ? [partsLibraryArg] : []),
  path.join(process.cwd(), 'public', 'ldraw-full'),
  path.join(process.cwd(), 'public', 'ldraw'),
].filter((dir) => existsSync(dir));
const partSource = new ChainedPartSource(libraries.map((dir) => new NodePartSource(dir)));

mkdirSync(outDir, { recursive: true });

const files = readdirSync(inDir).filter((f) => /\.(ldr|mpd)$/i.test(f)).sort();
console.log(`${files.length} files, library: ${libraries.join(', ')}\n`);

let totalStripped = 0;
let totalExtracted = 0;
let totalKept = 0;

// Inlined definitions that ARE parts but are not in the library get written
// here, and this directory is passed to the analysis as an extra parts library.
const extractedDir = path.join(outDir, '_extracted-parts');
mkdirSync(extractedDir, { recursive: true });

for (const file of files) {
  const source = readFileSync(path.join(inDir, file), 'utf8');
  const lines = source.split(/\r?\n/);

  // Split into blocks. A block starts at `0 FILE` and runs to the next `0 FILE`
  // or `0 NOFILE`. Everything before the first `0 FILE` is the preamble.
  interface Block {
    name: string | null;
    lines: string[];
  }
  const blocks: Block[] = [];
  let current: Block = { name: null, lines: [] };
  for (const line of lines) {
    const match = /^\s*0\s+FILE\s+(.+?)\s*$/i.exec(line);
    if (match) {
      if (current.lines.length > 0 || current.name !== null) blocks.push(current);
      current = { name: match[1]!.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  blocks.push(current);

  const kept: Block[] = [];
  let stripped = 0;
  let extracted = 0;
  for (const [index, block] of blocks.entries()) {
    // The first block is the model itself; never remove it whatever it is named.
    if (block.name === null || index === 0) {
      kept.push(block);
      continue;
    }

    if ((await partSource.read(block.name)) !== null) {
      // The library already has this part. Drop the copy and let references
      // resolve to it.
      stripped++;
      continue;
    }

    // Not in the library - but is it a PART or a sub-assembly? LDraw says so
    // explicitly. `0 !LDRAW_ORG Unofficial_Part` on an inlined block means
    // "this is a piece you buy", and official-set files use it for parts the
    // library has not adopted yet. Descending into one and inventorying its
    // primitives is the defect this corpus prep exists to route around, so
    // extract it to a private library instead of leaving it inline.
    const org = block.lines
      .slice(0, 20)
      .find((line) => /^\s*0\s+!LDRAW_ORG\b/i.test(line));
    // No \b before the keyword: the marker is written `Unofficial_Part`, and
    // an underscore is a word character, so \bpart\b never matches it.
    const isPart = org !== undefined && /(part|subpart|primitive|shortcut)/i.test(org);
    if (isPart) {
      const safe = block.name.replace(/[\\/]/g, '_');
      writeFileSync(path.join(extractedDir, safe), block.lines.join('\n'));
      extracted++;
      continue;
    }

    kept.push(block);
  }

  totalStripped += stripped;
  totalExtracted += extracted;
  totalKept += blocks.length - 1 - stripped - extracted;
  writeFileSync(
    path.join(outDir, file),
    kept.flatMap((b) => b.lines).join('\n'),
  );
  console.log(
    `${file.slice(0, 42).padEnd(43)} ${String(blocks.length - 1).padStart(4)} sub-files, ` +
      `${String(stripped).padStart(4)} un-inlined, ${String(extracted).padStart(4)} extracted, ` +
      `${String(blocks.length - 1 - stripped - extracted).padStart(4)} kept`,
  );
}

console.log(
  `\n${totalStripped} definitions un-inlined (already in the library), ` +
    `${totalExtracted} extracted to a private library, ${totalKept} kept inline (genuine sub-assemblies).`,
);
console.log(`Models: ${outDir}`);
console.log(`Extra parts library: ${extractedDir}`);
