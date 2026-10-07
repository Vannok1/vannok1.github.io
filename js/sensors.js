// Phone sensors → gravity direction + linear acceleration in the device frame.
// Handles the iOS 13+ permission prompt, iOS's inverted DeviceMotion sign, missing
// sensors (desktop) with a pointer/keyboard fallback.

import {
  gravityFromEuler,
  gravityFromRollTilt,
  MotionSignCalibrator,
  linearAcceleration,
} from './orientation.js';

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class Sensors {
  constructor() {
    this.g = { x: 0, y: -1, z: 0 }; // smoothed gravity (unit, device frame)
    this.gTarget = { x: 0, y: -0.92, z: -0.39 };
    this.acc = { x: 0, y: 0, z: 0 }; // high-passed linear acceleration
    this.accLP = { x: 0, y: 0, z: 0 };
    this.accRaw = { x: 0, y: 0, z: 0 };
    this.calib = new MotionSignCalibrator();
    this.orientationEvents = 0;
    this.motionEvents = 0;
    this.lastOrientationAt = 0;
    this.mode = 'idle'; // idle | sensor | pointer
    this.permission = 'unknown';
    this.pointer = { roll: 0, tilt: 22, dragging: false, lastX: 0, lastY: 0, vx: 0, kick: 0 };
    this.keys = new Set();
    this.onOrientation = this.onOrientation.bind(this);
    this.onMotion = this.onMotion.bind(this);
    this.motionGravity = null;
  }

  get needsPermission() {
    return (
      typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'
    );
  }

  /**
   * Must be called synchronously from a user gesture (iOS requirement). Both prompts are
   * requested before awaiting anything so the gesture is still "active" for both.
   */
  request() {
    const jobs = [];
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        jobs.push(DeviceOrientationEvent.requestPermission());
      }
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        jobs.push(DeviceMotionEvent.requestPermission());
      }
    } catch (e) {
      jobs.push(Promise.resolve('denied'));
    }
    if (!jobs.length) {
      this.permission = 'not-required';
      this.listen();
      return Promise.resolve('granted');
    }
    return Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => 'denied'))).then((res) => {
      const ok = res.some((r) => r === 'granted');
      this.permission = ok ? 'granted' : 'denied';
      if (ok) this.listen();
      return ok ? 'granted' : 'denied';
    });
  }

  listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.onOrientation);
    window.addEventListener('devicemotion', this.onMotion);
  }

  onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    this.gTarget = gravityFromEuler(e.beta, e.gamma);
    this.orientationEvents++;
    this.lastOrientationAt = performance.now();
    if (this.mode !== 'sensor') this.mode = 'sensor';
  }

  onMotion(e) {
    const aig = e.accelerationIncludingGravity;
    const acc = e.acceleration;
    const hasAig = aig && Number.isFinite(aig.x) && Number.isFinite(aig.y) && Number.isFinite(aig.z);
    const hasAcc = acc && Number.isFinite(acc.x) && Number.isFinite(acc.y);
    if (!hasAig && !hasAcc) return;
    this.motionEvents++;
    let sign = this.calib.sign;
    if (hasAig && this.orientationEvents > 0) {
      this.calib.add(aig, this.gTarget);
      sign = this.calib.sign;
    }
    if (!sign) sign = isIOS() ? -1 : 1;
    this.motionSign = sign;
    // No orientation events (rare): derive gravity from the accelerometer itself.
    if (this.orientationEvents === 0 && hasAig) {
      const gx = -sign * aig.x, gy = -sign * aig.y, gz = -sign * aig.z;
      const m = Math.hypot(gx, gy, gz);
      if (m > 3) {
        const lp = this.motionGravity || { x: gx / m, y: gy / m, z: gz / m };
        const k = 0.15;
        lp.x += (gx / m - lp.x) * k;
        lp.y += (gy / m - lp.y) * k;
        lp.z += (gz / m - lp.z) * k;
        this.motionGravity = lp;
        const n = Math.hypot(lp.x, lp.y, lp.z) || 1;
        this.gTarget = { x: lp.x / n, y: lp.y / n, z: lp.z / n };
        this.mode = 'sensor';
      }
    }
    const lin = linearAcceleration(hasAcc ? acc : null, hasAig ? aig : null, sign, this.gTarget);
    // Clamp spikes so a dropped phone does not explode the simulation.
    const cl = (v) => Math.max(-40, Math.min(40, v));
    this.accRaw = { x: cl(lin.x), y: cl(lin.y), z: cl(lin.z) };
  }

  // ----- pointer / keyboard fallback (desktop, or motion access denied) -------------
  enablePointer(target) {
    if (this.pointerBound) return;
    this.pointerBound = true;
    this.mode = this.mode === 'sensor' ? 'sensor' : 'pointer';
    const P = this.pointer;
    target.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'pointer') return;
      P.dragging = true;
      P.lastX = e.clientX;
      P.lastY = e.clientY;
      P.lastT = performance.now();
    });
    window.addEventListener('pointermove', (e) => {
      if (!P.dragging || this.mode !== 'pointer') return;
      const dx = e.clientX - P.lastX;
      const dy = e.clientY - P.lastY;
      P.lastX = e.clientX;
      P.lastY = e.clientY;
      P.roll = Math.max(-175, Math.min(175, P.roll - dx * 0.45));
      P.tilt = Math.max(-30, Math.min(80, P.tilt + dy * 0.2));
    });
    const up = () => {
      P.dragging = false;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', (e) => this.keys.add(e.key));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
  }

  /** Simulated hand shake for the pointer mode (double tap / "S" key). */
  kick(strength = 1) {
    this.pointer.kick = Math.max(this.pointer.kick, strength);
  }

  /** Call once per animation frame. */
  update(dt) {
    const P = this.pointer;
    if (this.mode === 'pointer') {
      if (this.keys.has('ArrowLeft')) P.roll = Math.min(175, P.roll + 120 * dt);
      if (this.keys.has('ArrowRight')) P.roll = Math.max(-175, P.roll - 120 * dt);
      if (this.keys.has('ArrowUp')) P.tilt = Math.max(-30, P.tilt - 60 * dt);
      if (this.keys.has('ArrowDown')) P.tilt = Math.min(80, P.tilt + 60 * dt);
      const anyKey = this.keys.has('ArrowLeft') || this.keys.has('ArrowRight');
      if (!P.dragging && !anyKey) {
        // let go → the glass returns upright like a hand putting it down
        P.roll += (0 - P.roll) * Math.min(1, dt * 2.2);
      }
      this.gTarget = gravityFromRollTilt(P.roll, P.tilt);
      if (P.kick > 0) {
        const t = performance.now() / 1000;
        const a = 16 * P.kick;
        this.accRaw = { x: a * Math.sin(t * 2 * Math.PI * 5.5), y: a * 0.4 * Math.cos(t * 2 * Math.PI * 4.1), z: 0 };
        P.kick = Math.max(0, P.kick - dt * 0.9);
      } else {
        this.accRaw = { x: 0, y: 0, z: 0 };
      }
    }

    // Smooth gravity a little (sensor jitter) without adding noticeable lag.
    const k = 1 - Math.exp(-dt / (this.mode === 'pointer' ? 0.06 : 0.03));
    const g = this.g;
    g.x += (this.gTarget.x - g.x) * k;
    g.y += (this.gTarget.y - g.y) * k;
    g.z += (this.gTarget.z - g.z) * k;
    const n = Math.hypot(g.x, g.y, g.z) || 1;
    g.x /= n;
    g.y /= n;
    g.z /= n;

    // Linear acceleration: light low-pass for noise, high-pass (~1.5 s) to remove bias.
    const r = this.accRaw;
    const kl = 1 - Math.exp(-dt / 1.5);
    const lp = this.accLP;
    lp.x += (r.x - lp.x) * kl;
    lp.y += (r.y - lp.y) * kl;
    lp.z += (r.z - lp.z) * kl;
    const kn = 1 - Math.exp(-dt / 0.02);
    const a = this.acc;
    a.x += (r.x - lp.x - a.x) * kn;
    a.y += (r.y - lp.y - a.y) * kn;
    a.z += (r.z - lp.z - a.z) * kn;
    return { g: this.g, acc: this.acc };
  }
}

export { isIOS };
