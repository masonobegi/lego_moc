# Phase 1 Research

All findings below were verified during development of this project. Where a primary source
could not be reached from the build environment, that is stated explicitly rather than papered
over. **Anything that limits the product is called out in bold.**

---

## 0. Research environment limitations (read this first)

This project was developed inside a sandboxed environment with a restrictive outbound network
policy. The following hosts were **blocked at the egress proxy** (HTTP 403 on CONNECT):

| Host | Needed for | Status |
| --- | --- | --- |
| `www.ldraw.org`, `library.ldraw.org` | Format specs, parts library download | **Blocked** |
| `rebrickable.com`, `cdn.rebrickable.com` | API + CSV catalog downloads | **Blocked** |
| `api.bricklink.com`, `www.bricklink.com` | Price Guide API + API docs | **Blocked** |
| `en.wikipedia.org`, `cdn.jsdelivr.net`, `unpkg.com` | general | **Blocked** |

Reachable: `registry.npmjs.org`, `raw.githubusercontent.com`, anonymous git clone of public
GitHub repositories, and a web-search tool that returns summarised content from the blocked
pages.

**Consequences for this repository, and how each was handled:**

1. **LDraw parts library** — obtained from the GitHub mirror
   [`gkjohnson/ldraw-parts-library`](https://github.com/gkjohnson/ldraw-parts-library) (a
   verbatim upload of the official `library.ldraw.org` complete distribution, Jan 2023). The
   mirror carries the original `CAreadme.txt` / `CAlicense.txt` and the original part headers
   with `0 !LICENSE Redistributable under CCAL version 2.0`, so provenance is verifiable.
   `scripts/fetch-ldraw-library.ts` defaults to the official `library.ldraw.org` URL and falls
   back to the GitHub mirror, so a user on an unrestricted network gets the official source.
2. **Rebrickable CSVs** — could not be downloaded here. `npm run catalog:import` is implemented
   against the documented CDN URLs and will work on an unrestricted network. **The repository
   therefore ships a bundled fallback catalog derived from real LDraw Official Model Repository
   files instead** (see §9). This is a genuine, citable data source — not invented data — but it
   has materially narrower coverage than Rebrickable, which the app surfaces in the UI.
3. **BrickLink Price Guide** — the live provider is implemented against the documented endpoint
   and OAuth 1.0a scheme, but **it has never been executed against the real API from this
   environment**. It is shipped as "implemented, untested against live credentials" and the app
   says so. Demo Mode is the default and is fully exercised by tests.
4. **BrickLink Wanted List XML** — the format is confirmed against a working third-party
   exporter (see §11) but **has not been round-tripped through a real BrickLink/Studio import
   from this environment**, so the app labels the export as unverified and tells the user how to
   verify it.

---

## 1. LDraw `.ldr` file format

Primary spec: <https://ldraw.org/article/218.html> (LDraw File Format 1.0.2). Reached via web
search summarisation; cross-checked line-by-line against ~19,000 real `.dat` part files and 104
real official-set `.mpd` models in the mirrored library, which is a stronger practical check
than reading the prose alone.

### Line types

An LDraw file is line-oriented. Leading/trailing whitespace is insignificant. The first
whitespace-delimited token on a line is the **line type**:

| Type | Meaning | Syntax |
| --- | --- | --- |
| `0` | Comment or META command | `0 // comment` or `0 !META ...` or `0 free text` |
| `1` | Sub-file reference (a part or submodel) | `1 <colour> x y z a b c d e f g h i <file>` |
| `2` | Line | `2 <colour> x1 y1 z1 x2 y2 z2` |
| `3` | Triangle | `3 <colour> x1 y1 z1 x2 y2 z2 x3 y3 z3` |
| `4` | Quadrilateral | `4 <colour> x1 y1 z1 x2 y2 z2 x3 y3 z3 x4 y4 z4` |
| `5` | Optional line | `5 <colour> x1 y1 z1 x2 y2 z2 x3 y3 z3 x4 y4 z4` |

