import { NextResponse } from 'next/server';

import { runAnalysis, readFixture } from '@/lib/runtime/analyze';
import { DEFAULT_SAFETY_LEVEL, SAFETY_LEVELS, type SafetyLevel } from '@/lib/optimizer/types';
import { LIMITS, ModelTooLargeError, UnsupportedFileError } from '@/lib/security/limits';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function parseSafetyLevel(value: unknown): SafetyLevel {
  return typeof value === 'string' && value in SAFETY_LEVELS
    ? (value as SafetyLevel)
    : DEFAULT_SAFETY_LEVEL;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    let source: string;
    let fileName: string;
    let safetyLevel: SafetyLevel = DEFAULT_SAFETY_LEVEL;

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'No file was included in the upload.' }, { status: 400 });
      }
      if (file.size > LIMITS.maxFileBytes) {
        return NextResponse.json(
          {
            error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${(
              LIMITS.maxFileBytes /
              1024 /
              1024
            ).toFixed(0)} MB limit.`,
          },
          { status: 413 },
        );
      }
      source = await file.text();
      fileName = file.name;
      safetyLevel = parseSafetyLevel(form.get('safetyLevel'));
    } else {
      const body = (await request.json()) as { fixture?: string; safetyLevel?: string };
      safetyLevel = parseSafetyLevel(body.safetyLevel);
      if (!body.fixture) {
        return NextResponse.json({ error: 'Expected a file upload or a fixture name.' }, { status: 400 });
      }
      const fixture = readFixture(body.fixture);
      if (!fixture) {
        return NextResponse.json({ error: `Unknown fixture "${body.fixture}".` }, { status: 404 });
      }
      source = fixture.source;
      fileName = fixture.fileName;
    }

    const wantsStream = new URL(request.url).searchParams.get('stream') === '1';
    if (!wantsStream) {
      const response = await runAnalysis({ source, fileName, safetyLevel });
      return NextResponse.json(response);
    }

    // Streaming variant: emit one NDJSON line as each stage begins, then the
    // finished result. Stages are reported when they actually start - there are
    // no invented percentages anywhere in this app.
    const encoder = new TextEncoder();
    const analysisSource = source;
    const analysisFileName = fileName;
    const level = safetyLevel;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown): void => {
          controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
        };
        try {
          const response = await runAnalysis({
            source: analysisSource,
            fileName: analysisFileName,
            safetyLevel: level,
            onStage: (stage) => send({ type: 'stage', stage }),
          });
          send({ type: 'done', ...response });
        } catch (streamError) {
          const message =
            streamError instanceof Error ? streamError.message : 'The model could not be analyzed.';
          send({ type: 'error', error: message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    if (error instanceof UnsupportedFileError) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    if (error instanceof ModelTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[analyze] failed:', error);
    return NextResponse.json(
      { error: `The model could not be analyzed: ${message}` },
      { status: 500 },
    );
  }
}
