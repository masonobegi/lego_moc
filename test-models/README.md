# BrickThrift synthetic test models

Hand-built LDraw fixtures with known expected outcomes. Every one of them goes
through the same parser, geometry resolver, visibility engine, price engine,
optimiser and serializer that a real uploaded model does - nothing about them is
special-cased anywhere in the code.

## Coordinate conventions used here

LDraw is right-handed with **-Y up**, 1 LDU = 0.4 mm.

* A brick body occupies `y` from its origin to `origin + 24`; its studs stick up
  into `origin - 4 .. origin`. So the origin sits on the brick's **top** face.
* A plate body occupies `origin .. origin + 8`.
* A 2x4 brick (`3001`) spans `x` -40..40 and `z` -20..20 about its origin.
* Stacking upwards means **decreasing** y.

## The sealed box used by several fixtures

Footprint 6x6 studs, `x, z` in -60..60.

| Element | Part | Placement | Occupies |
| --- | --- | --- | --- |
| floor | `3958` Plate 6x6 | `(0, 0, 0)` | y 0..8 |
| -X wall | `3009` Brick 1x6, rotated 90 deg about Y | `(-50, -24, 0)` | x -60..-40, all z |
| +X wall | `3009` Brick 1x6, rotated 90 deg about Y | `(50, -24, 0)` | x 40..60, all z |
| -Z wall | `3001` Brick 2x4 | `(0, -24, -40)` | z -60..-20 |
| +Z wall | `3001` Brick 2x4 | `(0, -24, 40)` | z 20..60 |
| **target** | `3001` Brick 2x4 | `(0, -24, 0)` | x -40..40, z -20..20 |
| ceiling | `3958` Plate 6x6 | `(0, -32, 0)` | y -32..-24 |

The wall layer tiles the full 120x120 footprint with no gaps, and the floor and
ceiling plates seal top and bottom, so the target has no path to the outside.

## The fixtures

| File | What it is | Expected optimiser behaviour |
| --- | --- | --- |
| `exposed-brick.ldr` | A red 2x4 brick sitting on a plate, in the open | **No change.** Obviously visible. |
| `buried-brick.ldr` | The sealed box above, red target inside | **Change** red -> black. |
| `partially-visible.ldr` | Sealed box with a 1-stud-wide strip of ceiling missing over the target | **No change.** A small part of the target is directly visible. |
| `gap-visible.ldr` | Sealed box with a 1-stud window through the +X wall, aimed at the target | **No change.** Visible only along a narrow line of sight, which is exactly the case a bounding-box test would get wrong. |
| `multi-step.mpd` | The sealed box built over 5 `0 STEP`s, target introduced in step 3 | **Change** red -> black, and the part stays in step 3. |
| `submodel.mpd` | Target two submodel levels down (`main` -> `core` -> `capsule`) | Parser resolves the nesting; the instance inside `capsule.ldr` is changed. |
| `multiple-instances.mpd` | `pod.ldr` used twice (one buried, one exposed); `sealed-pod.ldr` used twice (both buried) | **`pod.ldr` must not change** - one line type 1 produces both instances, and one of them is visible. **`sealed-pod.ldr` changes once**, quantity 2. |
| `transparent-window.mpd` | Sealed box whose +X wall is trans-clear | **No change.** Transparent parts do not occlude. |

`multiple-instances.mpd` is the important one. A submodel referenced N times is
still a single line in the file, so a colour change applies to all N physical
parts at once. The optimiser only proposes the change when **every** instance
sharing that line is hidden.

## Licence

These files are original work, part of this repository, and are covered by the
repository's licence. They are not derived from the LDraw Official Model
Repository or from any LEGO set.
