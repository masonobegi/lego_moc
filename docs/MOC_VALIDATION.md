# Community-MOC validation

# KILL AS PAID PRODUCT

Automatic hidden-colour optimization is **not a compelling standalone paid
product** on the evidence available.

One thing must be said in the same breath as that verdict, because it is the
thing you commissioned and I did not deliver: **the community-MOC population
could not be sampled from this environment.** Every legitimate source is
unreachable, and the five community models I could obtain are not a sample. The
verdict therefore rests on the 103 official sets, plus five community models
that show no improvement over them, plus an oracle showing that the one
remaining engineering idea is worth almost nothing.

If you want that verdict overturned, the way to do it is to supply 50-100 real
MOCs by hand — the workflow is at the bottom of this document — and re-run one
command. I would not expect it to overturn, for reasons given under "why", but
it is the honest test and it has not been run.

---

## 1. What was actually measured

| Population | n | Status |
| --- | ---: | --- |
| Official LEGO sets (LDraw OMR) | 103 | Measured, corrected, reliable |
| Community MOCs | **5** | **Not a sample. Anecdote only.** |

Both were run through the unmodified optimizer, same safety level (Extremely
Conservative), same demo price source, same corrected visibility methodology,
and the population statistics for both come out of the same function so a
difference between columns is a difference between populations rather than
between two definitions of "median".

Raw data: `docs/moc-validation-results.json`,
`docs/validation-results-corrected.json`.

---

## 2. Acquisition: why there are five and not a hundred

This is a hard blocker, not a shortfall of effort.

**Every preferred source is unreachable from this environment.** Measured, not
assumed - each returns 403 at the network policy layer on CONNECT:

| Host | Result |
| --- | --- |
| bricklink.com | blocked |
| rebrickable.com | blocked |
| bricksafe.com | blocked |
| ldraw.org, omr.ldraw.org | blocked |
| github.com (plain git) | **reachable** |
| api.github.com | locked to this session's own repository |

BrickLink Studio Gallery is doubly out of reach: unreachable, and it would
require authentication plus a per-model Full Access flag. Circumventing either
was out of scope and remains so.

That leaves cloning public GitHub repositories **by exact name**. GitHub's code
and repository search APIs are unavailable, so there is no discovery mechanism -
names have to be recalled and then verified one at a time. A seven-agent sweep
checked roughly fifty candidate repositories and found:

- **One** repository containing genuine community-designed LEGO models:
  `LasseD/buildinginstructions.js` (public, Unlicense).
- Everything else was official-set recreations already in the 103, renderer
  fixtures of 0-7 parts, colour swatch charts, machine-generated models, or
  non-LEGO systems (TENTE, VEX IQ).

**Five distinct community models, by two designers, from one renderer's test
fixture directory.** Deduplicated by subject - four of the eight candidate files
were second copies of the same builds.

### Why these five cannot answer the question

- **n = 5, and n(designers) = 2.** Four of the five are by one person. Any
  statistic is a statistic about Lasse Deleuran's building habits.
- **Selection is on the dependent variable.** The files are named
  `ldcad_motor_test`, `test_ldcad_pf`, `test_spike_philo` - they exist because
  they stress motors, Power Functions and flexible parts in a renderer. Models
  built around Technic internals have systematically atypical hidden interiors,
  because functional beams, axles and gears come in whatever colour the part is
  moulded in. That is precisely the variable under study.
- **No category coverage.** Vehicles and Technic robots only. No buildings, no
  spacecraft, no sculptures, no animals, no microscale, no castle or town - none
  of the genres where hidden-colour economising is most discussed. The brief
  asked for diversity across ten categories; this covers two.
- **Not display models.** An FLL competition robot and a motorised trailer are
  functional builds, not the curated MOCs people publish and sell instructions
  for.
- **Toolchain and era skew.** All authored in LDCad by LDraw-ecosystem insiders.
  The mainstream MOC population builds in Studio and publishes to Rebrickable.
- **Survivorship.** These files are on GitHub because a developer needed test
  fixtures, not because anyone judged them representative.

