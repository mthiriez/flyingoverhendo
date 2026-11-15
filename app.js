import * as THREE from './vendor/three.module.min.js';

/* =====================  FLYING OVER HENDO  ===================== 
   Real terrain: USGS National Map aerial imagery + Terrarium elevation tiles.
   Everything loads in the browser: no server, no API key. */

const UI = {
  start: document.getElementById('start'),
  status: document.getElementById('status'),
  bar: document.getElementById('bar').firstElementChild,
  go: document.getElementById('go'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  resume: document.getElementById('resume'),
  pause: document.getElementById('pause'),
  place: document.getElementById('place'),
  placeCity: document.getElementById('placeCity'),
  placeStreet: document.getElementById('placeStreet'),
  throttle: document.getElementById('throttle'),
  thrTrack: document.getElementById('thrTrack'),
  thrFill: document.getElementById('thrFill'),
  thrKnob: document.getElementById('thrKnob'),
  thrVal: document.getElementById('thrVal'),
  rotate: document.getElementById('rotate'),
  error: document.getElementById('error'),
  errorMsg: document.getElementById('errorMsg')
};

/* ---------- geography ---------- */
const R = 6378137;
const WORLD = 2 * Math.PI * R;
const CENTER = { lat: 35.2712, lon: -82.4440 };    // Flat Rock, Henderson County, NC
const FAR_Z = 11, FAR_TILES = 9;                    // fixed background layer, ~175 km across
const ELEV_Z = 10;                                  // Terrarium elevation tiles
const GRID = 400;                                   // vertices per side of the terrain mesh

const mercXOf = lon => lon * Math.PI / 180 * R;
const mercYOf = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
const latOfMercY = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

const farN = Math.pow(2, FAR_Z);
const farSpan = WORLD / farN;
const txC = Math.floor((CENTER.lon + 180) / 360 * farN);
const tyC = Math.floor((1 - Math.log(Math.tan(CENTER.lat * Math.PI / 180) + 1 / Math.cos(CENTER.lat * Math.PI / 180)) / Math.PI) / 2 * farN);
const tx0 = txC - Math.floor(FAR_TILES / 2), ty0 = tyC - Math.floor(FAR_TILES / 2);
const B = {
  x0: tx0 * farSpan - WORLD / 2,
  x1: (tx0 + FAR_TILES) * farSpan - WORLD / 2,
  yTop: WORLD / 2 - ty0 * farSpan,
  yBot: WORLD / 2 - (ty0 + FAR_TILES) * farSpan
};
const CX = mercXOf(CENTER.lon), CY = mercYOf(CENTER.lat);
const SPAN_X = B.x1 - B.x0;
const SPAN_Y = B.yTop - B.yBot;


/* ---------- data loading ---------- */
const IMAGERY = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile';
const ELEV_SRC = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// USGS tile service: z / row / column
function orthoUrl(z, col, row) {
  return IMAGERY + '/' + z + '/' + row + '/' + col;
}
// Terrarium tiles: z / column / row, elevation encoded in the RGB channels
function elevUrl(z, col, row) {
  return ELEV_SRC + '/' + z + '/' + col + '/' + row + '.png';
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Tile unavailable: ' + url));
    img.src = url;
  });
}

const elevTiles = new Map();

async function loadElevTile(col, row) {
  const key = col + ':' + row;
  if (elevTiles.has(key)) return elevTiles.get(key);
  const img = await loadImage(elevUrl(ELEV_Z, col, row));
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 256, 256);
  const d = g.getImageData(0, 0, 256, 256).data;
  const f = new Float32Array(256 * 256);
  for (let i = 0, k = 0; i < f.length; i++, k += 4) {
    // metres = (R * 256 + G + B / 256) - 32768
    f[i] = (d[k] * 256 + d[k + 1] + d[k + 2] / 256) - 32768;
  }
  elevTiles.set(key, f);
  return f;
}

function sampleElevation(lon, lat) {
  const span = WORLD / Math.pow(2, ELEV_Z);
  const fx = (mercXOf(lon) + WORLD / 2) / span;
  const fy = (WORLD / 2 - mercYOf(lat)) / span;
  const col = Math.floor(fx), row = Math.floor(fy);
  const t = elevTiles.get(col + ':' + row);
  if (!t) return 0;
  let px = (fx - col) * 256 - 0.5, py = (fy - row) * 256 - 0.5;
  px = Math.max(0, Math.min(255, px));
  py = Math.max(0, Math.min(255, py));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
  const dx = px - x0, dy = py - y0;
  const v00 = t[y0 * 256 + x0], v10 = t[y0 * 256 + x1];
  const v01 = t[y1 * 256 + x0], v11 = t[y1 * 256 + x1];
  return (v00 * (1 - dx) + v10 * dx) * (1 - dy) + (v01 * (1 - dx) + v11 * dx) * dy;
}

