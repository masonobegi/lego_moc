import { NextResponse } from 'next/server';

import { listFixtures } from '@/lib/runtime/analyze';

export const runtime = 'nodejs';

export function GET(): Response {
  return NextResponse.json({ fixtures: listFixtures() });
}
