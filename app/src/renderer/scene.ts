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

const PALETTES: Record<'light' | 'dark', Palette> = {
  dark: {
    near: new THREE.Color('#7c8cff'),
    far: new THREE.Color('#3ad0c0'),
    pointAlpha: 0.85,
    gridAlpha: 0.32,
    horizonAlpha: 0.5,
    blending: THREE.AdditiveBlending,
  },
  light: {
    near: new THREE.Color('#4f5fe8'),
    far: new THREE.Color('#1fa89a'),
    pointAlpha: 0.5,
    gridAlpha: 0.16,
    horizonAlpha: 0.18,
    blending: THREE.NormalBlending,
  },
};

const GRID_COLUMNS = 48;
const GRID_ROWS = 60;
const GRID_WIDTH = 80;
const GRID_DEPTH = 110;
const GRID_SEGMENTS = 4;
const POINT_COLUMNS = 64;
const POINT_ROWS = 64;
const MAX_PIXEL_RATIO = 2;
const PARALLAX_X = 1.1;
const PARALLAX_Y = 0.5;
const EASE = 0.045;

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

const gridUniforms = (palette: Palette): Record<string, THREE.IUniform> => ({
  uTime: { value: 0 },
  uScroll: { value: 0 },
  uNear: { value: palette.near.clone() },
  uFar: { value: palette.far.clone() },
  uAlpha: { value: palette.gridAlpha },
});

/** Grid lines along x and along z, each subdivided so the wave bends them. */
const buildGrid = (palette: Palette): THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial> => {
  const vertices: number[] = [];
  const pushSegment = (ax: number, az: number, bx: number, bz: number): void => {
    for (let s = 0; s < GRID_SEGMENTS; s += 1) {
      const t0 = s / GRID_SEGMENTS;
      const t1 = (s + 1) / GRID_SEGMENTS;
      vertices.push(ax + (bx - ax) * t0, 0, az + (bz - az) * t0, ax + (bx - ax) * t1, 0, az + (bz - az) * t1);
    }
  };
  for (let row = 0; row <= GRID_ROWS; row += 1) {
    const z = (row / GRID_ROWS - 0.5) * GRID_DEPTH;
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const x0 = (column / GRID_COLUMNS - 0.5) * GRID_WIDTH;
      const x1 = ((column + 1) / GRID_COLUMNS - 0.5) * GRID_WIDTH;
      pushSegment(x0, z, x1, z);
    }
  }
  for (let column = 0; column <= GRID_COLUMNS; column += 1) {
    const x = (column / GRID_COLUMNS - 0.5) * GRID_WIDTH;
    for (let row = 0; row < GRID_ROWS; row += 1) {
      const z0 = (row / GRID_ROWS - 0.5) * GRID_DEPTH;
      const z1 = ((row + 1) / GRID_ROWS - 0.5) * GRID_DEPTH;
      pushSegment(x, z0, x, z1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  const material = new THREE.ShaderMaterial({
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    uniforms: gridUniforms(palette),
    transparent: true,
    depthWrite: false,
    blending: palette.blending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.position.y = -3.2;
  return lines;
};

const buildPoints = ({ palette, pixelRatio }: { palette: Palette; pixelRatio: number }): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> => {
  const count = POINT_COLUMNS * POINT_ROWS;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let row = 0; row < POINT_ROWS; row += 1) {
    for (let column = 0; column < POINT_COLUMNS; column += 1) {
      const at = row * POINT_COLUMNS + column;
      positions[at * 3] = (column / (POINT_COLUMNS - 1) - 0.5) * GRID_WIDTH + (hashToUnit({ id: `x${at}`, salt: 3 }) - 0.5) * 1.4;
      positions[at * 3 + 1] = hashToUnit({ id: `y${at}`, salt: 7 }) * 6;
      positions[at * 3 + 2] = (row / (POINT_ROWS - 1) - 0.5) * GRID_DEPTH + (hashToUnit({ id: `z${at}`, salt: 5 }) - 0.5) * 1.4;
      seeds[at] = hashToUnit({ id: `s${at}`, salt: 11 });
    }
  }
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

const setUniform = (material: THREE.ShaderMaterial, name: string, value: number): void => {
  const uniform = material.uniforms[name];
  if (uniform) uniform.value = value;
};

/** Builds the scene on `canvas`. Returns null when WebGL is unavailable, and the page carries on without it. */
export const createScene = ({ canvas, reducedMotion, theme }: { canvas: HTMLCanvasElement; reducedMotion: boolean; theme: 'light' | 'dark' }): Scene | null => {
  const renderer = (() => {
    try {
      return new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
      return null;
    }
  })();
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

  let palette = PALETTES[theme];
  let grid = buildGrid(palette);
  let points = buildPoints({ palette, pixelRatio });
  scene.add(grid, points);

  const glowTexture = buildGlowTexture();
  const horizon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: palette.near, transparent: true, opacity: palette.horizonAlpha, blending: palette.blending, depthWrite: false }));
  horizon.position.set(0, -1, -48);
  horizon.scale.set(90, 34, 1);
  scene.add(horizon);

  const pointer = new THREE.Vector2(0, 0);
  const pointerEased = new THREE.Vector2(0, 0);
  let frame = 0;
  let disposed = false;
  let needsStill = true;
  const clock = new THREE.Clock();

  const resize = (): void => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    needsStill = true;
  };

  const step = (elapsed: number, delta: number): void => {
    const ease = reducedMotion ? 1 : Math.min(1, EASE * (delta * 60));
    setUniform(grid.material, 'uTime', elapsed);
    setUniform(grid.material, 'uScroll', elapsed * 1.6);
    setUniform(points.material, 'uTime', elapsed);
    pointerEased.lerp(pointer, ease);
    camera.position.set(cameraHome.x + pointerEased.x * PARALLAX_X, cameraHome.y - pointerEased.y * PARALLAX_Y, cameraHome.z);
    camera.lookAt(cameraTarget);
    renderer.render(scene, camera);
  };

  const loop = (): void => {
    if (disposed) return;
    frame = window.requestAnimationFrame(loop);
    if (document.hidden) return;
    if (reducedMotion && !needsStill) return;
    needsStill = false;
    const delta = Math.min(clock.getDelta(), 0.1);
    step(clock.elapsedTime, delta);
  };

  const setTheme = (next: 'light' | 'dark'): void => {
    palette = PALETTES[next];
    scene.remove(grid, points);
    grid.geometry.dispose();
    grid.material.dispose();
    points.geometry.dispose();
    points.material.dispose();
    grid = buildGrid(palette);
    points = buildPoints({ palette, pixelRatio });
    scene.add(grid, points);
    horizon.material.color.set(palette.near);
    horizon.material.opacity = palette.horizonAlpha;
    horizon.material.blending = palette.blending;
    horizon.material.needsUpdate = true;
    needsStill = true;
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointer.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
    needsStill = true;
  };
  const onLeave = (): void => {
    pointer.set(0, 0);
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerleave', onLeave);
  window.addEventListener('resize', resize);
  resize();
  loop();

  return {
    setTheme,
    dispose: () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', resize);
      grid.geometry.dispose();
      grid.material.dispose();
      points.geometry.dispose();
      points.material.dispose();
      horizon.material.dispose();
      glowTexture.dispose();
      renderer.dispose();
    },
  };
};