async function buildTerrainTexture() {
  const size = FAR_TILES * 256;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#1a2433';
  g.fillRect(0, 0, size, size);
  let done = 0, failed = 0;
  const total = FAR_TILES * FAR_TILES;
  const jobs = [];
  for (let iy = 0; iy < FAR_TILES; iy++) {
    for (let ix = 0; ix < FAR_TILES; ix++) {
      const col = tx0 + ix, row = ty0 + iy;
      jobs.push(loadImage(orthoUrl(FAR_Z, col, row)).then(img => {
        g.drawImage(img, ix * 256, iy * 256, 256, 256);
      }).catch(() => { failed++; }).then(() => {
        done++;
        if (window.__skyProgress) window.__skyProgress('Aerial imagery ' + done + '/' + total, done / total * 0.75);
      }));
    }
  }
  await Promise.all(jobs);
  if (failed > total * 0.4) throw new Error('Too many aerial tiles unavailable (' + failed + '/' + total + ')');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

async function loadElevationForBounds() {
  const eSpan = WORLD / Math.pow(2, ELEV_Z);
  const c0 = Math.floor((B.x0 + WORLD / 2) / eSpan), c1 = Math.floor((B.x1 + WORLD / 2) / eSpan);
  const r0 = Math.floor((WORLD / 2 - B.yTop) / eSpan), r1 = Math.floor((WORLD / 2 - B.yBot) / eSpan);
  const list = [];
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) list.push([c, r]);
  let done = 0;
  await Promise.all(list.map(([c, r]) => loadElevTile(c, r).catch(() => null).then(() => {
    done++;
    if (window.__skyProgress) window.__skyProgress('Elevation ' + done + '/' + list.length, 0.75 + done / list.length * 0.25);
  })));
  if (elevTiles.size === 0) throw new Error('Elevation data could not be loaded');
}

/* ---------- hauteurs pour les collisions ---------- */
const heightGrid = new Float32Array((GRID + 1) * (GRID + 1));
function terrainHeightAt(wx, wz) {
  const u = (wx + SPAN_X / 2) / SPAN_X;
  const v = (wz + SPAN_Y / 2) / SPAN_Y;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const gx = u * GRID, gy = v * GRID;
  const x0 = Math.min(GRID - 1, Math.floor(gx)), y0 = Math.min(GRID - 1, Math.floor(gy));
  const fx = gx - x0, fy = gy - y0;
  const i0 = y0 * (GRID + 1) + x0;
  const h00 = heightGrid[i0], h10 = heightGrid[i0 + 1];
  const h01 = heightGrid[i0 + GRID + 1], h11 = heightGrid[i0 + GRID + 2];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

function buildTerrainMesh(texture) {
  const n = GRID + 1;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const idx = new Uint32Array(GRID * GRID * 6);
  for (let iy = 0; iy < n; iy++) {
    const v = iy / GRID;
    const my = B.yTop - v * SPAN_Y;
    const lat = latOfMercY(my);
    for (let ix = 0; ix < n; ix++) {
      const u = ix / GRID;
      const mx = B.x0 + u * SPAN_X;
      const lon = mx / R * 180 / Math.PI;
      const h = sampleElevation(lon, lat);
      const k = iy * n + ix;
      pos[k * 3] = mx - CX;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = -(my - CY);
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
      heightGrid[k] = h;
    }
  }
  let hMin = 1e9, hMax = -1e9;
  for (let k = 0; k < heightGrid.length; k++) {
    if (heightGrid[k] < hMin) hMin = heightGrid[k];
    if (heightGrid[k] > hMax) hMax = heightGrid[k];
  }
  if (hMax > 3200 || hMin < -600) throw new Error('Inconsistent elevation (' + Math.round(hMin) + ' to ' + Math.round(hMax) + ' m): unexpected tile format');
  console.info('[HENDO] elevation range: ' + Math.round(hMin) + ' to ' + Math.round(hMax) + ' m');

  let o = 0;
  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) {
      const a = iy * n + ix, b = a + 1, c = a + n, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------- 3D scene ---------- */
const canvas = document.getElementById('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  UI.errorMsg.textContent = 'WebGL indisponible sur ce navigateur : ' + e.message;
  UI.error.classList.remove('hidden');
  throw e;
}
let DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb9cbdd, 0.000022);
const camera = new THREE.PerspectiveCamera(62, 1, 3, 130000);

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(0x1b3762) }, bottom: { value: new THREE.Color(0xd7e5f3) } },
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.3 + 0.12, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }'
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 24, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x5b5646, 1.25));
const sun = new THREE.DirectionalLight(0xffeedd, 0.95);
sun.position.set(-2600, 1900, -1200);
scene.add(sun);

