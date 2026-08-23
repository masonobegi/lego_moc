import Link from 'next/link';

export default function ResultNotFound() {
  return (
    <div className="mx-auto max-w-[560px] px-5 py-28 text-center">
      <h1 className="text-[1.5rem] font-semibold tracking-tight">
        That analysis is no longer available
      </h1>
      <p className="mt-3 text-[0.9rem] leading-relaxed text-[var(--text-dim)]">
        Results are stored on the machine running this app and are pruned as new ones arrive. Run
        the analysis again to get a fresh link.
      </p>
      <Link
        href="/optimize"
        className="mt-7 inline-block bg-[var(--accent)] px-5 py-2.5 text-[0.9rem] font-semibold text-[#14100a] hover:bg-[#eeb552]"
      >
        Optimize a model
      </Link>
    </div>
  );
}
