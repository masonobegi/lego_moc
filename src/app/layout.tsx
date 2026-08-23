import type { Metadata, Viewport } from 'next';
import Link from 'next/link';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'BrickThrift - LEGO MOC cost optimiser',
    template: '%s - BrickThrift',
  },
  description:
    'Make expensive LEGO builds cheaper without changing how they look. Analyse an LDraw model, ' +
    'find pieces that cannot be seen, and buy them in cheaper colours.',
};

export const viewport: Viewport = {
  themeColor: '#08090c',
  width: 'device-width',
  initialScale: 1,
};

const NAV = [
  { href: '/optimize', label: 'Optimise' },
  { href: '/dev', label: 'Dev' },
  { href: '/about', label: 'About' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-xl">
            <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
              <Link href="/" className="group flex items-center gap-2.5">
                <BrandMark />
                <span className="text-[0.94rem] font-semibold tracking-tight">
                  Brick<span className="text-[var(--accent)]">Thrift</span>
                </span>
              </Link>
              <nav className="ml-auto flex items-center gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-md px-3 py-1.5 text-[0.86rem] text-[var(--text-dim)] transition-colors hover:bg-[var(--panel-2)] hover:text-[var(--text)]"
                  >
                    {item.label}
                  </Link>
                ))}
                <Link
                  href="/optimize"
                  className="ml-2 rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-[0.86rem] font-semibold text-[#1a1206] transition-opacity hover:opacity-90"
                >
                  Optimise a model
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

/** An abstract mark: three descending bars, suggesting a falling price. */
function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="18" height="4.4" rx="1.2" fill="var(--accent)" />
      <rect x="2" y="8.8" width="13" height="4.4" rx="1.2" fill="var(--accent)" opacity="0.62" />
      <rect x="2" y="14.6" width="8" height="4.4" rx="1.2" fill="var(--accent)" opacity="0.34" />
    </svg>
  );
}