/* ---------- avion (design original) ---------- */
function buildAircraft() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf3f6f9, roughness: 0.42, metalness: 0.12 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.4, emissive: 0x3a1400 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.92, 6.4, 6, 12), white);
  body.rotation.x = Math.PI / 2;
  g.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.92, 2.1, 12), white);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -4.75;
  g.add(nose);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.3, 2.15), white);
  wing.position.set(0, -0.1, 0.35);
  g.add(wing);

  const wingTipL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 2.15), accent);
  wingTipL.position.set(-5.5, -0.1, 0.35);
  g.add(wingTipL);
  const wingTipR = wingTipL.clone();
  wingTipR.position.x = 5.5;
  g.add(wingTipR);

  const stab = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.22, 1.0), white);
  stab.position.set(0, 0.32, 3.15);
  g.add(stab);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.9, 1.35), accent);
  fin.position.set(0, 1.05, 3.15);
  g.add(fin);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.78, 12, 10), dark);
  canopy.scale.set(0.95, 0.8, 1.9);
  canopy.position.set(0, 0.72, -1.5);
  g.add(canopy);

  const engL = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.9, 10), dark);
  engL.rotation.x = Math.PI / 2;
  engL.position.set(-2.7, -0.42, 0.6);
  g.add(engL);
  const engR = engL.clone();
  engR.position.x = 2.7;
  g.add(engR);

  return g;
}
const aircraft = buildAircraft();
scene.add(aircraft);

/* ---------- moving aerial-detail windows ---------- */
// Two layers follow the plane: a 34 km mid layer (z13) and a 3 km close layer (z16).
// The whole 160 km base sits underneath at z11.
function makeFadeTexture(inner) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  const grad = g.createRadialGradient(128, 128, Math.max(4, 128 * inner), 128, 128, 127);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.72, '#ffffff');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(cv);
}