Contaminants were excluded deliberately, and excluding them mattered: the same
directory contains `pyramid50.ldr` - 42,925 parts, author `BuildPyramid.java`,
cycling 162 distinct colours - along with colour and material swatch charts. Any
of those would have manufactured a spectacular false positive. Also excluded:
`mf.mpd` (official set 10179), `test_assembly2.mpd` (official set 1702), and the
`omr_*.mpd` files, all of which are official sets already in the baseline.

---

## 3. A measurement bug found and worked around

Before any of the numbers below could be trusted, the instrument had to be
fixed.

An MPD may carry its own copy of a part's definition as a `0 FILE 3001.dat`
block, so the file renders on a machine without the parts library. It is the
normal way to share a self-contained model, and community MOCs use it far more
than official-set files do. The LDraw specification says an in-document sub-file
takes precedence over a library part of the same name, and `resolveModel`
follows that faithfully - which means it descends **into** the inlined part and
emits the primitives that make it up (`4-4edge`, `stud`, `4-4cyli`) as though
each were a piece you buy. They were then counted, priced and ray-traced as
bricks.

Share of "parts" that were actually primitives:

| Model | Contamination |
| --- | ---: |
| All five community MOCs | **100%** |
| 6286 Skulls Eye Schooner | 70% |
| 10283 NASA Space Shuttle Discovery | 52% |
| 75144 Snowspeeder | 30% |
| 10179 Millennium Falcon UCS | 10% |
| 21309 NASA Apollo Saturn V | 0% |

36 of the 103 official-set models were affected. The inlined blocks declare
`0 !LDRAW_ORG Unofficial_Part` - LDraw's own marker for "this is a piece, not an
assembly" - so the resolver has the information and does not use it.

**This is a product defect and it is not fixed here**, because the instruction
was to measure rather than change the optimizer. It is worked around at the
corpus level by `scripts/normalize-inlined-parts.ts`, which un-inlines a
definition when the library already has the part and extracts it to a private
parts directory when it does not but declares itself a part. Genuine
sub-assemblies are untouched. After preparation the Space Shuttle is 2,320 parts
rather than 8,149, and four of the five MOCs are entirely clean.

**Effect on the previously published verdict: none.** The corrected official-set
baseline is median $0.08 and 0.2% against the contaminated run's $0.08 and 0.1%.
The bug materially changed individual models and did not change the population
result. That is worth stating plainly rather than quietly: I reported figures
computed on corrupted data, and re-running on clean data happened to reproduce
them.

---

## 4. Community MOCs, model by model

Five models. This is the whole population, listed individually because
aggregating five numbers into a median dignifies them beyond what they support.

| Model | Designer | Category | Parts | Est. part cost | Savings | % | Hidden | Changed pieces |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chevrolet Corvette C7.R | Lasse Deleuran | vehicle - car | 692 | $100.89 | $0.49 | 0.49% | 1.9% | 11 |
| Coca-Cola trailer, motorised | Lasse Deleuran | vehicle - truck | 3,088 | $650.82 | $0.20 | 0.03% | 0.7% | 12 |
| Spike Prime build | Philippe Hurbain | technic | 6,604 | $560.70 | $0.58 | 0.10% | 0.1% | 2 |
| FLL 2017 robot | Lasse Deleuran | technic - robot | 197 | $78.82 | $0.00 | 0.00% | 0.0% | 0 |
| Northern Light (ship) | Lasse Deleuran | display - ship | 29 | $5.22 | $0.00 | 0.00% | 0.0% | 0 |

All files `.mpd`, all from `github.com/LasseD/buildinginstructions.js` (public,
Unlicense; the Spike Prime file carries CCAL 2.0 in its own header).

Average saving per changed piece where anything changed: $0.045, $0.017 and
$0.29 respectively. High-confidence savings: **$0.00** across all five, because
demo pricing reports no marketplace supply data and a change cannot be called
high-confidence without it.

---

## 5. Community MOCs against official sets

