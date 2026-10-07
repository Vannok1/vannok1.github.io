import { LiquidSim } from './liquid.js';
import { Bubbles } from './bubbles.js';
import { Droplets } from './droplets.js';
import { Renderer } from './renderer.js';
import { Sensors, isIOS } from './sensors.js';
import { AudioEngine } from './audio.js';
import { BEERS, beerById } from './beers.js';
import { deviceLockTransform, normalizeScreenAngle } from './orientation.js';

// ---------------------------------------------------------------------------------------
// i18n
const RU = (navigator.language || 'ru').toLowerCase().startsWith('ru') || !/^en/.test(navigator.language || '');
const T = RU
  ? {
      sensorsDenied: 'Нет доступа к датчикам. Наклоняй стакан пальцем ↔',
      noSensors: 'Датчиков не видно — наклоняй стакан пальцем или стрелками ←→',
      howTo: 'Поднеси к губам и наклони — пей. Потряси — будет пена.',
      rotateLock: 'Совет: включи блокировку поворота экрана — так реалистичнее',
      again: 'Ещё по одной?',
      emptyHint: 'или встряхни телефон',
      emptyHintPointer: 'или дважды тапни',
      noWebGL: 'Браузер не поддерживает WebGL 2 — открой в свежем Chrome или Safari.',
      glasses: (n) => `🍺 ${n}`,
      soundOn: 'Звук включён',
      soundOff: 'Звук выключен',
      cheers: 'Будем! 🍻',
    }
  : {
      sensorsDenied: 'No motion access. Tilt the glass with your finger ↔',
      noSensors: 'No motion sensors — drag or use ←→ to tilt the glass',
      howTo: 'Bring it to your lips and tilt to drink. Shake for foam.',
      rotateLock: 'Tip: turn on screen rotation lock for the best effect',
      again: 'Another one?',
      emptyHint: 'or shake your phone',
      emptyHintPointer: 'or double-tap',
      noWebGL: 'This browser has no WebGL 2 — please use an up-to-date Chrome or Safari.',
      glasses: (n) => `🍺 ${n}`,
      soundOn: 'Sound on',
      soundOff: 'Sound off',
      cheers: 'Cheers! 🍻',
    };

if (!RU) {
  document.documentElement.lang = 'en';
  document.getElementById('lead').textContent = 'A real pint of beer — right in your phone';
  document.getElementById('btn-start').textContent = 'Pour a beer';
  document.getElementById('tips').innerHTML =
    '<li><b>Tilt</b> — the beer sloshes and stays level</li><li><b>Bring it to your lips</b> and tip it — drink it all</li><li><b>Shake</b> — get a foamy head</li>';
  document.getElementById('fine').textContent = 'On iPhone allow access to “Motion & Orientation”. Sound is on.';
}

// ---------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const app = $('app');
const canvas = $('glass');
const hud = $('hud');
const toastEl = $('toast');
const emptyEl = $('empty');
const startEl = $('start');
const debugEl = $('debug');
const DEBUG = params.has('debug');
if (DEBUG) debugEl.classList.remove('hidden');

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('dbo.' + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('dbo.' + k, JSON.stringify(v));
    } catch (e) {
      /* private mode */
    }
  },
};

let beer = beerById(params.get('beer') || store.get('beer', 'lager'));
const sim = new LiquidSim({ width: 0.064, height: 0.13, beer });
const bubbles = new Bubbles();
const drops = new Droplets();
const sensors = new Sensors();
const audio = new AudioEngine();
audio.enabled = store.get('sound', true);
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  $('fatal').textContent = T.noWebGL;
  $('fatal').classList.remove('hidden');
  startEl.classList.add('hidden');
  console.warn(e);
}

// ---------------------------------------------------------------------------------------
// Layout: the whole app is glued to the physical phone. If the browser auto-rotates to
// landscape we rotate our root back, so the glass never jumps.
const M_PER_CSS_PX = 0.000165; // ≈ physical size of a CSS pixel on phones
let quality = 1;
let devW = 0, devH = 0, angleNow = 0;

function screenAngle() {
  const so = screen.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

function layout() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  angleNow = normalizeScreenAngle(screenAngle());
  const t = deviceLockTransform(angleNow, vw, vh);
  app.style.width = t.width + 'px';
  app.style.height = t.height + 'px';
  app.style.transform = t.transform;
  devW = t.width;
  devH = t.height;
  const mpp = Math.min(M_PER_CSS_PX, 0.16 / devH);
  const basePx = Math.min(devH * 0.055, 48);
  const W = devW * mpp;
  const B = basePx * mpp;
  const H = devH * mpp - B;
  sim.setSize(W, H);
  if (renderer) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
    renderer.resize(Math.max(2, Math.round(devW * dpr)), Math.max(2, Math.round(devH * dpr)), { W, H, B });
  }
}
layout();
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 50));
if (screen.orientation && screen.orientation.addEventListener) {
  screen.orientation.addEventListener('change', () => {
    layout();
    if (started && sensors.mode === 'sensor' && isIOS() && angleNow !== 0 && !store.get('rotTip', false)) {
      store.set('rotTip', true);
      toast(T.rotateLock, 4000);
    }
  });
}

