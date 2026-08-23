import { LIMITS } from '@/lib/security/limits';

/**
 * Reject an oversized request BEFORE its body is read.
 *
 * `request.formData()` buffers the entire multipart body into memory before
 * `file.size` can be inspected, so checking the size afterwards does not
 * protect the process: a 400 MB body costs 800 MB of heap before the check
 * runs. Content-Length is not trustworthy on its own, but it is free, it is
 * present on every real upload, and rejecting on it stops the cheap attack.
 */
export function checkContentLength(request: Request): Response | null {
  // Multipart framing adds a few hundred bytes of boundaries and headers.
  const allowance = LIMITS.maxFileBytes + 64 * 1024;
  const header = request.headers.get('content-length');
  if (header === null) {
    return Response.json(
      { error: 'A Content-Length header is required so the upload size can be checked.' },
      { status: 411 },
    );
  }
  const length = Number(header);
  if (!Number.isFinite(length) || length < 0) {
    return Response.json({ error: 'Invalid Content-Length header.' }, { status: 400 });
  }
  if (length > allowance) {
    return Response.json(
      {
        error:
          `That upload is ${(length / 1024 / 1024).toFixed(1)} MB, over the ` +
          `${(LIMITS.maxFileBytes / 1024 / 1024).toFixed(0)} MB limit.`,
      },
      { status: 413 },
    );
  }
  return null;
}
