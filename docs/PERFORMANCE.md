# Performance

## Where the time goes

Analysis is dominated by one thing: casting rays through real part geometry to
decide what is visible. On a realistic model it is around 90% of the total.
Parsing, price lookup and the optimization itself are noise beside it.

That is not an accident of implementation, it is the shape of the problem. A
part can only be called hidden after enough rays have failed to escape to make
the claim mean something, and "enough" is thousands of rays per part. The
engineering question is not how to avoid that work but how to do it quickly and
how to avoid doing it for parts that obviously do not need it.

## What makes it fast

**A two-level acceleration structure.** A 6,000-part model is about five
million instanced triangles but only a few hundred DISTINCT parts. Building one
BVH per distinct part in its own coordinate space, plus a second BVH over the
instances' world boxes, makes memory proportional to distinct parts rather than
to instance count. A ray is traversed against the top level, then transformed
into each candidate part's local space and tested against the shared bottom
level. Because the instance transform is affine, the ray parameter `t` is
identical in both spaces, so distance limits need no conversion.

**A cheap screen before the expensive pass.** Almost every exterior part has a
ray escape within the first handful of casts. The screen pass is 24 surface
points x 12 directions and exits on the first escape, so a visible part
typically costs a few dozen rays rather than tens of thousands. Only parts that
survive the screen go through the dense verification pass.

**Front-to-back traversal.** For a boolean "is anything in the way" query the
first hit ends the traversal, so descending into the nearer child first turns a
walk of the whole ray path into a couple of box tests.

**Flat typed arrays in the hot path.** Node bounds, instance boxes, inverse
matrices and positions all live in `Float32Array`/`Float64Array`. Chasing
`node.bounds.min.x` through three object headers on every box test costs more
than the arithmetic does, and at millions of rays per analysis that difference
is the entire performance budget. The ray query allocates nothing.

**Cached surface samples.** Sample points are generated in the part's own
coordinate space, so every instance of the same part reuses them. In a
3,500-part model with 130 distinct parts this work is done 130 times instead of
3,500.

**Worker threads.** Visibility is embarrassingly parallel: each part's verdict
depends only on the shared, read-only scene. The BVHs are serialisable, so
workers receive a built scene rather than rebuilding it, and slices are
disjoint. `tests/visibilityParallel.test.ts` asserts that the merged result is
identical to the single-threaded one, verdict by verdict and ray count by ray
count - which is what makes it acceptable to parallelize something this
safety-critical.

## Measurements

Run them yourself:

```bash
npm run bench                        # synthetic models, worker threads
npm run bench -- --single-threaded   # the in-process path
npm run bench -- --real              # real models, if you have installed them
npm run bench -- --write             # write docs/benchmark-results.md
```

Measured on Node 22.22, a 4-core Intel Xeon at 2.80 GHz, 16 GB RAM.

### Synthetic models: a deliberately hostile case

The synthetic model is a **solid block of 2x4 bricks**. Roughly half to
three-quarters of the bricks in a solid block are fully enclosed, so the
expensive verification pass runs on far more of the model than it would on a
real MOC, where 20-40% hidden is typical. Benchmarking a flat sheet would
produce much better numbers and mean much less.

| Parts | Triangles | Hidden | Rays | Single-threaded | 4 worker threads | Speedup |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 70,000 | 14% | 543,585 | 1.24 s | 1.33 s | 1.0x |
| 990 | 693,000 | 44% | 15,359,088 | 38.12 s | 11.44 s | 3.3x |
| 4,860 | 3,402,000 | 65% | 38,439,508 | 103.42 s | 28.11 s | 3.7x |
| 9,614 | 6,729,800 | 71% | 41,938,184 | 116.27 s | 31.13 s | 3.7x |

The ray column is identical in both columns of every row, which is the point:
the parallel and in-process paths cast exactly the same rays and reach exactly
the same verdicts. When those two numbers disagree, something is wrong - see
"A bug worth recording" below.

At 100 parts the model is below the parallelism threshold and runs in-process
on purpose: thread start-up would cost more than it saves.

### Real models

Measured against LDraw Official Model Repository files (install them with
`npm run parts:fetch -- --mirror --models`), with worker threads:

| Model | Parts | Triangles | Hidden | Total |
| --- | ---: | ---: | ---: | ---: |
| 10182 Cafe Corner | 3,457 | 912,344 | 1,172 (34%) | 14.5 s |
| 10179 Millennium Falcon UCS | 6,034 | 5,170,957 | 422 (7%) | 12.1 s |

Real models are considerably faster than the synthetic worst case at the same
part count, because a real MOC has a smaller hidden fraction and reuses far more
distinct parts.