A blank line is legal and carries no meaning. Anything else is invalid; this parser preserves
unparseable lines verbatim as `raw` commands rather than discarding them.

### Line type 1 transformation

`a`..`i` are the top-left 3×3 of a 4×4 homogeneous transform; `x, y, z` are the translation.
The spec states the transform explicitly as:

```
u' = a*u + b*v + c*w + x
v' = d*u + e*v + f*w + y
w' = g*u + h*v + i*w + z
```

so the 3×3 is **row-major** `[[a,b,c],[d,e,f],[g,h,i]]` applied as `M·p + t`. Composing nested
references multiplies these matrices. Note the matrix may include scaling and **mirroring**
(negative determinant), which real parts use — a mirrored reference flips triangle winding, and
the geometry builder in this project accounts for that when computing surface normals.

### Coordinate system and units

* 1 LDU (LDraw Unit) = 0.4 mm.
* A standard brick footprint is 20 LDU × 20 LDU per stud; a brick is 24 LDU tall; a plate is
  8 LDU tall.
* **`-Y` is up.** LDraw is a right-handed system with Y increasing downward. This matters for
  the viewer (the model is rotated so it appears upright) and for the "underside visibility"
  reasoning in the visibility engine.

### File references

The `<file>` field of a line type 1 is a filename. It may contain spaces (real OMR models rely on
this: `1 16 0 0 0 1 0 0 0 1 0 0 0 1 10182 - Ground floor.ldr`), so it must be parsed as
"everything after the 14th token", never by splitting on whitespace. It uses `\` as a path
separator (e.g. `s\3001s01.dat`) which must be normalised to `/` for filesystem/URL lookup, and
resolution is **case-insensitive** in practice.

### Colour values in geometry

Two colour values are special inside part files:

* **16** — "inherit": use the colour the caller specified for this sub-file reference.
* **24** — "complement/edge": use the caller's edge colour.

**Limitation:** because 16 is an inherit sentinel rather than a real colour, it must be excluded
when deriving "which colours does this part exist in" from model files, and a part instance
placed with colour 16 in a top-level model cannot be recoloured meaningfully. The optimiser
skips colour 16 and 24 instances.

---

## 2. LDraw `.mpd` file format

Primary spec: <https://www.ldraw.org/article/47.html> (MPD — Multi-Part Document).

* `0 FILE <name>` starts a new named sub-file. Everything up to the next `0 FILE` (or EOF)
  belongs to it.
* **The first `0 FILE` in the document is the main model.** Everything before the first
  `0 FILE` (if the file does not start with one) is treated as the main model in a
  single-file `.ldr`.
* `0 NOFILE` ends the current sub-file without starting a new one. Content after `0 NOFILE`
  and before the next `0 FILE` is not part of any sub-file.
* A line type 1 whose filename matches a `0 FILE` name in the same document resolves to that
  in-document sub-file, **taking precedence over a same-named file in the parts library**.
* Sub-file name matching is **case-insensitive** and treats `\` and `/` as equivalent.
* Submodels may be nested to arbitrary depth. **A malformed or malicious MPD can declare a
  cycle** (`A` references `B` references `A`); the spec does not forbid it. This parser detects
  cycles and refuses to expand them (see §12).

**Limitation:** an `.mpd` may reference a submodel that is *not* included in the document and
not present in the parts library (a designer's custom part). This is not an error in the format.
The app reports these as unresolved references, still imports the model, and excludes affected
instances from optimisation rather than crashing.

---

## 3. `0 STEP`

`0 STEP` is a META command. Historically, in the original LDraw renderer, it was shorthand for
`0 SAVE` plus a pause — it wrote a bitmap of everything drawn so far and waited for a keypress.
Modern tools (LPub3D, Studio, LeoCAD) interpret it as a **build-step boundary**: all parts
between the start of the file (or the previous `0 STEP`) and this `0 STEP` belong to one step of
the building instructions.

Consequences the optimiser must respect:

* Step index is *positional*, derived from how many `0 STEP` lines precede a part reference
  **within its own sub-file**.
* Each sub-file has its own independent step numbering.
* A trailing `0 STEP` at the end of a file is common and does not create an empty extra step
  with content.
* **Therefore: changing only the colour field of a line type 1, in place, cannot change any
  step assignment.** This is the structural reason the V1 optimiser is safe with respect to
  build steps, and the serializer is written so it never reorders or moves lines.

Related META commands that also affect step semantics and must be preserved verbatim:
`0 ROTSTEP` (instruction viewing angle), `0 BUFEXCHG` (LPub buffer exchange), `0 !LPUB ...`,
`0 PAUSE`, `0 WRITE`/`0 PRINT`. This parser preserves all unknown `0` lines byte-for-byte.

---

## 4. LDraw colour IDs

Defined by `LDConfig.ldr`, distributed with the parts library. Format
(`0 !COLOUR` language extension):

```
0 !COLOUR <name> CODE <code> VALUE <#RRGGBB> EDGE <#RRGGBB> [ALPHA <0-255>] [LUMINANCE <n>]
          [CHROME|PEARLESCENT|RUBBER|MATTE_METALLIC|METAL|MATERIAL <...>]
