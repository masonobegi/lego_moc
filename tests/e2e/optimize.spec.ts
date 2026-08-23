/**
 * End-to-end test of the workflow a user actually performs:
 *
 *   open the site -> upload buried-brick.ldr -> analyze -> see the savings ->
 *   toggle the change off and watch the total change -> toggle back on ->
 *   download the optimized model -> confirm the downloaded file really does
 *   contain the substituted color and still has its build steps.
 *
 * The download is parsed and asserted on, not merely observed to arrive: a
 * download button that hands back the original file would pass a weaker test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, 'test-models', 'buried-brick.ldr');

test.describe('optimize a model end to end', () => {
  test('upload, inspect, toggle and download', async ({ page }) => {
    await page.goto('/optimize');
    await expect(page.getByRole('heading', { name: 'Optimize a model' })).toBeVisible();

    // ---- upload, then the "model detected" step --------------------------
    await page.setInputFiles('input[type="file"]', FIXTURE);
    const detected = page.getByTestId('model-detected');
    await expect(detected).toBeVisible({ timeout: 60_000 });
    // The counts the parser reports for this fixture.
    await expect(detected).toContainText('7');
    await expect(detected).toContainText('Build steps');
    await expect(detected).toContainText('Submodels');
    await page.getByTestId('analyze-button').click();

    // ---- results --------------------------------------------------------
    await page.waitForURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 180_000 });
    await expect(page.getByRole('heading', { name: 'Buried Brick' })).toBeVisible();

    // Demo data must be labeled as such wherever it is used.
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

    // ---- the review step states what will actually be ordered ------------
    const order = page.getByTestId('order-summary');
    await expect(order).toContainText('You are about to order');
    await expect(order).toContainText('1 of 1');

    // ---- a threshold control clears out changes that are not worth it -----
    await page.getByRole('button', { name: 'Turn off under $1.00' }).click();
    await expect(page.getByTestId('savings-amount')).toHaveText('$0.00', { timeout: 30_000 });
    await expect(order).toContainText('0 of 1');
    // $0.63 is above the $0.25 threshold, so this one leaves it enabled.
    await page.getByRole('button', { name: 'Enable safe changes' }).click();
    await expect(page.getByTestId('savings-amount')).toHaveText('$0.63', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Turn off under $0.25' }).click();
    await expect(page.getByTestId('savings-amount')).toHaveText('$0.63');

    // ---- download the optimized model -----------------------------------
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-ldraw').getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('buried-brick-optimized.ldr');

    const downloadPath = await download.path();
    const optimized = readFileSync(downloadPath, 'utf8');
    const original = readFileSync(FIXTURE, 'utf8');

    // The substituted color really is in the file.
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
    await page.getByTestId('analyze-button').click();
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

test.describe('the model detected step', () => {
  test('reports the parse result before running the analysis', async ({ page }) => {
    await page.goto('/optimize');
    await page.setInputFiles('input[type="file"]', path.join(ROOT, 'test-models', 'multiple-instances.mpd'));

    const detected = page.getByTestId('model-detected');
    await expect(detected).toBeVisible({ timeout: 60_000 });
    await expect(detected).toContainText('Repeated Submodel Instances');
    await expect(detected).toContainText('23');
    // Nothing has been analyzed yet: we are still on /optimize.
    expect(page.url()).toContain('/optimize');

    await page.getByRole('button', { name: 'Choose another' }).click();
    await expect(detected).toBeHidden();
    await expect(page.getByText('Drop your LEGO model here')).toBeVisible();
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
    await expect(page.getByText('Could not analyze that file')).toBeVisible({ timeout: 60_000 });
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
    await page.getByTestId('analyze-button').click();
    await page.waitForURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 180_000 });
    await expect(
      page.getByText('could not be found in the LDraw library', { exact: false }),
    ).toBeVisible();
  });
});

/**
 * The product's answer to "will I actually save money?" is not our estimate -
 * it is the difference between two BrickLink order totals. These cover the
 * workflow that gets the user there, and the wording that stops the estimate
 * being read as a checkout price.
 */
