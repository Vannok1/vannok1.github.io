// GLSL ES 3.00 shaders. All lengths are metres in "glass space": origin at the centre of
// the glass interior, x → right edge of the phone, y → top edge (the rim).
//
// The look follows how beer is shot for adverts: a soft light card behind the glass so
// the beer glows from within, strip-box highlights along the glass edges, a dark bar
// behind, condensation in focus on the glass and the carbonation slightly out of focus.

export const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+17.1; a*=0.5; } return s; }
`;

const COMMON = `
uniform vec2 uSize;      // interior width, height
uniform float uBase;     // thickness of the glass bottom
uniform vec2 uUp;        // unit "up" (opposite to in-plane gravity)
uniform float uLevel;    // beer surface: dot(p,uUp) = uLevel
uniform float uFoamTop;  // top of the foam
uniform float uWaveR;
uniform sampler2D uWave; // surface elevation (mm) along the surface tangent
uniform float uTime;
uniform float uPx;       // metres per pixel
${NOISE}
vec2 toGlass(vec2 uv){ return vec2((uv.x-0.5)*uSize.x, uv.y*(uSize.y+uBase) - uBase - 0.5*uSize.y); }
vec2 toUv(vec2 p){ return vec2(p.x/uSize.x+0.5, (p.y + 0.5*uSize.y + uBase)/(uSize.y+uBase)); }
float waveAt(float s){
  float f = clamp((s + uWaveR)/(2.0*uWaveR), 0.0, 1.0);
  return texture(uWave, vec2((f*255.0+0.5)/256.0, 0.5)).r * 0.001;
}
`;

// Pre-rendered blurred bar background (linear colour), mip-mapped for cheap blur.
export const BG_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
${COMMON}
void main(){
  vec2 p = toGlass(vUv);
  vec2 q = p / (uSize.y+uBase);
  vec3 c = mix(vec3(0.010,0.006,0.003), vec3(0.06,0.03,0.012), smoothstep(-0.55,0.45,q.y));
  c += vec3(0.30,0.15,0.05)*exp(-dot(q-vec2(0.18,0.30),q-vec2(0.18,0.30))*9.0)*0.5;
  c += vec3(0.12,0.08,0.06)*exp(-dot(q-vec2(-0.25,-0.1),q-vec2(-0.25,-0.1))*14.0)*0.35;
  for(int i=0;i<16;i++){
    float fi = float(i);
    vec2 cc = vec2(hash12(vec2(fi,1.3))*0.9-0.45, hash12(vec2(fi,7.1))*1.05-0.45);
    float r = 0.018 + 0.05*hash12(vec2(fi,3.3));
    float k = hash12(vec2(fi,5.9));
    vec3 lc = k < 0.55 ? vec3(1.0,0.55,0.18) : (k < 0.85 ? vec3(1.0,0.74,0.4) : vec3(1.0,0.9,0.75));
    float d = length(q-cc);
    float disc = smoothstep(r, r*0.86, d);
    float ring = smoothstep(r*0.7, r*0.98, d)*disc;
    c += lc*(disc*0.11 + ring*0.06)*(0.25+0.75*hash12(vec2(fi,11.0)));
  }
  c = mix(c, vec3(0.04,0.018,0.007)*(0.8+0.4*vnoise(vec2(q.x*40.0, q.y*3.0))), smoothstep(-0.36,-0.42,q.y));
  o = vec4(c,1.0);
}`;

