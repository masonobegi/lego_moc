import type { Metadata, Viewport } from 'next';
import Link from 'next/link';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'BrickThrift - LEGO MOC cost optimizer',
    template: '%s - BrickThrift',
  },
  description:
    'Make expensive LEGO builds cheaper without changing how they look. Analyze an LDraw model, ' +
    'find pieces that cannot be seen, and buy those same pieces in cheaper colors.',
};

export const viewport: Viewport = {
  themeColor: '#08090c',
  width: 'device-width',
  initialScale: 1,
};

const NAV = [
  { href: '/optimize', label: 'Optimize' },
  { href: '/dev', label: 'Dev' },
  { href: '/about', label: 'About' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg)]">
            <div className="mx-auto flex h-[52px] max-w-[1600px] items-center gap-8 px-5">
              <Link href="/" className="flex items-center gap-2.5">
                <BrandMark />
                <span className="font-mono text-[0.86rem] font-medium tracking-[-0.01em]">
                  brickthrift
                </span>
              </Link>
              <nav className="ml-auto flex items-center gap-6">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="text-[0.85rem] text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
                  >
                    {item.label}
                  </Link>
                ))}
                <Link
                  href="/optimize"
                  className="border border-[var(--line-strong)] px-3 py-[5px] text-[0.85rem] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Optimize a model
                </Link>
              </nav>
            </div>
          </header>

          <main className="flex-1">{children}</main>

          <footer className="border-t border-[var(--line)] px-5 py-8">
            <div className="mx-auto flex max-w-[1600px] flex-col gap-3 text-[0.78rem] text-[var(--text-faint)] sm:flex-row sm:items-center sm:justify-between">
              <p>
                Part geometry from the{' '}
                <a
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-dim)]"
                  href="https://www.ldraw.org/"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  LDraw Parts Library
                </a>
                , licensed CC BY 2.0.
              </p>
              <p>
                LEGO is a trademark of the LEGO Group, which does not sponsor or endorse this
                project. BrickLink is a trademark of BrickLink Ltd.
              </p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

/** Three descending bars: a falling price. No rounding, no gradient. */
function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="2" width="14" height="3" fill="var(--accent)" />
      <rect x="1" y="6.5" width="9.5" height="3" fill="var(--accent)" opacity="0.6" />
      <rect x="1" y="11" width="5" height="3" fill="var(--accent)" opacity="0.32" />
    </svg>
  );
}
