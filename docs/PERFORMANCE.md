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
| 100 | 70,000 | 14% | 446,340 | 1.05 s | 1.07 s | 1.0x |
| 990 | 693,000 | 44% | 12,831,324 | 31.57 s | 9.73 s | 3.2x |
| 4,860 | 3,402,000 | 65% | 30,405,480 | 83.84 s | 23.73 s | 3.5x |
| 9,614 | 6,729,800 | 71% | 31,750,750 | 91.62 s | 30.38 s | 3.0x |

At 100 parts the model is below the parallelism threshold and runs in-process
on purpose: thread start-up would cost more than it saves.

### Real models

Measured against LDraw Official Model Repository files (install them with
`npm run parts:fetch -- --mirror --models`), with worker threads:

| Model | Parts | Distinct parts | Triangles | Hidden | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10182 Cafe Corner | 3,457 | 127 | 912,344 | 1,246 (36%) | 12.2 s |
| 10179 Millennium Falcon UCS | 6,034 | 273 | 5,170,957 | 630 (10%) | 12.1 s |

Real models are considerably faster than the synthetic worst case at the same
part count, because a real MOC has a smaller hidden fraction and reuses far more
distinct parts.

A wider survey of 15 official sets, spread across the size range, ran the full
pipeline end to end with no failures, no part moved and no build step altered:

| Model | Parts | Unresolved parts | Candidates | Saving (demo prices) | Time |
| --- | ---: | ---: | ---: | ---: | ---: |
| 21309 NASA Apollo Saturn V | 1,845 | 0 | 299 | $46.28 (13.5%) | 12.1 s |
| 10227 B-wing Starfighter | 1,688 | 5 | 187 | $30.07 (11.2%) | 8.0 s |
| 21041 Great Wall of China | 552 | 0 | 67 | $8.59 (8.1%) | 7.3 s |
| 75144 Snowspeeder | 2,467 | 6 | 264 | $26.45 (7.3%) | 11.2 s |
| 10019 Rebel Blockade Runner | 1,870 | 0 | 85 | $47.65 (6.1%) | 6.1 s |
| 5571 Giant Truck | 1,769 | 0 | 80 | $11.80 (3.0%) | 5.1 s |
| 10179 Millennium Falcon UCS | 6,034 | 8 | 203 | $8.51 (1.2%) | 11.6 s |
| 6285 Black Seas Barracuda | 4,399 | 11 | 5 | $0.17 (0.0%) | 5.2 s |
| 7181 TIE Interceptor UCS | 694 | 0 | 1 | $0.02 (0.0%) | 2.7 s |

The spread is the honest answer to "how much will this save me": it depends
entirely on how much hidden interior the model has and what colors the designer
used there. Nothing in the product tries to make that number look better than
it is.

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
