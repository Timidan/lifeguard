import { useEffect, useRef } from 'react';
import { num, rescue } from './App';

// A life ring floating over a waterline, drawn as a point cloud (technique after builder-desk/public/hero.js).
// The waterline is liquidation. The ring's height above it follows the health factor in evidence.json:
// it sits low at rescue.before, is lifted to rescue.after, and bobs and tilts on the water between.

const TAU = Math.PI * 2;
const R = 1; // ring radius, centre line of the tube
const TUBE = 0.3;
const SQUASH = 0.8; // the tube is a little flatter than round
const HALF = TUBE * SQUASH;
const WZ = 1.15; // half depth of the water; the waterline is its near edge
const PITCH = 0.42; // camera looks down at the water
const DEPTH = 0.08;
const LIFT = 0.6; // ring height per unit of health factor above 1
const BANDS = Array.from({ length: 4 }, (_, k) => Math.PI / 4 + (k * Math.PI) / 2);
const BAND_HW = 0.15;
const RESCUE_AT = 2.4, RESCUE_TAKES = 2.8; // seconds: the ring waits at rescue.before, then is lifted
const heightFor = (hf: number) => HALF + (hf - 1) * LIFT;

let seed = 524287;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
// Low-discrepancy pair (the R2 sequence): spreads points evenly, where random ones clump into static.
const fract = (x: number) => x - Math.floor(x);
// n is the point count; the jitter, about half a point spacing, keeps the lattice from showing.
const r2 = (i: number, n: number): [number, number] => {
  const j = 0.9 / Math.sqrt(n);
  return [fract(0.5 + 0.7548776662466927 * i + (rnd() - 0.5) * j), fract(0.5 + 0.5698402909980532 * i + (rnd() - 0.5) * j)];
};
// Tube angle for a share u of the ring's surface: area grows with R + TUBE cos(phi), so solve phi + k sin(phi) = 2 pi u.
const tubeAngle = (u: number) => {
  let ph = TAU * u;
  for (let i = 0; i < 6; i++) ph -= (ph + (TUBE / R) * Math.sin(ph) - TAU * u) / (1 + (TUBE / R) * Math.cos(ph));
  return ph;
};
const smoother = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

/** 0 while the loan is at rescue.before, 1 once the rescue has lifted it to rescue.after. */
const phaseAt = (t: number) => smoother(Math.min(1, Math.max(0, (t - RESCUE_AT) / RESCUE_TAKES)));