// Foam lacing / wet-film memory on the glass (ping-pong, low resolution).
export const LACE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
${COMMON}
uniform sampler2D uPrev;
uniform vec2 uDrift;
uniform float uDecayG;
uniform float uHasBeer;
void main(){
  vec2 p = toGlass(vUv);
  float h = dot(p,uUp);
  float s = dot(p, vec2(uUp.y,-uUp.x));
  float eta = waveAt(s);
  float surf = uLevel + eta;
  float ftop = uFoamTop + eta;
  float inBeer = uHasBeer * step(h, surf);
  float inFoam = uHasBeer * step(surf, h) * step(h, ftop) * step(0.0008, uFoamTop-uLevel);
  float g = texture(uPrev, vUv - uDrift).g;
  g = max(g*uDecayG, max(inBeer, inFoam));
  if (p.y < -0.5*uSize.y) g = 0.0;
  o = vec4(0.0, g, 0.0, 1.0);
}`;

// The main scene: background, beer, foam, carbonation, pour stream, glass bottom.
// Outputs display-referred colour (tone-mapped + sRGB) in an RGBA8 target.
export const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
${COMMON}
uniform sampler2D uBg;
uniform sampler2D uLace;
uniform float uHasBeer;
uniform float uSupport;
uniform float uBand;     // >0: we look at the surface from above, <0: from below
uniform vec3 uSigma;
uniform float uHaze;
uniform vec3 uHazeColor;
uniform vec3 uFoamColor;
uniform vec3 uFoamWet;
uniform float uFoamCell;
uniform float uFoamAge;
uniform float uCloud;
uniform float uCloudFront;
uniform float uNitro;
uniform vec4 uPour;      // origin.xy, length, intensity
uniform float uPourW;
uniform float uPourWall;
uniform float uExposure;
uniform vec2 uFizz0;     // accumulated rise of three layers of tiny bubbles
uniform vec2 uFizz1;
uniform vec2 uFizz2;
uniform float uFizzAmt;

// ---------------------------------------------------------------- foam
// A field of polydisperse bubbles pressed against the glass (one per cell). Used for the
// lacing and kept simple.
struct Bub { vec2 off; float d; float d2; float id; };
Bub bubbleField(vec2 q, float drift){
  vec2 n = floor(q), f = fract(q);
  Bub b;
  b.d = 9.0; b.d2 = 9.0; b.off = vec2(0.0); b.id = 0.0;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
    vec2 g = vec2(float(i),float(j));
    vec2 h = hash22(n + g);
    vec2 c = g + 0.15 + 0.7*h + 0.04*vec2(sin(drift + h.x*6.28), cos(drift*0.8 + h.y*6.28));
    float id = hash12(n + g + 3.7);
    float r = 0.44 + 0.3*id;
    vec2 v = (f - c)/r;
    float d = length(v);
    if (d < b.d){ b.d2 = b.d; b.d = d; b.off = v; b.id = id; } else if (d < b.d2) b.d2 = d;
  }
  return b;
}

// Foam against glass is a power (Apollonius) diagram: bubbles of different pressure meet
// along curved films. f1/f2: weighted distance to the nearest / second bubble,
// off: offset from the own centre, rad: its size.
struct Cell { vec2 off; float f1; float f2; float id; float rad; };
Cell foamCells(vec2 q, float drift, float spread){
  vec2 n = floor(q), f = fract(q);
  Cell c;
  c.f1 = 9.0; c.f2 = 9.0; c.off = vec2(0.0); c.id = 0.0; c.rad = 0.5;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
    vec2 g = vec2(float(i),float(j));
    vec2 h = hash22(n + g);
    float id = hash12(n + g + 3.7);
    vec2 ctr = g + 0.5 + 0.62*(h - 0.5) + 0.03*vec2(sin(drift + h.x*6.28), cos(drift*0.7 + h.y*6.28));
    float w = spread*id*id*id;
    vec2 v = f - ctr;
    float d = length(v) - w;
    if (d < c.f1){ c.f2 = c.f1; c.f1 = d; c.off = v; c.id = id; c.rad = 0.5 + w; }
    else if (d < c.f2) c.f2 = d;
  }
  return c;
}

// What one sees of a cell: the bubble's face is a thin film we look through into the
// foam behind (darker, greyer towards the middle), Plateau borders between bubbles are
// liquid and scatter light (bright; golden beer near the bottom of the head), a faint dark
// line where film meets border, and a small glint of the top light on the curved film.
vec3 shadeCells(Cell c, float aa, float bw, vec3 border, vec3 film, vec3 deep){
  float edge = c.f2 - c.f1;
  float bord = 1.0 - smoothstep(bw - aa, bw + aa, edge);
  float rr = clamp(length(c.off)/c.rad, 0.0, 1.0);
  vec3 face = mix(deep, film, smoothstep(0.15, 1.0, rr));
  face *= 0.94 + 0.12*c.id;
  float line = (1.0 - smoothstep(bw, bw + 0.09 + aa, edge))*(1.0 - bord);
  face *= 1.0 - line*0.3;
  vec2 hp = c.off/c.rad - vec2(-0.32, 0.42);
  face += exp(-dot(hp, hp)*45.0)*0.35 + exp(-dot(hp, hp)*7.0)*0.04;
  return mix(face, border, bord);
}

vec4 foamColor(vec2 p, float z, float thick, float topView, vec3 beerTint){
  float fz = clamp(z/max(thick, 0.0005), 0.0, 1.0);
  float age = 1.0 + uFoamAge*0.004;
  vec2 q = p - uUp*uLevel;
  if (topView > 0.5) q = vec2(dot(p, vec2(uUp.y,-uUp.x)), z*0.012/max(uBand, 0.001) + 0.03);
  float wet = topView > 0.5 ? 0.0 : 1.0 - smoothstep(0.0, 0.0065, z);
  float crust = smoothstep(0.72, 1.0, fz)*smoothstep(0.006, 0.014, thick);
  float t = uTime*0.3;
  // colours kept below white so the tone curve keeps the texture
  vec3 cream = uFoamColor*0.72*(0.9 + 0.14*fbm(q*vec2(150.0, 200.0) + 3.0));
  vec3 border = mix(cream*1.04, beerTint*1.05 + uFoamWet*0.12, wet);
  vec3 film = mix(cream*0.86, mix(cream*0.8, beerTint*1.15, 0.45), wet);
  // the foam behind the front bubbles: a fine, soft texture
  float fineCell = uFoamCell*0.55*age;
  float kFine = smoothstep(2.5, 5.0, fineCell/uPx);
  Cell cf = foamCells(q/fineCell + 31.0, t*1.2, 0.4);
  float fineEdge = cf.f2 - cf.f1;
  vec3 deep = cream*0.66*(1.0 + kFine*0.22*(smoothstep(0.0, 0.12, fineEdge) - 0.6));
  deep = mix(deep, beerTint*0.9, wet*0.5);
  // the bubbles touching the glass: bigger at the bottom (wet) and at the top (coarsening)
  // constant spacing; bubble "pressure" spreads the sizes near the beer and on top
  float cell = uFoamCell*1.9*age;
  Cell c = foamCells(q/cell, t, 0.45 + 0.4*wet + 0.3*crust);
  float bw = mix(0.045, 0.24, wet) + 0.02;
  float aa = 1.5*uPx/cell;
  vec3 col = shadeCells(c, aa, bw, border, film, deep);
  // shading of the head as a whole: lit from above, darker towards the glass edges
  float xn = p.x/(0.5*uSize.x);
  col *= mix(0.8, 1.0, smoothstep(1.0, 0.55, abs(xn)));
  col *= topView > 0.5 ? 1.05 : 0.9 + 0.12*fz;
  // a thin head breaks up into single floating bubbles
  float cov = smoothstep(0.0012, 0.0035, thick);
  float inCell = 1.0 - smoothstep(bw - aa, bw + aa, c.f2 - c.f1);
  float present = step(0.78 - 0.78*cov, c.id);
  float alpha = max(cov, present*(1.0 - inCell)*smoothstep(0.95, 0.75, length(c.off)/c.rad));
  return vec4(col, alpha);
}

// Rounded bubble caps along the top edge of the foam.
float foamEdge(float s, float thick){
  float k1 = s/0.0017;
  float i1 = floor(k1), x1 = fract(k1)*2.0 - 1.0;
  float r1 = hash12(vec2(i1, 4.2));
  float d1 = sqrt(max(1.0 - x1*x1, 0.0))*(0.00025 + 0.0006*r1);
  float k2 = s/0.00095 + 0.37;
  float i2 = floor(k2), x2 = fract(k2)*2.0 - 1.0;
  float r2 = hash12(vec2(i2, 9.1));
  float d2 = sqrt(max(1.0 - x2*x2, 0.0))*(0.00015 + 0.00035*r2);
  float big = (vnoise(vec2(s*260.0, 2.0)) - 0.5)*0.0014;
  return (max(d1, d2) + big - 0.0005)*smoothstep(0.0, 0.004, thick);
}

// ---------------------------------------------------------------- beer
vec3 bgAt(vec2 p, float lod){ return textureLod(uBg, toUv(p), lod).rgb; }

vec3 beerColor(vec2 p, float depth, float hRel){
  float xn = p.x/(0.5*uSize.x);
  float cyl = sqrt(max(1.0 - xn*xn*0.88, 0.0));
  // Refraction in a round glass lengthens the light path near the edges → deeper colour.
  float path = 0.075*(0.82 + 0.75*(1.0 - cyl));
  vec3 T = exp(-uSigma*path);
  float vy = p.y/uSize.y;
  // the light card behind the glass: brightest a little above the middle
  vec3 back = vec3(1.0,0.95,0.86)*(1.0 + 0.3*smoothstep(-0.5,0.4,vy))*(0.92 + 0.08*cyl);
  vec3 refr = bgAt(vec2(-p.x*0.5, p.y*0.8+0.01), 3.5);
  vec3 c = (back*0.9 + refr*2.0)*T;
  // Haze (wheat beer): yeast and proteins scatter the light → opaque, creamy gold with
  // slowly drifting clouds of suspended yeast.
  if (uHaze > 0.0){
    float swirl = fbm(p*vec2(55.0, 40.0) + vec2(uTime*0.012, -uTime*0.02));
    vec3 hz = uHazeColor*back*(0.82 + 0.3*swirl)*mix(0.7, 1.0, cyl);
    c = mix(c, hz, uHaze*(1.0 - exp(-path*28.0)));
  }
  c *= mix(0.62, 1.0, smoothstep(0.0, 0.6, cyl));
  c *= 0.84 + 0.16*exp(-depth*9.0);
  // light scattered by the rising bubble streams: faint vertical streaks
  vec2 st = vec2(dot(p, vec2(uUp.y,-uUp.x)), dot(p, uUp));
  c *= 0.95 + 0.1*vnoise(vec2(st.x*170.0, st.y*9.0 - uTime*0.15));
  float front = smoothstep(uCloudFront-0.18, uCloudFront+0.04, hRel);
  float cm = uCloud*front;
  if (cm > 0.001){
    float dir = uNitro > 0.5 ? 1.0 : -1.0;
    float n = fbm(vec2(p.x*700.0, p.y*450.0 + dir*uTime*1.6));
    vec3 cc = uNitro > 0.5 ? uFoamColor*vec3(0.36,0.27,0.19)*(0.75+0.5*n) : c*(1.2 + 0.3*n) + uFoamWet*0.04;
    c = mix(c, cc, clamp(cm*(uNitro > 0.5 ? 1.0 : 0.25), 0.0, 1.0));
  }
  return c;
}

// One layer of tiny carbonation bubbles (at most one per cell, so a single lookup).
// blur: 0 = in focus on the glass, 1 = far behind, soft bokeh.
vec2 fizzLayer(vec2 p, vec2 off, float cell, float density, float blur){
  vec2 q = (p - off)/cell;
  vec2 n = floor(q);
  if (hash12(n + 17.0) > density) return vec2(0.0);
  vec2 c = 0.3 + 0.4*hash22(n + 5.0);
  c.x += 0.08*sin(uTime*3.0 + hash12(n)*6.28);
  float r = 0.07 + 0.11*hash12(n + 9.0);
  float d = length(fract(q) - c)/r;
  float aa = 1.5*uPx/(cell*r) + blur*0.9;
  float disk = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float ring = smoothstep(0.45, 0.95, d)*disk*(1.0 - blur);
  float core = (1.0 - smoothstep(0.0, 0.7, d))*disk;
  // x: added light, y: darkening (total internal reflection at the rim)
  return vec2(core*(0.55 - 0.3*blur) + disk*0.12, ring*0.55);
}

vec3 addFizz(vec3 c, vec2 p, float depth){
  if (uFizzAmt <= 0.0) return c;
  vec2 a = fizzLayer(p, uFizz0, 0.0013, 0.22*uFizzAmt, 0.0)
         + fizzLayer(p, uFizz1, 0.0008, 0.3*uFizzAmt, 0.45)*0.8
         + fizzLayer(p, uFizz2, 0.00052, 0.4*uFizzAmt, 0.85)*0.55;
  // bubbles that just left the bottom are tiny; fade them in with height
  float k = smoothstep(0.0, 0.01, depth);
  return c*(1.0 - a.y*k) + (c*1.6 + 0.03)*a.x*k;
}

bool gBase = false;
vec3 airColor(vec2 p){
  vec2 uv = toUv(p);
  vec3 c = textureLod(uBg, uv, 0.0).rgb;
  if (gBase) return c;
  vec4 lace = texture(uLace, uv);
  c = mix(c, c*1.1 + uFoamWet*0.02, lace.g*0.5);
  return c;
}

vec3 interior(vec2 p){
  if (uHasBeer < 0.5) return airColor(p);
  float h = dot(p,uUp);
  float s = dot(p, vec2(uUp.y,-uUp.x));
  float eta = waveAt(s);
  float surf = uLevel + eta;
  float thick = max(uFoamTop - uLevel, 0.0);
  float px = uPx;
  float ftop = uFoamTop + eta + foamEdge(s, thick);
  float cover = smoothstep(0.0012, 0.0035, thick);
  vec3 col;
  if (h < surf - 2.0*px){
    float hRel = clamp((h + uSupport)/max(surf + uSupport, 1e-4), 0.0, 1.0);
    col = beerColor(p, surf - h, hRel);
    col += uFoamWet*0.07*exp(-(surf - h)/0.004)*cover;
    col = addFizz(col, p, h + uSupport);
  } else {
    bool needAir = h > ftop - 2.0*px || thick < 0.0036;
    col = needAir ? airColor(p) : uFoamColor;
    vec3 tint = beerColor(p, 0.004, 1.0);
    if (uBand > 0.0 && h > ftop - px && h < ftop + uBand + px){
      float a = smoothstep(ftop + uBand + px, ftop + uBand - px, h);
      float tt = clamp((h - ftop)/uBand, 0.0, 1.0);
      vec3 top = foamColor(p, h - ftop, uBand, 1.0, tint).rgb*(0.86 + 0.18*tt);
      vec3 bare = tint*0.5 + 0.05;
      col = mix(col, mix(bare, top, cover), a);
    }
    float aFoam = smoothstep(ftop + px, ftop - px, h);
    if (aFoam > 0.0){
      vec4 fc = foamColor(p, h - surf, thick, 0.0, tint);
      col = mix(col, fc.rgb, aFoam*fc.a);
    }
    float aBeer = smoothstep(surf + px*0.8, surf - px*0.8, h);
    if (aBeer > 0.0){
      float hRel = clamp((h + uSupport)/max(surf + uSupport, 1e-4), 0.0, 1.0);
      vec3 bc = beerColor(p, surf - h, hRel) + uFoamWet*0.07*cover;
      float dl = (surf - h)/(px*1.3 + 0.0002);
      bc += vec3(1.0,0.92,0.75)*0.35*exp(-dl*dl)*(1.0 - cover*0.7);
      col = mix(col, bc, aBeer);
    }
  }
  if (uBand < 0.0 && h < surf && h > surf + uBand - px){
    float m = smoothstep(surf + uBand - px, surf + uBand + px, h);
    col = mix(col, mix(col*1.6 + 0.04, uFoamWet*0.95, cover*0.7), m*0.85);
  }

  // Pouring stream + bubbly plume where it plunges into the beer.
  if (uPour.w > 0.0){
    vec2 d = -uUp;
    vec2 rel = p - uPour.xy;
    float t = dot(rel, d);
    float perp = dot(rel, vec2(d.y,-d.x));
    float w = uPourW/pow(1.0 + max(t,0.0)*30.0, 0.25);
    perp += sin(t*240.0 - uTime*38.0)*0.00022*smoothstep(0.0,0.04,t) + (vnoise(vec2(t*260.0 - uTime*22.0, 0.5))-0.5)*0.0007;
    float len = uPour.z;
    float inS = smoothstep(w + px, w - px, abs(perp))*step(0.0, t)*smoothstep(len + px*2.0, len - px*2.0, t);
    if (inS > 0.0){
      float xr = clamp(perp/w, -1.0, 1.0);
      float th = 2.0*w*sqrt(max(1.0 - xr*xr, 0.0));
      vec3 Ts = exp(-uSigma*(0.034 + th*4.0));
      vec3 sc = vec3(1.0,0.95,0.85)*1.3*Ts*(0.55 + 0.45*sqrt(1.0 - xr*xr));
      sc += 0.28*exp(-pow((xr+0.5)/0.13, 2.0)) + 0.1*exp(-pow((xr-0.72)/0.08, 2.0));
      sc = mix(sc, sc*1.2 + 0.03, 0.45*vnoise(vec2(perp*2600.0, t*160.0 - uTime*70.0)));
      col = mix(col, sc, inS);
    }
    if (uPourWall < 0.5){
      float tb = t - len;
      float wdt = 0.0035 + max(tb,0.0)*0.3;
      float plume = exp(-perp*perp/(wdt*wdt))*smoothstep(0.0, 0.002, tb)*exp(-tb/0.028)*uPour.w;
      float n = vnoise(vec2(perp*1800.0, tb*700.0 - uTime*28.0));
      col = mix(col, uFoamColor*0.96, clamp(plume*(0.55 + 0.45*n), 0.0, 0.9)*step(h, surf));
    }
  }
  return col;
}

vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }

void main(){
  vec2 p = toGlass(vUv);
  float bottom = -0.5*uSize.y;
  vec3 col;
  if (p.y < bottom){
    // Thick glass bottom: a blurred, tinted view of whatever sits on it.
    float t = clamp((bottom - p.y)/uBase, 0.0, 1.0);
    vec2 pm = vec2(p.x*0.9, bottom + 0.002 + t*0.004);
    float hb = dot(pm, uUp) - (uLevel + waveAt(dot(pm, vec2(uUp.y,-uUp.x))));
    float inB = uHasBeer*smoothstep(0.002, -0.002, hb);
    gBase = true;
    col = mix(textureLod(uBg, toUv(pm), 4.0).rgb*1.3, beerColor(pm, 0.01, 0.0), inB);
    col *= mix(vec3(0.85,0.93,0.89), vec3(0.42,0.5,0.47), t);
    float xn = p.x/(0.5*uSize.x);
    col += vec3(0.9,1.0,0.95)*(0.16*exp(-pow(t/0.05,2.0)) + 0.07*exp(-pow((t-0.95)/0.05,2.0)));
    col += 0.07*exp(-pow((xn+0.6)/0.08,2.0))*(1.0-t);
  } else {
    col = interior(p);
  }
  col = aces(col*uExposure);
  col = pow(col, vec3(1.0/2.2));
  o = vec4(col, 1.0);
}`;

