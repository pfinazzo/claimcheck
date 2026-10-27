/**
 * The backdrop behind the glass panels: a wireframe grid rolling slowly toward a lit horizon, with
 * a field of light above it. Both move on the same wave, the camera drifts with the pointer, and
 * nothing in it carries information, so the page reads the same with the scene gone.
 *
 * If the GPU refuses a WebGL context, createScene returns null and the CSS background stands alone.
 * Reduced motion draws one still frame and never animates.
 *
 * @author Patrick Finazzo
 */

import * as THREE from 'three';

export type Scene = {
  setTheme: (theme: 'light' | 'dark') => void;
  dispose: () => void;
};

type Palette = {
  near: THREE.Color;
  far: THREE.Color;
  pointAlpha: number;
  gridAlpha: number;
  horizonAlpha: number;
  blending: THREE.Blending;
};

const PALETTES = new Map<'light' | 'dark', Palette>([
  ['dark', { near: new THREE.Color('#7c8cff'), far: new THREE.Color('#3ad0c0'), pointAlpha: 0.85, gridAlpha: 0.32, horizonAlpha: 0.5, blending: THREE.AdditiveBlending }],
  ['light', { near: new THREE.Color('#4f5fe8'), far: new THREE.Color('#1fa89a'), pointAlpha: 0.5, gridAlpha: 0.16, horizonAlpha: 0.18, blending: THREE.NormalBlending }],
]);

const FALLBACK_PALETTE = PALETTES.get('dark') as Palette;

const GRID_COLUMNS = 48;
const GRID_ROWS = 60;
const GRID_WIDTH = 80;
const GRID_DEPTH = 110;
const GRID_SEGMENTS = 4;
const POINT_COLUMNS = 64;
const POINT_ROWS = 64;
const POINT_COUNT = POINT_COLUMNS * POINT_ROWS;
const MAX_PIXEL_RATIO = 2;
const PARALLAX_X = 1.1;
const PARALLAX_Y = 0.5;
const EASE = 0.045;
const MAX_FRAME_SECONDS = 0.1;
const SCROLL_SPEED = 1.6;

/** The wave every vertex rides, shared by the grid and the points so they stay in step. */
const WAVE_GLSL = `
  float wave(vec3 p, float t) {
    return sin(p.x * 0.22 + t * 0.5) * 0.7
         + sin(p.z * 0.3 - t * 0.4) * 0.6
         + sin((p.x + p.z) * 0.14 + t * 0.25) * 0.9;
  }
`;

const DEPTH_GLSL = `
  float depthOf(vec4 mv) {
    return clamp((-mv.z - 6.0) / 70.0, 0.0, 1.0);
  }
`;

const GRID_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uScroll;
  varying float vDepth;
  ${WAVE_GLSL}
  ${DEPTH_GLSL}
  void main() {
    vec3 p = position;
    p.z = mod(p.z + uScroll, ${GRID_DEPTH.toFixed(1)}) - ${(GRID_DEPTH / 2).toFixed(1)};
    p.y += wave(p, uTime);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth = depthOf(mv);
    gl_Position = projectionMatrix * mv;
  }
`;

const GRID_FRAGMENT_SHADER = `
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform float uAlpha;
  varying float vDepth;
  void main() {
    float edge = smoothstep(0.0, 0.08, vDepth) * (1.0 - smoothstep(0.55, 1.0, vDepth));
    gl_FragColor = vec4(mix(uNear, uFar, vDepth), edge * uAlpha);
  }
`;

const POINT_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSeed;
  varying float vDepth;
  varying float vSeed;
  ${WAVE_GLSL}
  ${DEPTH_GLSL}
  void main() {
    vec3 p = position;
    p.y += wave(p, uTime) * 0.6 + sin(uTime * 0.8 + aSeed * 6.2831) * 0.4;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth = depthOf(mv);
    vSeed = aSeed;
    float twinkle = 0.7 + 0.3 * sin(uTime * 1.3 + aSeed * 6.2831);
    gl_PointSize = (3.0 + aSeed * 3.0) * twinkle * uPixelRatio * (18.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAGMENT_SHADER = `
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform float uAlpha;
  varying float vDepth;
  varying float vSeed;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float disc = 1.0 - smoothstep(0.18, 0.5, d);
    float fade = (1.0 - vDepth * 0.75) * (0.5 + 0.5 * vSeed);
    gl_FragColor = vec4(mix(uNear, uFar, vDepth), disc * fade * uAlpha);
  }