Same code, same settings, both columns.

| Metric | Community MOCs (n=5) | Official sets (n=103) |
| --- | ---: | ---: |
| Median savings | $0.20 | $0.08 |
| Mean savings | $0.25 | $1.61 |
| Median savings % | **0.03%** | **0.16%** |
| Mean savings % | 0.12% | 0.57% |
| 25th percentile | $0.00 | $0.00 |
| 75th percentile | $0.49 | $1.40 |
| 90th percentile | $0.54 | $2.90 |
| % saving $0 | 40% | 41.7% |
| % saving > $5 | **0%** | 8.7% |
| % saving > $10 | 0% | 5.8% |
| % saving > $20 | 0% | 1.9% |
| % saving > $50 | 0% | 0% |
| % saving >= 5% | **0%** | 1.0% |
| % saving >= 10% | **0%** | 0% |
| % saving >= 20% | 0% | 0% |
| Median hidden pieces | 0.1% | 0.72% |
| Mean hidden pieces | 0.54% | 1.81% |

By size:

| Band | Community | Official |
| --- | --- | --- |
| small (<250) | n=2, median $0.00 | n=33, median $0.00 |
| medium (250-999) | n=1, $0.49 (0.49%) | n=37, median $0.06 (0.03%), p90 $0.97 |
| large (1000-2999) | n=0 | n=25, median $2.43 (0.85%), p90 $13.32 |
| very large (3000+) | n=2, median $0.39 (0.07%) | n=8, median $2.25 (0.29%), p90 $3.62 |

### Did community MOCs show higher hidden-piece counts, more expensive internal colours, or larger savings?

**No, on all four measures.** Every one goes the wrong way for the hypothesis:

- Hidden pieces: 0.1% median against 0.72%.
- Absolute savings: $0.20 against $0.08 median - nominally higher, but on models
  costing $100-650 rather than the baseline's mixed range, so as a fraction it
  is lower.
- Percentage savings: 0.03% against 0.16%.
- Share reaching any meaningful threshold: zero on every one.

**This is not evidence that MOCs are worse than official sets.** With n=5 from
two designers, selected for Technic content, it is not evidence of anything
about the population. What it does establish is narrower and still useful: the
five community models available did not behave differently in the direction the
product needs, and nothing here justifies continuing on the expectation that
they would.

---

## 6. The reused-submodel oracle

*Measured across all 103 official sets, on the prepared corpus described in
section 3. The community corpus is too small and too Technic-heavy to add
anything.*

The optimizer refuses to recolour a line when its submodel is used more than
once and at least one copy is visible. Splitting such submodels so hidden copies
can be recoloured independently is the obvious next feature and a structural
rewrite of the model file. `scripts/submodel-oracle.ts` measures its ceiling by
handing the hidden subset of every mixed group to the unmodified colour
optimizer and practicality gate - so the bound respects the same colour
validity, safety and availability rules the product ships with. The split itself
is assumed free, which no real split is.

```
Current measured savings:              $165.65   (0.9% of a $17,439 corpus)
Maximum additional from perfect split:  $13.30
Theoretical total:                     $178.95   (1.0%)
```

- Adds **nothing at all** on 87 of 103 models.
- Adds more than $5 on **one** model.
- Adds more than $20 on **none**.
- Median additional saving: **$0.00**.
- Best case: Apollo Saturn V, $13.45 to $21.79 (3.9% to 6.4%).
- Pieces in genuinely mixed groups across the whole corpus: **277**.

**Y is trivial. Do not implement submodel splitting.** It moves the corpus from
0.9% to 1.0% and would change no commercial conclusion.

This also corrects something I reported earlier, twice over. I described reused
submodels as the largest addressable opportunity, citing 1,163 pieces on Cafe
Corner. That was a misreading of the `mixed_visibility` rejection label, which
fires whenever a group's instances have *differing* classifications - including
VISIBLE plus LIKELY_VISIBLE, where nothing is hidden at all. I then corrected it
to 278 pieces, which was measured on the contaminated corpus. On clean data Cafe
Corner has **16** genuinely mixed hidden pieces, worth $1.54. The money was
right both times; the piece count was wrong both times, and in both cases the
error made the remaining opportunity look larger than it is.

