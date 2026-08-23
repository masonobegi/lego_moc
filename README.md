# BrickThrift

**Make expensive LEGO builds cheaper without changing how they look.**

BrickThrift analyzes an LDraw model, works out which pieces have no externally
visible surface in the finished build, and shows you where a cheaper color buys
you exactly the same model. Geometry, construction and build steps stay
identical. It exports an optimized `.ldr`/`.mpd` you can open straight back in
BrickLink Studio.

It is not a generic BrickLink price optimizer. It changes the design itself, in
the one way that costs nothing visually, and leaves everything else alone.

---

## Quick start

```bash
git clone <this-repo>
cd lego_moc
npm install
npm run dev
```

Open <http://localhost:3000>.

That is the whole setup. There is **no database to provision and no API key to
obtain**. The app ships with a labeled demo price dataset and a subset of the
LDraw parts library, so every feature works immediately.

Go to **/dev** and click **Buried brick** to watch the whole pipeline run on a
model with a known answer, or **/optimize** to upload your own.

### Requirements

- Node.js 20.9 or newer (22 recommended)
- About 300 MB of disk for `node_modules`; 1 GB more if you install the full
  parts library

### Before analyzing a real MOC

```bash
npm run parts:fetch
```

This installs the complete LDraw parts library into `public/ldraw-full/`
(~500 MB, git-ignored) and it is picked up automatically. Without it, parts
outside the bundled subset have no geometry - the model still imports, but those
parts can never be optimized, and the results page tells you which ones.

On a network that cannot reach `library.ldraw.org`, use the GitHub mirror:

```bash
npm run parts:fetch -- --mirror
```

Add `--models` to also download LDraw Official Model Repository files (real
official LEGO sets) into `test-models/omr/` for testing.

---

## Environment variables

Everything is optional. Copy `.env.example` to `.env.local` to change any of it.

| Variable | Default | What it does |
| --- | --- | --- |
| `PRICE_SOURCE` | `demo` | `demo` or `bricklink`. Falls back to `demo` with a visible warning if credentials are missing. |
| `BRICKLINK_CONSUMER_KEY` | - | BrickLink API credential |
| `BRICKLINK_CONSUMER_SECRET` | - | BrickLink API credential |
| `BRICKLINK_TOKEN_VALUE` | - | BrickLink API credential |
| `BRICKLINK_TOKEN_SECRET` | - | BrickLink API credential |
| `BRICKLINK_GUIDE_TYPE` | `stock` | `stock` (current items for sale) or `sold` (last 6 months) |
| `BRICKLINK_CONDITION` | `N` | `N` new or `U` used |
| `BRICKLINK_CURRENCY` | `USD` | ISO 4217 code |
| `BRICKLINK_COUNTRY_CODE` | - | Restrict to stores in one country |
| `BRICKLINK_REGION` | - | Restrict to a region: `europe`, `north_america`, ... |
| `REBRICKABLE_API_KEY` | - | Only used by `npm run catalog:import` |
| `LDRAW_LIBRARY_PATH` | `public/ldraw-full` | Point at an existing LDraw installation instead |

### Live BrickLink pricing

1. Sign in to BrickLink and register a consumer at
   <https://www.bricklink.com/v2/api/register_consumer.page>.
2. **Register the public IP address your server will call from.** BrickLink API
   credentials are IP-locked; requests from an unregistered IP are rejected.
3. Put the four values in `.env.local` and set `PRICE_SOURCE=bricklink`.

Credentials are read on the server only and never reach the browser. The daily
limit is 5,000 requests and there is no bulk price endpoint, so prices are
cached in `.brickthrift/price-cache.json` for 24 hours and alternative colors
are only priced for parts already known to be hidden.

**This implementation has never been executed against the live BrickLink API**
(see `docs/RESEARCH.md` §0). The request shape follows BrickLink's documentation
and two maintained client libraries, and the OAuth 1.0a signing is unit-tested,
but the first live call will be the first real test. The app reports whether it
has had a successful response.

---

## What it does

- **Reads LDraw properly.** `.ldr` and `.mpd`, submodels at any depth,
  `0 STEP`, `0 FILE`/`0 NOFILE`, and every META command it does not recognise.
  A file that goes in unchanged comes back byte for byte.
- **Builds the real model.** Actual LDraw part geometry resolved down to
  primitives, in a two-level BVH.
- **Casts rays, not guesses.** Points across each part's real triangle surface,
  rays in directions over the whole sphere. One escaping ray disqualifies a part.
- **Looks at the model from outside.** A second pass views the finished model
  from ~100 directions, including from underneath, and any part that shows up
  through a gap is left alone - the test that actually catches narrow lines of
  sight.
- **Checks you can buy it.** A replacement color stocked in four lots worldwide
  is not a saving. Supply is assessed against the quantity your build needs, and
  poorly stocked replacements are rejected unless the saving is large enough to
  absorb a shipping charge.
- **Checks the color exists.** A cheaper color is only proposed when catalog
  data evidences that the part has been produced in it.
- **Preserves your build.** Changes are written by rewriting the color field of
  the existing line, in place. Nothing moves, nothing is reordered, no step
  changes.
- **Shows its working.** Every change carries the ray count, the triangle
  coverage, the confidence and the evidence behind it.

### What it deliberately does not do

- No structural redesign, no changing how parts connect.
- Never replaces one piece with several.
- No checkout price. Shipping, seller minimums, lot availability and tax are not
  included, and it never claims otherwise: everything it shows is an
  **estimated part cost**. For the real answer it exports your original and
  optimized Wanted Lists so BrickLink - which does know about sellers and
  shipping - can price both, and you compare the totals.
