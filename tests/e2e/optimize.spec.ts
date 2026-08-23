/**
 * End-to-end test of the workflow a user actually performs:
 *
 *   open the site -> upload buried-brick.ldr -> analyse -> see the savings ->
 *   toggle the change off and watch the total change -> toggle back on ->
 *   download the optimised model -> confirm the downloaded file really does
 *   contain the substituted colour and still has its build steps.
 *
 * The download is parsed and asserted on, not merely observed to arrive: a
 * download button that hands back the original file would pass a weaker test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, 'test-models', 'buried-brick.ldr');

test.describe('optimise a model end to end', () => {
  test('upload, inspect, toggle and download', async ({ page }) => {
    await page.goto('/optimize');
    await expect(page.getByRole('heading', { name: 'Optimise a model' })).toBeVisible();

    // ---- upload ---------------------------------------------------------
    await page.setInputFiles('input[type="file"]', FIXTURE);

    // ---- results --------------------------------------------------------
    await page.waitForURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 180_000 });
    await expect(page.getByRole('heading', { name: 'Buried Brick' })).toBeVisible();

    // Demo data must be labelled as such wherever it is used.
    await expect(page.getByTestId('demo-price-badge')).toBeVisible();

    // ---- the savings are the ones the fixture is designed to produce -----
    await expect(page.getByTestId('original-cost')).toHaveText('$2.09');
    await expect(page.getByTestId('optimized-cost')).toHaveText('$1.46');
    await expect(page.getByTestId('savings-amount')).toHaveText('$0.63');

    // ---- the change is listed with its reason ---------------------------
    const changeRow = page.getByTestId('change-row').filter({ hasText: 'Brick 2 x 4' }).first();
    await expect(changeRow).toBeVisible();
    await expect(changeRow.getByText('Red')).toBeVisible();
    await expect(changeRow.getByText('Black')).toBeVisible();
    await expect(changeRow.getByText('Hidden', { exact: true })).toBeVisible();

    await changeRow.getByRole('button', { name: 'Why?' }).click();
    await expect(page.getByText('No externally visible surface detected', { exact: false })).toBeVisible();

    // ---- the 3D viewer renders real geometry ----------------------------
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByText('7 parts drawn')).toBeVisible({ timeout: 60_000 });

    // ---- toggling the change updates the total --------------------------
    const checkbox = changeRow.getByRole('checkbox');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(page.getByTestId('savings-amount')).toHaveText('$0.00', { timeout: 30_000 });
    await expect(page.getByTestId('optimized-cost')).toHaveText('$2.09');
    await checkbox.check();
    await expect(page.getByTestId('savings-amount')).toHaveText('$0.63', { timeout: 30_000 });
    await expect(page.getByTestId('optimized-cost')).toHaveText('$1.46');

    // ---- download the optimised model -----------------------------------
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-ldraw').getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('buried-brick-optimized.ldr');

    const downloadPath = await download.path();
    const optimized = readFileSync(downloadPath, 'utf8');
    const original = readFileSync(FIXTURE, 'utf8');

    // The substituted colour really is in the file.
    expect(optimized).toContain('1 0 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat');
    expect(optimized).not.toContain('1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat');
    expect(original).toContain('1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat');

    // Construction and build steps are untouched.
    const originalSteps = (original.match(/^0 STEP$/gm) ?? []).length;
    const optimizedSteps = (optimized.match(/^0 STEP$/gm) ?? []).length;
    expect(optimizedSteps).toBe(originalSteps);

    // Every other part line is byte-identical.
    const partLines = (text: string): string[] =>
      text.split(/\r?\n/).filter((line) => line.startsWith('1 '));
    const before = partLines(original);
    const after = partLines(optimized);
    expect(after).toHaveLength(before.length);
    const differing = before.filter((line, i) => line !== after[i]);
    expect(differing).toHaveLength(1);
  });

  test('downloading with the change disabled returns the original model', async ({ page }) => {
    await page.goto('/optimize');
    await page.setInputFiles('input[type="file"]', FIXTURE);
    await page.waitForURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 180_000 });

    await page.getByRole('button', { name: 'Disable all' }).click();
    await expect(page.getByTestId('enabled-count')).toContainText('0 enabled', { timeout: 30_000 });

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-ldraw').getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    const optimized = readFileSync(await download.path(), 'utf8');

    // The header block is added, but no part line changes.
    const original = readFileSync(FIXTURE, 'utf8');
    const partLines = (text: string): string[] =>
      text.split(/\r?\n/).filter((line) => line.startsWith('1 '));
    expect(partLines(optimized)).toEqual(partLines(original));
    expect(optimized).toContain('1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat');
  });
});

test.describe('a visible brick is never changed', () => {
  test('exposed-brick.ldr yields no candidates', async ({ page }) => {
    await page.goto('/dev');
    await page.getByText('exposed-brick.ldr').click();
    await expect(page.getByText('Open full results')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText('CANDIDATES (0)')).toBeVisible();
    await expect(page.getByText('None proposed', { exact: false })).toBeVisible();
  });
});

test.describe('error handling', () => {
  test('rejects an unsupported file type with a useful message', async ({ page }) => {
    await page.goto('/optimize');
    await page.setInputFiles('input[type="file"]', {
      name: 'model.io',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('not an ldraw file'),
    });
    await expect(page.getByText('Could not analyse that file')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Unsupported file type ".io"', { exact: false })).toBeVisible();
  });

  test('a model referencing unknown parts still imports', async ({ page }) => {
    const source = [
      '0 Unknown Parts Test',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 999999-does-not-exist.dat',
      '0 STEP',
    ].join('\n');
    await page.goto('/optimize');
    await page.setInputFiles('input[type="file"]', {
      name: 'unknown-parts.ldr',
      mimeType: 'text/plain',
      buffer: Buffer.from(source),
    });
    await page.waitForURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 180_000 });
    await expect(
      page.getByText('could not be found in the LDraw library', { exact: false }),
    ).toBeVisible();
  });
});
