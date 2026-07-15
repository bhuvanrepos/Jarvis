import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Landmark indices (MediaPipe hand model)
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_FINGER_TIP = 12;
const RING_FINGER_TIP = 16;
const PINKY_TIP = 20;

// Pinch hysteresis: thumb–index distance relative to hand size
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;

// How strongly hand movement rotates the orb (radians per normalized unit)
const ROTATE_SPEED = 5.0;
// Smoothing factor for grab-point tracking (0..1, higher = snappier)
const SMOOTHING = 0.4;

export type GestureMode = "idle" | "spin" | "zoom";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
}

export interface HandTrackerCallbacks {
  /** Called when a single pinched hand drags: deltas in mirrored normalized coords. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Called when both hands pinch and spread/close: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
  /** Called when a hand is tracked to send its position to the scene. */
  onMove?(x: number, y: number): void;
  /** Triggered when the user performs a clap gesture. */
  onClap?(): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  pinching: boolean;
  grab: Point; // smoothed pinch midpoint, mirrored
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastVideoTime = -1;
  private poseState = false;     // State debounce for Peace Sign gesture
  private lastPoseTime = 0;      // Timestamp of the last pose trigger to prevent double triggers

  // keyed by handedness label so state survives re-ordering between frames
  private handStates = new Map<string, HandState>();
  private prevMode: GestureMode = "idle";
  private prevSpinGrab: Point | null = null;
  private prevZoomDist: number | null = null;
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle" };

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      // Some browsers/GPUs reject the GPU delegate — fall back to CPU
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
      });
    }

    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.handStates.clear();
    this.prevMode = "idle";
    this.prevSpinGrab = null;
    this.prevZoomDist = null;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, mode: "idle" });
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const result = this.landmarker.detectForVideo(this.video, performance.now());
    this.processHands(result.landmarks, result.handedness.map((h) => h[0]?.categoryName ?? "?"));
    this.drawOverlay(result.landmarks);
  };

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const pinchedGrabs: Point[] = [];
    const seen = new Set<string>();

    landmarks.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;
      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;

      // Mirrored so hand-right = screen-right from the user's perspective
      const raw: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.handStates.get(label);
      if (!state) {
        state = { pinching: false, grab: raw };
        this.handStates.set(label, state);
      }

      // Hysteresis so the pinch doesn't flicker on/off at the threshold
      if (state.pinching && pinchRatio > PINCH_OFF) state.pinching = false;
      else if (!state.pinching && pinchRatio < PINCH_ON) state.pinching = true;

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      if (state.pinching) pinchedGrabs.push(state.grab);
    });

    // Drop state for hands that left the frame
    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    // Peace Sign (V-pose) detection on ANY hand
    let peaceDetected = false;
    landmarks.forEach((lm, i) => {
      const label = labels[i];
      const state = this.handStates.get(label);

      // Skip peace sign detection if the hand is currently pinching (spinning or zooming)
      if (state?.pinching) return;

      const wrist = lm[WRIST];
      const mcp = lm[MIDDLE_MCP];
      // Hand scale is 3D distance from Wrist to Middle MCP (hand size reference)
      const handScale = Math.hypot(wrist.x - mcp.x, wrist.y - mcp.y, wrist.z - mcp.z);
      
      if (handScale > 1e-6) {
        // Extended fingers tips (Index and Middle) should be far from the wrist
        const dIndex = Math.hypot(lm[INDEX_TIP].x - wrist.x, lm[INDEX_TIP].y - wrist.y, lm[INDEX_TIP].z - wrist.z) / handScale;
        const dMiddle = Math.hypot(lm[MIDDLE_FINGER_TIP].x - wrist.x, lm[MIDDLE_FINGER_TIP].y - wrist.y, lm[MIDDLE_FINGER_TIP].z - wrist.z) / handScale;
        
        // Curled/folded finger tips (Ring and Pinky) should be close to the wrist
        const dRing = Math.hypot(lm[RING_FINGER_TIP].x - wrist.x, lm[RING_FINGER_TIP].y - wrist.y, lm[RING_FINGER_TIP].z - wrist.z) / handScale;
        const dPinky = Math.hypot(lm[PINKY_TIP].x - wrist.x, lm[PINKY_TIP].y - wrist.y, lm[PINKY_TIP].z - wrist.z) / handScale;
        
        // Tips should be far from the thumb tip to confirm open fingers (not pinching/touching thumb)
        const dIndexThumb = Math.hypot(lm[INDEX_TIP].x - lm[THUMB_TIP].x, lm[INDEX_TIP].y - lm[THUMB_TIP].y, lm[INDEX_TIP].z - lm[THUMB_TIP].z) / handScale;
        const dMiddleThumb = Math.hypot(lm[MIDDLE_FINGER_TIP].x - lm[THUMB_TIP].x, lm[MIDDLE_FINGER_TIP].y - lm[THUMB_TIP].y, lm[MIDDLE_FINGER_TIP].z - lm[THUMB_TIP].z) / handScale;

        // Rotation-invariant Peace Sign / V-pose check (tip distances relative to hand scale)
        if (dIndex > 1.35 && dMiddle > 1.35 && dRing < 0.90 && dPinky < 0.90 && dIndexThumb > 0.80 && dMiddleThumb > 0.80) {
          peaceDetected = true;
        }
      }
    });

    const now = performance.now();
    if (peaceDetected) {
      if (!this.poseState && (now - this.lastPoseTime > 1500)) {
        this.poseState = true;
        this.lastPoseTime = now;
        this.callbacks.onClap?.(); // Triggers the React minimize/expand toggle handler
      }
    } else {
      this.poseState = false; // Reset pose trigger state when peace sign is released
    }

    const mode: GestureMode =
      pinchedGrabs.length >= 2 ? "zoom" : pinchedGrabs.length === 1 ? "spin" : "idle";

    // Reset reference points on any mode change to avoid jumps
    if (mode !== this.prevMode) {
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = mode;
    }

    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.prevSpinGrab) {
        const dx = grab.x - this.prevSpinGrab.x;
        const dy = grab.y - this.prevSpinGrab.y;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevSpinGrab = grab;
    } else if (mode === "zoom") {
      const d = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      if (this.prevZoomDist && d > 1e-4) {
        // Spread hands apart -> factor < 1 -> camera moves closer
        const factor = Math.min(1.18, Math.max(0.85, this.prevZoomDist / d));
        this.callbacks.onZoom(factor);
      }
      this.prevZoomDist = d;
    }
    
    if (landmarks.length > 0 && this.callbacks.onMove) {
      const firstLabel = labels[0];
      const state = this.handStates.get(firstLabel);
      if (state) {
        const ndcX = state.grab.x * 2 - 1;
        const ndcY = 1 - state.grab.y * 2;
        this.callbacks.onMove(ndcX, ndcY);
      }
    }

    this.emitStatus({ hands: landmarks.length, mode });
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.mode !== this.lastStatus.mode
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarks) {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      // Overlay canvas sits on the mirrored video preview, so mirror x here too
      const tx = (1 - thumb.x) * width;
      const ty = thumb.y * height;
      const ix = (1 - index.x) * width;
      const iy = index.y * height;

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      const pinched =
        handScale > 1e-6 && dist2d(thumb, index) / handScale < PINCH_ON;

      ctx.strokeStyle = pinched ? "#ffeed0" : "rgba(255,170,0,0.5)";
      ctx.lineWidth = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      ctx.fillStyle = pinched ? "#ffeed0" : "rgba(255,170,0,0.7)";
      for (const [x, y] of [
        [tx, ty],
        [ix, iy],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