```

The version bundled here (`LDConfig.ldr`, `0 !LDRAW_ORG Configuration UPDATE 2022-03-31`)
defines **204 colours**. Key facts used by this project:

* `ALPHA` present and < 255 ⇒ **transparent colour**. This is the authoritative signal the
  visibility engine uses to decide a part cannot occlude opaque geometry. There are 40
  transparent colours in the bundled config.
* Codes 16 and 24 are the inherit/edge sentinels described above.
* The file carries `// LEGOID <n> - <name>` comments giving the LEGO colour number, which is
  useful context but is *not* a BrickLink colour ID.
* **LDraw colour IDs are NOT BrickLink colour IDs.** LDraw 4 = Red, BrickLink 5 = Red. A
  mapping table is required and is a genuine product limitation (see §10).

---

## 5. BrickLink Studio ↔ LDraw import/export

* Studio's native format is `.io`, which is a **password-protected ZIP container** with an
  LDraw-derived model inside. **V1 of this product deliberately does not parse `.io`.**
* Studio exports LDraw via **File → Export As → Export Model (or Export as LDraw)**, producing
  `.ldr`/`.mpd`.
* Studio *imports* `.ldr`/`.mpd` directly via **File → Import → Import Model**.
* Studio's Instruction Maker operates on a model opened in Studio. Because our export preserves
  `0 STEP` boundaries exactly, a model optimised here and re-imported into Studio retains its
  step structure and can be run through Instruction Maker.

**Limitation:** Studio's LDraw export uses BrickLink part numbering for some parts where it
differs from LDraw numbering, and can emit parts that are in Studio's library but not in the
official LDraw library (unofficial/custom parts). Those appear to this app as unresolved parts.

---

## 6. BrickLink API

* Base URL: `https://api.bricklink.com/api/store/v1/`
* Auth: **OAuth 1.0a, HMAC-SHA1, one-legged** — the four credentials (consumer key/secret,
  token value/secret) are all issued to the same user; there is no redirect flow.
* Credentials are issued at <https://www.bricklink.com/v2/api/register_consumer.page> and are
  **IP-locked**: you register the IP address(es) the requests will originate from. **This is a
  real operational limitation** — a locally running dev server needs its public IP registered,
  and the registration must be updated when that IP changes.
* Requires a BrickLink account. Rate limit is documented as **5,000 requests/day**.

Endpoints used by this project:

| Purpose | Method + path |
| --- | --- |
| Price guide | `GET items/{type}/{no}/price` |
| Known colours for a part | `GET items/{type}/{no}/colors` |
| Element ID mapping | `GET item_mapping/{type}/{no}` |

`items/{type}/{no}/price` parameters (`type` = `PART`):

| Param | Values | Notes |
| --- | --- | --- |
| `color_id` | BrickLink colour id | required for a meaningful part price |
| `guide_type` | `stock` \| `sold` | `stock` = current items for sale; `sold` = last 6 months sales |
| `new_or_used` | `N` \| `U` | |
| `country_code`, `region` | ISO code / `europe`, `eu`, `north_america`, … | optional filter |
| `currency_code` | ISO 4217 | defaults to the account's base currency |
| `vat` | `N` \| `Y` \| `O` | |

