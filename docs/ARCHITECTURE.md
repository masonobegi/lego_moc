# Architecture

## The shape of the thing

```
upload (.ldr / .mpd)
        |
        v
  parser  ------------- byte-exact command list, nothing discarded
        |
        v
  resolver ------------ flat list of part instances, each addressable back
        |               to the single line that produced it
        v
  geometry ------------ real LDraw part meshes, two-level BVH
        |
        v
  visibility ---------- per part: is any surface reachable from outside?
        |
        v
  pricing ------------- one quote per part+color+condition
        |
        v
  optimizers ---------- hidden color, then equivalent mold
        |
        v
  results ------------- candidates with evidence; exports; 3D viewer
```

Every stage is a plain function over plain data. The optimizer does not import
anything from `src/app` or `src/components`, and the UI does not contain a line
of analysis logic. `tests/pipeline.test.ts` drives the whole pipeline with no
browser and no server.

## Where things live

| Path | What it is |
| --- | --- |
| `src/lib/ldraw/` | Parser, serializer, resolver, color table, vector maths |
| `src/lib/geometry/` | Part mesh resolution, triangle BVH, two-level scene |
| `src/lib/optimizer/` | Visibility engine, sampling, candidate grouping, the two optimizers, scoring, application |
| `src/lib/catalog/` | Color validity, id and color mappings, mold rules |
| `src/lib/pricing/` | Price provider interface, demo provider, BrickLink provider, cache, cost calculation |
| `src/lib/analysis/` | Pipeline orchestration, result types, viewer payload |
| `src/lib/export/` | Optimized LDraw, JSON report, CSV log, Wanted List XML |
| `src/lib/runtime/` | Server-only configuration, service wiring, storage |
| `src/lib/security/` | Limits and input sanitisation |
| `src/app/` | Next.js routes and API handlers |
| `src/components/` | React UI, including the Three.js viewer |
| `data/catalog/` | Generated catalog data, committed |
| `test-models/` | Synthetic fixtures with known expected outcomes |
| `scripts/` | Library fetch, catalog generation, benchmarks |

## Decisions that are not the obvious ones

### The analysis runs on the server, not in the browser

The visibility engine needs the LDraw parts library. The full library is over
500 MB; even a working subset is far more than a page should download, and
resolving a part means recursively reading dozens of files. Doing this
server-side means the browser downloads only the geometry actually used, already
resolved and deduplicated.

The consequence is that the browser is never blocked by analysis, so the Web
Worker the brief suggests is not needed there. The equivalent work is done with
Node `worker_threads` on the server, where the parallelism actually exists.

### The geometry and BVH code has no dependencies, not even Three.js

`three-mesh-bvh` is good and would have worked. It was not used because:

- the only query the visibility engine needs is "does anything block this ray
  before distance t", which allows returning on the FIRST hit and is much
  cheaper than the nearest-hit query a general library provides;
- the same code has to run in Node (analysis) and could run in a browser
  (future client-side preview) with no DOM or WebGL present;
- a custom top-level structure over instances was needed regardless, so half
  the work was going to be hand-written anyway;
- construction is fully deterministic, which matters because the ray counts it
  produces are shown to the user as evidence and asserted by tests.

Three.js is used, but only in the viewer component.

### Directions are sampled over the whole sphere, not a hemisphere

An LDraw part file is a surface model whose triangle winding is not reliably
outward - many parts are not BFC-certified, and a mirrored instance transform
flips winding anyway. Any code that depends on a correct outward normal will be
wrong for some parts, and being wrong here means calling a visible brick hidden.

Sampling the full sphere removes the dependency entirely. Rays aimed into the
part's own solid hit its far wall and count as blocked, so the method is
self-correcting. It costs roughly twice as many rays and buys a whole class of
bugs never existing.

The viewer renders double-sided for the same reason.

### The unit of change is a line, not a part

A submodel referenced four times produces four physical bricks from one line
type 1. Editing that line changes all four. So candidates are grouped by
`commandRef` and a change is only proposed when EVERY instance sharing that line
is hidden. `test-models/multiple-instances.mpd` exists to pin this down.

