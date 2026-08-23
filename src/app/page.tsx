import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      {/* ---- hero ---- */}
      <section className="stud-grid relative overflow-hidden border-b border-[var(--line)]">
        <div className="pointer-events-none absolute inset-x-0 -top-40 h-80 bg-[radial-gradient(60%_100%_at_50%_100%,color-mix(in_srgb,var(--accent)_10%,transparent),transparent)]" />
        <div className="mx-auto grid max-w-[1200px] items-center gap-14 px-5 py-24 sm:py-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1 text-[0.73rem] font-medium tracking-wide text-[var(--text-dim)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            For LDraw and BrickLink Studio designers
          </p>

          <h1 className="max-w-[19ch] text-[2.6rem] font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[3.6rem]">
            Make expensive LEGO builds cheaper{' '}
            <span className="text-[var(--accent)]">without changing how they look.</span>
          </h1>

          <p className="mt-6 max-w-[62ch] text-[1.03rem] leading-relaxed text-[var(--text-dim)]">
            BrickThrift analyses your digital model, works out which pieces cannot be seen from
            outside the finished build, and shows you where a cheaper colour buys you exactly the
            same model. The geometry, the construction and the build steps stay identical.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/optimize"
              className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-[0.92rem] font-semibold text-[#1a1206] transition-opacity hover:opacity-90"
            >
              Optimise a model
            </Link>
            <Link
              href="/dev"
              className="rounded-lg border border-[var(--line-strong)] px-5 py-2.5 text-[0.92rem] font-medium text-[var(--text-dim)] transition-colors hover:border-[var(--text-faint)] hover:text-[var(--text)]"
            >
              Try it on a test model
            </Link>
          </div>

          <p className="mt-5 text-[0.8rem] text-[var(--text-faint)]">
            Runs locally. Works with no API keys. Accepts <code className="font-mono">.ldr</code> and{' '}
            <code className="font-mono">.mpd</code>.
          </p>
        </div>

          <CutawayDiagram />
        </div>
      </section>

      {/* ---- worked example ---- */}
      <section className="border-b border-[var(--line)] px-5 py-20">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
            The idea
          </h2>
          <div className="mt-7 grid gap-4 md:grid-cols-[1fr_auto_1fr]">
            <ExampleCard
              title="A brick you can never see"
              lines={[
                ['Part', 'Brick 2 x 4'],
                ['Colour', 'Red'],
                ['Position', 'Sealed inside the structure'],
                ['Price', '$0.75 each'],
              ]}
            />
            <div className="flex items-center justify-center py-2 md:py-0">
              <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden className="text-[var(--accent)] max-md:rotate-90">
                <path d="M6 17h20m0 0-6.5-6.5M26 17l-6.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <ExampleCard
              title="The same brick, cheaper"
              accent
              lines={[
                ['Part', 'Brick 2 x 4'],
                ['Colour', 'Black'],
                ['Position', 'Identical'],
                ['Price', '$0.12 each'],
              ]}
            />
          </div>
          <p className="mt-6 max-w-[70ch] text-[0.88rem] leading-relaxed text-[var(--text-dim)]">
            Nothing about the finished model changes: same part, same place, same orientation, same
            build step. The only difference is what colour of plastic you buy. Multiply that across
            the hidden interior of a large MOC and it adds up.
          </p>
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="border-b border-[var(--line)] px-5 py-20">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
            How it decides
          </h2>
          <div className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Step
              n="01"
              title="Reads your model properly"
              body="A full LDraw and MPD parser: submodels, nesting, build steps, unknown metadata. Every line you did not change comes back byte for byte."
            />
            <Step
              n="02"
              title="Builds the real thing"
              body="Actual LDraw part geometry, not bounding boxes. A 6,000-part model becomes five million triangles in a two-level acceleration structure."
            />
            <Step
              n="03"
              title="Casts rays, not guesses"
              body="Thousands of rays leave each part's surface in every direction. A part is only called hidden when not one of them reaches the outside."
            />
            <Step
              n="04"
              title="Checks the colour exists"
              body="A cheaper colour is only proposed when catalogue data shows the part has genuinely been produced in it. Cheap and imaginary is not a saving."
            />
          </div>
        </div>
      </section>

      {/* ---- honesty section ---- */}
      <section className="px-5 py-20">
        <div className="mx-auto max-w-[1100px]">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-[1.45rem] font-semibold tracking-tight">
                Built to be wrong in the safe direction
              </h2>
              <p className="mt-4 text-[0.92rem] leading-relaxed text-[var(--text-dim)]">
                Recolouring a brick that turns out to be visible ruins a model. Missing a saving
                costs a few cents. Every judgement call in this tool is made with that asymmetry in
                mind.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  'A single escaping ray is enough to disqualify a part.',
                  'Transparent parts never count as hiding anything behind them.',
                  'A submodel used more than once is only changed when every copy is hidden.',
                  'A part whose geometry could not be fully resolved never reaches the top confidence tier.',
                  'The default safety level is the strictest one, and there is no aggressive mode.',
                ].map((item) => (
                  <li key={item} className="flex gap-3 text-[0.89rem] leading-relaxed text-[var(--text-dim)]">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="mt-0.5 shrink-0 text-[var(--good)]" aria-hidden>
                      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="panel p-6">
              <h3 className="text-[0.95rem] font-semibold">What this does not do</h3>
              <p className="mt-2 text-[0.85rem] leading-relaxed text-[var(--text-dim)]">
                Being clear about the boundary matters more than sounding capable.
              </p>
              <ul className="mt-5 space-y-2.5 text-[0.85rem] leading-relaxed text-[var(--text-dim)]">
                {[
                  'It does not redesign your model or change how any parts connect.',
                  'It never replaces one piece with several.',
                  'It does not give you a checkout price. Shipping, seller minimums and tax are not included.',
                  'It analyses the completed model as supplied - not detachable roofs, hinged panels or half-built states.',
                  'It does not generate instructions. It preserves your build steps so Studio can.',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <span className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-[var(--text-faint)]" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/about"
                className="mt-6 inline-flex items-center gap-1.5 text-[0.85rem] font-medium text-[var(--accent)] hover:underline"
              >
                Read the full method and its limits
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                  <path d="M3 6.5h7m0 0L7.2 3.7M10 6.5 7.2 9.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * A cross-section of a wall: the outside is what people see, and one brick
 * deep inside it is the one this product is about. Deliberately abstract - no
 * LEGO trade dress, just stacked rectangles with studs.
 */
function CutawayDiagram() {
  const rows = 5;
  const cols = 6;
  const cellW = 62;
  const cellH = 34;
  const hiddenCell = { row: 2, col: 2 };

  return (
    <div className="panel hidden overflow-hidden p-6 lg:block">
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">
        Cross-section
      </p>
      <svg
        viewBox={`0 0 ${cols * cellW + 8} ${rows * cellH + 8}`}
        className="mt-4 w-full"
        role="img"
        aria-label="A cross-section of a wall with one brick, deep inside, highlighted"
      >
        {Array.from({ length: rows }).map((_, row) =>
          // Offset rows get an extra brick so the running bond does not leave a
          // notch at the right-hand edge.
          Array.from({ length: row % 2 === 1 ? cols + 1 : cols }).map((__, col) => {
            const offset = row % 2 === 1 ? cellW / 2 : 0;
            const x = 4 + col * cellW - offset;
            const y = 4 + row * cellH;
            const isHidden = row === hiddenCell.row && col === hiddenCell.col;
            const lastCol = (row % 2 === 1 ? cols + 1 : cols) - 1;
            const isInterior = row > 0 && row < rows - 1 && col > 0 && col < lastCol;
            return (
              <g key={`${row}-${col}`} opacity={isHidden ? 1 : isInterior ? 0.4 : 0.85}>
                <rect
                  x={x}
                  y={y}
                  width={cellW - 4}
                  height={cellH - 4}
                  rx={3}
                  fill={isHidden ? '#B40000' : '#3a4453'}
                  stroke={isHidden ? '#f0a836' : '#4a5566'}
                  strokeWidth={isHidden ? 1.6 : 0.8}
                />
                <rect x={x + 9} y={y - 3} width={13} height={5} rx={2} fill={isHidden ? '#8f0000' : '#2f3846'} />
                <rect x={x + 34} y={y - 3} width={13} height={5} rx={2} fill={isHidden ? '#8f0000' : '#2f3846'} />
              </g>
            );
          }),
        )}
      </svg>
      <div className="mt-4 flex items-start gap-2.5">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[2px] bg-[#B40000] ring-1 ring-[var(--accent)]" />
        <p className="text-[0.8rem] leading-relaxed text-[var(--text-dim)]">
          No surface of this brick reaches the outside from any direction. Its colour is
          load-bearing for your wallet and for nothing else.
        </p>
      </div>
    </div>
  );
}

function ExampleCard({
  title,
  lines,
  accent,
}: {
  title: string;
  lines: [string, string][];
  accent?: boolean;
}) {
  return (
    <div
      className={`panel p-6 ${accent ? 'border-[color-mix(in_srgb,var(--accent)_38%,var(--line))]' : ''}`}
    >
      <h3 className="text-[0.9rem] font-semibold">{title}</h3>
      <dl className="mt-4 space-y-2.5">
        {lines.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-[0.8rem] text-[var(--text-faint)]">{label}</dt>
            <dd
              className={`tnum text-[0.86rem] ${
                label === 'Price' && accent ? 'font-semibold text-[var(--accent)]' : 'text-[var(--text)]'
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <span className="tnum text-[0.72rem] font-semibold tracking-widest text-[var(--accent)]">{n}</span>
      <h3 className="mt-2.5 text-[0.95rem] font-semibold leading-snug">{title}</h3>
      <p className="mt-2 text-[0.85rem] leading-relaxed text-[var(--text-dim)]">{body}</p>
    </div>
  );
}
