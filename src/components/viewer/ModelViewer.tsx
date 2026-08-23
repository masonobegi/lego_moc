'use client';

/**
 * Three.js model viewer.
 *
 * Renders real LDraw geometry, not stand-in boxes. Parts are instanced: a model
 * with 6,000 bricks made of 270 distinct parts uploads 270 geometries and draws
 * them with per-instance transforms and colors, which is what makes a large
 * MOC interactive in a browser at all.
 *
 * LDraw is -Y up, so the whole scene is rotated 180 degrees about X to put the
 * model the right way up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { decodeViewerPayload, type DecodedPayload } from './payload';

export interface SelectedPart {
  readonly instanceId: string;
  readonly partId: string;
  readonly description: string | null;
  readonly colorName: string;
  readonly colorHex: string;
  readonly subModel: string;
  readonly step: number;
  readonly visibility: string | null;
  readonly candidateId: string | null;
  readonly optimizedColorName: string | null;
  readonly optimizedPartId: string | null;
}

interface Props {
  readonly url: string;
  readonly showOptimized: boolean;
  /** Candidate ids currently switched on. Only these show their new color. */
  readonly enabledCandidateIds?: ReadonlySet<string>;
  readonly highlightInstanceIds?: readonly string[];
  readonly onSelect?: (part: SelectedPart | null) => void;
  readonly onLoaded?: (info: { instanceCount: number; partCount: number; omitted: number }) => void;
  readonly className?: string;
}

const HIGHLIGHT = new THREE.Color('#f0a836');
const DIM = 0.28;

export function ModelViewer({
  url,
  showOptimized,
  enabledCandidateIds,
  highlightInstanceIds,
  onSelect,
  onLoaded,
  className,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const sceneRef = useRef<SceneHandles | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const highlightSet = useMemo(
    () => new Set(highlightInstanceIds ?? []),
    [highlightInstanceIds],
  );

  // ---- build the scene once per payload -----------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    const controller = new AbortController();
    setStatus('loading');
    setError(null);

    const handles = createScene(mount);
    sceneRef.current = handles;

    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? 'This analysis is no longer available on the server.'
              : `The viewer could not load geometry (HTTP ${response.status}).`,
          );
        }
        const buffer = await response.arrayBuffer();
        if (disposed) return;
        const payload = decodeViewerPayload(buffer);
        buildModel(handles, payload);
        handles.fitToView();
        setStatus('ready');
        onLoaded?.({
          instanceCount: payload.header.instanceCount,
          partCount: payload.header.parts.length,
          omitted: payload.header.omittedInstanceCount,
        });
      } catch (caught) {
        if (disposed || (caught as Error).name === 'AbortError') return;
        setError((caught as Error).message);
        setStatus('error');
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      handles.dispose();
      sceneRef.current = null;
    };
    // onLoaded is intentionally not a dependency: it would rebuild the scene on
    // every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // ---- recolor when the optimized toggle or the highlight changes ---------
  useEffect(() => {
    const handles = sceneRef.current;
    if (!handles || status !== 'ready') return;
    handles.applyColors(showOptimized, enabledCandidateIds ?? null, highlightSet, selectedId);
  }, [showOptimized, enabledCandidateIds, highlightSet, selectedId, status]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const handles = sceneRef.current;
      if (!handles || status !== 'ready') return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const picked = handles.pick(x, y);
      setSelectedId(picked?.instanceId ?? null);
      onSelect?.(picked);
    },
    [onSelect, status],
  );

  return (
    <div className={`relative ${className ?? ''}`}>
      <div
        ref={mountRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
      />

      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2.5 rounded-[2px] bg-[var(--panel)] px-4 py-2.5 text-[0.82rem] text-[var(--text-dim)]">
            <Spinner />
            Building geometry
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-sm text-center text-[0.85rem] text-[var(--bad)]">{error}</p>
        </div>
      )}

      {status === 'ready' && (
        <div className="absolute right-3 top-3 flex flex-col gap-1.5">
          <ViewerButton label="Fit to view" onClick={() => sceneRef.current?.fitToView()}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
              <path d="M2 5.5V2h3.5M9.5 2H13v3.5M13 9.5V13H9.5M5.5 13H2V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </ViewerButton>
          <ViewerButton label="Reset camera" onClick={() => sceneRef.current?.resetCamera()}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
              <path d="M2.5 7.5a5 5 0 1 1 1.6 3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M2 4.2v3.4h3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </ViewerButton>
        </div>
      )}
    </div>
  );
}

function ViewerButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-[2px] border border-[var(--line)] bg-[var(--panel)] text-[var(--text-dim)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-[var(--line-strong)] border-t-[var(--accent)]" />
  );
}

// ---------------------------------------------------------------------------
// Three.js plumbing
// ---------------------------------------------------------------------------

interface SceneHandles {
  readonly root: THREE.Group;
  fitToView(): void;
  resetCamera(): void;
  pick(ndcX: number, ndcY: number): SelectedPart | null;
  applyColors(
    showOptimized: boolean,
    enabledCandidateIds: ReadonlySet<string> | null,
    highlight: ReadonlySet<string>,
    selectedId: string | null,
  ): void;
  /** Hand the scene its instanced meshes once the payload has been decoded. */
  attach(built: Built, sphere: THREE.Sphere, box: THREE.Box3): void;
  dispose(): void;
}

interface Built {
  meshes: THREE.InstancedMesh[];
  /** For each mesh, the global instance index of each of its slots. */
  slotToGlobal: Int32Array[];
  payload: DecodedPayload;
  root: THREE.Group;
}

function createScene(mount: HTMLElement): SceneHandles {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth || 1, mount.clientHeight || 1);
  renderer.setClearColor(0x0d0f14, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 100_000);
  camera.position.set(400, 320, 520);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI;

  scene.add(new THREE.HemisphereLight(0xdfe6f2, 0x1b2028, 1.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 1.4, 0.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xa9c4e8, 0.7);
  fill.position.set(-1, 0.4, -0.9);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.45);
  rim.position.set(0, -1, 0.3);
  scene.add(rim);

  // LDraw is -Y up.
  const root = new THREE.Group();
  root.rotation.x = Math.PI;
  scene.add(root);

  let built: Built | null = null;
  let boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  let boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let hasFitted = false;
  const resize = (): void => {
    const width = mount.clientWidth || 1;
    const height = mount.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (hasFitted) fitToView();
  };
  const observer = new ResizeObserver(() => resize());
  observer.observe(mount);

  let frame = 0;
  const tick = (): void => {
    frame = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();

  /**
   * Frame the model's bounding BOX as seen from the camera, not its bounding
   * sphere. Most MOCs are much wider than they are tall, and a sphere fit
   * leaves such a model as a small object floating in a large panel.
   *
   * The eight box corners are projected onto the camera's right and up axes and
   * the required distance is computed from the resulting 2D extents against the
   * horizontal and vertical fields of view separately.
   */
  const fitToView = (): void => {
    // The scene root carries the LDraw -Y-up correction. Its world matrix is
    // normally refreshed during render, so it must be forced here or the first
    // fit aims at the un-rotated center and the model sits off to one side.
    root.updateMatrixWorld(true);

    const direction = new THREE.Vector3(0.72, 0.46, 0.92).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(direction, up).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, direction).normalize();

    const worldBox = boundingBox.clone().applyMatrix4(root.matrixWorld);
    const target = worldBox.getCenter(new THREE.Vector3());

    let halfWidth = 0;
    let halfHeight = 0;
    let halfDepth = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? worldBox.max.x : worldBox.min.x,
        i & 2 ? worldBox.max.y : worldBox.min.y,
        i & 4 ? worldBox.max.z : worldBox.min.z,
      );
      corner.sub(target);
      halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
      halfHeight = Math.max(halfHeight, Math.abs(corner.dot(camUp)));
      halfDepth = Math.max(halfDepth, Math.abs(corner.dot(direction)));
    }

    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const distance =
      Math.max(halfHeight / Math.tan(vFov / 2), halfWidth / Math.tan(hFov / 2)) * 1.14 + halfDepth;

    camera.position.copy(target).addScaledVector(direction, Math.max(distance, 30));
    const radius = Math.max(1, boundingSphere.radius);
    camera.near = Math.max(0.5, radius / 500);
    camera.far = Math.max(2000, (distance + radius) * 4);
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.update();
  };

  resize();

  return {
    root,
    fitToView: () => {
      hasFitted = true;
      fitToView();
    },
    resetCamera: () => {
      hasFitted = true;
      fitToView();
    },
    attach(next, sphere, box) {
      built = next;
      boundingSphere = sphere;
      boundingBox = box;
    },
    pick(ndcX, ndcY) {
      if (!built) return null;
      pointer.set(ndcX, ndcY);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(built.meshes, false);
      const hit = hits.find((h) => h.instanceId !== undefined && h.instanceId !== null);
      if (!hit || hit.instanceId === undefined || hit.instanceId === null) return null;
      const mesh = hit.object as THREE.InstancedMesh;
      const meshIndex = built.meshes.indexOf(mesh);
      if (meshIndex < 0) return null;
      const global = built.slotToGlobal[meshIndex]![hit.instanceId]!;
      const record = built.payload.header.instances[global];
      if (!record) return null;
      const part = built.payload.header.parts[built.payload.partIndices[global]!];
      return {
        instanceId: record.id,
        partId: record.p,
        description: part?.description ?? null,
        colorName: record.cn,
        colorHex: record.ch,
        subModel: record.m,
        step: record.s + 1,
        visibility: record.v,
        candidateId: record.c,
        optimizedColorName: record.on,
        optimizedPartId: record.op,
      };
    },
    applyColors(showOptimized, enabledCandidateIds, highlight, selectedId) {
      if (!built) return;
      const { payload } = built;
      const color = new THREE.Color();
      const anyHighlight = highlight.size > 0 || selectedId !== null;

      built.meshes.forEach((mesh, meshIndex) => {
        const slots = built!.slotToGlobal[meshIndex]!;
        for (let slot = 0; slot < slots.length; slot++) {
          const global = slots[slot]!;
          const record = payload.header.instances[global]!;
          const changeActive =
            record.oh !== null &&
            record.c !== null &&
            (enabledCandidateIds === null || enabledCandidateIds.has(record.c));
          const hex = showOptimized && changeActive && record.oh ? record.oh : record.ch;
          color.set(hex);
          color.convertSRGBToLinear();

          const isFocus = record.id === selectedId || highlight.has(record.id);
          if (isFocus) {
            color.lerp(HIGHLIGHT.clone().convertSRGBToLinear(), 0.72);
          } else if (anyHighlight) {
            color.multiplyScalar(DIM);
          }
          mesh.setColorAt(slot, color);
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (built) {
        for (const mesh of built.meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
          root.remove(mesh);
        }
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    },
  };
}

function buildModel(handles: SceneHandles, payload: DecodedPayload): void {
  const root = handles.root;

  // Group instances by (part, opacity) so transparent bricks get their own
  // material and render pass.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < payload.header.instanceCount; i++) {
    const record = payload.header.instances[i]!;
    const transparent = record.ca < 255 || (record.oh !== null && record.ca < 255);
    const key = `${payload.partIndices[i]}|${transparent ? 't' : 'o'}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }

  const meshes: THREE.InstancedMesh[] = [];
  const slotToGlobal: Int32Array[] = [];
  const matrix = new THREE.Matrix4();

  for (const [key, indices] of groups) {
    const [partIndexText, kind] = key.split('|');
    const partIndex = Number(partIndexText);
    const positions = payload.partPositions[partIndex];
    if (!positions || positions.length === 0) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const transparent = kind === 't';
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: transparent ? 0.12 : 0.52,
      metalness: 0.02,
      // LDraw part files are surface models whose winding is not reliably
      // outward, so both faces are drawn rather than trusting the normals.
      side: THREE.DoubleSide,
      transparent,
      opacity: transparent ? 0.42 : 1,
      depthWrite: !transparent,
      flatShading: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, indices.length);
    mesh.frustumCulled = false;
    const slots = new Int32Array(indices.length);

    indices.forEach((global, slot) => {
      slots[slot] = global;
      const o = global * 12;
      const t = payload.transforms;
      // LDraw stores the 3x3 row-major; three.js `set` also takes row-major.
      matrix.set(
        t[o]!, t[o + 1]!, t[o + 2]!, t[o + 9]!,
        t[o + 3]!, t[o + 4]!, t[o + 5]!, t[o + 10]!,
        t[o + 6]!, t[o + 7]!, t[o + 8]!, t[o + 11]!,
        0, 0, 0, 1,
      );
      mesh.setMatrixAt(slot, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;

    root.add(mesh);
    meshes.push(mesh);
    slotToGlobal.push(slots);
  }

  const min = payload.header.bounds.min;
  const max = payload.header.bounds.max;
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const radius =
    Math.max(1, new THREE.Vector3(max[0] - center.x, max[1] - center.y, max[2] - center.z).length());
  const box = new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );

  handles.attach({ meshes, slotToGlobal, payload, root }, new THREE.Sphere(center, radius), box);
  handles.applyColors(true, null, new Set(), null);
}
