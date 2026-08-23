# Audit

A self-assessment of BrickThrift against the categories the brief asked for.
Scored 1-10, with the reasoning and the measurements behind each score, and the
weaknesses named rather than hedged.

The rule I set myself while writing this: **a score is a claim, and a claim
needs a measurement.** Where I have one, it is quoted. Where I do not, the score
is capped and the sentence says why.

---

## Summary

| Category | Score |
| --- | ---: |
| Functionality | 8 |
| Parser reliability | 9 |
| Optimization accuracy | 8 |
| False positives | 8 |
| Cost accuracy | 7 |
| User trust | 9 |
| Export reliability | 8 |
| Local setup | 9 |
| UI | 8 |
| Performance | 7 |
| Tests | 9 |
| **Overall** | **8.2** |

Nothing below 7. The two 7s are the honest ones: cost accuracy is limited by a
BrickLink integration that has never made a live call from this build, and
performance regressed by three to eight times when the visibility engine got
correct.

---

## Functionality - 8

Everything the brief specified for V1 is implemented and reachable from the UI:
`.ldr`/`.mpd` parsing, geometry resolution against the real LDraw library, the
visibility engine, hidden-color optimization, mold-equivalent optimization,
demo and live price providers, the 3D viewer with original/optimized/compare,
per-change enable and disable, all five exports, `/dev`, and the analysis
detail panels.

Not implemented, deliberately, with extension points left in place: `.io`
files, structural substitution, one-piece-to-many, user inventory, multi-store
optimization, instruction generation.

**Why not higher.** Two gaps are mine rather than the brief's. Reused submodels
are still the largest single source of missed savings - a submodel used four
times is one line, and if any copy is visible the line is untouched. And the
mold-equivalence catalog is 19 rules, of which 8 clear the auto-apply
threshold, so that half of the product contributes very little in practice.

---

## Parser reliability - 9

Measured on the 103 models of the LDraw Official Model Repository, 116,875
parts:

- **103/103 byte-exact** on parse then serialize.
- **103/103 semantically identical** on parse, regenerate, re-parse, re-resolve.
- **0 malformed lines**, 1 unresolved submodel reference (in a file that
  genuinely references a missing sub-file).

The parser never throws on content. Malformed lines are preserved verbatim and
counted. Unknown metadata survives untouched, which is what makes the round-trip
guarantee real rather than aspirational.

Two bugs found and fixed during this work are worth recording because both were
silent:

- `toFixed(6)` in the serializer truncated `0.0871557` to `0.087156`, breaking
  semantic round-trip on 7 of 103 models. Now emits the shortest decimal that
  round-trips exactly.
- Malformed lines inside part files were dropped without a trace during mesh
  resolution, so a part could silently lose geometry and be judged on what was
  left. Now counted, and the part is marked incomplete.

**Why not 10.** No fuzzing campaign. The hostile-input tests are hand-written
cases, and hand-written cases are only as good as the imagination behind them.

---

## Optimization accuracy - 8

"Accurate" here means: the change we propose is the change that gets written,
the price arithmetic is right, and the model is otherwise untouched.

- Applying every candidate to 15 real models and re-parsing the output: **no
  part moved, no step changed, no part count changed, nothing skipped.**
- Step preservation is structural, not checked after the fact: a color change
  rewrites the color field of an existing line in place, so it cannot move
  between `0 STEP` boundaries.
- A change is proposed only when **every** instance produced by that line is
  hidden. `test-models/multiple-instances.mpd` pins this down.
- Replacement colors come from catalog evidence that the part has actually been
  produced in that color, never from a list of colors that merely exist.

**Why not higher.** Color validity offline rests on ~2,000 parts observed
across 101 official sets. It is real data, but narrow: a part outside that set
never gets a proposal, which costs savings rather than safety. And the catalog
cannot distinguish "was produced in this color once in 1987" from "is available
now" without live data.

---

## False positives - 8

The category the brief called out as most important, and the one where this
audit found the most serious problem.

### What was measured

Every change the optimizer proposed across 15 real models was re-verified
independently, at a far denser sampling budget than the engine used to accept
it, counting only *robust* escapes - an escaping direction whose neighbours one
degree away also escape. That filter matters: LDraw geometry is exact-contact,
so a ray can slip along the zero-width gap between a stud's outer cylinder and a
tube's inner cylinder, and nobody can see through a measure-zero gap.

| | Proposed changes | With a genuine line of sight |
| --- | ---: | ---: |
| Before this audit | 920 | **146 (15.9%)** |
| After | 507 | **7 (1.4%)** |

### What caused it

Two things, both found by this audit rather than by the tests.

