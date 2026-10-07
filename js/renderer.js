import {
  QUAD_VS,
  BG_FS,
  LACE_FS,
  SCENE_FS,
  BUBBLE_VS,
  BUBBLE_FS,
  DROP_VS,
  DROP_FS,
  TRAIL_FS,
  TRAIL_POINT_FS,
  BRIGHT_FS,
  BLUR_FS,
  COMPOSITE_FS,
} from './shaders.js';
import { WAVE_SAMPLES } from './liquid.js';
import { supportAlong } from './geometry.js';
import { BUBBLE_FLOATS } from './bubbles.js';

const MAX_BUBBLES = 2400;
const MAX_DROPS = 800;
// Rise speeds of the three procedural carbonation layers (m/s): bigger = faster (Stokes).
const FIZZ_SPEED = [0.034, 0.022, 0.013];
const FIZZ_CELL = [0.0013, 0.0008, 0.00052];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile error: ' + log);
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

function makeTarget(gl, w, h, { mip = false, filter = gl.LINEAR } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb, w, h };
}

const toLinear = (c) => c.map((v) => Math.pow(v, 2.2));

function freeTarget(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fb);
}

function clearTarget(gl, t, r = 0, g = 0, b = 0, a = 1) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  gl.viewport(0, 0, t.w, t.h);
  gl.clearColor(r, g, b, a);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.progBg = program(gl, QUAD_VS, BG_FS);
    this.progLace = program(gl, QUAD_VS, LACE_FS);
    this.progScene = program(gl, QUAD_VS, SCENE_FS);
    this.progBubble = program(gl, BUBBLE_VS, BUBBLE_FS);
    this.progDrop = program(gl, DROP_VS, DROP_FS);
    this.progTrail = program(gl, QUAD_VS, TRAIL_FS);
    this.progTrailPt = program(gl, DROP_VS, TRAIL_POINT_FS);
    this.progBright = program(gl, QUAD_VS, BRIGHT_FS);
    this.progBlur = program(gl, QUAD_VS, BLUR_FS);
    this.progComp = program(gl, QUAD_VS, COMPOSITE_FS);

    // full-screen quad
    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // bubbles: one quad, instanced
    this.bubbleVao = gl.createVertexArray();
    gl.bindVertexArray(this.bubbleVao);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.bubbleBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, BUBBLE_FLOATS * 4 * MAX_BUBBLES, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BUBBLE_FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, BUBBLE_FLOATS * 4, 16);
    gl.vertexAttribDivisor(2, 1);

    // droplets (points): x, y, r, aspect, seed
    const mkDropVao = () => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, 5 * 4 * MAX_DROPS, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
      return { vao, buf };
    };
    this.drop = mkDropVao();
    this.trailPts = mkDropVao();
    gl.bindVertexArray(null);

    this.waveTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, WAVE_SAMPLES, 1, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.waveMM = new Float32Array(WAVE_SAMPLES);

    this.pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    this.fizz = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    this.width = 0;
    this.height = 0;
    this.frame = 0;
    this.bgDirty = true;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  /** Size in device pixels and physical size of the glass (metres). */
  resize(pxW, pxH, geom) {
    const gl = this.gl;
    this.geom = geom;
    if (pxW === this.width && pxH === this.height) return;
    this.width = pxW;
    this.height = pxH;
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    for (const t of [this.scene, this.bg, this.drops, this.bright, this.bloomA, this.bloomB]) freeTarget(gl, t);
    for (const pair of [this.lace, this.trail]) if (pair) pair.forEach((t) => freeTarget(gl, t));
    this.scene = makeTarget(gl, pxW, pxH);
    this.bg = makeTarget(gl, Math.max(64, Math.round(pxW / 2)), Math.max(64, Math.round(pxH / 2)), { mip: true });
    this.drops = makeTarget(gl, pxW, pxH);
    const lw = 160, lh = Math.max(64, Math.round((160 * pxH) / pxW));
    this.lace = [makeTarget(gl, lw, lh), makeTarget(gl, lw, lh)];
    const tw = Math.max(32, Math.round(pxW / 3)), th = Math.max(32, Math.round(pxH / 3));
    this.trail = [makeTarget(gl, tw, th), makeTarget(gl, tw, th)];
    const bw = Math.max(16, Math.round(pxW / 4)), bh = Math.max(16, Math.round(pxH / 4));
    this.bright = makeTarget(gl, bw, bh);
    this.bloomA = makeTarget(gl, bw, bh);
    this.bloomB = makeTarget(gl, bw, bh);
    for (const t of [...this.lace, ...this.trail]) clearTarget(gl, t);
    this.laceIdx = 0;
    this.trailIdx = 0;
    this.bgDirty = true;
  }

  setCommon(prog, s) {
    const gl = this.gl;
    const u = prog.u;
    const g = this.geom;
    gl.uniform2f(u.uSize, g.W, g.H);
    gl.uniform1f(u.uBase, g.B);
    if (u.uUp) gl.uniform2f(u.uUp, s.ux, s.uy);
    if (u.uLevel) gl.uniform1f(u.uLevel, s.c);
    if (u.uFoamTop) gl.uniform1f(u.uFoamTop, s.cf);
    if (u.uWaveR) gl.uniform1f(u.uWaveR, s.waveRange);
    if (u.uTime) gl.uniform1f(u.uTime, s.time % 1000);
    if (u.uPx) gl.uniform1f(u.uPx, g.W / this.width);
    if (u.uWave) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
      gl.uniform1i(u.uWave, 0);
    }
  }

  drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Accumulate how far each procedural carbonation layer has risen (along "up"). */
  advanceFizz(sim, dt) {
    const k = (0.35 + 0.65 * sim.carb) * Math.sqrt(Math.max(sim.gIn, 0.5) / 9.81);
    for (let i = 0; i < 3; i++) {
      const f = this.fizz[i];
      const v = FIZZ_SPEED[i] * k * dt;
      f[0] += sim.ux * v;
      f[1] += sim.uy * v;
      const wrap = FIZZ_CELL[i] * 8192;
      for (let j = 0; j < 2; j++) if (Math.abs(f[j]) > wrap) f[j] -= Math.sign(f[j]) * wrap;
    }
  }

  /**
   * @param sim LiquidSim, @param bubbles Bubbles, @param drops Droplets, @param view {band, dt}
   */
  render(sim, bubbles, drops, view) {
    const gl = this.gl;
    if (this.lost || !this.width) return;
    const beer = sim.beer;
    const g = this.geom;
    const dt = view.dt || 1 / 60;
    this.frame++;
    this.advanceFizz(sim, dt);

    for (let i = 0; i < WAVE_SAMPLES; i++) this.waveMM[i] = sim.wave[i] * 1000;
    gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_SAMPLES, 1, gl.RED, gl.FLOAT, this.waveMM);

    gl.disable(gl.BLEND);
    const hasBeer = sim.vol > 1e-6 * sim.area || sim.foamVol > 1e-6 * sim.area ? 1 : 0;
    const pxPerM = this.width / g.W;

    // 1. background (only when the size changes)
    if (this.bgDirty) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bg.fb);
      gl.viewport(0, 0, this.bg.w, this.bg.h);
      gl.useProgram(this.progBg.p);
      this.setCommon(this.progBg, sim);
      this.drawQuad();
      gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.bgDirty = false;
    }

    // 2. lacing / wet film memory
    {
      const src = this.lace[this.laceIdx];
      const dst = this.lace[1 - this.laceIdx];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      const P = this.progLace;
      gl.useProgram(P.p);
      this.setCommon(P, sim);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(P.u.uPrev, 1);
      const speed = 0.006 * Math.min(1, sim.gIn / 9.81); // film drains at ~6 mm/s
      gl.uniform2f(P.u.uDrift, (-sim.ux * speed * dt) / g.W, (-sim.uy * speed * dt) / (g.H + g.B));
      gl.uniform1f(P.u.uDecayG, Math.exp(-dt / 2.5));
      gl.uniform1f(P.u.uHasBeer, hasBeer);
      this.drawQuad();
      this.laceIdx = 1 - this.laceIdx;
    }

    // 3. droplets: normal map + the clear trails running drops leave in the mist
    clearTarget(gl, this.drops, 0.5, 0.5, 0, 0);
    if (drops && drops.renderCount > 0) {
      const P = this.progDrop;
      gl.useProgram(P.p);
      gl.uniform2f(P.u.uSize, g.W, g.H);
      gl.uniform1f(P.u.uBase, g.B);
      gl.uniform1f(P.u.uPxPerM, pxPerM);
      gl.uniform1f(P.u.uMaxPoint, this.pointRange[1]);
      gl.uniform1f(P.u.uScale, 1);
      const n = Math.min(drops.renderCount, MAX_DROPS);
      gl.bindVertexArray(this.drop.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.drop.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, drops.render, 0, n * 5);
      gl.drawArrays(gl.POINTS, 0, n);
    }
    {
      const src = this.trail[this.trailIdx];
      const dst = this.trail[1 - this.trailIdx];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(this.progTrail.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.progTrail.u.uPrev, 0);
      gl.uniform1f(this.progTrail.u.uDecay, Math.exp(-dt / 45));
      this.drawQuad();
      if (drops && drops.trailCount > 0) {
        const P = this.progTrailPt;
        gl.useProgram(P.p);
        gl.uniform2f(P.u.uSize, g.W, g.H);
        gl.uniform1f(P.u.uBase, g.B);
        gl.uniform1f(P.u.uPxPerM, dst.w / g.W);
        gl.uniform1f(P.u.uMaxPoint, this.pointRange[1]);
        gl.uniform1f(P.u.uScale, 1);
        const n = Math.min(drops.trailCount, MAX_DROPS);
        gl.bindVertexArray(this.trailPts.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.trailPts.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, drops.trailRender, 0, n * 5);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.drawArrays(gl.POINTS, 0, n);
        gl.blendEquation(gl.FUNC_ADD);
        gl.disable(gl.BLEND);
      }
      this.trailIdx = 1 - this.trailIdx;
    }

    // 4. scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    {
      const P = this.progScene;
      const u = P.u;
      gl.useProgram(P.p);
      this.setCommon(P, sim);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
      gl.uniform1i(u.uBg, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.lace[this.laceIdx].tex);
      gl.uniform1i(u.uLace, 2);
      gl.uniform1f(u.uHasBeer, hasBeer);
      gl.uniform1f(u.uSupport, supportAlong(g.W / 2, g.H / 2, sim.ux, sim.uy));
      gl.uniform1f(u.uBand, view.band || 0);
      gl.uniform3fv(u.uSigma, beer.sigma);
      gl.uniform1f(u.uHaze, beer.haze);
      gl.uniform3fv(u.uHazeColor, toLinear(beer.hazeColor));
      gl.uniform3fv(u.uFoamColor, toLinear(beer.foam));
      gl.uniform3fv(u.uFoamWet, toLinear(beer.foamWet));
      gl.uniform1f(u.uFoamCell, beer.foamCell);
      gl.uniform1f(u.uFoamAge, sim.foamAge);
      gl.uniform1f(u.uCloud, sim.cloud);
      gl.uniform1f(u.uCloudFront, sim.cloudFront);
      gl.uniform1f(u.uNitro, beer.nitro ? 1 : 0);
      const P0 = sim.pour;
      const intensity = P0.visible ? Math.min(1, P0.flow / Math.max(P0.rate, 1e-9)) : 0;
      const len = P0.wall ? Math.min(P0.len, P0.tWall) : P0.len;
      gl.uniform4f(u.uPour, P0.x0, P0.y0 + 0.01, len + 0.01, intensity);
      gl.uniform1f(u.uPourW, 0.0042 * Math.sqrt(intensity));
      gl.uniform1f(u.uPourWall, P0.wall ? 1 : 0);
      gl.uniform1f(u.uExposure, 1.0);
      gl.uniform2f(u.uFizz0, this.fizz[0][0], this.fizz[0][1]);
      gl.uniform2f(u.uFizz1, this.fizz[1][0], this.fizz[1][1]);
      gl.uniform2f(u.uFizz2, this.fizz[2][0], this.fizz[2][1]);
      gl.uniform1f(u.uFizzAmt, (0.25 + 0.75 * sim.carb) * beer.bubbleVis * (0.7 + 0.3 * Math.min(1, sim.shake * 0.3 + 0.7)));
      this.drawQuad();
    }

    // 5. hero bubbles on top of the scene
    if (bubbles && bubbles.renderCount > 0 && hasBeer) {
      const P = this.progBubble;
      gl.useProgram(P.p);
      gl.uniform2f(P.u.uSize, g.W, g.H);
      gl.uniform1f(P.u.uBase, g.B);
      gl.uniform1f(P.u.uPxPerM, pxPerM);
      gl.uniform1f(P.u.uShutter, 1 / 240);
      const T = beer.sigma.map((s) => Math.exp(-s * 0.03));
      gl.uniform3f(P.u.uTint, 0.55 + 0.45 * T[0], 0.5 + 0.5 * T[1], 0.35 + 0.65 * T[2]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.bubbleVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleBuf);
      const n = Math.min(bubbles.renderCount, MAX_BUBBLES);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, bubbles.render, 0, n * BUBBLE_FLOATS);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
    }

    // 6. bloom (quarter resolution)
    {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bright.fb);
      gl.viewport(0, 0, this.bright.w, this.bright.h);
      gl.useProgram(this.progBright.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
      gl.uniform1i(this.progBright.u.uSrc, 0);
      gl.uniform2f(this.progBright.u.uTexel, 1 / this.width, 1 / this.height);
      this.drawQuad();
      const blur = (src, dst, dx, dy) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.useProgram(this.progBlur.p);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform1i(this.progBlur.u.uSrc, 0);
        gl.uniform2f(this.progBlur.u.uDir, dx / src.w, dy / src.h);
        this.drawQuad();
      };
      blur(this.bright, this.bloomA, 1.5, 0);
      blur(this.bloomA, this.bloomB, 0, 1.5);
    }

    // 7. composite to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    {
      const P = this.progComp;
      const u = P.u;
      gl.useProgram(P.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
      gl.uniform1i(u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.drops.tex);
      gl.uniform1i(u.uDrops, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.trail[this.trailIdx].tex);
      gl.uniform1i(u.uTrail, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
      gl.uniform1i(u.uBloom, 3);
      gl.uniform2f(u.uRes, this.width, this.height);
      gl.uniform3f(u.uGlass, g.W, g.H, g.B);
      gl.uniform2f(u.uUp, sim.ux, sim.uy);
      gl.uniform1f(u.uLevel, hasBeer ? sim.c : -1);
      gl.uniform1f(u.uFog, drops ? Math.min(1, drops.cold * 1.15) : 0);
      gl.uniform1f(u.uTime, sim.time % 1000);
      gl.uniform1f(u.uBloomK, 0.28);
      this.drawQuad();
    }
    gl.bindVertexArray(null);
  }

  /** Render and read the frame back (tests / screenshots). RGBA rows bottom-up. */
  snapshot(sim, bubbles, drops, view) {
    this.render(sim, bubbles, drops, view);
    const gl = this.gl;
    const data = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { w: this.width, h: this.height, data };
  }
}