/** Each point: position(3), normal(3), meta(2) = kind, grain. Kinds: 0 body, 1 band, 2 rope, 3 water, 4 waterline. */
function build(k: number) {
  seed = 524287;
  const nBody = Math.round(34000 * k), nBand = Math.round(3000 * k), nRope = Math.round(1300 * k);
  const nWater = Math.round(14000 * k), nLine = 900;
  const ring = nBody + 4 * nBand + 4 * nRope;
  const data = new Float32Array((ring + nWater + nLine) * 8);
  let o = 0;
  const put = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, kind: number) => {
    const len = Math.hypot(nx, ny, nz) || 1;
    data.set([px, py, pz, nx / len, ny / len, nz / len, kind, rnd()], o);
    o += 8;
  };

  for (let i = 0; i < nBody; i++) {
    const [x, y] = r2(i, nBody), th = x * TAU, ph = tubeAngle(y);
    const rad = R + TUBE * Math.cos(ph);
    put(rad * Math.cos(th), HALF * Math.sin(ph), rad * Math.sin(th), Math.cos(ph) * Math.cos(th), Math.sin(ph) / SQUASH, Math.cos(ph) * Math.sin(th), 0);
  }
  // Four rope-wound bands: three strands wind round the tube while moving along it.
  for (const at of BANDS) {
    for (let i = 0; i < nBand; i++) {
      const t = r2(i, nBand)[0], th = at - BAND_HW + 2 * BAND_HW * t;
      const ph = TAU * (3 * t + (i % 3) / 3) + (rnd() - 0.5) * 0.06;
      const rad = R + TUBE * 1.09 * Math.cos(ph);
      put(rad * Math.cos(th), HALF * 1.09 * Math.sin(ph), rad * Math.sin(th), Math.cos(ph) * Math.cos(th), Math.sin(ph) / SQUASH, Math.cos(ph) * Math.sin(th), 1);
    }
  }
  // The grab line: a twisted rope hanging in a loop between each pair of bands.
  for (const at of BANDS) {
    for (let i = 0; i < nRope; i++) {
      const s = rnd(), th = at + BAND_HW + s * (Math.PI / 2 - 2 * BAND_HW);
      const a = s * TAU * 26 + (rnd() < 0.5 ? 0 : Math.PI);
      const rad = R + TUBE * 1.12 + 0.12 * Math.sin(Math.PI * s) + 0.016 * Math.cos(a);
      put(rad * Math.cos(th), -0.13 * Math.sin(Math.PI * s) + 0.016 * Math.sin(a), rad * Math.sin(th), Math.cos(a) * Math.cos(th), Math.sin(a), Math.cos(a) * Math.sin(th), 2);
    }
  }
  for (let i = 0; i < nWater; i++) { const [x, z] = r2(i, nWater); put(x, 0, (z * 2 - 1) * WZ, 0, 1, 0, 3); }
  for (let i = 0; i < nLine; i++) put((i + rnd()) / nLine, 0, WZ, 0, 1, 0, 4);
  return { data, ring, total: ring + nWater + nLine };
}

const vertex = `
attribute vec3 aPos, aNormal;
attribute vec2 aMeta;
uniform float uTime, uPitch, uDepth, uScale, uSize, uHeight, uPhase, uMode;
uniform vec2 uCentre, uRes, uTilt, uWaterX;
uniform vec3 uBody, uShade, uBand, uRope, uWater, uLine;
varying vec4 vColor;
const float WZ = ${WZ.toFixed(2)};

vec3 tilt(vec3 v) {
  float cx = cos(uTilt.x), sx = sin(uTilt.x), cz = cos(uTilt.y), sz = sin(uTilt.y);
  v = vec3(v.x, cx * v.y - sx * v.z, sx * v.y + cx * v.z);
  return vec3(cz * v.x - sz * v.y, sz * v.x + cz * v.y, v.z);
}

void main() {
  float kind = aMeta.x, grain = aMeta.y;
  vec3 p, n;
  float edge = 1.0;
  if (uMode < 1.5) {
    p = tilt(aPos) + vec3(0.0, uHeight, 0.0);
    n = tilt(aNormal);
    if (uMode > 0.5) { p.y = -p.y; n.y = -n.y; p.x += 0.025 * sin(p.y * 11.0 + uTime * 1.3); }
  } else {
    float z = aPos.z;
    float u = kind > 3.5 ? aPos.x : fract(aPos.x + uTime * (0.006 + 0.006 * (z + WZ) / (2.0 * WZ)));
    float x = mix(uWaterX.x, uWaterX.y, u), d = length(vec2(x, z)), y = 0.0;
    if (kind < 3.5) {
      y = 0.016 * sin(x * 2.3 + uTime * 0.8 + z * 1.7) + 0.01 * sin(x * 5.1 - uTime * 1.2 + z * 3.3)
        + (0.012 + 0.03 * (1.0 - uPhase)) * sin(d * 8.0 - uTime * 2.0) * exp(-d * 0.7);
    }
    p = vec3(x, y, z);
    n = vec3(0.0, 1.0, 0.0);
    edge = smoothstep(0.0, 0.14, u) * smoothstep(1.0, 0.86, u);
  }
  float cb = cos(uPitch), sb = sin(uPitch);
  vec3 q = vec3(p.x, cb * p.y - sb * p.z, sb * p.y + cb * p.z);
  vec3 m = vec3(n.x, cb * n.y - sb * n.z, sb * n.y + cb * n.z);
  float depth = 1.0 / (1.0 - q.z * uDepth);
  gl_Position = vec4((uCentre + uScale * q.xy * depth) / uRes * 2.0 - 1.0, -q.z * 0.25, 1.0);

  float lit = 0.12 + 0.88 * pow(max(dot(m, normalize(vec3(-0.45, 0.8, 0.5))), 0.0), 1.2);
  vec3 c;
  float a = 1.0, size = 1.8;
  if (uMode > 1.5) {
    if (kind > 3.5) { c = uLine; a = 0.75 * edge; size = 1.6; }
    else { c = mix(uWater * 0.55, uWater, grain); a = 0.55 * edge * mix(0.08, 1.0, (aPos.z + WZ) / (2.0 * WZ)); size = 1.5; }
  } else {
    if (kind < 0.5) c = mix(uShade, uBody, lit);
    else if (kind < 1.5) { c = uBand * (0.4 + 0.75 * lit); size = 2.1; }
    else c = uRope * (0.45 + 0.65 * lit);
    c *= 0.22 + 0.78 * smoothstep(-0.5, 0.25, m.z);
    c += (grain - 0.5) * 0.06;
    if (uMode > 0.5) { c *= 0.8; a = 0.2 * (1.0 - smoothstep(0.0, 2.0, -p.y)); }
  }
  gl_PointSize = uSize * depth * size;
  vColor = vec4(c, a);
}`;