**A stale worker bundle.** The visibility worker is a separate esbuild bundle
that does not rebuild when its source changes. A fix to the direction sampler
landed, the bundle was not rebuilt, and from that moment the parent process ran
corrected code while the worker threads ran the old sampler. Above 600 parts the
worker path is the default, so every real model was being judged by unfixed
code. The tell had been in the benchmark output the whole time: the
single-threaded and multi-threaded runs reported different ray counts for the
same model.

Now `analyzeVisibilityParallel` refuses a bundle older than any source under
`src/lib` and falls back in-process, and `npm run bench` rebuilds first.

**The method itself.** Casting rays from random points on a part in random
directions makes a part visible through a small gap a one-in-a-hundred-thousand
event, and the estimate does not converge - raising the budget from 34,200 rays
per part to 804,000 took the share of accepted parts found visible from 34.7% to
58.5%, still climbing. No affordable budget fixes that.

So the engine now also asks the question an observer asks: from a hundred-odd
viewpoints around the model, including underneath, does this part show up? Rays
laid out on the image plane land in the aperture routinely instead of by luck.
That change withdrew about 45% of previously proposed changes as unsafe.

### The residual

1.4% is not 0%, and the reason is structural: sampling can bound how much of a
part is visible, but it cannot prove that none of it is.
`tests/observerPass.test.ts` includes the limit case - a 2.4 mm hole 32 mm
off-axis that both passes miss, and a part behind which would be recolored.

Characterising the residual honestly: of the false positives measured before the
fix, **none** had more than 5% of their surface robustly exposed, and 85% had
under 0.5% - typically one escaping ray in 100,000. These are parts visible
through a pinhole from one narrow angle, not bricks on the front of the model.
That is a meaningful mitigation and it is not a defence: the brief is right that
this is the failure mode that matters, and 1.4% is a real 1.4%.

The evidence text now says the confidence bounds how much of a part can be seen
rather than proving that none of it can be.

**Why 8 and not 9.** 1.4% is good, is measured, and is a 91% reduction. It is
not zero, and the honest position is that it will not reach zero by sampling
harder.

---

## Cost accuracy - 7

The lowest score, and the reason is not subtle.

- The demo dataset is synthetic, labelled `DEMO PRICE DATA` everywhere it
  appears, and structurally incapable of being mistaken for live data - the
  provider stamps `source: 'demo'` on every quote and the UI keys off that.
- The BrickLink provider is written to the documented Store API v3 price-guide
  endpoint, signs one-legged OAuth 1.0a, caches per part/color/condition/guide
  type/currency/region, and degrades to demo prices rather than failing. Its
  OAuth signing is unit-tested against the RFC 5849 worked example.
- **It has never made a successful call to the real API from this build**,
  because `api.bricklink.com` was unreachable from the environment this was
  developed in. The app says "unverified in this build" until it gets a real
  response, and it would be dishonest to score this category as though the
  integration were proven.

Beyond that, and more fundamentally: an estimated part cost is not a checkout
price, and the app now says so everywhere rather than in a footnote. It exports
both Wanted Lists so BrickLink can price each, and records the two totals back
so the prediction error is visible. That is the right architecture for this
problem, and it is untested end to end for the same reason as above.

**What would move this to 9.** One successful live run against BrickLink with
real credentials, and one delivered-cost comparison of both Wanted Lists through
a real BrickLink account.

---

## User trust - 9

- Every change carries its ray count, triangle coverage, confidence and a
  sentence explaining what was measured.
- Confidence is computed from the rule of three, never asserted. Nothing in the
  codebase produces a confidence figure any other way.
- Demo prices are labelled as demo, live-but-unverified is labelled as such, and
  reduced sampling budgets on large models show up as lower confidence rather
  than being hidden.
- Parts are never silently skipped: the rejection panel says how many were left
  alone and why, including "hidden and cheaper, but the saving is too small" and
  "the replacement color is barely stocked".
- The app says when it found nothing worth doing. Two of the five model ratings
  are honest failures.
- The uploaded model is never modified; original and optimized are separate
  artifacts throughout.

**Why not 10.** The evidence sentences are good but long, and a builder in a
hurry will read the confidence percentage and not the caveat next to it. There
is no getting around that with wording alone.

---

## Export reliability - 8

- The optimized LDraw is verified by re-parsing it: 15 real models, no part
  moved, no step changed, nothing lost.
- The Wanted List XML is validated structurally in tests rather than eyeballed -
  the document is parsed back, every tag balanced, and quantities, BrickLink
  part ids, BrickLink color ids and condition all checked against known values.