function makeWindow(z, n, seg, inner, yOff, order, cell) {
  const cellPx = cell || 256;
  const px = n * cellPx;
  const span = n * (WORLD / Math.pow(2, z));
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#3a4038';
  ctx.fillRect(0, 0, px, px);
  const buf = document.createElement('canvas');
  buf.width = buf.height = px;
  const bctx = buf.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const nv = seg + 1;
  const pos = new Float32Array(nv * nv * 3);
  const uv = new Float32Array(nv * nv * 2);
  const idx = new Uint32Array(seg * seg * 6);
  for (let iy = 0; iy < nv; iy++) {
    for (let ix = 0; ix < nv; ix++) {
      const u = ix / seg, v = iy / seg, k = iy * nv + ix;
      pos[k * 3] = (u - 0.5) * span;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = (v - 0.5) * span;
      uv[k * 2] = u; uv[k * 2 + 1] = 1 - v;
    }
  }
  let o = 0;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iy * nv + ix, b = a + 1, c = a + nv, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshLambertMaterial({
    map: tex, alphaMap: makeFadeTexture(inner), transparent: true, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.visible = false;
  scene.add(mesh);
  return { z: z, n: n, seg: seg, span: span, cv: cv, ctx: ctx, buf: buf, bctx: bctx, tex: tex, cell: cellPx,
           geo: geo, mesh: mesh, yOff: yOff, colC: null, rowC: null, prevCol: null, prevRow: null,
           busy: false, pending: false, cache: new Map() };
}

function exportUrl(z, col, row, size) {
  const n = Math.pow(2, z);
  const lonL = col / n * 360 - 180, lonR = (col + 1) / n * 360 - 180;
  const latT = Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  const latB = Math.atan(Math.sinh(Math.PI * (1 - 2 * (row + 1) / n))) * 180 / Math.PI;
  return IMAGERY.replace(/\/tile$/, '') + '/export?bbox=' + [lonL, latB, lonR, latT].join(',') +
    '&bboxSR=4326&imageSR=4326&size=' + size + ',' + size + '&format=jpg&f=image';
}

function winTile(w, col, row) {
  const key = col + '/' + row;
  let job = w.cache.get(key);
  if (!job) {
    job = loadImage(w.cell > 256 ? exportUrl(w.z, col, row, w.cell) : orthoUrl(w.z, col, row)).catch(() => null);
    w.cache.set(key, job);
    if (w.cache.size > 240) w.cache.delete(w.cache.keys().next().value);
  }
  return job;
}

function winPosition(w) {
  const span = WORLD / Math.pow(2, w.z);
  const cxw = (w.colC + 0.5) * span - WORLD / 2;
  const cyw = WORLD / 2 - (w.rowC + 0.5) * span;
  w.mesh.position.set(cxw - CX, w.yOff, -(cyw - CY));
  const attr = w.geo.getAttribute('position');
  const nv = w.seg + 1;
  for (let iy = 0; iy < nv; iy++) {
    for (let ix = 0; ix < nv; ix++) {
      const k = iy * nv + ix;
      const wx = cxw + (ix / w.seg - 0.5) * w.span;
      const my = cyw - (iy / w.seg - 0.5) * w.span;
      attr.array[k * 3 + 1] = sampleElevation(wx / R * 180 / Math.PI, latOfMercY(my));
    }
  }
  attr.needsUpdate = true;
  w.geo.computeVertexNormals();
  w.geo.computeBoundingSphere();
}

async function winUpdate(w, wx, wy) {
  const span = WORLD / Math.pow(2, w.z);
  const colC = Math.floor((wx + WORLD / 2) / span);
  const rowC = Math.floor((WORLD / 2 - wy) / span);
  if (colC === w.colC && rowC === w.rowC) return;
  if (w.busy) { w.pending = true; return; }
  w.busy = true;
  // carry the previous window over, shifted by the tile delta, so nothing flashes dark
  w.bctx.clearRect(0, 0, w.buf.width, w.buf.height);
  if (w.prevCol !== null) {
    w.bctx.drawImage(w.cv, (w.prevCol - colC) * w.cell, (w.prevRow - rowC) * w.cell);
  }
  w.prevCol = colC; w.prevRow = rowC;
  w.colC = colC; w.rowC = rowC;
  const half = (w.n - 1) / 2;
  const jobs = [];
  let loaded = 0;
  for (let j = 0; j < w.n; j++) {
    for (let i = 0; i < w.n; i++) {
      const ix = i, iy = j;
      jobs.push(winTile(w, colC - half + i, rowC - half + j).then(img => {
        if (img) { loaded++; w.bctx.drawImage(img, ix * w.cell, iy * w.cell, w.cell, w.cell); }
      }));
    }
  }
  await Promise.all(jobs);
  if (loaded === 0 && !w.mesh.visible) {
    // nothing came back: keep the window hidden rather than show an empty square
    w.busy = false;
    return;
  }
  w.ctx.drawImage(w.buf, 0, 0);
  w.tex.needsUpdate = true;
  w.mesh.visible = true;
  winPosition(w);
  w.busy = false;
  if (w.pending) {
    w.pending = false;
    winUpdate(w, CX + flight.pos.x, CY - flight.pos.z);
  }
}

let detailTick = 0;
let isHovering = false;
let hoverCam = 0;
const winMid = makeWindow(13, 7, 56, 0.60, 2.2, 1);
const winNear = makeWindow(16, 5, 64, 0.54, 4.0, 2);
const winUltra = makeWindow(16, 3, 72, 0.55, 4.2, 3, 1024);

/* ---------- landmarks: labels, mini-map, quick jump ---------- */
const poiList = [];
let poiLoaded = false, labTick = 0, hdgTick = 0;
const labelsHost = document.getElementById('labels');
const labelEls = [];
for (let i = 0; i < 3; i++) {
  const el = document.createElement('div');
  el.className = 'poi';
  el.style.display = 'none';
  labelsHost.appendChild(el);
  labelEls.push(el);
}

fetch('./pois.json').then(r => (r.ok ? r.json() : [])).then(list => {
  for (const p of list) {
    const wx = mercXOf(p.lo) - CX;
    const wz = -(mercYOf(p.la) - CY);
    if (Math.hypot(wx, wz) > AREA_RADIUS + 4000) continue;
    poiList.push({ name: p.n, kind: p.k, ele: p.e, la: p.la, lo: p.lo, wx: wx, wz: wz, gy: null });
  }
  poiLoaded = true;
}).catch(() => {});

const projV = new THREE.Vector3();
const LBL_MAX = 3, LBL_MIN_D = 700, LBL_MAX_D = 12000;
function updateLabels() {
  if (!poiLoaded) return;
  const cand = [];
  for (let i = 0; i < poiList.length; i++) {
    const p = poiList[i];
    const dx = p.wx - flight.pos.x, dz = p.wz - flight.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < LBL_MIN_D || d > LBL_MAX_D) continue;
    if (p.gy === null) p.gy = sampleElevation(p.la, p.lo);
    projV.set(p.wx, p.gy + 60, p.wz).project(camera);
    if (projV.z < -1 || projV.z > 1) continue;
    const sx = (projV.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (0.5 - projV.y * 0.5) * window.innerHeight;
    if (sx < 44 || sx > window.innerWidth - 44 || sy < 70 || sy > window.innerHeight - 26) continue;
    cand.push({ p: p, d: d, sx: sx, sy: sy });
  }
  cand.sort((a, b) => a.d - b.d);
  const kept = [];
  for (let i = 0; i < cand.length && kept.length < LBL_MAX; i++) {
    const c = cand[i];
    let clash = false;
    for (let k = 0; k < kept.length; k++) {
      if (Math.abs(kept[k].sy - c.sy) < 22 && Math.abs(kept[k].sx - c.sx) < 120) { clash = true; break; }
    }
    if (!clash) kept.push(c);
  }
  for (let i = 0; i < labelEls.length; i++) {
    const el = labelEls[i], c = kept[i];
    if (!c) { el.style.display = 'none'; continue; }
    el.style.display = 'block';
    el.style.left = c.sx.toFixed(0) + 'px';
    el.style.top = c.sy.toFixed(0) + 'px';
    el.style.opacity = (1 - 0.5 * Math.min(1, Math.max(0, (c.d - 3000) / 9000))).toFixed(2);
    el.textContent = c.p.name + ' · ' + (c.d >= 1000 ? (c.d / 1000).toFixed(1) + ' km' : Math.round(c.d) + ' m');
    el.className = 'poi k-' + c.p.kind;
  }
}

function buildJumpList() {
  const host = document.getElementById('jumpList');
  host.innerHTML = '';
  const arr = poiList.map(p => ({ p: p, d: Math.hypot(p.wx - flight.pos.x, p.wz - flight.pos.z) }))
    .sort((a, b) => a.d - b.d).slice(0, 45);
  for (const it of arr) {
    const b = document.createElement('button');
    const km = it.d >= 1000 ? (it.d / 1000).toFixed(it.d < 10000 ? 1 : 0) + ' km' : Math.round(it.d) + ' m';
    b.textContent = it.p.name + (it.p.ele ? ' · ' + it.p.ele + ' m' : '') + ' · ' + km;
    b.addEventListener('click', () => jumpTo(it.p));
    host.appendChild(b);
  }
}

function jumpTo(p) {
  if (state !== 'flying' && state !== 'paused') return;
  const gh = sampleElevation(p.la, p.lo);
  flight.pos.x = p.wx;
  flight.pos.z = p.wz;
  flight.pos.y = gh + 320;
  flight.heading = Math.atan2(-p.wx, p.wz);
  flight.pitch = 0; flight.roll = 0;
  trail.length = 0;
  document.getElementById('jumpPanel').classList.add('hidden');
}

document.getElementById('jump').addEventListener('click', () => {
  if (state !== 'flying' && state !== 'paused') return;
  buildJumpList();
  document.getElementById('jumpPanel').classList.remove('hidden');
});
document.getElementById('jumpClose').addEventListener('click', () => {
  document.getElementById('jumpPanel').classList.add('hidden');
});

/* ---------- flight state ---------- */
const flight = {
  pos: new THREE.Vector3(0, 240, 3200),
  heading: 0, pitch: 0, roll: 0, speed: 66,
  shake: 0
};
const MAX_ALT = 3200, MIN_CLEAR = 7;
const AREA_RADIUS = 80467;          // 50 miles around Flat Rock

let stickX = 0, stickY = 0;
let state = 'loading';
const keys = Object.create(null);

/* ---------- audio ---------- */
let AC = null, eng = null, engGain = null, windGain = null, master = null;
function initAudio() {
  if (AC) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    AC = new Ctx();
    master = AC.createGain(); master.gain.value = 0.5; master.connect(AC.destination);
    eng = AC.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 80;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    engGain = AC.createGain(); engGain.gain.value = 0;
    eng.connect(lp); lp.connect(engGain); engGain.connect(master);
    eng.start();
    const len = Math.floor(AC.sampleRate * 2);
    const buf = AC.createBuffer(1, len, AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = AC.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    windGain = AC.createGain(); windGain.gain.value = 0;
    src.connect(bp); bp.connect(windGain); windGain.connect(master);
    src.start();
  } catch (e) { AC = null; }
}
function audioUpdate() {
  if (!AC) return;
  const t = AC.currentTime;
  const f = 62 + flight.speed * 1.25;
  try {
    eng.frequency.setTargetAtTime(f, t, 0.15);
    engGain.gain.setTargetAtTime(state === 'flying' ? 0.055 : 0.0, t, 0.2);
    windGain.gain.setTargetAtTime(state === 'flying' ? Math.min(0.09, flight.speed / 1400) : 0, t, 0.25);
  } catch (e) {}
}

/* ---------- input ---------- */
let pointerId = null, originX = 0, originY = 0;

const activePointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (state !== 'flying') return;
  e.preventDefault();
  initAudio();
  pointerId = e.pointerId;
  originX = e.clientX; originY = e.clientY;
}, { passive: false });