const fragment = `
precision mediump float;
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = vColor.a * smoothstep(0.5, 0.3, d);
  gl_FragColor = vec4(vColor.rgb * a, a);
}`;

function token(name: string): [number, number, number] {
  const n = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name).trim().slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
  return shader;
}

export function LifeRing() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const stage = stageRef.current!, canvas = canvasRef.current!;
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
    if (!gl) { stage.hidden = true; return; }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const row = (at: string) => stage.querySelector<HTMLElement>(`[data-at="${at}"]`)!;
    const axis = row('axis'), high = row('high'), low = row('low'), line = row('line');
    const hLow = heightFor(rescue.before), hHigh = heightFor(rescue.after);

    const program = gl.createProgram()!;
    const buffer = gl.createBuffer()!;
    try {
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      gl.useProgram(program);
    } catch (e) {
      console.error(e);
      stage.hidden = true;
      return;
    }

    const { data, ring, total } = build(innerWidth < 720 ? 0.55 : 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    ['aPos', 'aNormal', 'aMeta'].forEach((name, i) => {
      const at = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, i < 2 ? 3 : 2, gl.FLOAT, false, 32, i * 12);
    });
    const u = (n: string) => gl.getUniformLocation(program, n);
    const colours: [string, string][] = [['uBody', '--foreground'], ['uShade', '--faint'], ['uBand', '--safe'], ['uRope', '--ink-2'], ['uWater', '--muted-foreground'], ['uLine', '--ink-2']];
    colours.forEach(([name, tokenName]) => gl.uniform3fv(u(name), token(tokenName)));
    gl.uniform1f(u('uPitch'), PITCH);
    gl.uniform1f(u('uDepth'), DEPTH);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);

    // Same camera as the vertex shader, so the HTML labels sit where the ring is. CSS pixels from the stage's top left.
    let cx = 0, y0 = 0, scale = 1;
    const project = (x: number, y: number, z: number) => {
      const cb = Math.cos(PITCH), sb = Math.sin(PITCH);
      const qy = cb * y - sb * z, d = 1 / (1 - (sb * y + cb * z) * DEPTH);
      return [cx + scale * x * d, y0 - scale * qy * d];
    };

    const layout = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = stage.clientWidth, H = stage.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      scale = Math.min(0.225 * W, H / 3.4);
      cx = 0.36 * W;
      y0 = 0.55 * H;
      gl.uniform2f(u('uRes'), canvas.width, canvas.height);
      gl.uniform2f(u('uCentre'), cx * dpr, (H - y0) * dpr);
      gl.uniform1f(u('uScale'), scale * dpr);
      gl.uniform1f(u('uSize'), dpr);
      gl.uniform2f(u('uWaterX'), -(cx / scale) * 1.12 - 0.1, ((W - cx) / scale) * 1.12 + 0.1);

      const yHigh = project(0, hHigh, 0)[1], yLow = project(0, hLow, 0)[1], yLine = project(0, 0, WZ)[1];
      const left = cx + scale * 1.75;
      Object.assign(axis.style, { left: `${left}px`, top: `${yHigh}px`, height: `${yLine - yHigh}px`, width: `${W - left}px`, visibility: 'visible' });
      high.style.top = '0px';
      low.style.top = `${yLow - yHigh}px`;
      line.style.top = `${yLine - yHigh}px`;
    };

    let showing = '';
    const draw = (t: number) => {
      const phase = still ? 1 : phaseAt(t);
      const hf = rescue.before + (rescue.after - rescue.before) * phase;
      const bob = still ? 0 : 0.03 * Math.sin(t * 1.1);
      gl.uniform1f(u('uTime'), t);
      gl.uniform1f(u('uPhase'), phase);
      gl.uniform1f(u('uHeight'), heightFor(hf) + bob);
      gl.uniform2f(u('uTilt'), still ? 0.03 : 0.045 * Math.sin(t * 0.7), still ? -0.04 : 0.06 * Math.sin(t * 0.53 + 1));
      const now = still ? 'both' : phase > 0.5 ? 'after' : 'before';
      if (now !== showing) {
        showing = now;
        high.style.opacity = now === 'before' ? '0.4' : '1';
        low.style.opacity = now === 'after' ? '0.4' : '1';
      }
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.uniform1f(u('uMode'), 2);
      gl.drawArrays(gl.POINTS, ring, total - ring);
      gl.uniform1f(u('uMode'), 1);
      gl.drawArrays(gl.POINTS, 0, ring);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.uniform1f(u('uMode'), 0);
      gl.drawArrays(gl.POINTS, 0, ring);
    };

    const t0 = performance.now();
    let frame = 0;
    const loop = (ms: number) => {
      draw((ms - t0) / 1000);
      frame = requestAnimationFrame(loop);
    };
    const resize = new ResizeObserver(() => { layout(); if (still) draw(0); });
    resize.observe(stage);
    layout();
    if (still) draw(0);
    const watch = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(frame);
      if (entry.isIntersecting && !still) frame = requestAnimationFrame(loop);
    });
    watch.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      resize.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  const tick = <span aria-hidden className="h-px w-3 shrink-0 bg-input" />;
  const rowCls = 'absolute left-0 flex -translate-y-1/2 items-center gap-2.5 transition-opacity duration-500';
  return (
    <div ref={stageRef} aria-hidden className="relative aspect-[7/6] w-full lg:aspect-[6/5]">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <div data-at="axis" className="absolute border-l border-input" style={{ visibility: 'hidden' }}>
        <div data-at="high" className={rowCls}>{tick}<span><span className="tnum block font-mono text-[1.125rem] leading-none text-safe">{num(rescue.after, 3)}</span><span className="mt-1 block text-[0.75rem] leading-none text-muted-foreground">After</span></span></div>
        <div data-at="low" className={rowCls}>{tick}<span><span className="tnum block font-mono text-[1.125rem] leading-none text-foreground">{num(rescue.before, 3)}</span><span className="mt-1 block text-[0.75rem] leading-none text-muted-foreground">Before</span></span></div>
        <div data-at="line" className="absolute left-3 -translate-y-[calc(100%+4px)] text-[0.75rem] leading-none text-ink-2">Liquidation</div>
      </div>
    </div>
  );
}