- Both lists are exported. Tests assert the original is never altered by
  applying changes, that disabled changes stay at the original color, that
  enabled ones are reflected, and that a recolor conserves total piece count.
- Lots whose BrickLink id cannot be resolved with confidence are excluded and
  reported, never guessed. A wrong id would silently order the wrong brick.

**Why not higher.** The XML has never been imported into a real BrickLink
account. The format follows BrickLink's documentation and the export says so in
its own header comment, but "documented correctly" and "accepted by the live
importer" are different claims and only one of them is proven.

---

## Local setup - 9

`npm install && npm run dev` works, demo mode functions immediately with no
credentials, and `http://localhost:3000` is the whole story. `postinstall`
builds the visibility worker so a fresh clone is not silently slower or, worse,
divergent. `.env.example` documents every variable, all optional. `/dev` loads
every fixture through the real pipeline.

**Why not 10.** A full-fidelity run wants the complete LDraw parts library,
which is a separate `npm run parts:fetch`. The bundled subset covers the
fixtures and common parts, but a real MOC will report missing geometry until the
full library is installed, and that is a second step no matter how well
documented.

---

## UI - 8

Restrained, monospaced-accent, LEGO-adjacent without impersonating LEGO. No
gradients, no blur, no emoji, no pill-shaped everything. The savings figure is
the largest thing on the results page; the sentence explaining that it is not a
checkout price sits directly beneath it. The viewer does rotate, zoom, pan,
reset, fit, select, highlight, and original/optimized/compare. Selecting a
change highlights it in 3D and vice versa. Filtering covers savings, step, part,
kind, state, confidence and a minimum-saving threshold.

**Why not higher.** The results page is dense - it is a lot of information and
it looks like a lot of information. And it has not been tested on a narrow
screen beyond the layout being responsive; a phone would work but would not be
pleasant.

---

## Performance - 7

Measured on 4 cores, worker threads on:

| Parts | Rays | Total |
| ---: | ---: | ---: |
| 100 | 543,585 | 1.3 s |
| 990 | 15,359,088 | 11.4 s |
| 4,860 | 38,439,508 | 28.1 s |
| 9,614 | 41,938,184 | 31.1 s |

Real models: Great Wall of China (552 parts) 8.7 s, B-wing (1,688) 33.5 s,
Millennium Falcon UCS (6,034) 46.2 s, Apollo Saturn V (1,845) 92.3 s.

The work is a two-level BVH with flat typed arrays, front-to-back traversal,
cached per-part surface samples, a cheap screen pass before the expensive one,
and a 3.3-3.7x speedup from worker threads with byte-identical results.

**Why only 7.** The observer pass made analysis three to eight times slower.
Apollo Saturn V went from 11 s to 92 s. That is a real cost to the user and I
am not going to score it as though it were free. It was still the right trade -
the alternative was a tool that recolors visible bricks - but a minute and a
half for a 1,845-part model is a bad experience, and the fix is a GPU or SIMD
ray kernel rather than more tuning.

---

## Tests - 9

252 unit and integration tests across 15 files, plus 9 Playwright end-to-end
tests. The ones that matter:

- Parser: basic, MPD, nested submodels, steps, transformations, colors,
  malformed lines, recursive references, hostile inputs, warning caps.
- Round-trip: byte-exact and semantic, including the serializer precision case
  that a real corpus caught and the unit tests had not.
- BVH: brute-force comparison over 500 rays.
- Safety: 30 pipeline tests asserting visible parts are never changed, hidden
  ones are, partially visible ones are not, invalid colors are never proposed,
  steps are preserved, disabled changes are removed.
- Visibility: the vertical-shaft regression (proven to fail on the old code),
  the observer-pass aperture tests including the limit case, and parallel-path
  equivalence verdict by verdict and ray count by ray count.
- Availability: scarce-but-cheaper rejected, widely-available preferred, one
  cheap listing not dominating, supply judged against required quantity, sold
  history never read as stock.
- Wanted Lists: quantities, id mapping, disabled changes, original untouched.
- End to end: upload, analyze, toggle, download, and verify the color actually
  changed in the downloaded file.

**Why not 10.** The tests did not catch either of the two problems this audit
found. The stale bundle was invisible to them by construction - vitest runs the
source, so the divergence only existed in production paths - and the sampling
inadequacy was a wrong premise, which tests written from the same premise cannot
catch. Both now have regression tests. The lesson is that a corpus of real
models found what a test suite could not, and the corpus is not in CI.

---

## Does this product create real economic value?

**On the evidence I have: no.** Not enough to pay for, and not enough to be
worth the user's afternoon.

I am going to state the numbers before the excuses.

### What was measured