Response body (`meta` + `data`) contains: `item`, `new_or_used`, `currency_code`, `min_price`,
`max_price`, **`avg_price`**, **`qty_avg_price`**, `unit_quantity`, `total_quantity`, and a
`price_detail[]` array of individual lots.

Verified against the documented behaviour of two maintained client libraries,
[`FrogCosmonaut/bricklink_py`](https://github.com/FrogCosmonaut/bricklink_py) and
[`gebirgslok/BricklinkSharp`](https://github.com/gebirgslok/BricklinkSharp), because
`bricklink.com` itself was unreachable from this environment.

**Limitations that shape the product:**

* `avg_price` and `qty_avg_price` are *statistics over listings or past sales*, not a checkout
  price. Shipping, seller minimums, lot availability, and tax are not included. The app
  therefore always says **"estimated market parts cost"**, never a guaranteed price.
* There is **no bulk price endpoint** — one request per part+colour+condition. A 400-unique-lot
  model is 400 requests against a 5,000/day budget, so caching is mandatory, not optional.
* `unit_quantity`/`total_quantity` give sample size for `stock`; a low value means the average
  is not trustworthy. The app exposes this and de-prioritises thin-sample quotes.
* **Scraping BrickLink's website as a substitute for the API is against their terms and is not
  implemented here.**

---

## 7. BrickLink Price Guide (the concept, not the API)

The BrickLink Price Guide page shows six-month sold statistics and current-for-sale statistics,
split New/Used, each with min/avg/qty-avg/max and lot counts. The API `guide_type` parameter
selects between these two datasets. `sold` is a better estimate of what you will actually pay
over time; `stock` is a better estimate of what is purchasable right now. This app defaults to
`stock` (what you can buy today) and makes the choice explicit in the pricing metadata.

---

## 8. Rebrickable API

* Base URL: `https://rebrickable.com/api/v3/`
* Auth: header `Authorization: key <API_KEY>`, free key from a Rebrickable account.
* Useful endpoints: `lego/colors/`, `lego/parts/`, `lego/parts/{part_num}/`,
  `lego/parts/{part_num}/colors/`, `lego/part_categories/`.
* `lego/parts/` results include an **`external_ids`** object mapping to `BrickLink`,
  `BrickOwl`, `Brickset`, `LDraw`, `LEGO` and `Peeron` identifiers. This is the single most
  useful thing Rebrickable offers this project.

**Limitations:**

* Rate limited; **enumerating the full catalog via the API is explicitly the wrong approach** —
  Rebrickable directs bulk users to the CSV downloads (§9).
* The user's brief also warns against building on Rebrickable MOC download endpoints. This
  project does not use them at all.

---

## 9. Rebrickable downloadable catalog datasets

* Landing page: <https://rebrickable.com/downloads/>
* Files: `https://cdn.rebrickable.com/media/downloads/{table}.csv.gz` for
  `themes`, `colors`, `part_categories`, `parts`, `part_relationships`, `elements`, `sets`,
  `minifigs`, `inventories`, `inventory_parts`, `inventory_sets`, `inventory_minifigs`.
* Updated daily. **Licence/terms: free for any purpose including commercial, provided
  Rebrickable is acknowledged as the data source. Automated download is permitted at most once
  per day.** `npm run catalog:import` enforces the once-per-day rule locally.

`part_relationships.csv` (`rel_type, child_part_num, parent_part_num`) is the basis of the mold
optimiser. Relationship types:

| Code | Meaning | Usable as a drop-in replacement? |
| --- | --- | --- |
| `M` | **Mold** — alternate mold, functional drop-in replacement | **Yes** — this is the one the optimiser uses |
| `A` | Alternate — similar part, usually but *not necessarily* functionally compatible | No (offered only as low-confidence, off by default) |
| `P` | Print — printed/painted surface of the parent | No |
| `T` | Pattern — marbled/embossed/molded pattern | No |
| `R` | Pair — e.g. left/right, tyre+wheel | No |
| `B` | Sub-part | No |

`inventory_parts.csv` joined to `inventories.csv`/`sets.csv` gives **which part existed in which
colour in which official set** — the ground truth for colour validity.

**Limitation:** these CSVs cover official LEGO sets only (no MOC-exclusive parts), and
`elements.csv` colour coverage is what LEGO actually produced, which is a *subset* of what
BrickLink sells (BrickLink also lists parts that only ever appeared in promotional or
non-set contexts). Being narrower is the safe direction for this product: a colour we cannot
prove exists is simply never recommended.

### Bundled fallback catalog (what this repo ships)

Because `cdn.rebrickable.com` was unreachable, the repository ships
`data/catalog/bundled-catalog.json`, generated by `scripts/build-bundled-catalog.ts` from the
**104 real LDraw Official Model Repository `.mpd`/`.ldr` files** in the mirrored library. Each
entry records a `(LDraw part, LDraw colour)` pair together with the official set numbers it was
observed in, so every colour-validity claim the app makes offline is traceable to a specific
official LEGO set. Colour 16/24 sentinels are excluded.

This yields ~5,400 verified part/colour combinations across ~2,100 parts. **That is far smaller
than Rebrickable's catalog, so offline coverage is limited and many parts will have no
alternative colours proposed at all.** That is a deliberate false-negative-over-false-positive
trade-off, and the UI states which catalog source was used.

---

## 10. ID mappings: LDraw ↔ BrickLink ↔ Rebrickable ↔ LEGO design ID

There is **no single official, freely downloadable, complete crosswalk**. What exists:

* **Rebrickable `external_ids`** (API) — the most complete free source, and the one this project
  targets for Live Mode.
* **LDraw `0 !KEYWORDS`** — LDraw part files may carry cross-reference numbers from external
  inventory sites in their keywords. Coverage is inconsistent, so it is used only as a hint.
* **BrickLink `item_mapping`** endpoint — maps BrickLink part+colour to LEGO Element ID and
  back. It does *not* map from LDraw ids.
* [`Bricksnspace/brickmapping`](https://github.com/Bricksnspace/brickmapping) — a Java library
  for converting between LEGO Design ID, LDraw and BrickLink catalogs. Inspected: the repo
  contains **code only**; the mapping data itself is fetched from the author's own service, so
  there was no dataset to reuse.

**How this project handles it, honestly:**

For the large majority of ordinary elements the three catalogs agree (`3001` is Brick 2×4 in
LDraw, BrickLink and Rebrickable alike). They diverge for:

* **printed/patterned parts** — LDraw `3626bp01` vs BrickLink `3626bpb0001`;
* **mold variants** — LDraw appends letters (`3005a`) on different rules than BrickLink;
* **assemblies** — LDraw models some things as one part that BrickLink sells as several.

So `src/lib/catalog/mapping.ts` implements a three-tier mapping with an explicit
`MappingConfidence` on every result: `verified` (from a curated table or Rebrickable
`external_ids`), `identity` (the numeric stem matched and no override exists), and `unmapped`.
**Instances whose mapping is not `verified` or `identity` are excluded from BrickLink live
pricing and from the Wanted List export**, and the UI shows the count. Colour mapping
(LDraw ↔ BrickLink) is a curated table covering the common colours, with unmapped colours
excluded rather than guessed.

**This is a real, and the largest, source of cost-estimate error in the product.** It is
documented in the app's About page as well as here.

---

## 11. BrickLink Wanted List XML

Confirmed structure (element names verified against the test fixtures and exporter of
[`timonf/bricklib`](https://github.com/timonf/bricklib), a working BrickLink XML exporter):

```xml
<INVENTORY>
    <ITEM>
        <ITEMTYPE>P</ITEMTYPE>
        <ITEMID>3001</ITEMID>
        <COLOR>11</COLOR>
        <MINQTY>4</MINQTY>
        <CONDITION>N</CONDITION>
    </ITEM>
</INVENTORY>
```

* `ITEMTYPE` `P` = part. `ITEMID` is the **BrickLink** part number. `COLOR` is the
  **BrickLink** colour id. `MINQTY` is the quantity wanted. `CONDITION` (`N`/`U`) is optional.
* BrickLink's own upload UI is at *Want → Upload → Upload BrickLink XML format*; the site
  requires **pasting the XML text**, not dropping the file.
* Studio can import a Wanted List XML to create a custom palette.

**Limitation — stated in the app, not hidden:** this export has **not** been round-tripped
through a live BrickLink or Studio import from this environment, because `bricklink.com` was
unreachable. The generated XML is validated by unit tests for structure, escaping and
BrickLink-id/colour resolution only. The download UI labels it *"format follows the documented
BrickLink XML schema; please verify the first import"*.

---

## 12. LDraw licensing and attribution

* The LDraw Parts Library is licensed under **Creative Commons Attribution 2.0 (CC BY 2.0)**
  via the LDraw Contributor Agreement. Parts under the CA carry
  `0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt` in their header
  (newer contributor agreements also permit CC BY 4.0 and CC0).
* Rights granted: copy, distribute, display, use, **make derivative works, and make commercial
  use**, on condition of **attribution to the original author(s)**.
* Files converted from the LDraw library count as **derivative works** and inherit the
  attribution requirement.
* LDraw Official Model Repository files carry the same `0 !LICENSE ... CCAL version 2.0` line
  and are individually authored — attribution is per-model.

**What this repository therefore does:**

1. Ships only a **small subset** of the parts library (`public/ldraw/`) — the transitive closure
   of the parts used by the built-in fixtures — with `CAreadme.txt`, `CAlicense.txt` and the
   original unmodified headers intact, and `NOTICE.md` naming LDraw.org and the part authors.
2. Does **not** bundle any OMR model file. The bundled catalog is *derived* aggregate data
   (part/colour/set-number triples) and credits LDraw.org and the OMR; the models themselves are
   downloaded by the user via `npm run parts:fetch --models`.
3. Preserves the `0 !LICENSE` and `0 Author:` lines of any model it processes, so an exported
   optimised model carries its original attribution.
4. Does not use the LEGO® or BrickLink® logos or wordmarks as branding. LEGO is a trademark of
   the LEGO Group, which does not sponsor or endorse this project.

---

## 13. Sources

* LDraw File Format Specification — <https://ldraw.org/article/218.html>
* LDraw MPD Specification — <https://www.ldraw.org/article/47.html>
* LDraw Official Parts Library Specifications — <https://www.ldraw.org/article/512.html>
* LDraw Official Library Header Specification — <https://www.ldraw.org/article/398.html>
* LDraw Official Model Repository Specification — <https://www.ldraw.org/article/593.html>
* LDraw Legal Info — <https://www.ldraw.org/legal-info>
* LDraw Parts Library Agreement (`CAreadme.txt`) — bundled in `public/ldraw/CAreadme.txt`
* LDraw parts library mirror — <https://github.com/gkjohnson/ldraw-parts-library>
* BrickLink Store API — <https://www.bricklink.com/v3/api.page>
* `bricklink_py` (endpoint/parameter reference) — <https://github.com/FrogCosmonaut/bricklink_py>
* `BricklinkSharp` (endpoint/parameter reference) — <https://github.com/gebirgslok/BricklinkSharp>
* `bricklib` (Wanted List XML reference) — <https://github.com/timonf/bricklib>
* BrickLink XML import help — <https://www.bricklink.com/help.asp?helpID=2567>
* Studio: Importing a Wanted List — <https://studiohelp.bricklink.com/hc/en-us/articles/6483161921303-Importing-a-Wanted-List>
* Rebrickable API docs — <https://rebrickable.com/api/v3/docs/>
* Rebrickable catalog downloads — <https://rebrickable.com/downloads/>
* Rebrickable LEGO Database help (relationship types) — <https://rebrickable.com/help/lego-database/>
