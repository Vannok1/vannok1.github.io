// Condensation on the outside of a cold glass. Tiny droplets nucleate where the glass is
// cold (behind the beer), grow, and once heavy enough run down along gravity, picking up
// the droplets in their path and leaving a trail of small ones behind.

import { mulberry32 } from './bubbles.js';

const MAX = 700;

export class Droplets {
  constructor(seed = 99) {
    this.rand = mulberry32(seed);
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.r = new Float32Array(MAX);
    this.slide = new Float32Array(MAX); // > 0 while running down
    this.pause = new Float32Array(MAX);
    this.trail = new Float32Array(MAX);
    this.seed = new Float32Array(MAX);
    this.n = 0;
    this.W = 0;
    this.H = 0;
    this.render = new Float32Array(MAX * 5);
    this.trailRender = new Float32Array(MAX * 5);
    this.trailCount = 0;
    this.renderCount = 0;
    this.cold = 0.55; // 0 → warm glass, 1 → fully covered with condensation (glasses come chilled)
  }

  layout(W, H) {
    if (W === this.W && H === this.H) return;
    const sx = this.W ? W / this.W : 1;
    const sy = this.H ? H / this.H : 1;
    for (let i = 0; i < this.n; i++) {
      this.x[i] *= sx;
      this.y[i] *= sy;
    }
    this.W = W;
    this.H = H;
  }

  add(x, y, r) {
    if (this.n >= MAX) return -1;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.r[i] = r;
    this.slide[i] = 0;
    this.pause[i] = 0;
    this.trail[i] = 0;
    this.seed[i] = this.rand();
    return i;
  }

  remove(i) {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.r[i] = this.r[j];
    this.slide[i] = this.slide[j];
    this.pause[i] = this.pause[j];
    this.trail[i] = this.trail[j];
    this.seed[i] = this.seed[j];
  }

  update(dt, sim) {
    this.layout(sim.W, sim.H);
    const rand = this.rand;
    const hw = sim.W / 2, hh = sim.H / 2;
    // The glass gets cold while it holds beer and slowly warms up when empty.
    const hasBeer = sim.vol > 0.03 * sim.area;
    this.cold += ((hasBeer ? 1 : 0.35) - this.cold) * Math.min(1, dt / (hasBeer ? 12 : 90));
    const target = Math.floor(80 + 520 * this.cold);
    const expected = Math.max(0, target - this.n) * 1.5 * dt;
    let spawn = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
    while (spawn-- > 0 && this.n < target) {
      const x = (rand() - 0.5) * sim.W;
      const y = (rand() - 0.5) * sim.H;
      const coldHere = sim.heightAboveBeer(x, y) < 0.004;
      if (!coldHere && rand() > 0.22) continue;
      const u = rand();
      // mostly tiny droplets, some medium ones and the odd big drop
      const r = u < 0.6 ? 0.14 + 0.22 * rand() : u < 0.9 ? 0.36 + 0.45 * rand() : u < 0.985 ? 0.8 + 0.7 * rand() : 1.5 + 0.8 * rand();
      this.add(x, y, r * 1e-3);
    }

    // Gravity direction on the glass.
    const m = Math.min(1, sim.gIn / 9.81);
    const dx = -sim.ux, dy = -sim.uy;
    for (let i = 0; i < this.n; i++) {
      // condensation growth (very slow)
      if (this.r[i] < 1.2e-3) this.r[i] += 0.004e-3 * dt * this.cold;
      const heavy = this.r[i] > 1.75e-3 + 0.5e-3 * ((i * 0.6180339) % 1);
      if (heavy && m > 0.25) this.slide[i] = 1;
      if (this.slide[i] > 0) {
        if (this.pause[i] > 0) {
          this.pause[i] -= dt;
          continue;
        }
        if (rand() < dt * 1.2) this.pause[i] = 0.05 + 0.4 * rand(); // stick–slip
        const v = (0.008 + 26 * Math.max(0, this.r[i] - 1.5e-3)) * m;
        const step = v * dt;
        this.x[i] += dx * step + (rand() - 0.5) * 0.25 * step;
        this.y[i] += dy * step + (rand() - 0.5) * 0.25 * step;
        // trail of tiny droplets
        this.trail[i] += step;
        if (this.trail[i] > 0.0025 && this.r[i] > 1.0e-3) {
          this.trail[i] = 0;
          const tr = (0.12 + 0.18 * rand()) * 1e-3;
          this.r[i] = Math.cbrt(this.r[i] ** 3 - tr ** 3);
          this.add(this.x[i] - dx * this.r[i] * 1.3, this.y[i] - dy * this.r[i] * 1.3, tr);
        }
        // swallow droplets in the way
        for (let j = 0; j < this.n; j++) {
          if (j === i) continue;
          const ddx = this.x[j] - this.x[i], ddy = this.y[j] - this.y[i];
          const rr = (this.r[i] + this.r[j]) * 0.85;
          if (ddx * ddx + ddy * ddy < rr * rr && this.r[j] <= this.r[i]) {
            this.r[i] = Math.min(2.8e-3, Math.cbrt(this.r[i] ** 3 + this.r[j] ** 3));
            this.remove(j);
            if (j < i) i--;
            j--;
          }
        }
        if (this.r[i] < 1.2e-3 && rand() < dt * 2) this.slide[i] = 0;
      }
      const out = this.x[i] < -hw - 0.003 || this.x[i] > hw + 0.003 || this.y[i] < -hh - 0.01 || this.y[i] > hh + 0.003;
      if (out) {
        this.remove(i);
        i--;
      }
    }
    // When the glass warms up the droplets slowly evaporate.
    if (this.n > target + 10 && rand() < dt * 3) this.remove((rand() * this.n) | 0);

    const out = this.render;
    const tr = this.trailRender;
    let k = 0, t = 0;
    for (let i = 0; i < this.n; i++) {
      const r = this.r[i];
      // bigger drops sag under gravity; running ones stretch out
      const asp = 1 + Math.min(0.35, Math.max(0, r - 0.5e-3) * 220) + (this.slide[i] > 0 ? 0.25 : 0);
      out[k++] = this.x[i];
      out[k++] = this.y[i];
      out[k++] = r;
      out[k++] = asp;
      out[k++] = this.seed[i];
      if (this.slide[i] > 0) {
        tr[t++] = this.x[i];
        tr[t++] = this.y[i];
        tr[t++] = r * 1.15;
        tr[t++] = 1;
        tr[t++] = 0;
      }
    }
    this.renderCount = this.n;
    this.trailCount = t / 5;
  }
}
