/**
 * Why this file exists: it draws the confidence map as a 3D chart with Three.js. Each claim is a
 * sphere placed by the three checks claimcheck runs: what the author stated (up), what the tests
 * proved (right) and what the independent checker decided (toward you). Three red sheets mark the
 * flag lines, and a claim outside the green box needs a decision. Drag to orbit, scroll to zoom,
 * right-drag to pan, double-click to reset. Axis numbers, point names and the hover card are plain
 * page text laid over the canvas, so they stay sharp and readable.
 *
 * If the GPU refuses a WebGL context, startConfidenceMap says so and the page shows the table alone.
 *
 * @author Patrick Finazzo
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CHECKER_LEVELS, GUTTER, MAP_BOUNDS, type ConfidenceMap, type MapPoint } from '../shared/confidence-map.ts';
import { makeElement, mount } from './dom.ts';

export type MapHandle = {
  setMap: (map: ConfidenceMap) => void;
  setSelected: (id: string | null) => void;
  /** Reads the page's colours again, after the light or dark setting changed. */
  setTheme: () => void;
  resetView: () => void;
  /** Draws one frame now, so a canvas that was just moved in the page is never blank. */
  drawNow: () => void;
};

export type MapStart = { status: 'ready'; handle: MapHandle } | { status: 'unavailable'; reason: string };

type Parts = {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  tooltip: HTMLElement;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
};

type Tokens = { bad: THREE.Color; ok: THREE.Color; accent: THREE.Color; faint: THREE.Color; text: THREE.Color };

type Marker = {
  point: MapPoint;
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  halo: THREE.Sprite;
  ring: THREE.Sprite | null;
  phase: number;
};

type Box = { x: number; y: number; width: number; height: number };

type Axis = 'x' | 'y' | 'z';

type Screen = { sx: number; sy: number; distance: number; isInFront: boolean };

const { minX, maxX, minY, maxY, minZ, maxZ } = MAP_BOUNDS;
const CENTER = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
const HOME_OFFSET = new THREE.Vector3(2.0, 1.2, 2.5);
const SPHERE_RADIUS = 0.03;
const HALO_SIZE = 0.2;
const RING_SIZE = 0.115;
const HIT_RADIUS_PX = 18;
const CLICK_SLOP_PX = 4;
const LABEL_LIMIT = 40;
const NEAR_ZOOM_DISTANCE = 2;
const AUTO_ROTATE_SPEED = 0.7;
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
const CHECKER_TICKS: readonly { word: string; level: number }[] = [
  { word: 'not checked', level: GUTTER },
  { word: 'refuted', level: CHECKER_LEVELS.get('refuted') ?? 0 },
  { word: 'unverifiable', level: CHECKER_LEVELS.get('unverifiable') ?? 0.5 },
  { word: 'supported', level: CHECKER_LEVELS.get('supported') ?? 1 },
];

const readToken = ({ name, fallback }: { name: string; fallback: string }): THREE.Color => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(/^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);
};

const readTokens = (): Tokens => ({
  bad: readToken({ name: '--bad', fallback: '#d6382a' }),
  ok: readToken({ name: '--ok', fallback: '#178a4b' }),
  accent: readToken({ name: '--accent', fallback: '#4f5fe8' }),
  faint: readToken({ name: '--faint', fallback: '#8e97b1' }),
  text: readToken({ name: '--text', fallback: '#121830' }),
});

const formatTick = ({ value }: { value: number }): string => {
  if (value === 0) return '0';
  return value === 1 ? '1.0' : value.toFixed(2);
};

/** A canvas picture turned into a texture, for halos, floor shadows and the refuted ring. */
const buildCanvasTexture = ({ draw }: { draw: (context: CanvasRenderingContext2D, size: number) => void }): THREE.CanvasTexture => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) draw(context, size);
  return new THREE.CanvasTexture(canvas);
};

