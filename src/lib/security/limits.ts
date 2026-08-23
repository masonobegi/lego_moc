/**
 * Hard limits applied to every uploaded model.
 *
 * Uploaded files are untrusted input. LDraw is a plain-text format with no
 * scripting, so the risk is not code execution but resource exhaustion:
 * a small `.mpd` can declare submodels that reference each other in a cycle, or
 * a shallow tree that expands to billions of instances. Everything below exists
 * to bound that.
 */

export const LIMITS = {
  /** Maximum accepted upload size. A 10k-part MPD is typically ~1 MB. */
  maxFileBytes: 32 * 1024 * 1024,
  /** Maximum number of source lines parsed. */
  maxLines: 4_000_000,
  /** Maximum characters on a single line before it is rejected as malformed. */
  maxLineLength: 8192,
  /** Maximum number of `0 FILE` blocks in one document. */
  maxFiles: 20_000,
  /** Maximum submodel nesting depth during expansion. */
  maxDepth: 64,
  /** Maximum part instances produced by expansion. */
  maxInstances: 250_000,
  /**
   * Maximum sub-file frames visited while expanding.
   *
   * Separate from maxInstances because a document made only of submodels
   * referencing each other produces no instances at all while still expanding
   * exponentially, so the instance cap never fires.
   */
  maxExpansionFrames: 1_000_000,
  /** Maximum number of distinct part `.dat` files resolved from the library. */
  maxUniqueParts: 20_000,
  /** Maximum recursion depth when resolving a part's own sub-file references. */
  maxPartDepth: 32,
  /** Maximum triangles generated for a single part definition. */
  maxTrianglesPerPart: 400_000,
  /** Maximum triangles across the whole model's occluder set. */
  maxTrianglesTotal: 40_000_000,
} as const;

export const ALLOWED_EXTENSIONS = ['.ldr', '.mpd'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export class ModelTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelTooLargeError';
  }
}

export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._ ()-]/g;

/**
 * Reduce an arbitrary user-supplied filename to something safe to echo back in
 * the UI, use in a Content-Disposition header, or write to disk. Strips any
 * directory component, control characters and characters that are meaningful to
 * a shell or a header, then bounds the length.
 */
export function sanitizeFilename(input: string, fallback = 'model'): string {
  const base = input.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(CONTROL_CHARS, '')
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const limited = cleaned.slice(0, 120);
  return limited.length > 0 ? limited : fallback;
}

export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export function assertAllowedExtension(filename: string): AllowedExtension {
  const ext = fileExtension(filename);
  if ((ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return ext as AllowedExtension;
  }
  throw new UnsupportedFileError(
    `Unsupported file type "${ext || '(none)'}". BrickThrift v1 accepts .ldr and .mpd files. ` +
      `If your model is a BrickLink Studio .io file, open it in Studio and use ` +
      `File > Export As > LDraw to produce a .ldr or .mpd.`,
  );
}

/**
 * Validate an upload before any parsing happens.
 * Returns a sanitized filename or throws.
 */
export function validateUpload(filename: string, byteLength: number): string {
  assertAllowedExtension(filename);
  if (byteLength <= 0) {
    throw new UnsupportedFileError('The uploaded file is empty.');
  }
  if (byteLength > LIMITS.maxFileBytes) {
    const mb = (byteLength / (1024 * 1024)).toFixed(1);
    const limitMb = (LIMITS.maxFileBytes / (1024 * 1024)).toFixed(0);
    throw new ModelTooLargeError(
      `That file is ${mb} MB, over the ${limitMb} MB limit. Very large LDraw files are ` +
        `usually the result of an exported model containing embedded part definitions.`,
    );
  }
  return sanitizeFilename(filename);
}

/**
 * Strip characters that must never reach a rendered page or an export.
 * Used for model titles, author names and other text lifted out of an
 * uploaded file. React escapes HTML for us; this exists to remove control
 * characters and bound the length so a hostile file cannot break layout.
 */
export function sanitizeText(input: string, maxLength = 200): string {
  return input.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