canvas.addEventListener('pointermove', (e) => {
  if (pointerId !== e.pointerId || state !== 'flying') return;
  e.preventDefault();
  const track = activePointers.get(e.pointerId);
  if (track) {
    const dy2 = e.clientY - track.y;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2 && isHovering) {
      // two fingers in a hover: climb or descend
      flight.pos.y = Math.max(terrainHeightAt(flight.pos.x, flight.pos.z) + MIN_CLEAR,
                              Math.min(MAX_ALT, flight.pos.y - dy2 * 1.5));
      stickX = 0; stickY = 0;
      return;
    }
  }
  const dx = (e.clientX - originX) / 90;
  const dy = (e.clientY - originY) / 90;
  stickX = Math.max(-1, Math.min(1, dx));
  stickY = Math.max(-1, Math.min(1, dy));
}, { passive: false });

function endPointer(e) {
  if (e && e.pointerId !== undefined) activePointers.delete(e.pointerId);
  if (pointerId !== null && e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
  pointerId = null; stickX = 0; stickY = 0;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', endPointer);

/* ---------- commande de vitesse ---------- */
const SPD_MIN = 0, SPD_MAX = 380;
let targetKmh = 252;
function drawThrottle() {
  const p = (targetKmh - SPD_MIN) / (SPD_MAX - SPD_MIN);
  UI.thrFill.style.height = (p * 100).toFixed(1) + '%';
  UI.thrKnob.style.bottom = (p * 100).toFixed(1) + '%';
  UI.thrVal.textContent = Math.round(targetKmh);
}
function setThrottleFromY(clientY) {
  const r = UI.thrTrack.getBoundingClientRect();
  const p = 1 - Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height)));
  targetKmh = SPD_MIN + p * (SPD_MAX - SPD_MIN);
  drawThrottle();
}
let thrPointer = null;
UI.throttle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  thrPointer = e.pointerId;
  try { UI.throttle.setPointerCapture(e.pointerId); } catch (err) {}
  setThrottleFromY(e.clientY);
  initAudio();
}, { passive: false });
UI.throttle.addEventListener('pointermove', (e) => {
  if (thrPointer !== e.pointerId) return;
  e.preventDefault();
  setThrottleFromY(e.clientY);
}, { passive: false });
UI.throttle.addEventListener('pointerup', () => { thrPointer = null; });
UI.throttle.addEventListener('pointercancel', () => { thrPointer = null; });
drawThrottle();

