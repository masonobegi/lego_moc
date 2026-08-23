/**
 * Installs the complete LDraw parts library into public/ldraw-full.
 *
 *   npm run parts:fetch                 # official ldraw.org distribution
 *   npm run parts:fetch -- --mirror     # GitHub mirror, for restricted networks
 *   npm run parts:fetch -- --models     # also fetch Official Model Repository models
 *
 * The repository already ships the ~0.8 MB subset of parts the built-in
 * fixtures need (public/ldraw), so the app works before this is ever run. Run
 * this before analyzing a real MOC: without it, parts outside the subset have
 * no geometry, and a part with no geometry can never be optimized.
 *
 * LICENCE: the LDraw Parts Library is licensed CC BY 2.0. Attribution to
 * LDraw.org and the individual part authors is required, and their headers are
 * preserved verbatim. See NOTICE.md and public/ldraw/CAreadme.txt.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const OFFICIAL_ZIP = 'https://library.ldraw.org/library/updates/complete.zip';
const MIRROR_REPO = 'https://github.com/gkjohnson/ldraw-parts-library';
const OUT = path.join(process.cwd(), 'public', 'ldraw-full');
const TMP = path.join(process.cwd(), '.brickthrift', 'download');

function hasCommand(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function downloadOfficial(): Promise<boolean> {
  console.log(`Downloading the official LDraw library from ${OFFICIAL_ZIP} ...`);
  mkdirSync(TMP, { recursive: true });
  const zipPath = path.join(TMP, 'complete.zip');
  try {
    const response = await fetch(OFFICIAL_ZIP);
    if (!response.ok || !response.body) {
      console.error(`  ldraw.org returned HTTP ${response.status}.`);
      return false;
    }
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(zipPath));
  } catch (error) {
    console.error(`  Download failed: ${(error as Error).message}`);
    return false;
  }

  if (!hasCommand('unzip')) {
    console.error('  `unzip` is not installed, so the archive cannot be extracted.');
    console.error(`  The archive is at ${zipPath}; extract it so that ${OUT}/parts exists.`);
    return false;
  }

  mkdirSync(OUT, { recursive: true });
  // The official archive contains a top-level `ldraw/` directory.
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', TMP], { stdio: 'inherit' });
  const extracted = path.join(TMP, 'ldraw');
  if (!existsSync(extracted)) {
    console.error('  The archive did not contain the expected ldraw/ directory.');
    return false;
  }
  rmSync(OUT, { recursive: true, force: true });
  execFileSync('sh', ['-c', `mv ${JSON.stringify(extracted)} ${JSON.stringify(OUT)}`], { stdio: 'inherit' });
  rmSync(TMP, { recursive: true, force: true });
  return true;
}

function downloadMirror(withModels: boolean): boolean {
  if (!hasCommand('git')) {
    console.error('git is not installed, so the mirror cannot be cloned.');
    return false;
  }
  console.log(`Cloning the GitHub mirror ${MIRROR_REPO} (this is a large repository) ...`);
  mkdirSync(TMP, { recursive: true });
  const clone = path.join(TMP, 'mirror');
  rmSync(clone, { recursive: true, force: true });
  try {
    execFileSync('git', ['clone', '--depth', '1', MIRROR_REPO, clone], { stdio: 'inherit' });
  } catch (error) {
    console.error(`Clone failed: ${(error as Error).message}`);
    return false;
  }

  const source = path.join(clone, 'complete', 'ldraw');
  if (!existsSync(source)) {
    console.error(`The mirror did not contain complete/ldraw.`);
    return false;
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync('sh', ['-c', `mv ${JSON.stringify(source)} ${JSON.stringify(OUT)}`], { stdio: 'inherit' });

  if (withModels) {
    const models = path.join(clone, 'models');
    const target = path.join(process.cwd(), 'test-models', 'omr');
    if (existsSync(models)) {
      mkdirSync(path.dirname(target), { recursive: true });
      rmSync(target, { recursive: true, force: true });
      execFileSync('sh', ['-c', `mv ${JSON.stringify(models)} ${JSON.stringify(target)}`], { stdio: 'inherit' });
      console.log(`Official Model Repository models placed in test-models/omr.`);
      console.log(
        'These are CC BY 2.0 and individually authored. They are NOT committed to this ' +
          'repository; keep the attribution in their headers if you redistribute them.',
      );
    }
  }

  rmSync(TMP, { recursive: true, force: true });
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useMirror = args.includes('--mirror');
  const withModels = args.includes('--models');

  let ok = false;
  if (!useMirror) {
    ok = await downloadOfficial();
    if (!ok) {
      console.log('');
      console.log('Falling back to the GitHub mirror. Re-run with --mirror to skip this attempt.');
    }
  }
  if (!ok) ok = downloadMirror(withModels);

  if (!ok) {
    console.error('');
    console.error('Could not install the parts library.');
    console.error('Manual alternative:');
    console.error('  1. Download https://library.ldraw.org/library/updates/complete.zip');
    console.error(`  2. Extract it so that ${OUT}/parts and ${OUT}/p exist.`);
    console.error('  3. Or set LDRAW_LIBRARY_PATH in .env.local to an existing LDraw installation.');
    process.exit(1);
  }

  console.log('');
  console.log(`Parts library installed at ${OUT}`);
  console.log('It takes precedence over the bundled subset automatically.');
  console.log('');
  console.log('LDraw Parts Library, licensed CC BY 2.0. Credit: LDraw.org and the part authors.');
}

void main();