`;

/** A deterministic 0..1 from a label, so the layout is the same on every start. */
const hashToUnit = ({ id, salt }: { id: string; salt: number }): number => {
  const folded = [...id].reduce((acc, char) => (acc * 31 + char.charCodeAt(0) + salt) >>> 0, 7);
  return (folded % 10007) / 10007;
};

const buildGlowTexture = (): THREE.CanvasTexture => {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(0.3, 'rgba(255,255,255,0.25)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const buildGridUniforms = ({ palette }: { palette: Palette }): Record<string, THREE.IUniform> => ({
  uTime: { value: 0 },
  uScroll: { value: 0 },
  uNear: { value: palette.near.clone() },
  uFar: { value: palette.far.clone() },
  uAlpha: { value: palette.gridAlpha },
});

/** One straight line on the floor, cut into short pieces so the wave can bend it. Returns x, y, z for each end of each piece. */
const splitLine = ({ startX, startZ, endX, endZ }: { startX: number; startZ: number; endX: number; endZ: number }): number[] =>
  Array.from({ length: GRID_SEGMENTS }, (_, piece) => {
    const from = piece / GRID_SEGMENTS;
    const to = (piece + 1) / GRID_SEGMENTS;
    return [startX + (endX - startX) * from, 0, startZ + (endZ - startZ) * from, startX + (endX - startX) * to, 0, startZ + (endZ - startZ) * to];
  }).flat();

const toGridX = ({ column }: { column: number }): number => (column / GRID_COLUMNS - 0.5) * GRID_WIDTH;
const toGridZ = ({ row }: { row: number }): number => (row / GRID_ROWS - 0.5) * GRID_DEPTH;

/** Grid lines along x and along z. */
const buildGridVertices = (): number[] => {
  const lines = Array.from({ length: GRID_ROWS + 1 }, (_, row) => Array.from({ length: GRID_COLUMNS }, (_unused, column) => splitLine({ startX: toGridX({ column }), startZ: toGridZ({ row }), endX: toGridX({ column: column + 1 }), endZ: toGridZ({ row }) })).flat());
  const across = Array.from({ length: GRID_COLUMNS + 1 }, (_, column) => Array.from({ length: GRID_ROWS }, (_unused, row) => splitLine({ startX: toGridX({ column }), startZ: toGridZ({ row }), endX: toGridX({ column }), endZ: toGridZ({ row: row + 1 }) })).flat());
  return [...lines.flat(), ...across.flat()];
};

const buildGrid = ({ palette }: { palette: Palette }): THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial> => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buildGridVertices()), 3));
  const material = new THREE.ShaderMaterial({
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    uniforms: buildGridUniforms({ palette }),
    transparent: true,
    depthWrite: false,
    blending: palette.blending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.position.y = -3.2;
  return lines;
};

const buildPoints = ({ palette, pixelRatio }: { palette: Palette; pixelRatio: number }): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> => {
  const positions = Float32Array.from(
    Array.from({ length: POINT_COUNT }, (_, at) => {
      const row = Math.floor(at / POINT_COLUMNS);
      const column = at % POINT_COLUMNS;
      return [
        (column / (POINT_COLUMNS - 1) - 0.5) * GRID_WIDTH + (hashToUnit({ id: `x${at}`, salt: 3 }) - 0.5) * 1.4,
        hashToUnit({ id: `y${at}`, salt: 7 }) * 6,
        (row / (POINT_ROWS - 1) - 0.5) * GRID_DEPTH + (hashToUnit({ id: `z${at}`, salt: 5 }) - 0.5) * 1.4,
      ];
    }).flat(),
  );
  const seeds = Float32Array.from({ length: POINT_COUNT }, (_, at) => hashToUnit({ id: `s${at}`, salt: 11 }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uNear: { value: palette.near.clone() },
      uFar: { value: palette.far.clone() },
      uAlpha: { value: palette.pointAlpha },
    },
    transparent: true,
    depthWrite: false,
    blending: palette.blending,
  });
  const points = new THREE.Points(geometry, material);
  points.position.y = -2.2;
  return points;
};

const setUniform = ({ material, name, value }: { material: THREE.ShaderMaterial; name: string; value: number }): void => {
  const uniform = material.uniforms[name];
  if (uniform) uniform.value = value;
};

const makeRenderer = ({ canvas }: { canvas: HTMLCanvasElement }): THREE.WebGLRenderer | null => {
  try {
    return new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
};

/** Builds the scene on `canvas`. Returns null when WebGL is unavailable, and the page carries on without it. */
export const createScene = ({ canvas, reducedMotion, theme }: { canvas: HTMLCanvasElement; reducedMotion: boolean; theme: 'light' | 'dark' }): Scene | null => {
  const renderer = makeRenderer({ canvas });
  if (!renderer) return null;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 160);
  const cameraHome = new THREE.Vector3(0, 3.2, 22);
  const cameraTarget = new THREE.Vector3(0, 0.6, -20);
  camera.position.copy(cameraHome);
  camera.lookAt(cameraTarget);

  // The parts that change with the light or dark setting live in one holder, so a theme change swaps them in place.
  const parts = { palette: PALETTES.get(theme) ?? FALLBACK_PALETTE, grid: buildGrid({ palette: PALETTES.get(theme) ?? FALLBACK_PALETTE }), points: buildPoints({ palette: PALETTES.get(theme) ?? FALLBACK_PALETTE, pixelRatio }) };
  scene.add(parts.grid, parts.points);

  const glowTexture = buildGlowTexture();
  const horizon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: parts.palette.near, transparent: true, opacity: parts.palette.horizonAlpha, blending: parts.palette.blending, depthWrite: false }));
  horizon.position.set(0, -1, -48);
  horizon.scale.set(90, 34, 1);
  scene.add(horizon);

  const pointer = new THREE.Vector2(0, 0);
  const pointerEased = new THREE.Vector2(0, 0);
  const clock = new THREE.Clock();
  let frame = 0;
  let isDisposed = false;
  let isStillNeeded = true;

  const resize = (): void => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    isStillNeeded = true;
  };

  const step = ({ elapsed, delta }: { elapsed: number; delta: number }): void => {
    const ease = reducedMotion ? 1 : Math.min(1, EASE * (delta * 60));
    setUniform({ material: parts.grid.material, name: 'uTime', value: elapsed });
    setUniform({ material: parts.grid.material, name: 'uScroll', value: elapsed * SCROLL_SPEED });
    setUniform({ material: parts.points.material, name: 'uTime', value: elapsed });
    pointerEased.lerp(pointer, ease);
    camera.position.set(cameraHome.x + pointerEased.x * PARALLAX_X, cameraHome.y - pointerEased.y * PARALLAX_Y, cameraHome.z);
    camera.lookAt(cameraTarget);
    renderer.render(scene, camera);
  };

  const loop = (): void => {
    if (isDisposed) return;
    frame = window.requestAnimationFrame(loop);
    if (document.hidden) return;
    if (reducedMotion && !isStillNeeded) return;
    isStillNeeded = false;
    const delta = Math.min(clock.getDelta(), MAX_FRAME_SECONDS);
    step({ elapsed: clock.elapsedTime, delta });
  };

  const applyTheme = ({ next }: { next: 'light' | 'dark' }): void => {
    parts.palette = PALETTES.get(next) ?? FALLBACK_PALETTE;
    scene.remove(parts.grid, parts.points);
    parts.grid.geometry.dispose();
    parts.grid.material.dispose();
    parts.points.geometry.dispose();
    parts.points.material.dispose();
    parts.grid = buildGrid({ palette: parts.palette });
    parts.points = buildPoints({ palette: parts.palette, pixelRatio });
    scene.add(parts.grid, parts.points);
    horizon.material.color.set(parts.palette.near);
    horizon.material.opacity = parts.palette.horizonAlpha;
    horizon.material.blending = parts.palette.blending;
    horizon.material.needsUpdate = true;
    isStillNeeded = true;
  };

  const listeners = {
    pointerMove: (event: PointerEvent): void => {
      pointer.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
      isStillNeeded = true;
    },
    pointerLeave: (): void => {
      pointer.set(0, 0);
    },
    resize,
  };
  window.addEventListener('pointermove', listeners.pointerMove);
  window.addEventListener('pointerleave', listeners.pointerLeave);
  window.addEventListener('resize', listeners.resize);
  resize();
  loop();

  return {
    setTheme: (next) => applyTheme({ next }),
    dispose: () => {
      isDisposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', listeners.pointerMove);
      window.removeEventListener('pointerleave', listeners.pointerLeave);
      window.removeEventListener('resize', listeners.resize);
      parts.grid.geometry.dispose();
      parts.grid.material.dispose();
      parts.points.geometry.dispose();
      parts.points.material.dispose();
      horizon.material.dispose();
      glowTexture.dispose();
      renderer.dispose();
    },
  };
};
