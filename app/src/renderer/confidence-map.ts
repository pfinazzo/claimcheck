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
import { h, mount } from './dom.ts';

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

const { minX, maxX, minY, maxY, minZ, maxZ } = MAP_BOUNDS;
const CENTER = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
const HOME_OFFSET = new THREE.Vector3(2.0, 1.2, 2.5);
const SPHERE_RADIUS = 0.03;
const HALO_SIZE = 0.2;
const RING_SIZE = 0.115;
const HIT_RADIUS_PX = 18;
const CLICK_SLOP_PX = 4;
const LABEL_LIMIT = 40;
const AUTO_ROTATE_SPEED = 0.7;
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
const CHECKER_TICKS: readonly { word: string; z: number }[] = [
  { word: 'not checked', z: GUTTER },
  { word: 'refuted', z: CHECKER_LEVELS['refuted'] ?? 0 },
  { word: 'unverifiable', z: CHECKER_LEVELS['unverifiable'] ?? 0.5 },
  { word: 'supported', z: CHECKER_LEVELS['supported'] ?? 1 },
];

const readToken = (name: string, fallback: string): THREE.Color => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(/^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);
};

const readTokens = (): Tokens => ({
  bad: readToken('--bad', '#d6382a'),
  ok: readToken('--ok', '#178a4b'),
  accent: readToken('--accent', '#4f5fe8'),
  faint: readToken('--faint', '#8e97b1'),
  text: readToken('--text', '#121830'),
});

const formatTick = (value: number): string => (value === 0 ? '0' : value === 1 ? '1.0' : value.toFixed(2));

/** A soft round glow, drawn once on a canvas, for halos and floor shadows. */
const buildGlowTexture = (): THREE.CanvasTexture => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.3)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
};

/** A thin ring, drawn once on a canvas, that marks a claim the checker refuted. */
const buildRingTexture = (): THREE.CanvasTexture => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.strokeStyle = '#ffffff';
    context.lineWidth = 9;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
    context.stroke();
  }
  return new THREE.CanvasTexture(canvas);
};

