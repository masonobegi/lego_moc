import { NextResponse } from 'next/server';

import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel, summarizeModel } from '@/lib/ldraw/resolve';
import { readFixture } from '@/lib/runtime/analyze';
import { sanitizeText, validateUpload, LIMITS, ModelTooLargeError, UnsupportedFileError } from '@/lib/security/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Parse a model and report what is in it, without analyzing it.
 *
 * This backs the "Model detected" step: the user sees the part count, lot
 * count, step count and submodel count, and any problems the parser found,
 * BEFORE committing to an analysis that can take a minute on a large model.
 * It is cheap - parsing and resolving even a 6,000-part MPD is tens of
 * milliseconds - because it does no geometry, pricing or ray casting.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    let source: string;
    let fileName: string;

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
      fileName = validateUpload(file.name, file.size);
    } else {
      const body = (await request.json()) as { fixture?: string };
      const fixture = body.fixture ? readFixture(body.fixture) : null;
      if (!fixture) {
        return NextResponse.json({ error: 'Expected a file upload or a fixture name.' }, { status: 400 });
      }
      source = fixture.source;
      fileName = fixture.fileName;
    }

    const document = parseLDraw(source, { sourceName: fileName });
    const resolved = resolveModel(document);
    const summary = summarizeModel(resolved);
    const rootFile = document.files.find((f) => f.name === document.rootFile) ?? document.files[0];

    return NextResponse.json({
      fileName,
      title: sanitizeText(rootFile?.description ?? rootFile?.headerName ?? fileName, 120) || fileName,
      author: rootFile?.author ? sanitizeText(rootFile.author, 80) : null,
      isMpd: document.isMpd,
      byteSize: Buffer.byteLength(source, 'utf8'),
      partCount: summary.partCount,
      uniqueLotCount: summary.uniqueLotCount,
      uniquePartCount: summary.uniquePartCount,
      stepCount: summary.stepCount,
      submodelCount: summary.submodelCount,
      malformedLineCount: document.warnings.filter((w) => w.code === 'malformed_line').length,
      unresolvedSubmodels: summary.unresolvedSubmodels.slice(0, 20),
      truncated: summary.truncated,
      truncationReason: summary.truncationReason,
      warnings: [...document.warnings, ...resolved.warnings].slice(0, 20).map((w) => w.message),
    });
  } catch (error) {
    if (error instanceof UnsupportedFileError) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    if (error instanceof ModelTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `The model could not be read: ${message}` }, { status: 500 });
  }
}
