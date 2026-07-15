import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

export interface OrbSceneApi {
  /** Rotate the camera around the orb by the given angles (radians). */
  rotateBy(deltaTheta: number, deltaPhi: number): void;
  /** Multiply the camera distance by `factor` (<1 zooms in, >1 zooms out). */
  zoomBy(factor: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  dispose(): void;
  setMicActive(active: boolean): Promise<boolean>;
  updateMouse(x: number, y: number): void;
  setMinimized(minimized: boolean): void;
}

const HOME_POSITION = new THREE.Vector3(0, 0.5, 5.5);
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 120; // Increased limit so you can zoom out much further to a very small size if desired

export function createOrbScene(container: HTMLElement): OrbSceneApi {
  const width = container.clientWidth;
  const height = container.clientHeight;

  // ——— SCENE ———
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500);
  camera.position.copy(HOME_POSITION);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  container.appendChild(renderer.domElement);

  // ——— MOUSE/POINTER & INTERACTIVE PHYSICS ———
  const raycaster = new THREE.Raycaster();
  const mouse2D = new THREE.Vector2(0, 0);
  const mouse3D = new THREE.Vector3();
  const intersectionPlane = new THREE.Plane();

  // ——— AUDIO VISUALIZER STATE ———
  let audioCtx: AudioContext | null = null;
  let audioAnalyser: AnalyserNode | null = null;
  let audioStream: MediaStream | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null;
  let micActive = false;