/** Draws the chart on `parts.canvas`, or explains why it cannot. */
export const startConfidenceMap = (parts: Parts): MapStart => {
  const { stage, canvas, overlay, tooltip, reducedMotion, onSelect } = parts;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
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
  const state = { map: null as ConfidenceMap | null, selectedId: null as string | null, hoverId: null as string | null, isDirty: true };
  let tokens = readTokens();
  let markers: Marker[] = [];
  const labels = new Map<string, HTMLElement>();
  const scratch = new THREE.Vector3();

  const isDark = (): boolean => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const blending = (): THREE.Blending => (isDark() ? THREE.AdditiveBlending : THREE.NormalBlending);

  // ---- the box, its grids, the flag sheets and the green backed box -------------------------------------------------

  /** Removes everything in a group and frees its GPU memory. The shared sphere geometry is kept. */
  const disposeGroup = (group: THREE.Group): void => {
    for (const child of [...group.children]) {
      group.remove(child);
      const drawable = child as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      if (drawable.geometry && drawable.geometry !== sphereGeometry) drawable.geometry.dispose();
      const material = drawable.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      if (child instanceof THREE.Group) disposeGroup(child);
    }
  };

  const lineSet = ({ segments, color, opacity }: { segments: number[]; color: THREE.Color; opacity: number }): THREE.LineSegments => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments), 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  };

  const boxEdges = ({ x0, x1, y0, y1, z0, z1 }: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }): number[] => [
    x0, y0, z0, x1, y0, z0, x1, y0, z0, x1, y1, z0, x1, y1, z0, x0, y1, z0, x0, y1, z0, x0, y0, z0,
    x0, y0, z1, x1, y0, z1, x1, y0, z1, x1, y1, z1, x1, y1, z1, x0, y1, z1, x0, y1, z1, x0, y0, z1,
    x0, y0, z0, x0, y0, z1, x1, y0, z0, x1, y0, z1, x1, y1, z0, x1, y1, z1, x0, y1, z0, x0, y1, z1,
  ];

  /** A translucent sheet across the box at one flag line, with a bright outline so its edge reads. */
  const flagSheet = ({ axis, value, color }: { axis: 'x' | 'y' | 'z'; value: number; color: THREE.Color }): THREE.Group => {
    const group = new THREE.Group();
    const width = axis === 'x' ? maxZ - minZ : maxX - minX;
    const height = axis === 'y' ? maxZ - minZ : maxY - minY;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    const outline: Record<'x' | 'y' | 'z', number[]> = {
      x: [value, minY, minZ, value, minY, maxZ, value, minY, maxZ, value, maxY, maxZ, value, maxY, maxZ, value, maxY, minZ, value, maxY, minZ, value, minY, minZ],
      y: [minX, value, minZ, maxX, value, minZ, maxX, value, minZ, maxX, value, maxZ, maxX, value, maxZ, minX, value, maxZ, minX, value, maxZ, minX, value, minZ],
      z: [minX, minY, value, maxX, minY, value, maxX, minY, value, maxX, maxY, value, maxX, maxY, value, minX, maxY, value, minX, maxY, value, minX, minY, value],
    };
    if (axis === 'x') {
      sheet.rotation.y = Math.PI / 2;
      sheet.position.set(value, CENTER.y, CENTER.z);
    } else if (axis === 'y') {
      sheet.rotation.x = Math.PI / 2;
      sheet.position.set(CENTER.x, value, CENTER.z);
    } else {
      sheet.position.set(CENTER.x, CENTER.y, value);
    }
    group.add(sheet, lineSet({ segments: outline[axis], color, opacity: 0.85 }));
    return group;
  };

  const buildStatic = (map: ConfidenceMap): void => {
    disposeGroup(staticGroup);
    // the plot box, and gridlines on the floor and the two back walls
    staticGroup.add(lineSet({ segments: boxEdges({ x0: minX, x1: maxX, y0: minY, y1: maxY, z0: minZ, z1: maxZ }), color: tokens.text, opacity: 0.3 }));
    const grid: number[] = [];
    for (const tick of [...TICKS, GUTTER]) {
      grid.push(tick, minY, minZ, tick, minY, maxZ, minX, minY, tick, maxX, minY, tick);
      grid.push(tick, minY, minZ, tick, maxY, minZ, minX, tick, minZ, maxX, tick, minZ);
      grid.push(minX, tick, minZ, minX, tick, maxZ, minX, minY, tick, minX, maxY, tick);
    }
    staticGroup.add(lineSet({ segments: grid, color: tokens.text, opacity: 0.1 }));
    // the three flag lines as red sheets
    staticGroup.add(flagSheet({ axis: 'x', value: map.flagCatchRate, color: tokens.bad }));
    staticGroup.add(flagSheet({ axis: 'y', value: map.flagConfidence, color: tokens.bad }));
    staticGroup.add(flagSheet({ axis: 'z', value: map.flagChecker, color: tokens.bad }));
    // the box where a claim is backed: tests above the line, confidence above the line, checker satisfied
    const backed = { x0: map.flagCatchRate, x1: maxX, y0: map.flagConfidence, y1: maxY, z0: map.flagChecker, z1: maxZ };
    const backedBox = new THREE.Mesh(new THREE.BoxGeometry(backed.x1 - backed.x0, backed.y1 - backed.y0, backed.z1 - backed.z0), new THREE.MeshBasicMaterial({ color: tokens.ok, transparent: true, opacity: 0.1, depthWrite: false }));
    backedBox.position.set((backed.x0 + backed.x1) / 2, (backed.y0 + backed.y1) / 2, (backed.z0 + backed.z1) / 2);
    staticGroup.add(backedBox, lineSet({ segments: boxEdges(backed), color: tokens.ok, opacity: 0.9 }));
  };

  // ---- the spheres, their halos, and their drop lines to the floor ---------------------------------------------------

  const colorOf = (point: MapPoint): THREE.Color => (point.isSettled ? tokens.faint : point.needsDecision ? tokens.bad : tokens.accent);

  const sprite = ({ texture, color, opacity }: { texture: THREE.Texture; color: THREE.Color; opacity: number }): THREE.Sprite =>
    new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color, transparent: true, opacity, depthWrite: false, blending: blending() }));

  const buildMarkers = (map: ConfidenceMap): void => {
    disposeGroup(markerGroup);
    const stems: number[] = [];
    const feet: number[] = [];
    markers = map.points.map((point, index) => {
      const color = colorOf(point);
      const sphere = new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.05 }));
      sphere.position.set(point.x, point.y, point.z);
      sphere.scale.setScalar(SPHERE_RADIUS);
      const halo = sprite({ texture: glowTexture, color, opacity: 0 });
      halo.position.copy(sphere.position);
      const ring = point.isRefuted ? sprite({ texture: ringTexture, color: tokens.text, opacity: 0.95 }) : null;
      ring?.position.copy(sphere.position);
      ring?.scale.setScalar(RING_SIZE);
      markerGroup.add(halo, sphere);
      if (ring) markerGroup.add(ring);
      stems.push(point.x, point.y, point.z, point.x, minY, point.z);
      feet.push(point.x, minY, point.z);
      return { point, sphere, halo, ring, phase: index * 0.9 };
    });
    if (stems.length) markerGroup.add(lineSet({ segments: stems, color: tokens.text, opacity: 0.16 }));
    if (feet.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(feet), 3));
      markerGroup.add(new THREE.Points(geometry, new THREE.PointsMaterial({ map: glowTexture, color: tokens.text, size: 0.07, transparent: true, opacity: 0.5, depthWrite: false })));
    }
  };

  const recolor = (): void => {
    for (const marker of markers) {
      const color = colorOf(marker.point);
      marker.sphere.material.color.copy(color);
      marker.sphere.material.emissive.copy(color);
      (marker.halo.material as THREE.SpriteMaterial).color.copy(color);
      (marker.halo.material as THREE.SpriteMaterial).blending = blending();
      if (marker.ring) (marker.ring.material as THREE.SpriteMaterial).color.copy(tokens.text);
    }
  };

  // ---- the text laid over the canvas ---------------------------------------------------------------------------------------

  const project = (x: number, y: number, z: number): { sx: number; sy: number; distance: number; isInFront: boolean } => {
    scratch.set(x, y, z);
    const distance = camera.position.distanceTo(scratch);
    scratch.project(camera);
    return { sx: (scratch.x * 0.5 + 0.5) * size.width, sy: (-scratch.y * 0.5 + 0.5) * size.height, distance, isInFront: scratch.z < 1 };
  };

  const placeLabel = ({ key, text, x, y, z, className, dx = 0, dy = 0 }: { key: string; text: string; x: number; y: number; z: number; className: string; dx?: number; dy?: number }, used: Set<string>): void => {
    const spot = project(x, y, z);
    if (!spot.isInFront) return;
    used.add(key);
    let label = labels.get(key);
    if (!label) {
      label = h('span', { class: className });
      labels.set(key, label);
      overlay.appendChild(label);
    }
    if (label.textContent !== text) label.textContent = text;
    // Things farther from the camera fade, which helps the eye tell near from far.
    const toCenter = camera.position.distanceTo(CENTER);
    label.style.opacity = Math.min(1, Math.max(0.35, 1.15 - ((spot.distance - (toCenter - 0.9)) / 1.8) * 0.7)).toFixed(2);
    label.style.transform = `translate(${(spot.sx + dx).toFixed(1)}px, ${(spot.sy + dy).toFixed(1)}px)`;
  };

  const layoutOverlay = (): void => {
    const used = new Set<string>();
    const front = maxZ + 0.07;
    for (const tick of TICKS) {
      placeLabel({ key: `x${tick}`, text: formatTick(tick), x: tick, y: minY, z: front, className: 'map-tick' }, used);
      placeLabel({ key: `y${tick}`, text: formatTick(tick), x: minX - 0.05, y: tick, z: front, className: 'map-tick', dx: -22 }, used);
    }
    placeLabel({ key: 'xn', text: 'no run', x: GUTTER, y: minY, z: front, className: 'map-tick', dx: -16, dy: 14 }, used);
    placeLabel({ key: 'yn', text: 'none', x: minX - 0.05, y: GUTTER, z: front, className: 'map-tick', dx: -24 }, used);
    for (const level of CHECKER_TICKS) placeLabel({ key: `z${level.word}`, text: level.word, x: maxX + 0.07, y: minY, z: level.z, className: 'map-tick', dx: level.z === GUTTER ? 38 : 4, dy: level.z === GUTTER ? 12 : 0 }, used);
    placeLabel({ key: 'tx', text: 'Tests: planted bugs caught', x: CENTER.x, y: minY, z: maxZ + 0.34, className: 'map-axis-title', dx: -40, dy: 10 }, used);
    placeLabel({ key: 'ty', text: 'Author: stated confidence', x: minX, y: maxY + 0.07, z: maxZ, className: 'map-axis-title', dy: -14 }, used);
    placeLabel({ key: 'tz', text: 'Checker: independent verdict', x: maxX + 0.3, y: minY, z: CENTER.z, className: 'map-axis-title', dx: 8, dy: 22 }, used);
    const map = state.map;
    if (map) {
      placeLabel({ key: 'fx', text: `tests below ${map.flagCatchRate}`, x: map.flagCatchRate, y: maxY, z: minZ, className: 'map-line-label', dy: -16 }, used);
      placeLabel({ key: 'fy', text: `confidence below ${map.flagConfidence}`, x: maxX, y: map.flagConfidence, z: maxZ, className: 'map-line-label', dx: 10, dy: -4 }, used);
      placeLabel({ key: 'fz', text: 'checker not satisfied', x: minX, y: maxY, z: map.flagChecker, className: 'map-line-label', dx: -138, dy: -4 }, used);
      const showNames = markers.length <= LABEL_LIMIT || camera.position.distanceTo(CENTER) < 2;
      // The selected claim is named first, then the claims that need a decision, then the rest. A name that
      // would land on one already placed is left out, so a crowd stays readable. Orbiting or zooming separates them.
      const priority = (marker: Marker): number => (marker.point.id === state.selectedId ? 0 : marker.point.needsDecision && !marker.point.isSettled ? 1 : 2);
      const taken: { x: number; y: number; width: number; height: number }[] = [];
      for (const marker of [...markers].sort((first, second) => priority(first) - priority(second))) {
        if (!showNames && marker.point.id !== state.selectedId) continue;
        const spot = project(marker.point.x, marker.point.y, marker.point.z);
        const box = { x: spot.sx + 10, y: spot.sy - 22, width: marker.point.id.length * 8 + 6, height: 14 };
        const overlaps = taken.some((other) => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y);
        if (overlaps || !spot.isInFront) continue;
        taken.push(box);
        placeLabel({ key: `p${marker.point.id}`, text: marker.point.id, x: marker.point.x, y: marker.point.y, z: marker.point.z, className: `map-name${marker.point.id === state.selectedId ? ' is-selected' : ''}`, dx: 10, dy: -22 }, used);
      }
    }
    for (const [key, label] of labels) {
      if (used.has(key)) continue;
      label.remove();
      labels.delete(key);
    }
  };

  const showTooltip = (marker: Marker | null): void => {
    if (!marker) {
      tooltip.hidden = true;
      return;
    }
    const { point } = marker;
    const stated = point.confidence === null ? 'no confidence stated' : `stated ${point.confidence.toFixed(2)}`;
    const caught = point.catchRate === null ? 'no planted-bug run' : `tests caught ${Math.round(point.catchRate * 100)}%`;
    mount(tooltip, h('strong', {}, point.id), h('span', {}, point.title), h('span', { class: 'muted' }, `${stated}. ${caught}. Checker: ${point.verdict}.`), h('span', { class: point.needsDecision && !point.isSettled ? 'error' : 'muted' }, point.isSettled ? 'Settled.' : point.needsDecision ? 'Needs a decision.' : 'Backed.'));
    const { sx, sy } = project(point.x, point.y, point.z);
    tooltip.hidden = false;
    const flipLeft = sx > size.width - 300;
    tooltip.style.transform = `translate(${Math.round(flipLeft ? sx - 292 : sx + 18)}px, ${Math.round(Math.max(4, Math.min(size.height - 110, sy - 20)))}px)`;
  };

  // ---- drawing a frame -------------------------------------------------------------------------------------------------------

  const placeMarkers = (elapsed: number): void => {
    for (const marker of markers) {
      const isSelected = marker.point.id === state.selectedId;
      const isHover = marker.point.id === state.hoverId;
      const isFlagged = marker.point.needsDecision && !marker.point.isSettled;
      marker.sphere.scale.setScalar(SPHERE_RADIUS * (isSelected ? 1.45 : isHover ? 1.25 : 1));
      marker.sphere.material.emissiveIntensity = isSelected || isHover ? 0.8 : 0.35;
      const pulse = isFlagged && !reducedMotion ? 1 + 0.2 * Math.sin(elapsed * 2.2 + marker.phase) : 1;
      (marker.halo.material as THREE.SpriteMaterial).opacity = isSelected ? 0.6 : isHover ? 0.5 : isFlagged ? 0.32 : 0;
      marker.halo.scale.setScalar(HALO_SIZE * (isSelected ? 1.5 : 1) * pulse);
      marker.ring?.scale.setScalar(RING_SIZE * (isSelected ? 1.3 : 1));
    }
  };

  const clock = new THREE.Clock();
  const draw = (): void => {
    placeMarkers(clock.getElapsedTime());
    renderer.render(scene, camera);
    layoutOverlay();
    state.isDirty = false;
  };

  const hasPulse = (): boolean => !reducedMotion && markers.some((m) => m.point.needsDecision && !m.point.isSettled);
  const loop = (): void => {
    window.requestAnimationFrame(loop);
    if (!stage.isConnected || document.hidden) return;
    const isMoving = controls.update();
    if (isMoving || state.isDirty || hasPulse()) draw();
  };

  // ---- pointer: hover and click on spheres; orbit, pan and zoom belong to the controls ----------------------------------------

  const pointerAt = (event: PointerEvent): { px: number; py: number } => {
    const box = stage.getBoundingClientRect();
    return { px: event.clientX - box.left, py: event.clientY - box.top };
  };

  /** The sphere nearest the pointer on screen, and nearest the camera when two overlap. */
  const nearest = (px: number, py: number): Marker | null => {
    let best: Marker | null = null;
    let bestScore = Infinity;
    for (const marker of markers) {
      const spot = project(marker.point.x, marker.point.y, marker.point.z);
      const reach = Math.max(HIT_RADIUS_PX, (SPHERE_RADIUS / (spot.distance * Math.tan((camera.fov * Math.PI) / 360))) * size.height * 0.5 + 6);
      const gap = Math.hypot(spot.sx - px, spot.sy - py);
      if (!spot.isInFront || gap > reach) continue;
      const score = gap + spot.distance * 4;
      if (score < bestScore) {
        best = marker;
        bestScore = score;
      }
    }
    return best;
  };

  const drag = { isDown: false, moved: 0, lastX: 0, lastY: 0 };

  const onPointerDown = (event: PointerEvent): void => {
    drag.isDown = true;
    drag.moved = 0;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    showTooltip(null);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag.isDown) {
      drag.moved += Math.abs(event.clientX - drag.lastX) + Math.abs(event.clientY - drag.lastY);
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      return;
    }
    const { px, py } = pointerAt(event);
    const hit = nearest(px, py);
    if ((hit?.point.id ?? null) !== state.hoverId) {
      state.hoverId = hit?.point.id ?? null;
      showTooltip(hit);
      stage.style.cursor = hit ? 'pointer' : 'grab';
      state.isDirty = true;
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    const wasClick = drag.isDown && drag.moved <= CLICK_SLOP_PX;
    drag.isDown = false;
    if (!wasClick) return;
    const { px, py } = pointerAt(event);
    const hit = nearest(px, py);
    if (hit) onSelect(hit.point.id);
  };

  const onPointerLeave = (): void => {
    drag.isDown = false;
    if (state.hoverId === null) return;
    state.hoverId = null;
    showTooltip(null);
    state.isDirty = true;
  };

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
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointerleave', onPointerLeave);
  stage.addEventListener('dblclick', resetView);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(stage);
  resize();
  loop();

  const handle: MapHandle = {
    setMap: (map) => {
      state.map = map;
      buildStatic(map);
      buildMarkers(map);
      state.isDirty = true;
    },
    setSelected: (id) => {
      if (state.selectedId === id) return;
      state.selectedId = id;
      state.isDirty = true;
    },
    setTheme: () => {
      tokens = readTokens();
      if (state.map) buildStatic(state.map);
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