// ---------------------------------------------------------------------------------------
// UI helpers
let toastTimer = 0;
function toast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

let glassesTotal = store.get('glasses', 0);
function renderHud() {
  $('btn-sound').textContent = audio.enabled ? '🔊' : '🔇';
  $('btn-beer').textContent = beer.name[RU ? 'ru' : 'en'];
  $('counter').textContent = glassesTotal > 0 ? T.glasses(glassesTotal) : '';
}
renderHud();

let hudTimer = 0;
function wakeHud() {
  hud.classList.remove('dim');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.add('dim'), 3500);
}

$('btn-sound').addEventListener('click', (e) => {
  e.stopPropagation();
  audio.setEnabled(!audio.enabled);
  store.set('sound', audio.enabled);
  toast(audio.enabled ? T.soundOn : T.soundOff, 1200);
  renderHud();
  wakeHud();
});
$('btn-beer').addEventListener('click', (e) => {
  e.stopPropagation();
  const i = BEERS.indexOf(beer);
  beer = BEERS[(i + 1) % BEERS.length];
  sim.setBeer(beer);
  store.set('beer', beer.id);
  renderHud();
  wakeHud();
  if (sim.fill < 0.3 && !sim.pour.active) refill();
});
$('btn-refill').addEventListener('click', (e) => {
  e.stopPropagation();
  refill();
  wakeHud();
});
$('btn-again').addEventListener('click', (e) => {
  e.stopPropagation();
  refill();
});

function refill() {
  audio.init();
  emptyEl.classList.add('hidden');
  emptyShownAt = 0;
  if (sim.fill > 0.7) return;
  sim.startPour();
}

// double tap → shake in finger mode
let lastTap = 0;
canvas.addEventListener('pointerdown', () => {
  wakeHud();
  const now = performance.now();
  if (now - lastTap < 300 && sensors.mode === 'pointer') sensors.kick(1);
  lastTap = now;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы') sensors.kick(1);
});

// ---------------------------------------------------------------------------------------
// Start
let started = false;
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    /* not critical */
  }
}

function start() {
  if (started) return;
  started = true;
  // Everything that needs the user gesture happens synchronously here; the iOS motion
  // permission prompt goes first.
  const perm = sensors.request();
  audio.init();
  if (!isIOS() && /Android/i.test(navigator.userAgent) && document.documentElement.requestFullscreen && !params.has('nofs')) {
    document.documentElement
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('portrait'))
      .catch(() => {});
  }
  keepAwake();
  startEl.classList.add('leaving');
  setTimeout(() => startEl.classList.add('hidden'), 520);
  hud.classList.remove('hidden');
  wakeHud();
  sensors.enablePointer(canvas);
  sim.startPour();
  perm.then((res) => {
    if (res !== 'granted') {
      sensors.mode = 'pointer';
      toast(T.sensorsDenied, 4500);
      return;
    }
    setTimeout(() => {
      if (sensors.orientationEvents === 0 && sensors.motionEvents === 0) {
        sensors.mode = 'pointer';
        toast(T.noSensors, 4500);
      }
    }, 1500);
  });
}
$('btn-start').addEventListener('click', start);
if (params.has('autostart')) setTimeout(start, 0);

document.addEventListener('visibilitychange', () => {
  perfReset = true;
  if (document.hidden) audio.suspend();
  else {
    audio.resume();
    if (started) keepAwake();
  }
});

// ---------------------------------------------------------------------------------------
// Main loop
let last = performance.now();
let frames = 0;
let fpsAcc = 0, fpsN = 0, fps = 60, slowFrames = 0;
let band = 0;
let emptyShownAt = 0;
let lowSince = 0;
let gulpNext = 0;
let howToShown = store.get('howto', false);
let pourWasActive = false;
let paused = false;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) return;
  if (paused) return;
  measurePerformance(dt);
  tick(Math.min(dt, 0.1), now);
}

// Adaptive resolution, measured on real (unclamped) frame times.
let perfReset = false;
function measurePerformance(realDt) {
  if (perfReset || realDt > 3) {
    // the tab was hidden (or the page was paused): start over
    perfReset = false;
    fpsAcc = 0;
    fpsN = 0;
    return;
  }
  fpsAcc += realDt;
  fpsN++;
  if (fpsAcc < 1) return;
  fps = fpsN / fpsAcc;
  fpsAcc = 0;
  fpsN = 0;
  if (fps < 42 && quality > 0.45 && renderer) {
    slowFrames++;
    if (slowFrames >= 2 || fps < 20) {
      quality = Math.max(0.45, quality * (fps < 20 ? 0.75 : 0.85));
      slowFrames = 0;
      layout();
    }
  } else slowFrames = 0;
}

