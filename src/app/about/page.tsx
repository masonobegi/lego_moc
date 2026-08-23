import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'About' };

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-[820px] px-5 py-14">
      <h1 className="text-[2rem] font-semibold tracking-tight">How BrickThrift works</h1>
      <p className="mt-4 text-[1rem] leading-relaxed text-[var(--text-dim)]">
        BrickThrift makes a digital LEGO design cheaper to buy before you buy it. It is not a
        generic BrickLink price optimizer: it changes the model itself, in the one way that costs
        nothing visually, and leaves everything else alone.
      </p>
      <p className="mt-4 text-[0.92rem] leading-relaxed text-[var(--text-dim)]">
        It does exactly one thing: find pieces that cannot be seen from outside the finished model,
        and buy those same pieces in a cheaper color. It never turns one part into several, never
        changes how anything connects, and never redesigns anything. That restriction is the point
        &mdash; it is what lets the tool promise that the finished model looks identical.
      </p>
      <p className="mt-4 text-[0.92rem] leading-relaxed text-[var(--text-dim)]">
        Every price figure it shows is an estimate of what the{' '}
        <strong className="font-medium text-[var(--text)]">parts</strong> cost. It is not a checkout
        total, because BrickThrift does not know which sellers BrickLink would pick for your order,
        what they charge to ship, or what their minimums are. For the real answer it exports your
        original and optimized parts lists so BrickLink &mdash; which does know &mdash; can price
        both.
      </p>

      <Section title="The method">
        <p>
          Every analysis runs the same pipeline, whether it came from an upload or from a built-in
          test fixture. Nothing is special-cased and no result is precomputed.
        </p>
        <ol className="mt-4 space-y-3">
          {[
            [
              'Parse',
              'A full LDraw and MPD parser. Submodels, arbitrary nesting, 0 STEP boundaries, 0 FILE and 0 NOFILE, and every META command it does not recognise. Unknown lines are preserved verbatim, so a file that goes in and comes back unchanged is byte-for-byte identical.',
            ],
            [
              'Build',
              'Real LDraw part geometry, resolved recursively through the parts library down to primitives. A 6,000-part model becomes about five million triangles, held in a two-level acceleration structure: one triangle BVH per distinct part, and one instance BVH over the model.',
            ],
            [
              'Look',
              'For each part, points are placed across its actual triangle surface and rays are cast from each in directions spread over the whole sphere. A ray "escapes" if nothing opaque stops it before it leaves the model. One escaping ray is enough to call a part visible.',
            ],
            [
              'Price',
              'Every distinct part-and-color combination is priced once. Alternatives are only priced for parts that are already known to be hidden, which is what keeps live BrickLink usage inside its daily budget.',
            ],
            [
              'Propose',
              'A cheaper color is proposed only when catalog data shows the part has genuinely been produced in it. The change is written by rewriting the color field of the existing line, in place, so the part cannot move and cannot change build step.',
            ],
          ].map(([title, body]) => (
            <li key={title} className="flex gap-4">
              <span className="mt-0.5 w-16 shrink-0 text-[0.78rem] font-semibold uppercase tracking-wide text-[var(--accent)]">
                {title}
              </span>
              <span className="flex-1">{body}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="What the confidence number means">
        <p>
          When a part is called hidden, the number next to it is not a vibe. Thousands of rays are
          cast from points covering the part&apos;s surface, and none of them reach the outside.
          With <em>N</em> such trials and zero successes, the rule of three puts the true escape
          probability below roughly 3/<em>N</em> at 95% confidence, and that is exactly what is
          reported: 2,000 rays gives 99.85%, not &ldquo;definitely invisible&rdquo;.
        </p>
        <p className="mt-3">
          It is a statement about the sampling, not a geometric proof. The tool does not claim
          absolute invisibility, because it has not proved absolute invisibility. Expand any change
          on the results page and it will tell you exactly how many points and how many triangles
          were probed.
        </p>
      </Section>

      <Section title="Where it deliberately gives up savings">
        <ul className="space-y-2.5">
          {[
            'A transparent part never counts as hiding anything. Anything behind glass reads as visible.',
            'A submodel used more than once is a single line in the file. If any copy of it is visible, the line is left alone - even when the other copies are sealed inside the model. On real sets this is usually the largest single block of missed savings.',
            'A part drawn in LDraw color 16 takes its color from whatever references it, so rewriting it there would recolor the whole submodel. Skipped.',
            'A part whose geometry could not be fully resolved from the library can never reach the top confidence tier.',
            'A color that cannot be evidenced in the catalog is never proposed, however cheap the price data says it would be.',
            'Mold substitutions where the two molds are not visually identical are only offered for parts that are hidden anyway.',
          ].map((item) => (
            <li key={item} className="flex gap-2.5">
              <span className="mt-[0.6em] h-[3px] w-[3px] shrink-0 bg-[var(--text-faint)]" />
              {item}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What the prices are, and are not">
        <p>
          BrickThrift reports an <strong className="font-semibold text-[var(--text)]">estimated
          market parts cost</strong>. It is not a checkout price. It excludes shipping, seller
          minimum orders, whether a seller actually has the quantity you need, and tax. Buying 400
          lots from twelve stores costs meaningfully more than the sum of the part prices.
        </p>
        <p className="mt-3">
          With no configuration the app uses a built-in{' '}
          <strong className="font-semibold text-[var(--text)]">demo price dataset</strong>. Those
          numbers are synthetic, deliberately shaped to make the optimizer easy to see working, and
          labeled as such everywhere they appear. Live BrickLink pricing is opt-in and needs API
          credentials in <code className="font-mono">.env.local</code>; the app never presents demo
          figures as live ones.
        </p>
      </Section>

      <Section title="Scope of the visibility test">
        <p>
          Visibility is judged against the completed model exactly as you supplied it. That is a
          real limitation and worth understanding:
        </p>
        <ul className="mt-3 space-y-2.5">
          {[
            'A model with a lift-off roof is analyzed with the roof on.',
            'A hinged panel is analyzed in the position it was saved in.',
            'A part that is on show while you are building but buried at the end counts as hidden.',
            'A model meant to be viewed from underneath is analyzed from every direction, including underneath, so this case is handled - but a model displayed permanently against a wall will not gain the savings it could.',
          ].map((item) => (
            <li key={item} className="flex gap-2.5">
              <span className="mt-[0.6em] h-[3px] w-[3px] shrink-0 bg-[var(--text-faint)]" />
              {item}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Instructions">
        <p>
          BrickThrift does not generate building instructions. It preserves your{' '}
          <code className="font-mono">0 STEP</code> structure exactly, so the optimized file opens
          in BrickLink Studio with the same step sequence and Studio&apos;s Instruction Maker can
          produce instructions from it. Re-creating a designer&apos;s own PDF instructions is out of
          scope for this version.
        </p>
      </Section>

      <Section title="Attribution and trademarks">
        <p>
          Part geometry and color definitions come from the{' '}
          <a
            className="text-[var(--accent)] hover:underline"
            href="https://www.ldraw.org/"
            rel="noreferrer noopener"
            target="_blank"
          >
            LDraw Parts Library
          </a>
          , licensed under Creative Commons Attribution 2.0. Credit belongs to LDraw.org and the
          individual part authors, whose names are preserved in the part files this app ships.
          Color-availability data is derived from LDraw Official Model Repository files, also CC BY
          2.0.
        </p>
        <p className="mt-3">
          LEGO is a trademark of the LEGO Group, which does not sponsor, authorise or endorse this
          project. BrickLink is a trademark of BrickLink Ltd. No LEGO or BrickLink logo or wordmark
          is used as branding here.
        </p>
      </Section>

      <div className="mt-12 flex flex-wrap gap-3">
        <Link
          href="/optimize"
          className="bg-[var(--accent)] px-5 py-2.5 text-[0.9rem] font-semibold text-[#14100a] hover:bg-[#eeb552]"
        >
          Optimize a model
        </Link>
        <Link
          href="/dev"
          className="border border-[var(--line-strong)] px-5 py-2.5 text-[0.9rem] font-medium text-[var(--text-dim)] hover:border-[var(--text-faint)] hover:text-[var(--text)]"
        >
          Run the test fixtures
        </Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-11 border-t border-[var(--line)] pt-9">
      <h2 className="text-[1.15rem] font-semibold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-3 text-[0.92rem] leading-relaxed text-[var(--text-dim)]">
        {children}
      </div>
    </section>
  );
}