The savings figures previously quoted here came from a 15-model sample taken
before the visibility engine was corrected. They were wrong, and rather than
restate them the whole corpus was measured instead: all 103 LDraw Official Model
Repository models, in `docs/validation-results.json`, with the verdict in
`docs/AUDIT.md`. The short version is that the median model saves 0.1% and 42%
save nothing, because three quarters of the parts in a LEGO model can be seen.

Runtime across that corpus, with worker threads: median 3.9 s per model, and the
largest (8,149 parts) around two minutes.

## A bug worth recording

An earlier version of this table showed materially larger savings - 13.5% on
Apollo Saturn V rather than 9.2%, 11.2% on the B-wing rather than 7.0%. Those
numbers were wrong, and the reason is worth writing down because it is a hazard
inherent to the architecture rather than a one-off slip.

The visibility worker is a SEPARATE esbuild bundle (`dist-workers/`). Unlike
every other module it does not rebuild when its source changes; it rebuilds only
when one of the `workers:build` npm hooks runs. A fix to the direction sampler
landed in `sampling.ts`, the bundle was not rebuilt, and from that moment the
parent process ran the corrected sampler while the worker threads ran the old
one. Since the parallel path is the default above 600 parts, every real model
measured in that window was judged by the unfixed code - which sampled fewer
directions, found fewer escaping rays, and therefore called more parts hidden.
More "savings", all of them unsafe.

The tell was in the benchmark output the whole time: the single-threaded and
multi-threaded runs reported different ray counts for the same model. Two code
paths that are supposed to be identical were not.

Two changes came out of it:

- `analyzeVisibilityParallel` now refuses to use a bundle older than any
  TypeScript source under `src/lib`, falling back to the in-process path. Slower
  is always better than divergent. `tests/visibilityParallel.test.ts` covers it.
- `npm run bench` gained a `prebench` hook, so benchmarks can no longer be taken
  against a stale bundle.

### Why 5,000 and 10,000 parts cost nearly the same

The ray budget per part scales down for large models
(`optionsForModelSize` in `src/lib/optimizer/visibilityEngine.ts`):

| Model size | Verification points | Directions | Max rays per part |
| --- | ---: | ---: | ---: |
| up to 1,500 parts | 900 | 32 | 28,800 |
| up to 5,000 parts | 450 | 24 | 10,800 |
| above 5,000 parts | 220 | 20 | 4,400 |

This is a deliberate, visible trade. Fewer rays means a lower rule-of-three
confidence bound, and that lower confidence is reported on every affected
change rather than hidden - a part verified with 4,400 rays shows about 99.93%
rather than 99.99%. Under the default Extremely Conservative safety level the
threshold is 99%, so large models still produce changes, with honestly smaller
error bars.

## Memory

Peak resident set for the 10,000-part synthetic model is under 1.5 GB with four
workers, most of it the per-worker copies of the scene's triangle buffers. The
two-level structure is what keeps this bounded: the same model with one merged
BVH per instance would be roughly an order of magnitude larger.

## Browser-side performance

The browser never runs the analysis. It receives a binary payload containing one
geometry per DISTINCT part plus per-instance transforms, and draws the model
with one `InstancedMesh` per part and opacity class. A 6,000-part model is a few
megabytes and a few hundred draw calls rather than 6,000 meshes.

Two consequences worth knowing:

- Toggling a change never refetches geometry. Every candidate's replacement
  color is included in the payload up front, and the browser decides per
  instance which to display.
- The viewer caps at 60,000 drawn instances. The analysis always covers the
  whole model; if the cap is reached the viewer says so rather than silently
  showing part of the model.

## Limits

The hard bounds in `src/lib/security/limits.ts` exist to stop a hostile or
broken file from exhausting the machine, not to reflect what the software can
comfortably do:

| Limit | Value |
| --- | ---: |
| Upload size | 32 MB |
| Source lines | 4,000,000 |
| Sub-files per document | 20,000 |
| Submodel nesting depth | 64 |
| Part instances after expansion | 250,000 |
| Triangles per part definition | 400,000 |

## Ideas not yet taken

Honest list of what would make this faster, roughly in order of expected value:

1. **A GPU or SIMD ray kernel.** The traversal is the entire cost and is
   trivially vectorisable. This is the only change likely to be worth an order
   of magnitude.
2. **Coarse voxel pre-classification.** A conservative occupancy grid could
   discharge obviously-exterior parts without any ray casting, cutting the
   screen pass. It cannot be used to conclude "hidden", only "not obviously
   visible".
3. **Reusing verdicts across identical instances.** Two instances of the same
   part in identical local surroundings must have the same verdict, but
   establishing "identical surroundings" cheaply and soundly is the hard part,
   and getting it wrong is exactly the failure mode this product must not have.