window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === '+' || e.key === '=') { targetKmh = Math.min(SPD_MAX, targetKmh + 15); drawThrottle(); }
  if (e.key === '-') { targetKmh = Math.max(SPD_MIN, targetKmh - 15); drawThrottle(); }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].indexOf(e.key) >= 0) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
});

/* ---------- place readout: city and neighbourhood under the plane ---------- */
let geoAccum = 9, geoBusy = false, geoShown = '';
let geoLastX = 1e9, geoLastZ = 1e9;
function showPlace(city, sub) {
  const key = city + '|' + sub;
  if (key === geoShown) return;
  geoShown = key;
  UI.placeCity.textContent = city || '—';
  UI.placeStreet.textContent = sub || '';
  UI.place.classList.remove('hidden');
}
function scheduleGeo(dt) {
  geoAccum += dt;
  // Nominatim allows one request per second; 2.5 s keeps a wide margin.
  if (geoAccum < 2.5 || geoBusy) return;
  const x = flight.pos.x, z = flight.pos.z;
  const moved = Math.hypot(x - geoLastX, z - geoLastZ);
  if (geoShown && moved < 400) return;
  geoAccum = 0;
  geoLastX = x; geoLastZ = z;
  const lon = (CX + x) / R * 180 / Math.PI;
  const lat = latOfMercY(CY - z);
  geoBusy = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&accept-language=en&lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5), { signal: ctl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const a = j && j.address;
      if (!a) return;
      const city = a.city || a.town || a.village || a.hamlet || a.county || '';
      const sub = a.suburb || a.neighbourhood || a.road || '';
      const st = a.state_code ? String(a.state_code).toUpperCase() : '';
      showPlace(city + (st ? ', ' + st : ''), sub);
    })
    .catch(() => {})
    .finally(() => { clearTimeout(timer); geoBusy = false; });
}