/** A soft round glow. */
const buildGlowTexture = (): THREE.CanvasTexture =>
  buildCanvasTexture({
    draw: (context, size) => {
      const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
      gradient.addColorStop(0.35, 'rgba(255,255,255,0.3)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    },
  });

/** A thin ring that marks a claim the checker refuted. */
const buildRingTexture = (): THREE.CanvasTexture =>
  buildCanvasTexture({
    draw: (context, size) => {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 9;
      context.beginPath();
      context.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
      context.stroke();
    },
  });

const buildLineSet = ({ segments, color, opacity }: { segments: readonly number[]; color: THREE.Color; opacity: number }): THREE.LineSegments => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments), 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
};

/** The twelve edges of a box, as pairs of corners. */
const buildBoxEdges = ({ xMin, xMax, yMin, yMax, zMin, zMax }: { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number }): number[] => [
  ...[xMin, yMin, zMin, xMax, yMin, zMin, xMax, yMin, zMin, xMax, yMax, zMin, xMax, yMax, zMin, xMin, yMax, zMin, xMin, yMax, zMin, xMin, yMin, zMin],
  ...[xMin, yMin, zMax, xMax, yMin, zMax, xMax, yMin, zMax, xMax, yMax, zMax, xMax, yMax, zMax, xMin, yMax, zMax, xMin, yMax, zMax, xMin, yMin, zMax],
  ...[xMin, yMin, zMin, xMin, yMin, zMax, xMax, yMin, zMin, xMax, yMin, zMax, xMax, yMax, zMin, xMax, yMax, zMax, xMin, yMax, zMin, xMin, yMax, zMax],
];

/** The outline of the sheet at one flag line, as pairs of corners. */
const buildSheetOutline = ({ axis, value }: { axis: Axis; value: number }): number[] => {
  if (axis === 'x') return [value, minY, minZ, value, minY, maxZ, value, minY, maxZ, value, maxY, maxZ, value, maxY, maxZ, value, maxY, minZ, value, maxY, minZ, value, minY, minZ];
  if (axis === 'y') return [minX, value, minZ, maxX, value, minZ, maxX, value, minZ, maxX, value, maxZ, maxX, value, maxZ, minX, value, maxZ, minX, value, maxZ, minX, value, minZ];
  return [minX, minY, value, maxX, minY, value, maxX, minY, value, maxX, maxY, value, maxX, maxY, value, minX, maxY, value, minX, maxY, value, minX, minY, value];
};

/** A translucent sheet across the box at one flag line, with a bright outline so its edge reads. */
const buildFlagSheet = ({ axis, value, color }: { axis: Axis; value: number; color: THREE.Color }): THREE.Group => {
  const group = new THREE.Group();
  const width = axis === 'x' ? maxZ - minZ : maxX - minX;
  const height = axis === 'y' ? maxZ - minZ : maxY - minY;
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  if (axis === 'x') {
    sheet.rotation.y = Math.PI / 2;
    sheet.position.set(value, CENTER.y, CENTER.z);
  } else if (axis === 'y') {
    sheet.rotation.x = Math.PI / 2;
    sheet.position.set(CENTER.x, value, CENTER.z);
  } else {
    sheet.position.set(CENTER.x, CENTER.y, value);
  }
  group.add(sheet, buildLineSet({ segments: buildSheetOutline({ axis, value }), color, opacity: 0.85 }));
  return group;
};

/** Removes everything in a group and frees its GPU memory. A geometry named in `keep` is shared, so it stays. */
const cleanGroup = ({ group, keep }: { group: THREE.Object3D; keep: THREE.BufferGeometry }): void => {
  for (const child of [...group.children]) {
    cleanGroup({ group: child, keep });
    group.remove(child);
    const drawable = child as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (drawable.geometry && drawable.geometry !== keep) drawable.geometry.dispose();
    const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
    materials.forEach((material) => material?.dispose());
  }
};