---

## 7. Why the answer is what it is

The optimizer is not underperforming. It is reporting a fact about LEGO models.

Across a sample of large sets, of the pieces declined: **77% are declined
because they are visible.** The median model in the corrected baseline has
**0.72%** of its pieces fully hidden; the five MOCs, 0.1%. Three quarters of a
LEGO model can be seen, and the small fraction that cannot is usually already a
cheap colour, because the designer had no reason to spend on it either.

There is no engineering fix for that. It is the shape of the problem.

A plausible reason MOCs may be *worse* than official sets, rather than better -
worth stating because the hypothesis was that they would be better: fan
designers buying part by part on BrickLink already feel every expensive colour
they choose. They have the incentive the product is trying to supply, and they
have already acted on it. Official set designers do not pay retail. If anything,
the theory predicts the opposite of the hypothesis.

---

## 8. Against the thresholds you set

Fixed before the numbers, not adjusted after.

| Criterion | Threshold | Community MOCs | Official sets |
| --- | --- | --- | --- |
| **Strong** | median >= 10% and common meaningful absolute savings | 0.03% | 0.16% |
| **Niche** | median 5-10% with a substantial $20+ tail | 0.03%, no tail | 0.16%, 1.9% over $20 |
| **Weak / kill** | median < 5%, or few dollars, or rare outliers only | **all three** | **all three** |

Both populations land in "weak / kill" on every condition, by two orders of
magnitude rather than narrowly.

---

## 9. Conclusion

**KILL AS PAID PRODUCT.**

Automatic hidden-colour optimization does not save enough money for anyone to
pay for it. The median model saves pennies, four in ten save nothing, none
reaches 10%, the one remaining engineering idea is worth 0.1% of corpus cost,
and the delivered-cost picture is worse still - a $0.08 median part-price saving
cannot survive a single shipping charge.

What the software is genuinely good at is narrower and real: it finds $10-20 on
a small number of large, colourful, interior-heavy models (Blockade Runner,
Apollo Saturn V, the B-wing), and it tells the other 95 models' owners that
there is nothing worth doing - correctly, 94 times out of 103. That is a
defensible free tool. It is not a business.

### The one open question, and how to close it

The community-MOC population remains untested at any useful scale. If you want
that answer:

1. **Obtain the models manually.** From BrickLink Studio Gallery, download
   Studio files only where the creator has enabled downloading and the
   submission is Full Access; export each to LDraw via
   *File → Export As → Export LDraw*. Rebrickable free MOCs with LDraw files
   work equally well. Aim for 50-100 across buildings, vehicles, spacecraft,
   mecha, sculptures, animals, display models and Technic, at a spread of sizes,
   and **do not filter by what looks promising** - the selection is the
   experiment.

2. **Drop them in a directory with a metadata sidecar** listing `file`, `name`,
   `source`, `designer`, `category`, `fileType` for each - the format is in
   `docs/moc-validation-results.json` under `community.rows`.

3. **Run two commands:**

   ```bash
   npx tsx scripts/normalize-inlined-parts.ts <your-mocs> /tmp/mocs-prepared \
     --parts-library <ldraw-library>

   npx tsx scripts/moc-validation.ts /tmp/mocs-prepared \
     --metadata <your-mocs>/metadata.json \
     --parts-library "<ldraw-library>,/tmp/mocs-prepared/_extracted-parts" \
     --baseline docs/validation-results-corrected.json \
     --out docs/moc-validation-results.json
   ```

   The first step is required, not optional: without it a self-contained MPD is
   measured as a bag of primitives. That is the defect in section 3, and it
   should be fixed in the resolver before this tool is used on community files
   in earnest.

The result prints both populations side by side against the same thresholds. If
the community median comes back at or above 5%, this verdict deserves
revisiting. On the evidence available, I do not expect it to.