This is also the single largest source of missed savings on real models: on
Cafe Corner, 1,200 pieces are genuinely hidden but share lines with visible
copies. Fixing it means splitting the submodel, which changes the build
instructions, so V1 does not do it. It is the highest-value V2 feature.

### Confidence is computed, not asserted

When N rays are cast from points covering a part's surface and none escape, the
rule of three bounds the true escape probability at about 3/N with 95%
confidence. The reported number is `1 - 3/N`, and N is shown alongside it. It is
a statement about the sampling, not a proof of invisibility, and the UI says so.
Nothing anywhere in the codebase produces a confidence figure by any other means.

### Storage is a JSON file, not PostgreSQL

The brief allows a database "only if persistent storage materially helps". It
does not here. An analysis is one self-contained document that one browser
session reads back a handful of times. It is written to `.brickthrift/analyzes/`
with an in-memory index in front, which keeps setup to `npm install && npm run
dev` with nothing to provision.

The interface in `src/lib/runtime/store.ts` is four functions, so swapping in
Prisma later touches one file. Exports and re-costing re-derive everything from
the stored original text, which is also what guarantees "reset to original"
cannot fail: the user's bytes are never mutated.

### Progress is streamed, not simulated

`POST /api/analyze?stream=1` returns NDJSON, one line per stage as that stage
actually begins, then the result. There are no percentages anywhere, because
the pipeline cannot honestly produce one: the cost of the visibility pass is not
known until it has run.

### Demo prices are synthetic and say so, structurally

`PriceQuote.source` is `'demo'` or `'bricklink'`, `isEstimate` is always `true`,
and every demo quote carries the disclaimer in its notes. The UI renders a DEMO
PRICE DATA badge from that field rather than from a page-level flag, so it is not
possible to render a demo figure without the label.

Demo prices for parts outside the table are derived from the part's own
bounding-box volume rather than from a hash or a constant, so the fallback is
explainable, and the quote says which path produced it.

### Library choices

| Choice | Why |
| --- | --- |
| Next.js 16 App Router | Server route handlers and React pages in one process; `npm run dev` is the whole setup |
| React 19 + TypeScript strict | `noUncheckedIndexedAccess` is on; there is no `any` in the analysis path |
| Tailwind CSS v4 | No config file, CSS-first tokens |
| Three.js | Only for the viewer; instanced rendering is what makes large models interactive |
| Vitest | Runs TypeScript directly, fast enough to run the whole suite on every change |
| Playwright | The end-to-end test parses the actual downloaded file, which needs a real browser |
| esbuild | Bundles the worker entry point; already present via the toolchain |
| No ORM, no database | See above |
| No state management library | The results page has one piece of state: the set of enabled candidate ids |

## Extension points that exist but are not implemented

These are deliberately left as seams rather than as TODOs:

**Structural optimization** (one 1x8 plate to two 1x4 plates). An
`OptimizationCandidate` already carries `originalPartId`/`replacementPartId`
separately from color, and `applyOptimizations` edits a command in place. A
one-to-many change needs a different application step - inserting lines - which
is exactly where step preservation gets hard, which is why it is not in V1.

**Submodel splitting**, to unlock the `mixed_visibility` case above. Requires
generating a new sub-file, rewriting one reference to point at it, and deciding
what that does to the user's instructions.

**User-owned inventory.** `calculateCost` takes an instance list and a price
book. Subtracting owned parts is a filter on the instance list before it, with
no change to the optimizer.

**A different catalog.** `CatalogService` is an interface with four methods.
`DefaultCatalogService` already accepts an alternative LDraw-native color
source through `ldrawNativeColors`.

**A different price source.** `PriceProvider` is one method. A multi-store
purchasing optimizer would consume the Wanted List export rather than living
inside this codebase.

**Instruction generation.** Out of scope on purpose. The step structure is
preserved exactly so BrickLink Studio's Instruction Maker can do it.

## What the code deliberately does not do

- No AI or heuristic judgment about whether a structural change is safe.
- No scraping. The BrickLink API is the only route to live prices.
- No guessing of catalog ids. Unmappable lots are excluded and reported.
- No mutation of the uploaded file, ever.