const makeRenderer = ({ canvas }: { canvas: HTMLCanvasElement }): THREE.WebGLRenderer | string => {
  try {
    return new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** The tooltip's last line: where the claim stands. */
const describeStanding = ({ point }: { point: MapPoint }): string => {
  if (point.isSettled) return 'Settled.';
  return point.needsDecision ? 'Needs a decision.' : 'Backed.';
};

/** How much bigger than normal a sphere is drawn. */
const toGrowth = ({ isSelected, isHover }: { isSelected: boolean; isHover: boolean }): number => {
  if (isSelected) return 1.45;
  return isHover ? 1.25 : 1;
};

/** How bright a sphere's glow is: strong for the selected one, softer for hover, faint for a flagged claim, none otherwise. */
const toHaloOpacity = ({ isSelected, isHover, isFlagged }: { isSelected: boolean; isHover: boolean; isFlagged: boolean }): number => {
  if (isSelected) return 0.6;
  if (isHover) return 0.5;
  return isFlagged ? 0.32 : 0;
};

const isDarkScheme = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

const pickBlending = (): THREE.Blending => (isDarkScheme() ? THREE.AdditiveBlending : THREE.NormalBlending);

const isOverlapping = ({ first, second }: { first: Box; second: Box }): boolean =>
  first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;

/** Draws the chart on `parts.canvas`, or explains why it cannot. */
export const startConfidenceMap = ({ stage, canvas, overlay, tooltip, reducedMotion, onSelect }: Parts): MapStart => {
  const made = makeRenderer({ canvas });
  if (typeof made === 'string') return { status: 'unavailable', reason: made };
  const renderer = made;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 60);
  camera.position.copy(CENTER.clone().add(HOME_OFFSET));
  camera.lookAt(CENTER);

  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
  keyLight.position.set(2.5, 3.5, 2.5);
  scene.add(keyLight);

  const staticGroup = new THREE.Group();
  const markerGroup = new THREE.Group();
  scene.add(staticGroup, markerGroup);

  const sphereGeometry = new THREE.SphereGeometry(1, 20, 14);
  const glowTexture = buildGlowTexture();
  const ringTexture = buildRingTexture();

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(CENTER);
  controls.enableDamping = !reducedMotion;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.9;
  controls.maxDistance = 6;
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
  controls.update();
  controls.saveState();

  const size = { width: 1, height: 1 };
  const state = { map: null as ConfidenceMap | null, selectedId: null as string | null, hoverId: null as string | null, isDirty: true, tokens: readTokens(), markers: [] as readonly Marker[] };
  const labels = new Map<string, HTMLElement>();
  const scratch = new THREE.Vector3();
  const clock = new THREE.Clock();

  // ---- the box, its grids, the flag sheets and the green backed box -------------------------------------------------

  const buildStatic = ({ map }: { map: ConfidenceMap }): void => {
    cleanGroup({ group: staticGroup, keep: sphereGeometry });
    const { text, bad, ok } = state.tokens;
    const grid = [...TICKS, GUTTER].flatMap((tick) => [
      ...[tick, minY, minZ, tick, minY, maxZ, minX, minY, tick, maxX, minY, tick],
      ...[tick, minY, minZ, tick, maxY, minZ, minX, tick, minZ, maxX, tick, minZ],
      ...[minX, tick, minZ, minX, tick, maxZ, minX, minY, tick, minX, maxY, tick],
    ]);
    const backed = { xMin: map.flagCatchRate, xMax: maxX, yMin: map.flagConfidence, yMax: maxY, zMin: map.flagChecker, zMax: maxZ };
    const backedBox = new THREE.Mesh(
      new THREE.BoxGeometry(backed.xMax - backed.xMin, backed.yMax - backed.yMin, backed.zMax - backed.zMin),
      new THREE.MeshBasicMaterial({ color: ok, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    backedBox.position.set((backed.xMin + backed.xMax) / 2, (backed.yMin + backed.yMax) / 2, (backed.zMin + backed.zMax) / 2);
    staticGroup.add(
      buildLineSet({ segments: buildBoxEdges({ xMin: minX, xMax: maxX, yMin: minY, yMax: maxY, zMin: minZ, zMax: maxZ }), color: text, opacity: 0.3 }),
      buildLineSet({ segments: grid, color: text, opacity: 0.1 }),
      buildFlagSheet({ axis: 'x', value: map.flagCatchRate, color: bad }),
      buildFlagSheet({ axis: 'y', value: map.flagConfidence, color: bad }),
      buildFlagSheet({ axis: 'z', value: map.flagChecker, color: bad }),
      backedBox,
      buildLineSet({ segments: buildBoxEdges(backed), color: ok, opacity: 0.9 }),
    );
  };

  // ---- the spheres, their halos, and their drop lines to the floor ---------------------------------------------------

  const colorOf = ({ point }: { point: MapPoint }): THREE.Color => {
    if (point.isSettled) return state.tokens.faint;
    return point.needsDecision ? state.tokens.bad : state.tokens.accent;
  };

  const buildSprite = ({ texture, color, opacity }: { texture: THREE.Texture; color: THREE.Color; opacity: number }): THREE.Sprite =>
    new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color, transparent: true, opacity, depthWrite: false, blending: pickBlending() }));

  const buildMarker = ({ point, index }: { point: MapPoint; index: number }): Marker => {
    const color = colorOf({ point });
    const sphere = new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.05 }));
    sphere.position.set(point.x, point.y, point.z);
    sphere.scale.setScalar(SPHERE_RADIUS);
    const halo = buildSprite({ texture: glowTexture, color, opacity: 0 });
    halo.position.copy(sphere.position);
    const ring = point.isRefuted ? buildSprite({ texture: ringTexture, color: state.tokens.text, opacity: 0.95 }) : null;
    ring?.position.copy(sphere.position);
    ring?.scale.setScalar(RING_SIZE);
    markerGroup.add(halo, sphere);
    if (ring) markerGroup.add(ring);
    return { point, sphere, halo, ring, phase: index * 0.9 };
  };

  const buildMarkers = ({ map }: { map: ConfidenceMap }): void => {
    cleanGroup({ group: markerGroup, keep: sphereGeometry });
    state.markers = map.points.map((point, index) => buildMarker({ point, index }));
    if (map.points.length === 0) return;
    markerGroup.add(buildLineSet({ segments: map.points.flatMap((point) => [point.x, point.y, point.z, point.x, minY, point.z]), color: state.tokens.text, opacity: 0.16 }));
    const feet = new THREE.BufferGeometry();
    feet.setAttribute('position', new THREE.BufferAttribute(new Float32Array(map.points.flatMap((point) => [point.x, minY, point.z])), 3));
    markerGroup.add(new THREE.Points(feet, new THREE.PointsMaterial({ map: glowTexture, color: state.tokens.text, size: 0.07, transparent: true, opacity: 0.5, depthWrite: false })));
  };

  const recolor = (): void => {
    for (const marker of state.markers) {
      const color = colorOf({ point: marker.point });
      marker.sphere.material.color.copy(color);
      marker.sphere.material.emissive.copy(color);
      marker.halo.material.color.copy(color);
      marker.halo.material.blending = pickBlending();
      if (marker.ring) marker.ring.material.color.copy(state.tokens.text);
    }
  };

  // ---- the text laid over the canvas ---------------------------------------------------------------------------------------

  const project = ({ x, y, level }: { x: number; y: number; level: number }): Screen => {
    scratch.set(x, y, level);
    const distance = camera.position.distanceTo(scratch);
    scratch.project(camera);
    return { sx: (scratch.x * 0.5 + 0.5) * size.width, sy: (-scratch.y * 0.5 + 0.5) * size.height, distance, isInFront: scratch.z < 1 };
  };

  const placeLabel = ({ key, text, x, y, level, className, offsetX = 0, offsetY = 0, used }: { key: string; text: string; x: number; y: number; level: number; className: string; offsetX?: number; offsetY?: number; used: Set<string> }): void => {
    const spot = project({ x, y, level });
    if (!spot.isInFront) return;
    used.add(key);
    const label = labels.get(key) ?? makeElement({ tag: 'span', props: { class: className } });
    if (!labels.has(key)) {
      labels.set(key, label);
      overlay.appendChild(label);
    }
    if (label.textContent !== text) label.textContent = text;
    // Things farther from the camera fade, which helps the eye tell near from far.
    const toCenter = camera.position.distanceTo(CENTER);
    label.style.opacity = Math.min(1, Math.max(0.35, 1.15 - ((spot.distance - (toCenter - 0.9)) / 1.8) * 0.7)).toFixed(2);
    label.style.transform = `translate(${(spot.sx + offsetX).toFixed(1)}px, ${(spot.sy + offsetY).toFixed(1)}px)`;
  };

  /** The selected claim ranks first, then claims that need a decision, then the rest. */
  const rankMarker = ({ marker }: { marker: Marker }): number => {
    if (marker.point.id === state.selectedId) return 0;
    return marker.point.needsDecision && !marker.point.isSettled ? 1 : 2;
  };

  /**
   * Which claim names to show. A name that would land on one already chosen is left out, so a crowd
   * stays readable. Orbiting or zooming separates them.
   */
  const chooseNames = (): readonly Marker[] => {
    const shouldShowAll = state.markers.length <= LABEL_LIMIT || camera.position.distanceTo(CENTER) < NEAR_ZOOM_DISTANCE;
    const ordered = state.markers.toSorted((first, second) => rankMarker({ marker: first }) - rankMarker({ marker: second }));
    return ordered.reduce<{ taken: readonly Box[]; chosen: readonly Marker[] }>(
      (carried, marker) => {
        if (!shouldShowAll && marker.point.id !== state.selectedId) return carried;
        const spot = project({ x: marker.point.x, y: marker.point.y, level: marker.point.z });
        const box = { x: spot.sx + 10, y: spot.sy - 22, width: marker.point.id.length * 8 + 6, height: 14 };
        if (!spot.isInFront || carried.taken.some((other) => isOverlapping({ first: box, second: other }))) return carried;
        return { taken: [...carried.taken, box], chosen: [...carried.chosen, marker] };
      },
      { taken: [], chosen: [] },
    ).chosen;
  };

  const layoutOverlay = (): void => {
    const used = new Set<string>();
    const front = maxZ + 0.07;
    for (const tick of TICKS) {
      placeLabel({ key: `x${tick}`, text: formatTick({ value: tick }), x: tick, y: minY, level: front, className: 'map-tick', used });
      placeLabel({ key: `y${tick}`, text: formatTick({ value: tick }), x: minX - 0.05, y: tick, level: front, className: 'map-tick', offsetX: -22, used });
    }
    placeLabel({ key: 'xn', text: 'no run', x: GUTTER, y: minY, level: front, className: 'map-tick', offsetX: -16, offsetY: 14, used });
    placeLabel({ key: 'yn', text: 'none', x: minX - 0.05, y: GUTTER, level: front, className: 'map-tick', offsetX: -24, used });
    for (const entry of CHECKER_TICKS) {
      const isGutter = entry.level === GUTTER;
      placeLabel({ key: `z${entry.word}`, text: entry.word, x: maxX + 0.07, y: minY, level: entry.level, className: 'map-tick', offsetX: isGutter ? 38 : 4, offsetY: isGutter ? 12 : 0, used });
    }
    placeLabel({ key: 'tx', text: 'Tests: planted bugs caught', x: CENTER.x, y: minY, level: maxZ + 0.34, className: 'map-axis-title', offsetX: -40, offsetY: 10, used });
    placeLabel({ key: 'ty', text: 'Author: stated confidence', x: minX, y: maxY + 0.07, level: maxZ, className: 'map-axis-title', offsetY: -14, used });
    placeLabel({ key: 'tz', text: 'Checker: independent verdict', x: maxX + 0.3, y: minY, level: CENTER.z, className: 'map-axis-title', offsetX: 8, offsetY: 22, used });
    const map = state.map;
    if (map) {
      placeLabel({ key: 'fx', text: `tests below ${map.flagCatchRate}`, x: map.flagCatchRate, y: maxY, level: minZ, className: 'map-line-label', offsetY: -16, used });
      placeLabel({ key: 'fy', text: `confidence below ${map.flagConfidence}`, x: maxX, y: map.flagConfidence, level: maxZ, className: 'map-line-label', offsetX: 10, offsetY: -4, used });
      placeLabel({ key: 'fz', text: 'checker not satisfied', x: minX, y: maxY, level: map.flagChecker, className: 'map-line-label', offsetX: -138, offsetY: -4, used });
      for (const marker of chooseNames()) {
        const isSelected = marker.point.id === state.selectedId;
        placeLabel({ key: `p${marker.point.id}`, text: marker.point.id, x: marker.point.x, y: marker.point.y, level: marker.point.z, className: `map-name${isSelected ? ' is-selected' : ''}`, offsetX: 10, offsetY: -22, used });
      }
    }
    for (const [key, label] of labels) {
      if (used.has(key)) continue;
      label.remove();
      labels.delete(key);
    }
  };

  const showTooltip = ({ marker }: { marker: Marker | null }): void => {
    if (!marker) {
      tooltip.hidden = true;
      return;
    }
    const { point } = marker;
    const stated = point.confidence === null ? 'no confidence stated' : `stated ${point.confidence.toFixed(2)}`;
    const caught = point.catchRate === null ? 'no planted-bug run' : `tests caught ${Math.round(point.catchRate * 100)}%`;
    const isOpen = point.needsDecision && !point.isSettled;
    mount({
      parent: tooltip,
      children: [
        makeElement({ tag: 'strong', props: {}, children: [point.id] }),
        makeElement({ tag: 'span', props: {}, children: [point.title] }),
        makeElement({ tag: 'span', props: { class: 'muted' }, children: [`${stated}. ${caught}. Checker: ${point.verdict}.`] }),
        makeElement({ tag: 'span', props: { class: isOpen ? 'error' : 'muted' }, children: [describeStanding({ point })] }),
      ],
    });
    const { sx, sy } = project({ x: point.x, y: point.y, level: point.z });
    tooltip.hidden = false;
    const shouldFlipLeft = sx > size.width - 300;
    tooltip.style.transform = `translate(${Math.round(shouldFlipLeft ? sx - 292 : sx + 18)}px, ${Math.round(Math.max(4, Math.min(size.height - 110, sy - 20)))}px)`;
  };

  // ---- drawing a frame -------------------------------------------------------------------------------------------------------

  const placeMarkers = ({ elapsed }: { elapsed: number }): void => {
    for (const marker of state.markers) {
      const isSelected = marker.point.id === state.selectedId;
      const isHover = marker.point.id === state.hoverId;
      const isFlagged = marker.point.needsDecision && !marker.point.isSettled;
      marker.sphere.scale.setScalar(SPHERE_RADIUS * toGrowth({ isSelected, isHover }));
      marker.sphere.material.emissiveIntensity = isSelected || isHover ? 0.8 : 0.35;
      const pulse = isFlagged && !reducedMotion ? 1 + 0.2 * Math.sin(elapsed * 2.2 + marker.phase) : 1;
      marker.halo.material.opacity = toHaloOpacity({ isSelected, isHover, isFlagged });
      marker.halo.scale.setScalar(HALO_SIZE * (isSelected ? 1.5 : 1) * pulse);
      marker.ring?.scale.setScalar(RING_SIZE * (isSelected ? 1.3 : 1));
    }
  };

  const draw = (): void => {
    placeMarkers({ elapsed: clock.getElapsedTime() });
    renderer.render(scene, camera);
    layoutOverlay();
    state.isDirty = false;
  };

  const hasPulse = (): boolean => !reducedMotion && state.markers.some((marker) => marker.point.needsDecision && !marker.point.isSettled);

  const loop = (): void => {
    window.requestAnimationFrame(loop);
    if (!stage.isConnected || document.hidden) return;
    const isMoving = controls.update();
    if (isMoving || state.isDirty || hasPulse()) draw();
  };

  // ---- pointer: hover and click on spheres; orbit, pan and zoom belong to the controls ----------------------------------------

  const pointerAt = ({ event }: { event: PointerEvent }): { px: number; py: number } => {
    const box = stage.getBoundingClientRect();
    return { px: event.clientX - box.left, py: event.clientY - box.top };
  };

  /** The sphere nearest the pointer on screen, and nearest the camera when two overlap. */
  const nearest = ({ px, py }: { px: number; py: number }): Marker | null =>
    state.markers.reduce<{ best: Marker | null; bestScore: number }>(
      (carried, marker) => {
        const spot = project({ x: marker.point.x, y: marker.point.y, level: marker.point.z });
        const reach = Math.max(HIT_RADIUS_PX, (SPHERE_RADIUS / (spot.distance * Math.tan((camera.fov * Math.PI) / 360))) * size.height * 0.5 + 6);
        const gap = Math.hypot(spot.sx - px, spot.sy - py);
        const score = gap + spot.distance * 4;
        return spot.isInFront && gap <= reach && score < carried.bestScore ? { best: marker, bestScore: score } : carried;
      },
      { best: null, bestScore: Infinity },
    ).best;

  const drag = { isDown: false, moved: 0, lastX: 0, lastY: 0 };

  const resetView = (): void => {
    controls.reset();
    controls.autoRotate = false;
    state.isDirty = true;
  };

  const resize = (): void => {
    size.width = Math.max(1, stage.clientWidth);
    size.height = Math.max(1, stage.clientHeight);
    renderer.setSize(size.width, size.height, false);
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    state.isDirty = true;
  };

  const listeners = {
    pointerDown: (event: PointerEvent): void => {
      drag.isDown = true;
      drag.moved = 0;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      showTooltip({ marker: null });
    },
    pointerMove: (event: PointerEvent): void => {
      if (drag.isDown) {
        drag.moved += Math.abs(event.clientX - drag.lastX) + Math.abs(event.clientY - drag.lastY);
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        return;
      }
      const hit = nearest(pointerAt({ event }));
      if ((hit?.point.id ?? null) === state.hoverId) return;
      state.hoverId = hit?.point.id ?? null;
      showTooltip({ marker: hit });
      stage.style.cursor = hit ? 'pointer' : 'grab';
      state.isDirty = true;
    },
    pointerUp: (event: PointerEvent): void => {
      const wasClick = drag.isDown && drag.moved <= CLICK_SLOP_PX;
      drag.isDown = false;
      if (!wasClick) return;
      const hit = nearest(pointerAt({ event }));
      if (hit) onSelect(hit.point.id);
    },
    pointerLeave: (): void => {
      drag.isDown = false;
      if (state.hoverId === null) return;
      state.hoverId = null;
      showTooltip({ marker: null });
      state.isDirty = true;
    },
  };

  // Rotating by itself is a hint that the chart is 3D. It stops for good the moment someone takes hold of it.
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
  });
  controls.addEventListener('change', () => {
    // Panning must not carry the box out of view: keep the point the camera looks at inside the box.
    controls.target.set(Math.min(maxX, Math.max(minX, controls.target.x)), Math.min(maxY, Math.max(minY, controls.target.y)), Math.min(maxZ, Math.max(minZ, controls.target.z)));
    state.isDirty = true;
  });
  stage.style.cursor = 'grab';
  stage.addEventListener('pointerdown', listeners.pointerDown);
  stage.addEventListener('pointermove', listeners.pointerMove);
  stage.addEventListener('pointerup', listeners.pointerUp);
  stage.addEventListener('pointerleave', listeners.pointerLeave);
  stage.addEventListener('dblclick', resetView);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(stage);
  resize();
  loop();

  const handle: MapHandle = {
    setMap: (map) => {
      state.map = map;
      buildStatic({ map });
      buildMarkers({ map });
      state.isDirty = true;
    },
    setSelected: (id) => {
      if (state.selectedId === id) return;
      state.selectedId = id;
      state.isDirty = true;
    },
    setTheme: () => {
      state.tokens = readTokens();
      if (state.map) buildStatic({ map: state.map });
      recolor();
      state.isDirty = true;
    },
    resetView,
    drawNow: () => {
      if (stage.isConnected) draw();
    },
  };
  return { status: 'ready', handle };
};