test.describe('estimated part cost is never presented as a delivered price', () => {
  test('the results page separates the two and offers both Wanted Lists', async ({ page }) => {
    const id = await analyzeFixture(page, 'buried-brick.ldr');
    await page.goto(`/results/${id}`);

    const disclaimer = page.getByTestId('not-checkout-price');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText('not');
    await expect(disclaimer).toContainText('what an order costs');
    await expect(disclaimer).toContainText('shipping');
    await expect(disclaimer).toContainText('minimum order requirements');

    // Both lists are downloadable, and the original is offered first.
    await expect(page.getByTestId('export-wanted-list-original')).toBeVisible();
    await expect(page.getByTestId('export-wanted-list')).toBeVisible();

    // And the page never claims a guaranteed saving.
    await expect(page.getByText(/you will save/i)).toHaveCount(0);
  });

  test('the verify-on-BrickLink workflow computes savings from the user\'s own figures', async ({
    page,
  }) => {
    const id = await analyzeFixture(page, 'buried-brick.ldr');
    await page.goto(`/results/${id}`);

    const verify = page.getByTestId('verify-on-bricklink');
    await expect(verify).toBeVisible();
    await expect(verify).toContainText('Want to know whether you actually save money after shipping?');

    await page.getByTestId('delivered-original').fill('186.42');
    await page.getByTestId('delivered-optimized').fill('161.07');

    const comparison = page.getByTestId('delivered-comparison');
    await expect(comparison).toBeVisible();
    await expect(comparison).toContainText('$25.35');
    await expect(comparison).toContainText('cheaper');
    // Even the user's own BrickLink figures are not called guaranteed.
    await expect(comparison).toContainText('not a guaranteed price');
  });

  test('an optimized order that costs more is reported as more expensive', async ({ page }) => {
    const id = await analyzeFixture(page, 'buried-brick.ldr');
    await page.goto(`/results/${id}`);

    // Splitting the order across an extra seller really can do this, and the
    // page must say so rather than showing a negative "saving".
    await page.getByTestId('delivered-original').fill('100.00');
    await page.getByTestId('delivered-optimized').fill('112.50');

    const comparison = page.getByTestId('delivered-comparison');
    await expect(comparison).toContainText('$12.50');
    await expect(comparison).toContainText('more expensive');
  });
});

/** Runs a bundled fixture through the real pipeline and returns the analysis id. */
async function analyzeFixture(page: import('@playwright/test').Page, fixture: string): Promise<string> {
  const response = await page.request.post('/api/analyze', { data: { fixture } });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { id: string } };
  return body.result.id;
}

/**
 * The changed-parts export is the one a user is most likely to act on without
 * reading, so these check the artifacts that actually land on disk rather than
 * just the functions that build them.
 */
test.describe('the changed-parts-only export', () => {
  test('downloads both forms and they agree with each other', async ({ page }) => {
    const id = await analyzeFixture(page, 'buried-brick.ldr');
    await page.goto(`/results/${id}`);

    const csvDownload = page.waitForEvent('download');
    await page.getByTestId('export-changed-parts-csv').getByRole('button', { name: 'Download' }).click();
    const csv = readFileSync(await (await csvDownload).path(), 'utf8');

    // Provenance first, then the column row.
    expect(csv.startsWith('#')).toBe(true);
    expect(csv).toContain('NOT a complete parts list');
    expect(csv).toContain('DEMO PRICE DATA');
    expect(csv).toContain('COSTS you');
    const rows = csv.trim().split('\r\n').filter((row) => !row.startsWith('#'));
    expect(rows[0]).toContain('action');
    expect(rows.length).toBeGreaterThan(1);
    // buried-brick.ldr recolors one red 2x4 to black: one lot out, one lot in.
    expect(csv).toContain('No longer needed');
    expect(csv).toMatch(/Buy/);

    const xmlDownload = page.waitForEvent('download');
    await page
      .getByTestId('export-changed-parts-wanted-list')
      .getByRole('button', { name: 'Download' })
      .click();
    const xml = readFileSync(await (await xmlDownload).path(), 'utf8');

    // Only the increase is expressible, and the file says so plainly.
    expect(xml).toContain('CHANGED PARTS ONLY');
    expect(xml).toContain('NOT a complete parts list');
    // The precondition, and where to go instead if it does not hold.
    expect(xml).toContain('correct only if');
    expect(xml).toContain('use the OPTIMIZED Wanted List');
    // Acting on it after ordering costs money and returns nothing.
    expect(xml).toContain('COSTS you');
    expect(xml).toContain('BEFORE you order');
    // The delta is its own order, with its own shipping.
    expect(xml).toContain('own BrickLink order');
    // Provenance, and the demo-price disclosure this file used to lack.
    expect(xml).toContain('buried-brick.ldr');
    expect(xml).toContain('DEMO PRICE DATA');
    expect(xml).toContain('<INVENTORY>');
    expect(xml).toContain('<MINQTY>1</MINQTY>');

    // The XML carries only the added lot; the removed one exists only in the CSV.
    const items = [...xml.matchAll(/<ITEM>/g)].length;
    expect(items).toBe(1);
  });

  test('is empty, not broken, when no changes are enabled', async ({ page }) => {
    const id = await analyzeFixture(page, 'buried-brick.ldr');
    await page.goto(`/results/${id}`);

    await page.getByRole('button', { name: 'Disable all' }).click();
    await expect(page.getByTestId('enabled-count')).toContainText('0 enabled', { timeout: 30_000 });

    const csvDownload = page.waitForEvent('download');
    await page.getByTestId('export-changed-parts-csv').getByRole('button', { name: 'Download' }).click();
    const csv = readFileSync(await (await csvDownload).path(), 'utf8');

    // Column row only: nothing changed, so nothing to buy differently.
    const rows = csv.trim().split('\r\n').filter((row) => !row.startsWith('#'));
    expect(rows).toHaveLength(1);
  });
});