// Carbonation bubbles: instanced quads stretched along their velocity (motion blur),
// blurred by depth (the camera focuses on the glass), backlit look: bright core and a
// dark rim from total internal reflection.
export const BUBBLE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aB;   // x, y, r (m), alpha
layout(location=2) in vec4 aV;   // vx, vy (m/s), depth 0..1, seed
uniform vec2 uSize;
uniform float uBase;
uniform float uPxPerM;
uniform float uShutter;
out vec2 vLocal;
out float vLenPx;
out float vRadPx;
out float vBlur;
out float vA;
out float vSeed;
void main(){
  float rv = 0.00006 + aB.z*1.3;
  float blurM = abs(aV.z - 0.12)*0.00055;
  vec2 vel = aV.xy;
  float speed = length(vel);
  vec2 dir = speed > 1e-5 ? vel/speed : vec2(0.0, 1.0);
  float len = speed*uShutter;
  float halfW = rv + blurM + 1.5/uPxPerM;
  float halfL = halfW + len*0.5;
  vec2 side = vec2(dir.y, -dir.x);
  vec2 center = aB.xy - vel*uShutter*0.5;
  vec2 pos = center + dir*(aCorner.y*halfL) + side*(aCorner.x*halfW);
  vec2 uv = vec2(pos.x/uSize.x + 0.5, (pos.y + 0.5*uSize.y + uBase)/(uSize.y + uBase));
  gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);
  vLocal = vec2(aCorner.x*halfW, aCorner.y*halfL)*uPxPerM;
  vLenPx = len*0.5*uPxPerM;
  vRadPx = max(rv*uPxPerM, 0.5);
  vBlur = blurM*uPxPerM + 0.7;
  vA = aB.w;
  vSeed = aV.w;
}`;

export const BUBBLE_FS = `#version 300 es
precision mediump float;
in vec2 vLocal;
in float vLenPx;
in float vRadPx;
in float vBlur;
in float vA;
in float vSeed;
out vec4 o;
uniform vec3 uTint;
void main(){
  vec2 q = vec2(vLocal.x, max(abs(vLocal.y) - vLenPx, 0.0));
  float d = length(q)/vRadPx;
  float b = vBlur/vRadPx;
  float disk = 1.0 - smoothstep(1.0 - b, 1.0 + b, d);
  if (disk <= 0.001) discard;
  float streak = vLenPx/(vLenPx + vRadPx);
  float sharp = clamp(1.0 - b*0.9, 0.0, 1.0)*(1.0 - streak*0.7);
  float ring = smoothstep(0.5, 0.92, d)*disk;
  float core = 1.0 - smoothstep(0.0, 0.7, d);
  vec2 hp = vec2(vLocal.x, vLocal.y)/vRadPx - vec2(-0.32, 0.36);
  float hl = exp(-dot(hp, hp)*12.0)*sharp;
  // big out-of-focus bubbles turn into faint bokeh discs
  float energy = 1.0/(1.0 + b*b*2.0);
  vec3 add = uTint*(core*0.3 + 0.1)*disk*energy + vec3(1.0)*hl*0.7;
  float dark = ring*0.55*sharp + disk*0.06*energy;
  o = vec4(add*vA, dark*vA);
}`;

// Condensation droplets into a normal map: rg = normal, b = height, a = radius.
export const DROP_VS = `#version 300 es
layout(location=0) in vec4 aD;   // x, y, r (m), aspect
layout(location=1) in float aSeed;
uniform vec2 uSize;
uniform float uBase;
uniform float uPxPerM;
uniform float uMaxPoint;
uniform float uScale;
out float vPx;
out float vAsp;
out float vSeed;
void main(){
  vec2 uv = vec2(aD.x/uSize.x + 0.5, (aD.y + 0.5*uSize.y + uBase)/(uSize.y + uBase));
  gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);
  vPx = aD.z*uPxPerM*uScale;
  vAsp = aD.w;
  vSeed = aSeed;
  gl_PointSize = min(uMaxPoint, max(1.0, 2.2*vPx*aD.w + 1.0));
}`;

export const DROP_FS = `#version 300 es
precision mediump float;
in float vPx;
in float vAsp;
in float vSeed;
out vec4 o;
void main(){
  vec2 c = gl_PointCoord*2.0 - 1.0;
  c *= 1.1;
  c.y = -c.y;
  c.x *= vAsp;
  c.y += 0.12*(vAsp - 1.0);
  // real drops are never perfect circles
  float a = atan(c.y, c.x);
  float wob = 1.0 + 0.07*sin(3.0*a + vSeed*6.28) + 0.04*sin(5.0*a + vSeed*17.0) + 0.03*sin(2.0*a + vSeed*9.0);
  float d = length(c)/wob;
  if (d > 1.0) discard;
  float h = sqrt(1.0 - d*d);
  o = vec4((c/wob)*0.5 + 0.5, h, clamp(vPx/48.0, 0.0, 1.0));
}`;

// Trails: running drops wipe the fine mist off the glass; it slowly fogs up again.
export const TRAIL_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev;
uniform float uDecay;
void main(){ o = vec4(texture(uPrev, vUv).r*uDecay, 0.0, 0.0, 1.0); }`;

