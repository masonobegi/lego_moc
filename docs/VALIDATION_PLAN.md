# Validation plan

## What this document is for

BrickThrift works. That is not the same as BrickThrift being worth building.

The technical question - can we reliably find pieces nobody can see and swap
them for cheaper colors without changing how the model looks - is answered
elsewhere in these docs, with measurements. This document is about the
commercial question: **does that capability save enough money that somebody
would pay for it?**

The two questions are easy to confuse, because a satisfying answer to the first
feels like an answer to the second. It is not. A tool can be correct,
well-engineered and completely pointless.

## The criteria, fixed before the numbers

These are written down first, deliberately, so they cannot be adjusted after
seeing the results. Read this section before `docs/validation-results.json`.

**Strong signal - continue.** Both must hold:

- Median saving across the corpus is **at least 10%** of estimated part cost.
- Meaningful absolute savings on larger models: **median saving above $20** for
  models over 1,500 parts.

**Weak signal - stop, or change the product.** Any of:

- Median saving below **5%**.
- Most models save only a few dollars: **median absolute saving below $10**.
- Fewer than **a quarter** of models clear $10 in savings.

**In between** is genuinely in between, and the honest response is "not proven",
not "promising". If the numbers land there, the next step is a better test
(live prices, real orders), not a louder claim.

One rule that matters more than the thresholds: **do not move these numbers to
make the result look better.** If the outcome is weak, the outcome is weak. A
product that saves people $4 is not made valuable by redefining $4 as a win.

## The test

1. **Obtain 50-100 legitimate, downloadable `.ldr`/`.mpd` models of varied
   size.** The LDraw Official Model Repository is the right corpus: freely
   redistributable, real designs by real people, and it spans 29 parts to 8,149.
   Do not scrape private or paid MOCs; see `docs/RESEARCH.md` section 12.

2. **Run every model through the optimizer** at the default Extremely
   Conservative safety level, with the same price source for all of them.

   ```bash
   npx tsx scripts/validation-study.ts <models-dir> \
     --parts-library <ldraw-library-dir> \
     --out docs/validation-results.json
   ```

3. **Record per model:** estimated original part cost, savings found, savings as
   a percentage, part count, hidden-piece count and percentage, candidate count,
   pieces changed, rejected candidates, and the value rating.

4. **Analyze the distribution:** mean and median savings, median percentage,
   25th and 75th percentiles, the share of models saving over $5, $10, $20 and
   $50, and how savings correlate with model size.

The script computes all of it. It does not know what the criteria are, so it
cannot be tuned toward passing them.

## What the current run does and does not prove

The run recorded in `docs/validation-results.json` uses **demo prices**. That
is a real limitation and it cuts both ways:

- The demo dataset's relative prices are modelled on the real shape of the
  BrickLink market - rare colors cost several times common ones, and the ratios
  between the seeded parts come from observed listings - so the *structure* of
  the result (which models have expensive hidden interiors, how savings scale
  with size) is meaningful.
- The absolute dollar figures are not real prices. A median saving of $X in demo
  dollars is not a claim that a builder saves $X.

So the current run can support a conclusion of the form "hidden-color
optimization finds roughly N% of part cost on a typical model", and it cannot
support "you will save $N". Re-running against live BrickLink prices with
credentials configured is the obvious next step and needs no code changes.

There is a second, larger gap. Even live part prices are not what an order
costs. Shipping, seller minimums, handling and tax are all outside anything this
application can see, and a color change can push an order onto an extra seller
and cost more than it saves. **The only honest end-to-end validation is
delivered-cost validation:** export both Wanted Lists for a model, price both
through BrickLink's own purchasing tools, and compare the two order totals. The
results page already collects those two figures and computes the error between
what we predicted and what BrickLink charged.

A proper commercial validation would gather that error across at least 20
models. Until then, every figure in this study is a parts-price estimate, and
the difference between that and a checkout price is not a rounding error.

## Threats to validity, stated plainly

- **The corpus is official LEGO sets, not MOCs.** Official sets are designed by
  people who are not paying retail for the bricks and who often use whatever
  color is convenient inside. Fan MOCs bought part by part may be built more
  cost-consciously already, which would make savings *smaller* than measured
  here; or built with whatever the designer had spare, which would make them
  larger. This is the single biggest unknown, and one that no amount of running
  more official sets will resolve.
- **Demo prices, as above.**
- **A saving is only banked if the builder acts on it.** Re-exporting a model,
  re-importing it into Studio and re-pricing an order is real work. A $6 saving
  that takes twenty minutes to realise is not obviously worth it.
- **Selection by availability.** The OMR contains the sets people chose to
  digitise, which skews toward large, popular, well-loved sets. That is roughly
  the population that would use this tool, so the skew is not fatal, but it is
  not a random sample either.
- **Savings and safety trade against each other.** These figures come from the
  default Extremely Conservative level after the observer pass landed, which
  withdrew about 45% of previously proposed changes as unsafe. An earlier,
  less careful version of this software reported substantially higher savings.
  Those numbers were wrong. Any future change that increases reported savings
  must be checked against `docs/AUDIT.md`'s false-positive measurement before
  being believed.

## The answer

The measured outcome and the verdict against the criteria above are in
`docs/AUDIT.md`, under "Does this product create real economic value?".
