// Pure orientation / motion math. No DOM access here so it can be unit-tested in Node.
//
// Device frame (W3C DeviceOrientation spec): x → right edge of the screen,
// y → top edge of the screen, z → out of the screen towards the viewer.
// Euler angles are intrinsic Z-X'-Y'' (alpha, beta, gamma).

const DEG = Math.PI / 180;
export const G = 9.81;

/**
 * Unit gravity vector ("which way is down") expressed in the device frame.
 * R = Rz(alpha)·Rx(beta)·Ry(gamma) maps device → world, so
 * g_device = Rᵀ·(0,0,-1) = (sinγ·cosβ, −sinβ, −cosγ·cosβ). Alpha (compass) drops out.
 * Continuous in the physical rotation even where the Euler angles themselves jump.
 */
export function gravityFromEuler(beta, gamma) {
  const b = beta * DEG;
  const g = gamma * DEG;
  const cb = Math.cos(b);
  return { x: Math.sin(g) * cb, y: -Math.sin(b), z: -Math.cos(g) * cb };
}

/**
 * Inverse helper used by tests and the pointer fallback: gravity for a device that is
 * rotated `rollDeg` counter-clockwise in its own plane (0 = upright portrait) and whose
 * screen is tipped back by `tiltDeg` (0 = screen vertical, 90 = lying flat, screen up).
 */
export function gravityFromRollTilt(rollDeg, tiltDeg = 0) {
  const r = rollDeg * DEG;
  const t = tiltDeg * DEG;
  const ct = Math.cos(t);
  return { x: -Math.sin(r) * ct, y: -Math.cos(r) * ct, z: -Math.sin(t) };
}

/**
 * Euler angles (beta, gamma) that the browser would report for a device in the pose
 * described by gravityFromRollTilt. Used to synthesise realistic sensor events in tests.
 */
export function eulerFromGravity(gx, gy, gz) {
  // gy = -sinβ, gx = sinγ·cosβ, gz = -cosγ·cosβ, with γ ∈ [-90, 90).
  let beta = Math.asin(Math.max(-1, Math.min(1, -gy)));
  let cb = Math.cos(beta);
  let gamma = 0;
  if (cb > 1e-9) {
    // cosγ must be ≥ 0, so pick the β branch that makes -gz/cb ≥ 0.
    if (-gz < 0) {
      beta = Math.PI - beta;
      cb = Math.cos(beta);
    }
    gamma = Math.atan2(gx / cb, -gz / cb);
  }
  let bd = beta / DEG;
  if (bd >= 180) bd -= 360;
  if (bd < -180) bd += 360;
  return { beta: bd, gamma: gamma / DEG };
}

/** Normalise screen orientation angle to one of 0, 90, 180, 270 (counter-clockwise). */
export function normalizeScreenAngle(angle) {
  const a = Math.round(((Number(angle) || 0) % 360 + 360) % 360 / 90) * 90;
  return a % 360;
}

/**
 * CSS transform that keeps an element glued to the *physical* device when the browser
 * auto-rotates its content. `vw`/`vh` are the current viewport size. Returns the size
 * the element must have (device-frame portrait size) and the transform string.
 */
export function deviceLockTransform(angle, vw, vh) {
  switch (normalizeScreenAngle(angle)) {
    case 90:
      return { width: vh, height: vw, transform: `translate(0px, ${vh}px) rotate(-90deg)` };
    case 270:
      return { width: vh, height: vw, transform: `translate(${vw}px, 0px) rotate(90deg)` };
    case 180:
      return { width: vw, height: vh, transform: `translate(${vw}px, ${vh}px) rotate(180deg)` };
    default:
      return { width: vw, height: vh, transform: 'none' };
  }
}

/**
 * iOS Safari reports DeviceMotion with the opposite sign to the spec (and to Android):
 * a phone lying flat gives accelerationIncludingGravity.z = -9.81 instead of +9.81.
 * Rather than sniffing the user agent we calibrate at runtime: per spec, at rest
 * accelerationIncludingGravity ≈ −G·ĝ, so its dot product with the orientation-derived
 * gravity direction is negative. Returns +1 (spec) or −1 (inverted) once confident,
 * or 0 if the evidence is still ambiguous.
 */
export class MotionSignCalibrator {
  constructor() {
    this.score = 0;
    this.samples = 0;
  }
  add(aig, gdir) {
    if (!aig || !gdir) return;
    const mag = Math.hypot(aig.x, aig.y, aig.z);
    // Only trust samples taken while roughly at rest (|a| close to 1 g).
    if (!(mag > 6.5 && mag < 13)) return;
    const d = (aig.x * gdir.x + aig.y * gdir.y + aig.z * gdir.z) / mag;
    if (Math.abs(d) < 0.5) return;
    this.score = this.score * 0.95 + Math.sign(-d);
    this.samples++;
  }
  get sign() {
    if (this.samples < 5 || Math.abs(this.score) < 2) return 0;
    return this.score > 0 ? 1 : -1;
  }
}

/**
 * Linear acceleration of the device (m/s², device frame, spec sign: positive x means
 * the phone itself is accelerating towards its right edge).
 */
export function linearAcceleration(acc, aig, sign, gdir) {
  const s = sign || 1;
  if (acc && Number.isFinite(acc.x) && Number.isFinite(acc.y)) {
    return { x: s * acc.x, y: s * acc.y, z: s * (acc.z || 0) };
  }
  if (aig && gdir && Number.isFinite(aig.x)) {
    // Spec: aig = a − g·ĝ  ⇒  a = aig + g·ĝ
    return {
      x: s * aig.x + G * gdir.x,
      y: s * aig.y + G * gdir.y,
      z: s * (aig.z || 0) + G * gdir.z,
    };
  }
  return { x: 0, y: 0, z: 0 };
}