- No shipping calculator and no seller picker. BrickLink has those already; a
  confident number computed without the data would be worse than no number.
- Analyzes the completed model as supplied - not detachable roofs, hinged panels
  or half-built states.
- Does not generate instructions. It preserves your step structure so Studio can.

---

## Using it with BrickLink Studio

**Studio to BrickThrift**

1. Open your model in Studio.
2. **File → Export As → Export Model**, choosing `.ldr` or `.mpd`.
   Keep `.mpd` if your model uses submodels; BrickThrift preserves that
   structure exactly.
3. Drop the file on `/optimize`.

**BrickThrift back to Studio**

1. Download **Optimized model** from the results page.
2. In Studio: **File → Import → Import Model**, and choose the file.
3. Your `0 STEP` boundaries survive the round trip, so **Instruction Maker**
   produces instructions for the optimized model.

Studio's own `.io` format is not read by this version. It is a
password-protected archive; exporting to LDraw is one menu item and loses
nothing this tool needs.

---

## Testing with real models

Two sources of real `.ldr`/`.mpd` files:

**LDraw Official Model Repository** - official LEGO sets modeled in LDraw,
licensed CC BY 2.0.

```bash
npm run parts:fetch -- --mirror --models   # into test-models/omr/
```

Then drop any file from `test-models/omr/` on `/optimize`. These files are
**not** committed to this repository: they are individually authored and their
attribution requirements are per-model. See `NOTICE.md`.

**BrickLink Studio Gallery** - <https://www.bricklink.com/v3/studio/gallery.page>.
Some designers publish models with Full Access, which permits downloading the
Studio file. Open it in Studio, export to LDraw, and analyze that. Only use
models whose designer has granted download permission; this project does not
automate around access controls and neither should you.

---

## Test models

`test-models/` contains eight hand-built fixtures with known expected outcomes.
`test-models/README.md` documents the exact geometry of each.

| File | Expected |
| --- | --- |
| `exposed-brick.ldr` | No change |
| `buried-brick.ldr` | Red to black, saving $0.63 |
| `partially-visible.ldr` | No change |
| `gap-visible.ldr` | No change - visible only through a one-stud window |
| `multi-step.mpd` | Red to black, part stays in step 3 |
| `submodel.mpd` | Change applied two submodel levels down |
| `multiple-instances.mpd` | Only the submodel whose every copy is hidden changes |
| `transparent-window.mpd` | Only the brick in the opaque box changes |

They go through exactly the same code an upload does. Nothing is special-cased.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on :3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | 252 unit and integration tests |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run typecheck` | TypeScript, strict |
| `npm run bench` | Performance benchmark |
| `npm run parts:fetch` | Install the full LDraw parts library |
| `npm run catalog:import` | Import Rebrickable catalog data |
| `npm run colors:build` | Regenerate the color table from `LDConfig.ldr` |
| `npm run parts:bundle -- <lib>` | Regenerate the bundled parts subset |
| `npm run workers:build` | Bundle the visibility worker (runs automatically) |
| `npx tsx scripts/validation-study.ts <dir>` | Run a model corpus and report the savings distribution |

`npm run test:e2e` needs a browser. If Playwright's managed browser is not
installed, run `npm run test:e2e:install`, or point at an existing one with
`CHROMIUM_PATH=/path/to/chrome`.

---

## Documentation

| Document | Contents |
| --- | --- |
| `docs/RESEARCH.md` | Format and API research, and every limitation it revealed |
| `docs/ARCHITECTURE.md` | How it is put together and why, including the decisions that are not obvious |
| `docs/PERFORMANCE.md` | Benchmarks and what makes it fast |
| `docs/AUDIT.md` | Honest self-assessment, scored, with the weaknesses named |
| `docs/VALIDATION_PLAN.md` | How to test whether this is commercially worth building, with criteria fixed in advance |
| `docs/validation-results.json` | The measured savings distribution across the model corpus |
| `NOTICE.md` | Third-party data, licenses and attribution |
| `test-models/README.md` | Fixture geometry and expected outcomes |

---

## Known limitations

Read `docs/AUDIT.md` for the full list. The ones most likely to affect you:

1. **Reused submodels are the largest source of missed savings.** A submodel
   used more than once is one line in the file. If any copy is visible the line
   is left alone, even when the others are sealed inside the model. On Cafe
   Corner that is 1,200 hidden pieces left untouched.
2. **Offline color coverage is narrow.** Without a Rebrickable import, color
   validity comes from ~2,000 parts observed in 101 official sets. A part not in
   that data never gets a proposal.
3. **How much you save depends entirely on the model.** Measured across 15
   official LEGO sets with the demo price data, savings ranged from **0% to
   13.5%**. Models with substantial hidden internal structure do well (NASA
   Apollo Saturn V 13.5%, B-wing 11.2%, Great Wall of China 8.1%); models that
   are mostly exterior surface do not (TIE Interceptor 0.0%, Black Seas
   Barracuda 0.0%). A MOC built from whatever colors the designer happened to
   have plenty of typically has more headroom than an official set.
4. **Live BrickLink pricing is untested against the real API.**
5. **The Wanted List XML has not been round-tripped through a real import.**
6. **`.io` files are not read.** Export to LDraw from Studio first.

---

## Attribution

Part geometry and color definitions come from the
[LDraw Parts Library](https://www.ldraw.org/), licensed CC BY 2.0. Credit to
LDraw.org and the individual part authors. See `NOTICE.md`.

LEGO is a trademark of the LEGO Group, which does not sponsor, authorise or
endorse this project. BrickLink is a trademark of BrickLink Ltd.

Source code is MIT licensed; see `LICENSE`.
