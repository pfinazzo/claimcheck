/**
 * Pure pan/zoom math for the scatter: a scale `k` and a translation `tx, ty`
 * applied as `translate(tx, ty) scale(k)` to the plot group.
 *
 * @author Patrick Finazzo
 */

export const MIN_K = 0.5;
export const MAX_K = 8;

export const reset = () => ({ k: 1, tx: 0, ty: 0 });

/** Zoom about the cursor (x, y in SVG units); wheel up = zoom in. */
export const applyWheel = (state, { x, y, deltaY }) => {
  const factor = Math.exp(-deltaY * 0.002);
  const k = Math.min(MAX_K, Math.max(MIN_K, state.k * factor));
  const ratio = k / state.k;
  return {
    k: Number(k.toFixed(6)),
    tx: Number((x - (x - state.tx) * ratio).toFixed(4)),
    ty: Number((y - (y - state.ty) * ratio).toFixed(4)),
  };
};

export const applyDrag = (state, { dx, dy }) => ({ k: state.k, tx: state.tx + dx, ty: state.ty + dy });

export const transformOf = (state) => `translate(${state.tx} ${state.ty}) scale(${state.k})`;
