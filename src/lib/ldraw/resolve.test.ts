import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLDraw } from './parser';
import { countSteps, resolveModel, summarizeModel, totalStepCount } from './resolve';

function fixture(name: string) {
  return parseLDraw(readFileSync(path.join(process.cwd(), 'test-models', name), 'utf8'), {
    sourceName: name,
  });
}

describe('resolveModel: transforms', () => {
  it('composes nested transforms as M1*(M2*p + t2) + t1', () => {
    const document = parseLDraw(
      [
        '0 FILE main.ldr',
        // Rotate 90 degrees about Y, then translate.
        '1 16 100 0 0 0 0 1 0 1 0 -1 0 0 sub.ldr',
        '0 FILE sub.ldr',
        '1 4 10 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      ].join('\n'),
    );
    const resolved = resolveModel(document);
    expect(resolved.instances).toHaveLength(1);
    const instance = resolved.instances[0]!;
    // The child sits at local (10, 0, 0); the parent rotation maps x -> -z.
    expect(instance.position.x).toBeCloseTo(100);
    expect(instance.position.y).toBeCloseTo(0);
    expect(instance.position.z).toBeCloseTo(-10);
  });

  it('resolves color 16 up the reference chain', () => {
    const document = parseLDraw(
      [
        '0 FILE main.ldr',
        '1 4 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr',
        '0 FILE sub.ldr',
        '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      ].join('\n'),
    );
    const instance = resolveModel(document).instances[0]!;
    expect(instance.declaredColorId).toBe(16);
    expect(instance.colorId).toBe(4);
  });
});

describe('resolveModel: steps', () => {
  it('assigns each part the step it appears in, per sub-file', () => {
    const resolved = resolveModel(fixture('multi-step.mpd'));
    const red = resolved.instances.find((i) => i.colorId === 4)!;
    // The fixture introduces the red brick in the third step (index 2).
    expect(red.stepIndex).toBe(2);
  });

  it('counts a file with no STEP as one step, and ignores a trailing STEP', () => {
    expect(countSteps(parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat').files[0]!)).toBe(1);
    expect(
      countSteps(parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 STEP').files[0]!),
    ).toBe(1);
    expect(
      countSteps(
        parseLDraw(
          ['1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '0 STEP', '1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '0 STEP'].join('\n'),
        ).files[0]!,
      ),
    ).toBe(2);
  });

  it('totals steps across every reachable sub-file', () => {
    const resolved = resolveModel(fixture('submodel.mpd'));
    expect(totalStepCount(resolved)).toBeGreaterThan(countSteps(resolved.document.files[0]!));
  });
});

describe('resolveModel: instance identity', () => {
  it('gives every physical part a unique id', () => {
    const resolved = resolveModel(fixture('multiple-instances.mpd'));
    const ids = new Set(resolved.instances.map((i) => i.instanceId));
    expect(ids.size).toBe(resolved.instances.length);
  });

  it('makes instances from a reused submodel share one commandRef', () => {
    const resolved = resolveModel(fixture('multiple-instances.mpd'));
    const pods = resolved.instances.filter((i) => i.parentModel === 'pod.ldr');
    expect(pods).toHaveLength(2);
    // Same line, two physical bricks: this is the whole point of the fixture.
    expect(pods[0]!.commandRef).toEqual(pods[1]!.commandRef);
    expect(pods[0]!.instanceId).not.toBe(pods[1]!.instanceId);
  });

  it('produces stable ids across re-parses', () => {
    const a = resolveModel(fixture('multiple-instances.mpd')).instances.map((i) => i.instanceId);
    const b = resolveModel(fixture('multiple-instances.mpd')).instances.map((i) => i.instanceId);
    expect(b).toEqual(a);
  });
});

describe('resolveModel: hostile input', () => {
  it('refuses a direct self-reference without hanging', () => {
    const document = parseLDraw(
      ['0 FILE a.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.ldr'].join('\n'),
    );
    const resolved = resolveModel(document);
    expect(resolved.instances).toHaveLength(0);
    expect(resolved.warnings.some((w) => w.message.includes('recurse forever'))).toBe(true);
  });

  it('refuses a mutual reference cycle', () => {
    const document = parseLDraw(
      [
        '0 FILE a.ldr',
        '1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.ldr',
        '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
        '0 FILE b.ldr',
        '1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.ldr',
        '1 0 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      ].join('\n'),
    );
    const resolved = resolveModel(document);
    // The non-cyclic parts still come through.
    expect(resolved.instances.map((i) => i.partId).sort()).toEqual(['3001', '3005']);
  });

  it('stops at the instance limit rather than exploding', () => {
    // Eight levels of doubling would be 256 parts; the limit cuts it short.
    const files = ['0 FILE l0.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'];
    for (let level = 1; level <= 12; level++) {
      files.push(`0 FILE l${level}.ldr`);
      files.push(`1 16 0 0 0 1 0 0 0 1 0 0 0 1 l${level - 1}.ldr`);
      files.push(`1 16 100 0 0 1 0 0 0 1 0 0 0 1 l${level - 1}.ldr`);
    }
    // Make the deepest file the root by declaring it first.
    const source = ['0 FILE root.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 l12.ldr', ...files].join('\n');
    const resolved = resolveModel(parseLDraw(source), { maxInstances: 500 });
    expect(resolved.instances.length).toBeLessThanOrEqual(500);
    expect(resolved.truncated).toBe(true);
  });

  it('reports an external reference it cannot resolve', () => {
    const resolved = resolveModel(
      parseLDraw(['0 FILE a.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 missing-submodel.ldr'].join('\n')),
    );
    expect(resolved.unresolvedSubmodels).toContain('missing-submodel.ldr');
  });
});

describe('summarizeModel', () => {
  it('counts parts, lots and submodels', () => {
    const summary = summarizeModel(resolveModel(fixture('multiple-instances.mpd')));
    expect(summary.partCount).toBe(23);
    expect(summary.submodelCount).toBe(3);
    expect(summary.uniqueLotCount).toBeGreaterThan(0);
  });
});