export const TRAIL_POINT_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main(){
  vec2 c = gl_PointCoord*2.0 - 1.0;
  float d = length(c);
  if (d > 1.0) discard;
  o = vec4(1.0 - smoothstep(0.7, 1.0, d), 0.0, 0.0, 1.0);
}`;

// Bloom: bright parts of the frame glow like in a real camera lens.
export const BRIGHT_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main(){
  vec3 c = texture(uSrc, vUv + uTexel*vec2(-1.0,-1.0)).rgb + texture(uSrc, vUv + uTexel*vec2(1.0,-1.0)).rgb
         + texture(uSrc, vUv + uTexel*vec2(-1.0,1.0)).rgb + texture(uSrc, vUv + uTexel*vec2(1.0,1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c*smoothstep(0.86, 1.0, l), 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uDir;
void main(){
  vec3 c = texture(uSrc, vUv).rgb*0.227;
  c += (texture(uSrc, vUv + uDir*1.385).rgb + texture(uSrc, vUv - uDir*1.385).rgb)*0.316;
  c += (texture(uSrc, vUv + uDir*3.23).rgb + texture(uSrc, vUv - uDir*3.23).rgb)*0.07;
  o = vec4(c, 1.0);
}`;

// Final composite: droplets and fine mist on the glass (tiny lenses), glass reflections,
// rim, lens glow, a touch of chromatic aberration, vignette and film grain.
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene;
uniform sampler2D uDrops;
uniform sampler2D uTrail;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec3 uGlass;     // W, H, B (m)
uniform vec2 uUp;
uniform float uLevel;
uniform float uFog;
uniform float uTime;
uniform float uBloomK;
${NOISE}

