// Geometry of a liquid in a rectangular glass (the phone screen seen from the side).
// Coordinates are metres relative to the glass centre; `u` is the unit "up" vector.
// The free surface is the line u·p = c, liquid occupies u·p ≤ c.

const PX = new Float64Array(8);
const PY = new Float64Array(8);

/** Area of the part of the rectangle [-hw,hw]×[-hh,hh] lying below the line u·p = c. */
export function areaBelow(hw, hh, ux, uy, c) {
  const xs0 = -hw, xs1 = hw, ys0 = -hh, ys1 = hh;
  let n = 0;
  // Unrolled Sutherland–Hodgman clip of the rectangle against one half-plane.
  for (let i = 0; i < 4; i++) {
    const xi = i === 0 || i === 3 ? xs0 : xs1;
    const yi = i < 2 ? ys0 : ys1;
    const j = (i + 1) & 3;
    const xj = j === 0 || j === 3 ? xs0 : xs1;
    const yj = j < 2 ? ys0 : ys1;
    const fi = ux * xi + uy * yi - c;
    const fj = ux * xj + uy * yj - c;
    if (fi <= 0) {
      PX[n] = xi;
      PY[n] = yi;
      n++;
    }
    if (fi <= 0 !== fj <= 0) {
      const t = fi / (fi - fj);
      PX[n] = xi + t * (xj - xi);
      PY[n] = yi + t * (yj - yi);
      n++;
    }
  }
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += PX[i] * PY[j] - PX[j] * PY[i];
  }
  return Math.abs(a) * 0.5;
}

/** Half-extent of the rectangle along u (support function). */
export function supportAlong(hw, hh, ux, uy) {
  return Math.abs(ux) * hw + Math.abs(uy) * hh;
}

/** Level c such that areaBelow(...) === area (bisection, monotone). */
export function solveLevel(hw, hh, ux, uy, area) {
  const R = supportAlong(hw, hh, ux, uy);
  const total = 4 * hw * hh;
  if (area <= 0) return -R;
  if (area >= total) return R;
  let lo = -R, hi = R;
  for (let it = 0; it < 48; it++) {
    const mid = 0.5 * (lo + hi);
    if (areaBelow(hw, hh, ux, uy, mid) < area) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Extent [sMin, sMax] of the surface line inside the rectangle, measured along the
 * tangent t = (uy, −ux) from the projection of the centre. Returns null if the line
 * misses the rectangle.
 */
export function chordExtent(hw, hh, ux, uy, c) {
  const tx = uy, ty = -ux;
  let lo = -Infinity, hi = Infinity;
  // p = c·u + s·t must satisfy |p.x| ≤ hw and |p.y| ≤ hh.
  const cx = c * ux, cy = c * uy;
  if (Math.abs(tx) > 1e-12) {
    const a = (-hw - cx) / tx, b = (hw - cx) / tx;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  } else if (Math.abs(cx) > hw) return null;
  if (Math.abs(ty) > 1e-12) {
    const a = (-hh - cy) / ty, b = (hh - cy) / ty;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  } else if (Math.abs(cy) > hh) return null;
  if (!(hi > lo)) return null;
  return [lo, hi];
}