/* ---------- flight model ---------- */
function updateFlight(dt) {
  const kx = ((keys['arrowright'] || keys['d']) ? 1 : 0) - ((keys['arrowleft'] || keys['a']) ? 1 : 0);
  const ky = ((keys['arrowdown'] || keys['s']) ? 1 : 0) - ((keys['arrowup'] || keys['w']) ? 1 : 0);
  const ix = Math.max(-1, Math.min(1, stickX + kx));
  const iy = Math.max(-1, Math.min(1, stickY + ky));

  const targetSpeed = targetKmh / 3.6;
  flight.speed += (targetSpeed - flight.speed) * Math.min(1, dt * 0.9);

  // hovering: throttle at zero and the aircraft stopped. The stick now turns
  // the aircraft in place and moves it up or down instead of banking it.
  const hovering = targetKmh < 6 && flight.speed < 3.5;
  flight.heading += ix * (hovering ? 0.95 : 0.62) * dt;
  const pitchTarget = iy * 0.5;
  flight.pitch += (pitchTarget - flight.pitch) * Math.min(1, dt * 3.0);
  flight.roll += ((-ix * (hovering ? 0.14 : 0.55)) - flight.roll) * Math.min(1, dt * 4.0);

  isHovering = hovering;
  if (hovering) {
    flight.pitch += (0 - flight.pitch) * Math.min(1, dt * 3.0);
    hoverCam = Math.max(0, Math.min(1, hoverCam + iy * dt * 0.85));
  } else {
    hoverCam += (0 - hoverCam) * Math.min(1, dt * 3.0);
    const climb = Math.sin(flight.pitch) * flight.speed;
    const sink = Math.max(0, 38 - flight.speed) * 0.6;
    flight.pos.y += (climb - sink) * dt;
  }
  if (flight.pos.y > MAX_ALT) flight.pos.y = MAX_ALT;

  flight.pos.x += Math.sin(flight.heading) * flight.speed * dt;
  flight.pos.z -= Math.cos(flight.heading) * flight.speed * dt;

  const dist = Math.hypot(flight.pos.x, flight.pos.z);
  if (dist > AREA_RADIUS) {
    flight.pos.x *= AREA_RADIUS / dist;
    flight.pos.z *= AREA_RADIUS / dist;
  }

  const gh = terrainHeightAt(flight.pos.x, flight.pos.z);
  if (flight.pos.y < gh + MIN_CLEAR) {
    flight.pos.y = gh + MIN_CLEAR;
    flight.speed *= 0.996;
  }

  aircraft.position.copy(flight.pos);
  aircraft.rotation.set(flight.pitch, -flight.heading, flight.roll, 'YXZ');
}

const camFwd = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const camLook = new THREE.Vector3();

function updateCamera(dt) {
  const h = flight.heading;
  camFwd.set(Math.sin(h), 0, -Math.cos(h));
  const down = hoverCam;
  camDesired.copy(flight.pos).addScaledVector(camFwd, -(30 * (1 - down * 0.86)));
  camDesired.y += 7.2 + down * 46;
  const k = state === 'flying' ? (1 - Math.exp(-dt * 4.5)) : 1;
  camera.position.lerp(camDesired, k);
  camLook.copy(flight.pos).addScaledVector(camFwd, 46 * (1 - down));
  camLook.y += 2 - down * 14;
  camera.lookAt(camLook);
  sky.position.copy(camera.position);
}

/* ---------- interface ---------- */
const hdgCv = document.getElementById('hdg');
const hdgCtx = hdgCv ? hdgCv.getContext('2d') : null;
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function drawHeading(deg) {
  if (!hdgCtx) return;
  const W = hdgCv.width, H = hdgCv.height, c = W / 2;
  const g = hdgCtx;
  g.clearRect(0, 0, W, H);
  const pxPerDeg = 2.3;
  for (let d = Math.floor(deg - 48); d <= deg + 48; d += 5) {
    const x = c + (d - deg) * pxPerDeg;
    if (x < 4 || x > W - 4) continue;
    const dd = ((d % 360) + 360) % 360;
    const major = dd % 45 === 0;
    g.strokeStyle = major ? 'rgba(255,207,122,.9)' : 'rgba(150,190,235,.5)';
    g.lineWidth = major ? 1.8 : 1;
    g.beginPath();
    g.moveTo(x, H - (major ? 12 : 6));
    g.lineTo(x, H - 2);
    g.stroke();
    if (major) {
      g.fillStyle = dd === 0 ? '#ffcf7a' : 'rgba(226,238,255,.92)';
      g.font = 'bold 10px Arial';
      g.textAlign = 'center';
      g.fillText(CARD[(dd / 45) % 8], x, 13);
    }
  }
  g.strokeStyle = '#ffcf7a';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(c, H - 15);
  g.lineTo(c, H - 4);
  g.stroke();
}