// fine condensation: one droplet per cell at most
vec4 mist(vec2 pm, float cell, float density, float seed, float mpx){
  vec2 q = pm/cell;
  vec2 n = floor(q);
  if (hash12(n + seed) > density) return vec4(0.0);
  vec2 c = 0.3 + 0.4*hash22(n + seed + 3.1);
  float r = 0.13 + 0.2*hash12(n + seed + 7.7)*hash12(n + seed + 2.9);
  vec2 v = (fract(q) - c)/r;
  float d = length(v);
  float aa = 1.4/(mpx*r*cell) + 0.05;
  float m = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  return vec4(v, m, r*cell);
}

void main(){
  vec2 uv = vUv;
  float Ht = uGlass.y + uGlass.z;
  vec2 pm = vec2((uv.x - 0.5)*uGlass.x, uv.y*Ht);
  vec2 pc = vec2(pm.x, pm.y - uGlass.z - 0.5*uGlass.y);
  vec4 d = texture(uDrops, uv);
  vec2 n = vec2(0.0);
  float hgt = 0.0, rpx = 0.0, drop = 0.0;
  if (d.b > 0.003){
    n = (d.rg - 0.5)*2.0;
    hgt = d.b;
    rpx = d.a*48.0;
    drop = 1.0;
  } else {
    // fine mist: colder (denser) where the beer is
    float cold = mix(0.45, 1.0, smoothstep(0.004, -0.004, dot(pc, uUp) - uLevel));
    float fog = uFog*cold*(1.0 - texture(uTrail, uv).r);
    if (fog > 0.02 && pm.y > uGlass.z){
      float mpx = uRes.x/uGlass.x;
      vec4 m1 = mist(pm, 0.0009, 0.55*fog, 1.0, mpx);
      vec4 m2 = mist(pm + 0.00021, 0.00052, 0.7*fog, 5.0, mpx);
      vec4 m = m1.z > 0.0 ? m1 : m2;
      if (m.z > 0.0){
        n = m.xy*m.z;
        hgt = sqrt(max(1.0 - dot(m.xy, m.xy), 0.0))*m.z;
        rpx = m.w*mpx;
        drop = m.z*0.85;
      }
    }
  }
  vec2 off = -n*rpx*0.85/uRes;
  vec2 ca = (uv - 0.5)*0.0009;
  vec3 col;
  col.r = texture(uScene, uv + off + ca).r;
  col.g = texture(uScene, uv + off).g;
  col.b = texture(uScene, uv + off - ca).b;
  if (drop > 0.0){
    float dd = length(n);
    col *= 1.0 + 0.1*drop;
    float rim = smoothstep(0.55, 1.0, dd);
    col *= 1.0 - rim*(0.32 + 0.3*clamp(-n.y - n.x*0.3, 0.0, 1.0))*drop;
    col += vec3(1.0,0.95,0.82)*0.3*smoothstep(0.45, 0.82, dd)*smoothstep(0.2, 0.85, -n.y)*(1.0 - smoothstep(0.86, 1.0, dd))*drop;
    vec3 N = normalize(vec3(n*1.35, hgt + 0.22));
    vec3 L = normalize(vec3(-0.42, 0.62, 0.66));
    float nl = max(dot(N, L), 0.0);
    col += (pow(nl, 70.0)*1.1 + pow(nl, 9.0)*0.07)*drop;
  }
  col += texture(uBloom, uv).rgb*uBloomK;

  // reflections on a cylindrical glass: two strip boxes and soft bounce cards
  float xn = uv.x*2.0 - 1.0;
  float yv = uv.y;
  float vfade = smoothstep(0.02, 0.3, yv)*(0.8 + 0.2*smoothstep(1.0, 0.7, yv));
  float bend = 0.012*sin(yv*3.14);
  vec3 hl = vec3(0.0);
  hl += vec3(1.0,0.98,0.95)*0.16*smoothstep(0.035, 0.0, abs(xn + 0.78 + bend));
  hl += 0.05*exp(-pow((xn + 0.62)/0.1, 2.0));
  hl += vec3(1.0,0.97,0.92)*0.11*smoothstep(0.025, 0.0, abs(xn - 0.85 - bend));
  hl += 0.03*exp(-pow((xn - 0.6)/0.12, 2.0));
  col += hl*vfade;
  // glass wall seen edge-on: a dark refraction band and a bright inner line
  float e = min(uv.x, 1.0 - uv.x)*uRes.x;
  float ew = uRes.x*0.018;
  col *= 0.62 + 0.38*smoothstep(0.0, ew, e);
  col += 0.1*exp(-abs(e - ew*0.9)/1.2);
  // the rim at the top edge
  float top = (1.0 - uv.y)*uRes.y;
  col += 0.22*exp(-top/1.6) + 0.06*exp(-top/6.0);
  // lens: vignette and grain
  vec2 q = uv - 0.5;
  col *= 1.0 - 0.25*dot(q*vec2(1.3,1.0), q*vec2(1.3,1.0));
  float g = hash12(gl_FragCoord.xy + fract(uTime*7.3)*311.0) - 0.5;
  col += g*0.022*(1.0 - 0.6*dot(col, vec3(0.33)));
  o = vec4(col, 1.0);
}`;