All 103 models of the LDraw Official Model Repository, 29 to 8,149 parts,
$21,292 of estimated parts in total, run through the optimizer at the default
safety level with demo prices. Method and criteria: `docs/VALIDATION_PLAN.md`,
written before the run. Full data: `docs/validation-results.json`.

| | |
| --- | ---: |
| Median saving | **$0.08** |
| Median saving, percent | **0.1%** |
| Mean saving | $1.64 (0.5%) |
| 25th / 75th percentile | $0.00 / $1.40 |
| Models saving nothing at all | **41.7%** |
| Models saving over $5 | 8.7% |
| Models saving over $10 | 5.8% |
| Models saving over $20 | 1.9% |
| Models saving over $50 | 0% |
| Models reaching 10% | **0%** |
| Best single result | $23.25 on a $783 model (3.0%) |
| Best percentage | 5.0% (B-wing, $13.46) |
| Total across the whole corpus | $169 of $21,292 = **0.8%** |
| Savings from color changes | 96.8% |

Correlation of savings with part count is 0.54 - bigger models save more in
absolute terms, which is the one encouraging line in the table - but with
percentage only 0.29. Even among the 29 models over 1,500 parts the median
saving is **$2.43**.

### Against the criteria fixed in advance

- **Strong signal** required median ≥10% AND median above $20 on large models.
  Measured: 0.1% and $2.43. Not close.
- **Weak signal** was any of: median below 5%, median absolute below $10, or
  fewer than a quarter of models clearing $10. **All three** are true (0.1%,
  $0.08, 5.8%).

The plan says weak signal means stop or change the product. That is the finding.
I am not going to move the thresholds now that I can see the numbers.

### Why, mechanically

The optimizer is not failing. It is reporting the truth about these models.

Across a sample of three large sets, of the pieces it declined to change:

| Reason | Pieces | |
| --- | ---: | --- |
| Visible from outside | 5,375 | 77% |
| Reused submodel with a visible copy | 1,533 | 22% |
| Drawn in inherited color 16 | 386 | 6% |
| Everything else | ~55 | <1% |

**Three quarters of the parts in a LEGO model can be seen.** The median model in
this corpus has 0.8% of its pieces fully hidden. There is very little buried
plastic, and what is buried is often already a cheap color, because the designer
had no reason to spend on it either.

This is a fact about how LEGO models are built, not a gap in the software. No
amount of engineering makes an exterior brick invisible.

### An honest note about the earlier numbers

An earlier version of this software reported far better results - 13.5% on
Apollo Saturn V where the corrected engine reports 3.9%. Those numbers were
wrong: the visibility worker was running a stale bundle and the sampling method
could not find parts visible through gaps. Fixing that withdrew about 45% of
proposed changes and cut measured savings by roughly two thirds.

So the honest summary of this project's arc is that **the product looked
viable until it was measured correctly.** That is worth saying plainly, because
the temptation to stop auditing while the numbers still look good is exactly
what the audit exists to resist.

### The one part that worked

The feature that tells the user we found nothing is doing its job. Of 103
models, 95 were rated "already cost-efficient" and 1 "not worth acting on" -
and that is the correct answer for those models. A tool that had reported a
result for all 103 would have been lying 96 times.

### What would have to be different

Not excuses - the specific things that could change the answer, and how much I
believe each:

1. **Reused submodels (most promising).** 22% of declined pieces are lines
   shared between hidden and visible copies. Splitting the submodel would unlock
   them, at the cost of changing the file's structure and therefore the build
   instructions. On Cafe Corner alone that is 1,163 pieces. The value is
   unmeasured, and those particular pieces are mostly already-cheap tan and
   white, so I would not assume it rescues the number.
2. **Fan MOCs rather than official sets.** The biggest unknown, and it cuts both
   ways: MOCs are often display models with more open interiors, which would be
   worse, not better. This needs measuring, not assuming.
3. **Live BrickLink prices.** Real color rarity spreads may be wider than the
   demo dataset's. This would change absolute dollars; it is unlikely to move a
   0.1% median by two orders of magnitude.
4. **Used-condition pricing**, where color premiums are larger.

### The recommendation

As a paid product, on this evidence: no. As a free tool that occasionally finds
$10-20 on a large, colorful, interior-heavy model - Blockade Runner, Apollo,
the B-wing - it is genuinely useful, and it is honest about the other 95 cases.

The delivered-cost point makes it worse rather than better, and it belongs in
this verdict: a $0.08 median part-price saving cannot survive a shipping charge.
Even the $23 best case has to survive the order splitting across an extra
seller. The verify-on-BrickLink workflow exists precisely so nobody has to take
my estimate on faith, and if anything it will make these numbers look worse, not
better.