/* ---------- boucle ---------- */
let last = 0, frames = 0, fpsTime = 0, fpsValue = 0, slow = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!last) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  if (dt > 0.05) dt = 0.05;

  if (state === 'flying') {
    updateFlight(dt);
      scheduleGeo(dt);
    audioUpdate();
    detailTick += dt;
    if (detailTick > 0.45) {
      detailTick = 0;
      winUpdate(winMid, CX + flight.pos.x, CY - flight.pos.z);
      winUpdate(winNear, CX + flight.pos.x, CY - flight.pos.z);
      winUltra && winUpdate(winUltra, CX + flight.pos.x, CY - flight.pos.z);
    }
    labTick += dt;
    hdgTick += dt;
    if (hdgTick > 0.08) {
      hdgTick = 0;
      let d = flight.heading * 180 / Math.PI;
      d = (d % 360 + 360) % 360;
      drawHeading(d);
    }
    if (labTick > 0.12) {
      labTick = 0;
      updateLabels();
    }
  }
  updateCamera(dt);
  renderer.render(scene, camera);

  frames++; fpsTime += dt;
  if (fpsTime >= 0.5) {
    fpsValue = Math.round(frames / fpsTime);
    frames = 0; fpsTime = 0;
    if (state === 'flying') {
      if (fpsValue < 28) { slow++; } else { slow = Math.max(0, slow - 1); }
      if (slow >= 6 && DPR > 1.05) { DPR = Math.max(1, DPR - 0.25); renderer.setPixelRatio(DPR); slow = 0; }
    }
  }
}

/* ---------- redimensionnement ---------- */
function resize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  UI.rotate.style.display = (h > w) ? 'flex' : 'none';
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));

/* ---------- cycle de vie ---------- */
function startFlight() {
  initAudio();
  if (AC && AC.state === 'suspended') AC.resume();
  flight.pos.set(0, 420, 3200);
  flight.heading = 0; flight.pitch = 0; flight.roll = 0; flight.speed = 66;
  flight.shake = 0;
  const gh = terrainHeightAt(0, 3200);
  flight.pos.y = Math.max(360, gh + 340);
  camera.position.set(flight.pos.x, flight.pos.y + 7, flight.pos.z + 24);
  state = 'flying';
  UI.start.classList.add('hidden');
  UI.pauseOverlay.classList.add('hidden');
}
UI.go.addEventListener('click', startFlight);UI.start.addEventListener('click', () => {
  if (!UI.go.disabled && state !== 'flying') startFlight();
});

UI.pause.addEventListener('click', () => {
  if (state !== 'flying') return;
  state = 'paused';
  UI.pauseOverlay.classList.remove('hidden');
});
UI.resume.addEventListener('click', () => {
  UI.pauseOverlay.classList.add('hidden');
  state = 'flying';
  last = 0;
  if (AC && AC.state === 'suspended') AC.resume();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'flying') {
    state = 'paused';
    UI.pauseOverlay.classList.remove('hidden');
  }
  last = 0;
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

/* ---------- startup ---------- */
window.__skyProgress = function (msg, frac) {
  UI.status.textContent = msg;
  UI.bar.style.width = Math.round(frac * 100) + '%';
};

async function boot() {
  resize();
  requestAnimationFrame(frame);
  try {
    window.__skyProgress('Loading aerial imagery…', 0.02);
    const tex = await buildTerrainTexture();
    window.__skyProgress('Loading elevation…', 0.78);
    await loadElevationForBounds();
    window.__skyProgress('Building terrain…', 0.96);
    const terrain = buildTerrainMesh(tex);
    scene.add(terrain);
    window.__skyProgress('High-resolution detail…', 0.97);
    await winUpdate(winMid, CX, CY - 3200);
    await winUpdate(winNear, CX, CY - 3200);
    const gh = terrainHeightAt(0, 3200);
    flight.pos.y = Math.max(360, gh + 340);
    camera.position.set(0, flight.pos.y + 7, 3224);
    camera.lookAt(0, flight.pos.y, 0);
    UI.bar.style.width = '100%';
    UI.status.textContent = 'Ready · 50 miles around Flat Rock, North Carolina';
    UI.go.disabled = false;
    state = 'ready';
  } catch (err) {
    console.error(err);
    UI.status.textContent = 'Loading failed';
    UI.errorMsg.textContent = 'Map data could not be loaded (' + err.message + '). Check your connection and reload the page.';
    UI.error.classList.remove('hidden');
  }
}
boot();
