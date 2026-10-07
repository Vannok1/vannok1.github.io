// CO₂ bubbles. Real beer bubbles are born at fixed nucleation sites (micro-scratches and
// fibres on the glass), grow at a roughly constant rate while rising (dr/dt ≈ const,
// Liger-Belair) and rise at the Stokes terminal velocity of a rigid sphere
// v = 2·Δρ·g·r² / (9·μ) because surfactants make their interface immobile.

const MU = 1.6e-3; // dynamic viscosity of beer, Pa·s
const RHO = 1010;
const STOKES = (2 * RHO) / (9 * MU);
const R0 = 0.035e-3;
const RMAX = 0.3e-3;
const STRIDE = 8; // x, y, r, vx, vy, z, phase, alive
export const BUBBLE_FLOATS = 8; // per rendered bubble: x, y, radius, alpha, vx, vy, depth, seed

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Bubbles {
  constructor(max = 1400, seed = 7) {
    this.max = max;
    this.p = new Float32Array(max * STRIDE);
    this.count = 0;
    this.rand = mulberry32(seed);
    this.sites = [];
    this.stuck = [];
    this.render = new Float32Array((max + 200) * BUBBLE_FLOATS);
    this.renderCount = 0;
    this.pops = 0;
    this.W = 0;
    this.H = 0;
    this.time = 0;
  }

  layout(W, H) {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    const r = mulberry32(1234);
    this.sites = [];
    const nSites = 20;
    for (let i = 0; i < nSites; i++) {
      this.sites.push({
        // relative coordinates so the sites stay put on resize
        fx: 0.06 + 0.88 * r(),
        fy: 0.015 + 0.55 * Math.pow(r(), 1.6),
        rate: 10 + 22 * r(),
        acc: r(),
        z: r() < 0.7 ? 0.02 + 0.1 * r() : 0.3 + 0.6 * r(),
      });
    }
    this.stuck = [];
    for (let i = 0; i < 70; i++) {
      this.stuck.push({ fx: r(), fy: Math.pow(r(), 1.3), r: (0.1 + 0.26 * Math.pow(r(), 2)) * 1e-3, ph: r() * 6.28 });
    }
    this.count = 0;
  }

  spawn(x, y, z, r) {
    if (this.count >= this.max) return;
    const o = this.count * STRIDE;
    const p = this.p;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = r;
    p[o + 3] = 0;
    p[o + 4] = 0;
    p[o + 5] = z;
    p[o + 6] = this.rand() * 6.283;
    p[o + 7] = 1;
    this.count++;
  }

  /**
   * @param sim LiquidSim
   * @param acc linear acceleration of the phone (device frame)
   */
  update(dt, sim, acc) {
    const W = sim.W, H = sim.H;
    this.layout(W, H);
    const hw = W / 2, hh = H / 2;
    const rand = this.rand;
    const carb = sim.carb;
    const beer = sim.beer;
    this.pops = 0;
    const hasBeer = sim.vol > 0.002 * sim.area;
    // Effective gravity felt by the liquid: g·(−u) − a  → bubbles rise along −g_eff.
    const gIn = sim.gIn;
    let ex = sim.ux * gIn + (acc ? acc.x : 0);
    let ey = sim.uy * gIn + (acc ? acc.y : 0);
    const gMag = Math.max(Math.hypot(ex, ey), 0.3);
    ex /= gMag;
    ey /= gMag;
    const agitation = Math.min(3, sim.shake * 0.25);

    if (hasBeer && dt > 0) {
      // Nucleation sites: regular trains of bubbles.
      for (const s of this.sites) {
        const x = (s.fx - 0.5) * W, y = (s.fy - 0.5) * H;
        if (sim.heightAboveBeer(x, y) > -0.002) continue;
        s.acc += dt * s.rate * carb * (0.25 + 0.75 * carb) * (1 + agitation);
        while (s.acc >= 1) {
          s.acc -= 1;
          this.spawn(x + (rand() - 0.5) * 0.0003, y, s.z, R0 * (0.8 + 0.4 * rand()));
        }
      }
      // Free bubbles everywhere in the liquid (+ bursts while shaking / pouring).
      const freeRate = (sim.vol * 2600 * carb * (1 + 6 * agitation) + sim.pour.flow * 2.5e5) * dt;
      let n = Math.floor(freeRate) + (rand() < freeRate % 1 ? 1 : 0);
      let guard = 0;
      while (n > 0 && guard++ < 400) {
        const x = (rand() - 0.5) * W;
        const y = (rand() - 0.5) * H;
        if (sim.heightAboveBeer(x, y) < -0.001) {
          this.spawn(x, y, rand(), R0 * (1 + 3 * rand() * rand()));
          n--;
        }
      }
      // Pour plume: a dense cloud of bubbles driven down where the stream hits.
      const P = sim.pour;
      if (P.visible && !P.wall && P.flow > 0) {
        const k = P.flow * 9e4 * dt;
        let m = Math.floor(k) + (rand() < k % 1 ? 1 : 0);
        const ix = P.x0 - sim.ux * P.len;
        const iy = P.y0 - sim.uy * P.len;
        while (m-- > 0) {
          const d = rand() * 0.035;
          const x = ix - sim.ux * d + (rand() - 0.5) * 0.012 * (0.3 + d / 0.035);
          const y = iy - sim.uy * d + (rand() - 0.5) * 0.012 * (0.3 + d / 0.035);
          if (sim.heightAboveBeer(x, y) < -0.0005) this.spawn(x, y, rand(), R0 * (1 + 4 * rand()));
        }
      }
    }

    // Integrate.
    const p = this.p;
    const growth = 0.11e-3 * (0.4 + 0.6 * carb);
    const tw = Math.min(1, dt / 0.04);
    let i = 0;
    while (i < this.count) {
      const o = i * STRIDE;
      let r = p[o + 2] + growth * dt;
      if (r > RMAX) r = RMAX;
      const vt = STOKES * gMag * r * r;
      const wob = Math.sin(p[o + 6] + this.time * 9) * vt * 0.12;
      const tvx = ex * vt + -ey * wob;
      const tvy = ey * vt + ex * wob;
      p[o + 3] += (tvx - p[o + 3]) * tw;
      p[o + 4] += (tvy - p[o + 4]) * tw;
      p[o] += p[o + 3] * dt;
      p[o + 1] += p[o + 4] * dt;
      p[o + 2] = r;
      const x = p[o], y = p[o + 1];
      const out = x < -hw || x > hw || y < -hh || y > hh;
      if (out || !hasBeer || sim.heightAboveBeer(x, y) > -r) {
        if (!out && hasBeer) this.pops++;
        // swap-remove
        this.count--;
        if (i !== this.count) {
          const last = this.count * STRIDE;
          for (let k = 0; k < STRIDE; k++) p[o + k] = p[last + k];
        }
        continue;
      }
      i++;
    }
    this.time += dt;

    // Build the render list: moving bubbles + bubbles clinging to the glass.
    const out = this.render;
    let n = 0;
    const vis = beer.bubbleVis;
    for (let j = 0; j < this.count; j++) {
      const o = j * STRIDE;
      const z = p[o + 5];
      out[n++] = p[o];
      out[n++] = p[o + 1];
      out[n++] = p[o + 2];
      out[n++] = vis * (1 - 0.45 * z);
      out[n++] = p[o + 3];
      out[n++] = p[o + 4];
      out[n++] = z;
      out[n++] = p[o + 6];
    }
    if (hasBeer) {
      for (const s of this.stuck) {
        const x = (s.fx - 0.5) * W, y = (s.fy - 0.5) * H;
        if (sim.heightAboveBeer(x, y) > -s.r * 2) continue;
        out[n++] = x;
        out[n++] = y;
        out[n++] = s.r * (0.6 + 0.4 * carb);
        out[n++] = vis * 0.85;
        out[n++] = 0;
        out[n++] = 0;
        out[n++] = 0.05;
        out[n++] = s.ph;
      }
    }
    this.renderCount = n / BUBBLE_FLOATS;
  }

  clear() {
    this.count = 0;
  }
}