let sinceRender = 0;
function tick(dt, now, render = true) {
  frames++;
  sinceRender += dt;
  const input = sensors.update(dt);
  // sub-step long frames for the oscillators and the spill integral
  const n = dt > 1 / 45 ? 2 : 1;
  for (let i = 0; i < n; i++) sim.step(dt / n, input);
  bubbles.update(dt, sim, input.acc);
  drops.update(dt, sim);

  // Looking at the surface from above (screen tilted back) shows its top as a band.
  const g = input.g;
  const m = Math.hypot(g.x, g.y);
  const bandTarget = Math.max(-0.01, Math.min(0.018, (0.011 * -g.z) / Math.max(m, 0.15)));
  band += (bandTarget - band) * Math.min(1, dt / 0.12);

  if (renderer && render) {
    renderer.render(sim, bubbles, drops, { band, dt: Math.min(sinceRender, 0.25) });
    sinceRender = 0;
  }

  // ---- sound & haptics
  const fill = sim.fill;
  const fizz = fill > 0.01 ? 0.03 + 0.12 * sim.carb * Math.min(1, fill * 1.5) + Math.min(0.2, bubbles.pops * 0.004) + Math.min(0.15, sim.shake * 0.02) : 0;
  audio.update({ fizz, pour: sim.pour.visible ? Math.min(1, sim.pour.flow / (sim.pour.rate || 1)) : 0, pourFill: fill });
  const drink = sim.outflow;
  if (drink > 0.02) {
    if (now > gulpNext) {
      const intensity = Math.min(1, drink * 3);
      audio.gulp(intensity);
      if (navigator.vibrate && audio.enabled) {
        try {
          navigator.vibrate(14);
        } catch (e) {
          /* ignore */
        }
      }
      gulpNext = now + 330 + Math.random() * 160 + (1 - intensity) * 200;
    }
  } else if (gulpNext < now) gulpNext = now + 120;

  // ---- events
  while (sim.events.length) {
    const ev = sim.events.shift();
    if (ev === 'finished') {
      glassesTotal++;
      store.set('glasses', glassesTotal);
      renderHud();
      if (Math.random() < 0.85) setTimeout(() => audio.burp(), 700);
    }
  }

  if (pourWasActive && !sim.pour.active && !howToShown && started) {
    howToShown = true;
    store.set('howto', true);
    setTimeout(() => toast(T.howTo, 4200), 900);
  }
  pourWasActive = sim.pour.active;

  // ---- empty glass → offer another one
  const isEmpty = started && fill < 0.015 && !sim.pour.active && sim.pour.flow === 0;
  if (isEmpty) {
    if (!lowSince) lowSince = now;
    if (now - lowSince > 1400 && emptyEl.classList.contains('hidden')) {
      $('btn-again').textContent = T.again;
      $('empty-hint').textContent = sensors.mode === 'pointer' ? T.emptyHintPointer : T.emptyHint;
      emptyEl.classList.remove('hidden');
      emptyShownAt = now;
    }
    if (emptyShownAt && now - emptyShownAt > 600 && sim.shake > 4) {
      refill();
      toast(T.cheers, 1500);
    }
  } else {
    lowSince = 0;
    if (!emptyEl.classList.contains('hidden') && fill > 0.03) emptyEl.classList.add('hidden');
  }

  if (DEBUG && frames % 6 === 0) {
    debugEl.textContent =
      `fps ${fps.toFixed(0)}  q ${quality.toFixed(2)}  ${renderer ? renderer.width + 'x' + renderer.height : ''}\n` +
      `mode ${sensors.mode}  perm ${sensors.permission}  sign ${sensors.motionSign ?? '?'}\n` +
      `g ${g.x.toFixed(2)} ${g.y.toFixed(2)} ${g.z.toFixed(2)}  a ${input.acc.x.toFixed(1)} ${input.acc.y.toFixed(1)}\n` +
      `fill ${(fill * 100).toFixed(1)}%  foam ${(sim.foamThickness * 1000).toFixed(1)}mm  carb ${sim.carb.toFixed(2)}\n` +
      `drink ${(drink * 100).toFixed(1)}%/s  bubbles ${bubbles.count}  drops ${drops.n}  angle ${angleNow}`;
  }
}
requestAnimationFrame(frame);

// Hooks for automated tests and curious people.
window.__beer = {
  sim,
  sensors,
  bubbles,
  drops,
  audio,
  get renderer() {
    return renderer;
  },
  get frames() {
    return frames;
  },
  get started() {
    return started;
  },
  get band() {
    return band;
  },
  get quality() {
    return quality;
  },
  layout,
  start,
  refill,
  setPaused(v) {
    paused = v;
  },
  tick,
};