  async function setMicActive(active: boolean): Promise<boolean> {
    if (active) {
      if (micActive) return true;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioCtx = new AudioContextClass();
        audioAnalyser = audioCtx.createAnalyser();
        audioAnalyser.fftSize = 256;
        
        audioSource = audioCtx.createMediaStreamSource(audioStream);
        audioSource.connect(audioAnalyser);
        
        micActive = true;
        return true;
      } catch (err) {
        console.error("Microphone access failed", err);
        micActive = false;
        return false;
      }
    } else {
      if (!micActive) return false;
      if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
      }
      if (audioSource) {
        audioSource.disconnect();
        audioSource = null;
      }
      if (audioCtx && audioCtx.state !== "closed") {
        await audioCtx.close();
        audioCtx = null;
      }
      audioAnalyser = null;
      micActive = false;
      return false;
    }
  }

  function updateMouse(x: number, y: number) {
    mouse2D.x = x;
    mouse2D.y = y;
  }

  // ——— POST PROCESSING ———
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    1.8, // strength
    0.4, // radius
    0.2, // threshold
  );
  composer.addPass(bloom);

  // Chromatic aberration + color grade shader
  const chromaticShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uIntensity: { value: 0.003 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        vec2 dir = vUv - vec2(0.5);
        float d = length(dir);
        float offset = uIntensity * d;
        // Slight flicker
        float flicker = 1.0 + 0.02 * sin(uTime * 30.0) * sin(uTime * 7.3);
        vec4 cr = texture2D(tDiffuse, vUv + dir * offset);
        vec4 cg = texture2D(tDiffuse, vUv);
        vec4 cb = texture2D(tDiffuse, vUv - dir * offset * 0.5);
        gl_FragColor = vec4(cr.r * 1.25, cg.g * 0.95, cb.b * 0.55, 1.0) * flicker;
        // Push towards golden/amber warm tone
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.2, 0.85, 0.45), 0.35);
      }
    `,
  };
  const chromaticPass = new ShaderPass(chromaticShader);
  composer.addPass(chromaticPass);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.04;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.zoomSpeed = 1.4;
  controls.enablePan = false;

  // ——— COLORS ———
  const C_BRIGHT = 0xffaa00; // Vibrant Golden Orange
  const C_MID = 0xff7700;    // Rich Warm Amber
  const C_DIM = 0xcc4400;    // Deep Amber
  const C_FAINT = 0x551100;  // Faint Crimson
  const C_HOT = 0xffeed0;    // Warm Gold / Hot Core

  // ——— ORB ROOT ———
  // Every part of the orb (shells, core, orbiting debris, text, dust, rings)
  // lives under this group.
  const orbGroup = new THREE.Group();
  scene.add(orbGroup);

  // ——— MATERIAL HELPERS ———
  function lineMat(color: number, opacity = 1) {
    return new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  // ——— UTILITY: Create ring at latitude ———
  function latRing(radius: number, lat: number, segs = 120) {
    const r = radius * Math.cos(lat);
    const y = radius * Math.sin(lat);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ——— UTILITY: Create meridian ———
  function meridian(radius: number, lon: number, segs = 120) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const lat = (i / segs) * Math.PI - Math.PI / 2;
      pts.push(
        new THREE.Vector3(
          radius * Math.cos(lat) * Math.cos(lon),
          radius * Math.sin(lat),
          radius * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ═══════════════════════════════════════════════
  // LAYER 1: OUTER SHELL — dense wireframe grid
  // ═══════════════════════════════════════════════
  const outerShell = new THREE.Group();
  const R1 = 2.0;

  // Dense latitude rings (30+)
  for (let i = -15; i <= 15; i++) {
    const lat = (i / 15) * (Math.PI / 2) * 0.95;
    const opacity = i % 3 === 0 ? 0.5 : 0.12;
    const color = i % 3 === 0 ? C_MID : C_FAINT;
    outerShell.add(new THREE.Line(latRing(R1, lat), lineMat(color, opacity)));
  }

  // Dense meridians (24)
  for (let i = 0; i < 24; i++) {
    const lon = (i / 24) * Math.PI * 2;
    const isMajor = i % 6 === 0;
    outerShell.add(
      new THREE.Line(
        meridian(R1, lon),
        lineMat(isMajor ? C_MID : C_FAINT, isMajor ? 0.6 : 0.1),
      ),
    );
  }

  // 4 bright cross meridians (the "plus" shape) — wide bands
  const CROSS_LINES = 18;
  const CROSS_SPREAD = 0.25; // radians total width
  for (let i = 0; i < 4; i++) {
    const lon = (i / 4) * Math.PI * 2;
    for (let j = 0; j < CROSS_LINES; j++) {
      const t = (j / (CROSS_LINES - 1)) * 2 - 1; // -1 to 1
      const offset = (t * CROSS_SPREAD) / 2;
      const falloff = 1 - Math.abs(t) * 0.7; // brighter at center, dimmer at edges
      const opacity = 0.85 * falloff;
      const color = Math.abs(t) < 0.3 ? C_BRIGHT : C_MID;
      const line = new THREE.Line(meridian(R1, lon + offset, 200), lineMat(color, opacity));
      line.userData = { isThickBand: true };
      outerShell.add(line);
    }
  }

  // Bright equator band — wide
  const EQ_LINES = 20;
  const EQ_SPREAD = 0.35;
  for (let j = 0; j < EQ_LINES; j++) {
    const t = (j / (EQ_LINES - 1)) * 2 - 1;
    const offset = (t * EQ_SPREAD) / 2;
    const falloff = 1 - Math.abs(t) * 0.65;
    const opacity = 0.8 * falloff;
    const color = Math.abs(t) < 0.3 ? C_BRIGHT : C_MID;
    const line = new THREE.Line(latRing(R1, offset, 200), lineMat(color, opacity));
    line.userData = { isThickBand: true };
    outerShell.add(line);
  }

  orbGroup.add(outerShell);

  // ═══════════════════════════════════════════════
  // LAYER 2: GRID PANELS on the sphere surface
  // ═══════════════════════════════════════════════
  const panelGroup = new THREE.Group();

  function createSpherePanel(
    latCenter: number,
    lonCenter: number,
    latSpan: number,
    lonSpan: number,
    radius: number,
    divisions = 4,
  ) {
    const group = new THREE.Group();
    const mat = lineMat(C_DIM, 0.25);

    // horizontal lines
    for (let i = 0; i <= divisions; i++) {
      const lat = latCenter - latSpan / 2 + (i / divisions) * latSpan;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= divisions * 4; j++) {
        const lon = lonCenter - lonSpan / 2 + (j / (divisions * 4)) * lonSpan;
        pts.push(
          new THREE.Vector3(
            radius * Math.cos(lat) * Math.cos(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.sin(lon),
          ),
        );
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }

    // vertical lines
    for (let j = 0; j <= divisions; j++) {
      const lon = lonCenter - lonSpan / 2 + (j / divisions) * lonSpan;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= divisions * 4; i++) {
        const lat = latCenter - latSpan / 2 + (i / (divisions * 4)) * latSpan;
        pts.push(
          new THREE.Vector3(
            radius * Math.cos(lat) * Math.cos(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.sin(lon),
          ),
        );
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }

    return group;
  }

  // Scatter panels across the sphere
  for (let i = 0; i < 30; i++) {
    const lat = (Math.random() - 0.5) * Math.PI * 0.8;
    const lon = Math.random() * Math.PI * 2;
    const size = 0.15 + Math.random() * 0.25;
    const panel = createSpherePanel(
      lat,
      lon,
      size,
      size,
      R1 + 0.01,
      3 + Math.floor(Math.random() * 3),
    );
    panelGroup.add(panel);
  }
  orbGroup.add(panelGroup);

  // ═══════════════════════════════════════════════
  // LAYER 3: SECONDARY SHELL — offset, partial arcs
  // ═══════════════════════════════════════════════
  const shell2 = new THREE.Group();
  const R2 = 2.12;

  // Partial arcs at random latitudes
  for (let i = 0; i < 16; i++) {
    const lat = (Math.random() - 0.5) * Math.PI * 0.85;
    const startLon = Math.random() * Math.PI * 2;
    const arcLen = 0.3 + Math.random() * 1.2;
    const pts: THREE.Vector3[] = [];
    const segs = 60;
    const r = R2 * Math.cos(lat);
    const y = R2 * Math.sin(lat);
    for (let j = 0; j <= segs; j++) {
      const a = startLon + (j / segs) * arcLen;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    shell2.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        lineMat(C_MID, 0.2 + Math.random() * 0.3),
      ),
    );
  }

  // Partial meridian arcs
  for (let i = 0; i < 12; i++) {
    const lon = Math.random() * Math.PI * 2;
    const startLat = (Math.random() - 0.5) * Math.PI * 0.8;
    const arcLen = 0.3 + Math.random() * 0.8;
    const pts: THREE.Vector3[] = [];
    const segs = 40;
    for (let j = 0; j <= segs; j++) {
      const lat = startLat + (j / segs) * arcLen;
      pts.push(
        new THREE.Vector3(
          R2 * Math.cos(lat) * Math.cos(lon),
          R2 * Math.sin(lat),
          R2 * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    shell2.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        lineMat(C_DIM, 0.15 + Math.random() * 0.2),
      ),
    );
  }
  orbGroup.add(shell2);

  // ═══════════════════════════════════════════════
  // LAYER 4: INNER CORE — spiral geodesic
  // ═══════════════════════════════════════════════
  const innerCore = new THREE.Group();
  const R3 = 0.9;

  // Dense spirals
  for (let s = 0; s < 8; s++) {
    const pts: THREE.Vector3[] = [];
    const turns = 3 + Math.random() * 2;
    const segs = 300;
    const phase = (s / 8) * Math.PI * 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const lat = t * Math.PI - Math.PI / 2;
      const lon = t * turns * Math.PI * 2 + phase;
      pts.push(
        new THREE.Vector3(
          R3 * Math.cos(lat) * Math.cos(lon),
          R3 * Math.sin(lat),
          R3 * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    innerCore.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        lineMat(C_BRIGHT, 0.3 + Math.random() * 0.2),
      ),
    );
  }

  // Inner latitude rings
  for (let i = -6; i <= 6; i++) {
    const lat = (i / 6) * (Math.PI / 2) * 0.9;
    innerCore.add(new THREE.Line(latRing(R3, lat, 80), lineMat(C_DIM, 0.2)));
  }

  // Inner meridians
  for (let i = 0; i < 12; i++) {
    const lon = (i / 12) * Math.PI * 2;
    innerCore.add(new THREE.Line(meridian(R3, lon, 80), lineMat(C_DIM, 0.15)));
  }

  orbGroup.add(innerCore);

  // ═══════════════════════════════════════════════
  // LAYER 5: INNERMOST CORE — bright hot center
  // ═══════════════════════════════════════════════
  const coreR = 0.38;

  // Icosahedron wireframe core
  const icoGeo = new THREE.IcosahedronGeometry(coreR, 1);
  const icoEdges = new THREE.EdgesGeometry(icoGeo);
  const icoWireMat = lineMat(C_HOT, 0.9);
  const icoWire = new THREE.LineSegments(icoEdges, icoWireMat);
  orbGroup.add(icoWire);

  // Glowing center sphere — dense, high intensity
  const coreSphereMat = new THREE.MeshBasicMaterial({
    color: C_HOT,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
  });
  const coreSphere = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), coreSphereMat);
  orbGroup.add(coreSphere);

  // Larger faint glow — more prominent golden halo
  const glowSphereMat = new THREE.MeshBasicMaterial({
    color: C_MID,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
  });
  const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 16), glowSphereMat);
  orbGroup.add(glowSphere);

  // ═══════════════════════════════════════════════
  // CODE TEXT — tiny, dense, scattered
  // ═══════════════════════════════════════════════
  const codeSnippets = [
    "sys.init()", "0xFF3A", "malloc()", ">> SCAN", "void*", "ACK",
    "SYNC OK", "ptr_ref", "exec()", "hash256", "::bind", "core.0",
    "01101001", "10110100", ">>> RDY", "HEAP 4K", "TCP/SYN",
    "mutex.lk", "IRQ 0x7", "DMA xfer", "REG EAX", "FAULT 0",
    "kernel.d", "pipe |>", "chmod +x", "fork()", "SIGTERM",
    "eth0: UP", "AES-256", "RSA 4096", "TLS 1.3", "HTTP/2",
    "latency", "200 OK", "PATCH /", "fn main", "use std",
    "impl Orb", "async {}", "spawn()", "arc::new", ".unwrap",
  ];

  interface SpriteDrift {
    phi: number;
    theta: number;
    r: number;
    speed: number;
  }

  const sharedMaterials = new Map<string, THREE.SpriteMaterial>();
  function getOrCreateTextMaterial(text: string) {
    let mat = sharedMaterials.get(text);
    if (!mat) {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 32;
      const ctx = c.getContext("2d")!;
      ctx.font = "bold 14px Courier New";
      const alpha = 0.35 + Math.random() * 0.55;
      ctx.fillStyle = `rgba(0, ${(180 + Math.random() * 75) | 0}, 30, ${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 128, 16);
      const tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      sharedMaterials.set(text, mat);
    }
    return mat;
  }

  function scatterText(count: number, sizeFn: () => number, rFn: () => number, speedScale: [number, number]) {
    const group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const snippet = codeSnippets[Math.floor(Math.random() * codeSnippets.length)];
      const mat = getOrCreateTextMaterial(snippet);
      const sp = new THREE.Sprite(mat);
      const size = sizeFn();
      sp.scale.set(size * 5, size * 0.7, 1);
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const r = rFn();
      sp.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
      sp.userData = {
        phi,
        theta,
        r,
        speed:
          (speedScale[0] + Math.random() * speedScale[1]) *
          (Math.random() > 0.5 ? 1 : -1),
      } satisfies SpriteDrift;
      group.add(sp);
    }
    return group;
  }

  // On outer sphere — dense text coverage
  const textOuter = scatterText(
    1200,
    () => 0.04 + Math.random() * 0.04,
    () => R1 + 0.03 + Math.random() * 0.08,
    [0.0002, 0.0008],
  );
  orbGroup.add(textOuter);

  // On inner core — more text
  const textInner = scatterText(
    100,
    () => 0.03 + Math.random() * 0.03,
    () => R3 + 0.02,
    [0.0005, 0.001],
  );
  orbGroup.add(textInner);

  // Floating ambient text between shells
  const textAmbient = scatterText(
    400,
    () => 0.03,
    () => R3 + 0.2 + Math.random() * (R1 - R3 - 0.3),
    [0.0003, 0.0006],
  );
  orbGroup.add(textAmbient);

  // ═══════════════════════════════════════════════
  // ORBITING DEBRIS / ROCKS
  // ═══════════════════════════════════════════════
  // Shared geometries for performance — reuse across 250 satellites
  const debrisGeos = [
    new THREE.IcosahedronGeometry(0.012, 0),
    new THREE.IcosahedronGeometry(0.02, 0),
    new THREE.IcosahedronGeometry(0.03, 1),
    new THREE.IcosahedronGeometry(0.008, 0),
    new THREE.TetrahedronGeometry(0.015, 0),
    new THREE.OctahedronGeometry(0.018, 0),
  ];
  interface DebrisOrbit {
    orbitR: number;
    speed: number;
    tiltX: number;
    tiltZ: number;
    phase: number;
  }
  const debris: THREE.Mesh[] = [];
  for (let i = 0; i < 250; i++) {
    const geo = debrisGeos[Math.floor(Math.random() * debrisGeos.length)];
    const mat = new THREE.MeshBasicMaterial({
      color: Math.random() > 0.7 ? C_BRIGHT : C_MID,
      transparent: true,
      opacity: 0.3 + Math.random() * 0.6,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const orbitR = 1.2 + Math.random() * 4.0;
    const speed = (0.08 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1);
    const tiltX = (Math.random() - 0.5) * Math.PI * 0.9;
    const tiltZ = (Math.random() - 0.5) * Math.PI * 0.5;
    const phase = Math.random() * Math.PI * 2;
    mesh.userData = { orbitR, speed, tiltX, tiltZ, phase } satisfies DebrisOrbit;
    debris.push(mesh);
    orbGroup.add(mesh);

    // ~15% get a faint trailing line
    if (Math.random() > 0.85) {
      const trailPts: THREE.Vector3[] = [];
      for (let j = 0; j <= 15; j++) {
        const a = -(j / 15) * 0.3;
        trailPts.push(
          new THREE.Vector3(
            orbitR * Math.cos(a + phase),
            orbitR * 0.08 * Math.sin(a * 3),
            orbitR * Math.sin(a + phase),
          ),
        );
      }
      const trail = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(trailPts),
        lineMat(C_FAINT, 0.08),
      );
      mesh.add(trail);
    }
  }

  // ═══════════════════════════════════════════════
  // DUST PARTICLES — lots of them
  // ═══════════════════════════════════════════════
  const dustCount = 2000;
  const dustPos = new Float32Array(dustCount * 3);

  for (let i = 0; i < dustCount; i++) {
    // Concentrate near the sphere, sparse further out
    const rr = 0.5 + Math.pow(Math.random(), 0.6) * 7;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    dustPos[i * 3] = rr * Math.sin(phi) * Math.cos(theta);
    dustPos[i * 3 + 1] = rr * Math.cos(phi);
    dustPos[i * 3 + 2] = rr * Math.sin(phi) * Math.sin(theta);
  }

  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.Float32BufferAttribute(dustPos, 3));

  const dustOriginal = new Float32Array(dustPos);
  const dustVels = new Float32Array(dustCount * 3);

  // Soft dot texture - matched to golden/amber theme
  const dotC = document.createElement("canvas");
  dotC.width = dotC.height = 64;
  const dCtx = dotC.getContext("2d")!;
  const g = dCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255, 204, 0, 1)");
  g.addColorStop(0.2, "rgba(255, 136, 0, 0.6)");
  g.addColorStop(0.5, "rgba(200, 68, 0, 0.15)");
  g.addColorStop(1, "rgba(100, 20, 0, 0)");
  dCtx.fillStyle = g;
  dCtx.fillRect(0, 0, 64, 64);

  const dustMat = new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dotC),
    size: 0.04,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    color: C_BRIGHT,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  orbGroup.add(dustPoints);

  // ——— TONY STARK ATOM MODE SPIKES ———
  const spikeGeo = new THREE.BufferGeometry();
  const spikePos = new Float32Array(dustCount * 2 * 3); // 2 vertices per spike, 3 coordinates per vertex
  spikeGeo.setAttribute("position", new THREE.BufferAttribute(spikePos, 3));
  const spikeMat = new THREE.LineBasicMaterial({
    color: C_BRIGHT,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const spikeLines = new THREE.LineSegments(spikeGeo, spikeMat);
  orbGroup.add(spikeLines);

  // ——— SPIKE END-NODE DOTS ———
  const nodeGeo = new THREE.BufferGeometry();
  const nodePos = new Float32Array(dustCount * 3); // coordinates for each spike's end node
  nodeGeo.setAttribute("position", new THREE.BufferAttribute(nodePos, 3));
  const nodeMat = new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dotC),
    size: 0.15, // Large and bright tips at the end of each spike
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    color: 0xffaa00, // Bright amber-gold
  });
  const nodePoints = new THREE.Points(nodeGeo, nodeMat);
  orbGroup.add(nodePoints);

  // ——— AUDIO VISUALIZER RINGS ———
  const waveSegments = 128;
  const waveGeoH = new THREE.BufferGeometry();
  const wavePosH = new Float32Array((waveSegments + 1) * 3);
  waveGeoH.setAttribute("position", new THREE.BufferAttribute(wavePosH, 3));
  const waveLineH = new THREE.LineLoop(waveGeoH, lineMat(C_BRIGHT, 0.7));
  orbGroup.add(waveLineH);

  const waveGeoV = new THREE.BufferGeometry();
  const wavePosV = new Float32Array((waveSegments + 1) * 3);
  waveGeoV.setAttribute("position", new THREE.BufferAttribute(wavePosV, 3));
  const waveLineV = new THREE.LineLoop(waveGeoV, lineMat(C_BRIGHT, 0.7));
  waveLineV.rotation.y = Math.PI / 2;
  orbGroup.add(waveLineV);

  // ═══════════════════════════════════════════════
  // SCANNING RINGS
  // ═══════════════════════════════════════════════
  function makeScanRing(radius: number, thickness = 0.015) {
    const geo = new THREE.RingGeometry(radius - thickness, radius + thickness, 120);
    const mat = new THREE.MeshBasicMaterial({
      color: C_BRIGHT,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  const scanRing1 = makeScanRing(R1, 0.01);
  const scanRing2 = makeScanRing(R1 * 0.7, 0.008);
  const shockwaveRing = makeScanRing(R1 * 1.5, 0.02);
  orbGroup.add(scanRing1, scanRing2, shockwaveRing);

  // ═══════════════════════════════════════════════
  // HEXAGONAL NODES — small tech details
  // ═══════════════════════════════════════════════
  for (let i = 0; i < 15; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r = R1 + 0.02;
    const hexGeo = new THREE.CircleGeometry(0.03 + Math.random() * 0.02, 6);
    const hexEdges = new THREE.EdgesGeometry(hexGeo);
    const hex = new THREE.LineSegments(hexEdges, lineMat(C_MID, 0.5));
    hex.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    hex.lookAt(0, 0, 0);
    outerShell.add(hex);
  }

  // ═══════════════════════════════════════════════
  // GESTURE / PROGRAMMATIC CAMERA CONTROL
  // ═══════════════════════════════════════════════
  const sphericalScratch = new THREE.Spherical();
  const offsetScratch = new THREE.Vector3();

  function rotateBy(deltaTheta: number, deltaPhi: number) {
    offsetScratch.copy(camera.position).sub(controls.target);
    sphericalScratch.setFromVector3(offsetScratch);
    sphericalScratch.theta -= deltaTheta;
    sphericalScratch.phi = THREE.MathUtils.clamp(
      sphericalScratch.phi - deltaPhi,
      0.05,
      Math.PI - 0.05,
    );
    sphericalScratch.makeSafe();
    offsetScratch.setFromSpherical(sphericalScratch);
    camera.position.copy(controls.target).add(offsetScratch);
    camera.lookAt(controls.target);
  }

  function zoomBy(factor: number) {
    offsetScratch.copy(camera.position).sub(controls.target);
    const maxD = isMinimized ? 22.0 : 7.5;
    const dist = THREE.MathUtils.clamp(
      offsetScratch.length() * factor,
      MIN_DISTANCE,
      maxD,
    );
    offsetScratch.setLength(dist);
    camera.position.copy(controls.target).add(offsetScratch);
  }

  function resetView() {
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }

  // ═══════════════════════════════════════════════
  // ANIMATION
  // ═══════════════════════════════════════════════
  const clock = new THREE.Clock();
  let flickerTimer = 0;
  let rafId = 0;
  let disposed = false;
  let currentSurge = 0;
  let isMinimized = false;
  let minimizeT = 0;

  function animate() {
    if (disposed) return;
    rafId = requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // Outer shell rotation
    outerShell.rotation.y += 0.0015;
    outerShell.rotation.x = Math.sin(t * 0.08) * 0.05;

    // Panel group follows shell but with slight offset
    panelGroup.rotation.y += 0.0018;
    panelGroup.rotation.x = Math.sin(t * 0.08 + 0.5) * 0.04;

    // Secondary shell counter-rotates slowly
    shell2.rotation.y -= 0.001;
    shell2.rotation.z = Math.sin(t * 0.12) * 0.03;

    // Inner core — opposite, faster
    innerCore.rotation.y -= 0.005;
    innerCore.rotation.z += 0.002;
    innerCore.rotation.x = Math.cos(t * 0.1) * 0.08;

    // Innermost wireframe
    icoWire.rotation.x += 0.008;
    icoWire.rotation.y += 0.012;

    // Smooth transition for minimized mode
    if (isMinimized) {
      minimizeT += (1.0 - minimizeT) * 0.08;
    } else {
      minimizeT += (0.0 - minimizeT) * 0.08;
    }

    // Scale entire group down dynamically
    // Normal scale is 1.0; minimized scale is 0.38
    const targetGroupScale = 1.0 - minimizeT * 0.62;
    orbGroup.scale.setScalar(targetGroupScale);

    // Fade in spikes and node dots when minimized, fade out general random dust points
    spikeMat.opacity = minimizeT * 0.12; // faint orange spike lines (preventing solid yellow core wall)
    nodeMat.opacity = minimizeT * 0.95; // bright glowing tip node dots
    dustMat.opacity = 0.5 * (1.0 - minimizeT * 0.95);

    // Update spikes to connect core to selected dust nodes (multi-length corona spokes, each ending in a bright dot)
    if (minimizeT > 0.01) {
      const spikeArr = spikeGeo.attributes.position.array as Float32Array;
      const nodeArr = nodeGeo.attributes.position.array as Float32Array;
      const posArr = dustGeo.attributes.position.array as Float32Array;
      
      // Reset all lines and nodes in the buffer
      spikeArr.fill(0);
      nodeArr.fill(0);
      
      let count = 0;
      const step = 6; // connect every 6th dust particle (about 333 spikes total for a rich, dense corona)
      for (let i = 0; i < dustCount; i += step) {
        const dustIdx = i * 3;
        const spikeIdx = count * 6; // 1 line segment = 2 vertices = 6 floats
        const nodeIdx = count * 3;  // 1 node dot = 3 floats
        
        const dx = posArr[dustIdx];
        const dy = posArr[dustIdx + 1];
        const dz = posArr[dustIdx + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        if (len > 0.1) {
          const startR = 0.38;
          // Layered length distribution (spans from 30% to 100% of the distance to the outer particle)
          const lenMult = 0.30 + ((i / step) % 6) * 0.14; // multipliers: 0.30, 0.44, 0.58, 0.72, 0.86, 1.0
          
          const endX = (dx / len) * (startR + (len - startR) * lenMult);
          const endY = (dy / len) * (startR + (len - startR) * lenMult);
          const endZ = (dz / len) * (startR + (len - startR) * lenMult);

          // Radial Spike (starts at core boundary and ends at computed end coordinate)
          spikeArr[spikeIdx] = (dx / len) * startR;
          spikeArr[spikeIdx + 1] = (dy / len) * startR;
          spikeArr[spikeIdx + 2] = (dz / len) * startR;
          
          spikeArr[spikeIdx + 3] = endX;
          spikeArr[spikeIdx + 4] = endY;
          spikeArr[spikeIdx + 5] = endZ;
          
          // Place a bright glowing dot exactly at the end of the spike line
          nodeArr[nodeIdx] = endX;
          nodeArr[nodeIdx + 1] = endY;
          nodeArr[nodeIdx + 2] = endZ;
        } else {
          spikeArr[spikeIdx] = 0;
          spikeArr[spikeIdx + 1] = 0;
          spikeArr[spikeIdx + 2] = 0;
          spikeArr[spikeIdx + 3] = 0;
          spikeArr[spikeIdx + 4] = 0;
          spikeArr[spikeIdx + 5] = 0;
          
          nodeArr[nodeIdx] = 0;
          nodeArr[nodeIdx + 1] = 0;
          nodeArr[nodeIdx + 2] = 0;
        }
        
        count++;
      }
      spikeGeo.attributes.position.needsUpdate = true;
      nodeGeo.attributes.position.needsUpdate = true;
      
      spikeLines.visible = true;
      nodePoints.visible = true;
    } else {
      spikeLines.visible = false;
      nodePoints.visible = false;
    }

    // Core pulse — dramatic surges but mostly transparent, solid core size clamped
    // Conditions 2 & 3: Turn off dimming (fadeOut) and stop surges (targetSurge = 0, currentSurge = 0) when minimized
    const wave1 = Math.sin(t * 1.2);
    const wave3 = Math.pow(Math.max(0, Math.sin(t * 0.4)), 5); // rare big surge
    const wave4 = Math.pow(Math.max(0, Math.sin(t * 0.7 + 2)), 8); // mega surge
    const fadeOut = isMinimized ? 0 : Math.pow(Math.max(0, Math.sin(t * 0.25)), 3); // periodic full transparency
    
    const targetSurge = isMinimized ? 0 : (wave3 * 1.5 + wave4 * 2.0);
    if (isMinimized) {
      currentSurge = 0; // Force explosion to stop instantly when minimized
    }
    if (targetSurge > currentSurge) {
      // Rapid burst attack (smooth but explosive)
      currentSurge += (targetSurge - currentSurge) * 0.18;
    } else {
      // Damped decay release (feels like physical cooling off)
      currentSurge += (targetSurge - currentSurge) * 0.045;
    }
    const surge = isMinimized ? 0 : currentSurge;

    // Clamp solid core sphere expansion (avoiding giant solid light block)
    // Scale down the solid core sphere when minimized to a tiny pinpoint nucleus (scaled down by 82%)
    const coreSphereScale = 1.0 + Math.min(0.28, surge * 0.3) + Math.sin(t * 5) * 0.04;
    const targetCoreSphereScale = (1.0 - minimizeT * 0.82) * coreSphereScale;
    coreSphere.scale.setScalar(targetCoreSphereScale);

    // Keep it bright and glowing (reduce opacity slightly when minimized to prevent blinding bloom)
    const coreOpacity = Math.max(
      0.4,
      (0.5 + wave1 * 0.05 + surge * 0.15) * (1 - fadeOut * 0.95),
    );
    coreSphereMat.opacity = Math.min(0.85, coreOpacity) * (1.0 - minimizeT * 0.35);

    // Let the glow sphere (halo) expand and fade out
    // Clear out the fuzzy halo by 90% when minimized to keep the inner space dark and sharp
    glowSphere.scale.setScalar(1 + surge * 0.9);
    glowSphereMat.opacity = Math.max(0, 0.18 * (1.0 - surge / 3.5)) * (1.0 - minimizeT * 0.90);

    // Icosahedron wireframe shell (scaled down by only 4% so it stays large and clearly visible as a cage around the tiny core)
    icoWire.scale.setScalar((1.0 - minimizeT * 0.04) * (1 + surge * 0.75));
    icoWireMat.opacity = Math.min(0.95, 0.5 + surge * 0.45);

    // Scale all outer shells dynamically with the surge so the entire globe swells
    outerShell.scale.setScalar(1.0 + surge * 0.12);
    panelGroup.scale.setScalar(1.0 + surge * 0.12);
    shell2.scale.setScalar(1.0 + surge * 0.15);
    innerCore.scale.setScalar(1.0 + surge * 0.35);

    // Dynamic opacity/intensity boost for outer lines during surges (never fade them out)
    const traverseOpacityBoost = (obj: THREE.Object3D) => {
      obj.traverse((child) => {
        if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
          const mat = child.material as THREE.LineBasicMaterial;
          if (mat) {
            if (mat.userData.origOpacity === undefined) {
              mat.userData.origOpacity = mat.opacity;
            }
            if (child.userData.isThickBand) {
              // Fade out thick cross/equator bands when minimized to keep the center clean
              mat.opacity = mat.userData.origOpacity * (1.0 - minimizeT * 0.96);
            } else {
              // Boost opacity during surge, up to 1.85x, capped at 1.0
              mat.opacity = Math.min(1.0, mat.userData.origOpacity * (1.0 + surge * 0.85));
            }
          }
        }
      });
    };
    traverseOpacityBoost(outerShell);
    traverseOpacityBoost(panelGroup);
    traverseOpacityBoost(shell2);
    traverseOpacityBoost(innerCore);

    // Debris orbits
    debris.forEach((d) => {
      const u = d.userData as DebrisOrbit;
      const a = t * u.speed + u.phase;
      d.position.set(
        u.orbitR * Math.cos(a) * Math.cos(u.tiltX),
        u.orbitR * Math.sin(u.tiltX) * Math.sin(a * 0.8) + Math.sin(a * 0.3 + u.tiltZ) * 0.2,
        u.orbitR * Math.sin(a) * Math.cos(u.tiltZ),
      );
      d.rotation.x += 0.015;
      d.rotation.z += 0.01;
    });

    // Text drift
    const driftGroups: [THREE.Group, number][] = [
      [textOuter, 1],
      [textInner, 2],
      [textAmbient, 1.2],
    ];
    for (const [group, mult] of driftGroups) {
      group.children.forEach((sp) => {
        const u = sp.userData as SpriteDrift;
        u.theta += u.speed * mult;
        sp.position.set(
          u.r * Math.sin(u.phi) * Math.cos(u.theta),
          u.r * Math.cos(u.phi),
          u.r * Math.sin(u.phi) * Math.sin(u.theta),
        );
      });
    }

    // Scan rings sweeping
    const scanY1 = Math.sin(t * 0.4) * R1;
    scanRing1.position.y = scanY1;
    const scanS1 = Math.sqrt(Math.max(0, R1 * R1 - scanY1 * scanY1)) / R1;
    scanRing1.scale.set(scanS1, scanS1, 1);
    (scanRing1.material as THREE.MeshBasicMaterial).opacity = 0.2 * scanS1;

    const scanY2 = Math.sin(t * 0.6 + 2) * R3;
    scanRing2.position.y = scanY2;
    const scanS2 = Math.sqrt(Math.max(0, R3 * R3 - scanY2 * scanY2)) / R3;
    scanRing2.scale.set(scanS2, scanS2, 1);
    (scanRing2.material as THREE.MeshBasicMaterial).opacity = 0.15 * scanS2;

    // Shockwave Ring Update (expanding golden explosion)
    if (surge > 0.05) {
      shockwaveRing.visible = true;
      const swScale = (surge / 3.5) * 2.2;
      shockwaveRing.scale.set(swScale, swScale, 1);
      (shockwaveRing.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.65 * (1.0 - surge / 3.5));
    } else {
      shockwaveRing.visible = false;
    }

    // Dust rotation + interactive physics
    dustPoints.rotation.y += 0.0002;

    // Project pointer
    let pointerActive = false;
    if (mouse2D.x !== 0 || mouse2D.y !== 0) {
      pointerActive = true;
      intersectionPlane.normal.copy(camera.position).normalize();
      raycaster.setFromCamera(mouse2D, camera);
      raycaster.ray.intersectPlane(intersectionPlane, mouse3D);
    }

    const posArr = dustGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < dustCount; i++) {
      const idx = i * 3;
      let x = posArr[idx];
      let y = posArr[idx + 1];
      let z = posArr[idx + 2];

      const ox = dustOriginal[idx];
      const oy = dustOriginal[idx + 1];
      const oz = dustOriginal[idx + 2];

      let vx = dustVels[idx];
      let vy = dustVels[idx + 1];
      let vz = dustVels[idx + 2];

      // Spring force back to origin
      const k = 0.03;
      const damp = 0.90;
      vx += (ox - x) * k;
      vy += (oy - y) * k;
      vz += (oz - z) * k;

      // Radial blast wave during core surge
      if (surge > 0.15) {
        const dx = x;
        const dy = y;
        const dz = z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.1 && dist < 4.0) {
          const force = (surge * 0.08) * (1.0 - dist / 4.0);
          vx += (dx / dist) * force;
          vy += (dy / dist) * force;
          vz += (dz / dist) * force;
        }
      }

      // Repulsion force
      if (pointerActive) {
        const dx = x - mouse3D.x;
        const dy = y - mouse3D.y;
        const dz = z - mouse3D.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const dist = Math.sqrt(distSq);
        const repelRadius = 1.8;
        if (dist < repelRadius && dist > 0.01) {
          const force = (repelRadius - dist) * 0.16;
          vx += (dx / dist) * force;
          vy += (dy / dist) * force;
          vz += (dz / dist) * force;
        }
      }

      vx *= damp;
      vy *= damp;
      vz *= damp;

      x += vx;
      y += vy;
      z += vz;

      posArr[idx] = x;
      posArr[idx + 1] = y;
      posArr[idx + 2] = z;

      dustVels[idx] = vx;
      dustVels[idx + 1] = vy;
      dustVels[idx + 2] = vz;
    }
    dustGeo.attributes.position.needsUpdate = true;

    // ——— AUDIO WAVEFORM UPDATES ———
    const freqData = new Uint8Array(waveSegments);
    if (micActive && audioAnalyser) {
      audioAnalyser.getByteFrequencyData(freqData);
    } else {
      // Mock talking audio waves
      for (let i = 0; i < waveSegments; i++) {
        const angle = (i / waveSegments) * Math.PI * 2;
        const pulse = Math.pow(Math.max(0, Math.sin(t * 1.5 + Math.sin(t * 0.3))), 3);
        const wave = Math.sin(angle * 4 + t * 5) * 0.4 + Math.cos(angle * 7 - t * 8) * 0.3;
        freqData[i] = Math.max(0, (wave + 0.7) * pulse * 140);
      }
    }

    const posH = waveGeoH.attributes.position.array as Float32Array;
    const posV = waveGeoV.attributes.position.array as Float32Array;
    const baseR = R3;

    for (let i = 0; i <= waveSegments; i++) {
      const angle = (i % waveSegments) / waveSegments * Math.PI * 2;
      const freqVal = freqData[i % waveSegments] / 255;
      const r = baseR + freqVal * 0.55;

      const idx = i * 3;
      posH[idx] = r * Math.cos(angle);
      posH[idx + 1] = (freqVal * 0.1) * Math.sin(angle * 10 + t * 5);
      posH[idx + 2] = r * Math.sin(angle);

      posV[idx] = r * Math.cos(angle);
      posV[idx + 1] = r * Math.sin(angle);
      posV[idx + 2] = (freqVal * 0.1) * Math.cos(angle * 10 + t * 5);
    }
    waveGeoH.attributes.position.needsUpdate = true;
    waveGeoV.attributes.position.needsUpdate = true;

    // Random flicker on some panels
    flickerTimer += 0.016;
    if (flickerTimer > 0.1) {
      flickerTimer = 0;
      panelGroup.children.forEach((p) => {
        if (Math.random() > 0.95) {
          p.visible = !p.visible;
        }
      });
    }

    // Bloom pulse (damped in minimized mode to keep wireframe details crisp and prevent over-bleeding)
    bloom.strength = (1.6 + Math.sin(t * 0.8) * 0.3) * (1.0 + minimizeT * 0.05);

    // Update chromatic aberration time
    chromaticPass.uniforms.uTime.value = t;

    controls.maxDistance = isMinimized ? 22.0 : 7.5;
    controls.update();
    composer.render();
  }
  animate();

  // ——— RESIZE ———
  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  // ——— CLEANUP ———
  function dispose() {
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", onResize);
    controls.dispose();
    void setMicActive(false);

    // Dispose shared text materials
    sharedMaterials.forEach((mat) => {
      mat.map?.dispose();
      mat.dispose();
    });
    sharedMaterials.clear();

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const anyMat = mat as THREE.Material & { map?: THREE.Texture };
        anyMat.map?.dispose();
        mat.dispose();
      }
    });
    composer.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    rotateBy,
    zoomBy,
    zoomIn: () => zoomBy(0.65),
    zoomOut: () => zoomBy(1.55),
    resetView,
    dispose,
    setMicActive,
    updateMouse,
    setMinimized: (min: boolean) => { 
      isMinimized = min; 
      resetView();
    },
  };
}
