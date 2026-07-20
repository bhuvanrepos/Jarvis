"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";


type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  // New interactive states
  const [coords, setCoords] = useState({ x: "0.00", y: "0.00" });
  const [mic, setMic] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [hologramMode, setHologramMode] = useState<"jarvis" | "ultron">("jarvis");
  const [logs, setLogs] = useState<string[]>([
    "SYS: JARVIS CORE INITIALIZED",
    "SYS: POSITION HANDS WITH WRISTS VISIBLE FOR BEST TRACKING",
    "SYS: SHADER CHROMATIC PASS: ARMED",
    "SYS: STANDBY ACTIVE",
  ]);

  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    setLogs((prev) => [...prev.slice(-15), `[${timestamp}] ${msg}`]);
  }, []);

  const toggleHologramMode = useCallback(() => {
    setHologramMode((prev) => {
      const next = prev === "jarvis" ? "ultron" : "jarvis";
      sceneRef.current?.setHologramMode(next);
      addLog(`SYSTEM RECONFIGURATION: ${next.toUpperCase()} INTERFACE INTEGRATED`);
      return next;
    });
  }, [addLog]);

  useEffect(() => {
    const mockMsgs = [
      "TCP handshake established on port 3000",
      "Memory garbage collection: OK",
      "Diagnostic Core: 0.00ms latency",
      "Updating spherical projections...",
      "Analyzing hand landmarks stream...",
      "Running bloom post-processing...",
      "AI status check: standing by",
      "Network status check: encrypted",
      "Buffer allocations: stable",
      "Clearing old execution stack...",
      "Ready for hands-free user instructions",
    ];

    const interval = setInterval(() => {
      const msg = mockMsgs[Math.floor(Math.random() * mockMsgs.length)];
      addLog(msg);
    }, 4500);

    return () => clearInterval(interval);
  }, [addLog]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
    addLog("GESTURES DEACTIVATED");
  }, [addLog]);

  const toggleMinimize = useCallback(() => {
    setMinimized((prev) => {
      const nextState = !prev;
      sceneRef.current?.setMinimized(nextState);
      addLog(`MINIMIZATION: ${nextState ? "ACTIVATED" : "DEACTIVATED"}`);
      return nextState;
    });
  }, [addLog]);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
      onMove: (x, y) => {
        sceneRef.current?.updateMouse(x, y);
        setCoords({ x: x.toFixed(2), y: y.toFixed(2) });
      },
      onClap: toggleMinimize, // Clap gesture toggles minimize mode!
      onTonyGesture: toggleHologramMode, // Tony Stark palm gesture swaps hologram mode!
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
      addLog("GESTURES ACTIVATED");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
      addLog("GESTURE ACTIVATION FAILED");
    }
  }, [addLog, toggleMinimize, toggleHologramMode]);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const toggleMic = useCallback(async () => {
    if (!sceneRef.current) return;
    const nextState = !mic;
    const success = await sceneRef.current.setMicActive(nextState);
    if (success || !nextState) {
      setMic(nextState);
      addLog(`MICROPHONE ${nextState ? "ACTIVATED" : "DEACTIVATED"}`);
    } else {
      addLog("MICROPHONE ACTIVATION FAILED");
    }
  }, [mic, addLog]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    sceneRef.current?.updateMouse(x, y);
    setCoords({ x: x.toFixed(2), y: y.toFixed(2) });
  }, []);

  const handleMouseLeave = useCallback(() => {
    sceneRef.current?.updateMouse(0, 0);
    setCoords({ x: "0.00", y: "0.00" });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "m":
        case "M":
          toggleMinimize();
          break;
        case "h":
        case "H":
          toggleHologramMode();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, toggleMinimize, toggleHologramMode]);

  const cameraOn = camera === "on";

  return (
    <div className={hologramMode === "ultron" ? "ultron-theme" : "jarvis-theme"}>
      <div
        ref={containerRef}
        className="orb-root"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      {/* Advanced HUD System */}
      <AdvancedHUD
        cameraOn={cameraOn}
        hands={status.hands}
        mode={MODE_LABEL[status.mode]}
        coords={coords}
        mic={mic}
        toggleMic={toggleMic}
        logs={logs}
        videoRef={videoRef}
        overlayRef={overlayRef}
        camera={camera}
        toggleGestures={toggleGestures}
        sceneRef={sceneRef}
        error={error}
        minimized={minimized}
        toggleMinimize={toggleMinimize}
        hologramMode={hologramMode}
        toggleHologramMode={toggleHologramMode}
      />
    </div>
  );
}

interface AdvancedHUDProps {
  cameraOn: boolean;
  hands: number;
  mode: string;
  coords: { x: string; y: string };
  mic: boolean;
  toggleMic: () => void;
  logs: string[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  camera: CameraState;
  toggleGestures: () => void;
  sceneRef: React.RefObject<OrbSceneApi | null>;
  error: string | null;
  minimized: boolean;
  toggleMinimize: () => void;
  hologramMode: "jarvis" | "ultron";
  toggleHologramMode: () => void;
}

function AdvancedHUD({
  cameraOn,
  hands,
  mode,
  coords,
  mic,
  toggleMic,
  logs,
  videoRef,
  overlayRef,
  camera,
  toggleGestures,
  sceneRef,
  error,
  minimized,
  toggleMinimize,
  hologramMode,
  toggleHologramMode,
}: AdvancedHUDProps) {
  return (
    <>
      <div className="hud hud-title">
        {hologramMode === "jarvis" ? "J.A.R.V.I.S." : "U.L.T.R.O.N."}
      </div>

      {/* LEFT CONTAINER (Left Column + Left Floating Column) */}
      <div className="hud-left-container">
          {/* Main Left Status Column */}
          <div className="hud-column">
            {/* SYSTEM STATUS CARD */}
            <div className="hud-left-panel">
              <div className="panel-section">
                <div className="section-title">SYSTEM STATUS</div>
                <div className="status-item">
                  <span className="status-label">CORE STATE</span>
                  <span className="status-value" style={{ color: '#ffcc00', textShadow: '0 0 8px rgba(255, 204, 0, 0.6)' }}>{mode}</span>
                </div>
                <div className="status-item">
                  <span className="status-label">MIC INPUT</span>
                  <span className="status-value" style={{ color: mic ? '#ffcc00' : '#ff5500' }}>
                    {mic ? "ACTIVE" : "STANDBY"}
                  </span>
                </div>
                <div className="status-item">
                  <span className="status-label">TRACKING</span>
                  <span className="status-value" style={{ color: cameraOn ? '#ffcc00' : '#ffaa00' }}>
                    {cameraOn ? "ON" : "OFF"}
                  </span>
                </div>
              </div>

              <div className="panel-section">
                <div className="section-title">PROCESSOR LOAD</div>
                <div className="status-item">
                  <span className="status-label">SYS_LOAD</span>
                  <span className="status-value">28.4%</span>
                </div>
                <div className="status-graph">
                  <div className="graph-bar" style={{ height: '35%' }} />
                  <div className="graph-bar" style={{ height: '55%' }} />
                  <div className="graph-bar" style={{ height: '40%' }} />
                  <div className="graph-bar" style={{ height: '80%' }} />
                  <div className="graph-bar" style={{ height: '25%' }} />
                </div>
              </div>

              <div className="panel-section">
                <div className="section-title">SYSTEM LOGS</div>
                <div style={{
                  maxHeight: '130px',
                  overflowY: 'hidden',
                  fontFamily: 'monospace',
                  fontSize: '9px',
                  lineHeight: '1.4',
                  display: 'flex',
                  flexDirection: 'column-reverse',
                  gap: '3px',
                  opacity: 0.8,
                  color: '#ffeed0'
                }}>
                  {logs.slice().reverse().map((log, idx) => (
                    <div key={idx} style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* CORE DIAGNOSTICS CARD */}
            <div className="hud-bottom-left">
              <div className="section-title">CORE DIAGNOSTICS</div>
              <div className="diagnostic-row">
                <span className="diag-label">MEMORY</span>
                <div className="diag-bar">
                  <div className="diag-fill" style={{ width: '42%' }} />
                </div>
                <span className="diag-value">4.2 GB</span>
              </div>
              <div className="diagnostic-row">
                <span className="diag-label">FPS</span>
                <div className="diag-bar">
                  <div className="diag-fill" style={{ width: '95%' }} />
                </div>
                <span className="diag-value">60 FPS</span>
              </div>
              <div className="diagnostic-row">
                <span className="diag-label">LATENCY</span>
                <div className="diag-bar">
                  <div className="diag-fill" style={{ width: '8%' }} />
                </div>
                <span className="diag-value">12 ms</span>
              </div>

              <div className="stability-indicator">
                <div className="stability-circle" />
                <div className="stability-text">
                  SYSTEM STABILITY
                  <div style={{ fontSize: '10px', color: '#ffcc00', textShadow: 'none' }}>99.98% OK</div>
                </div>
              </div>
            </div>
          </div>

          {/* Floating Left Column (only when gestures camera is on) */}
          {cameraOn && (
            <div className="hud-floating-column">
              <div className="floating-panel-1">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">NEURAL LINKS</div>
                  <div className="neural-stats">
                    <div className="stat-row">
                      <span className="stat-label">WEIGHTS</span>
                      <span className="stat-value">FP16</span>
                    </div>
                    <div className="stat-row">
                      <span className="stat-label">ATTN CORES</span>
                      <span className="stat-value">64/64</span>
                    </div>
                    <div className="neural-graph-mini">
                      <div className="graph-line" />
                      <div className="graph-line" />
                      <div className="graph-line" />
                    </div>
                  </div>
                </div>
              </div>

              <div className="floating-panel-2">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">SECTOR TRACK</div>
                  <div className="threat-stats">
                    <div className="stat-row">
                      <span className="stat-label">TARGETS</span>
                      <span className="stat-value">00</span>
                    </div>
                    <div className="threat-meter-mini">
                      <div className="meter-fill" style={{ width: '2%' }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="floating-panel-5">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">ANALYTICS</div>
                  <div className="analytics-grid">
                    <div className="analytics-item">
                      <span className="analytics-icon">⚡</span>
                      <span className="analytics-text">VIBRANCY OPTIMAL</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

      {/* RIGHT CONTAINER (Right Column + Right Floating Column) */}
      <div className="hud-right-container">
          {/* Main Right Column */}
          <div className="hud-column">
            {/* RADAR CARD */}
            <div className="hud-right-top">
              <div className="section-title">RADAR / SCANNER</div>
              <div className="threat-circle">
                <svg className="threat-svg" width="140" height="140" viewBox="0 0 140 140">
                  <circle cx="70" cy="70" r="65" fill="none" stroke="rgba(255, 170, 0, 0.15)" strokeWidth="1" />
                  <circle cx="70" cy="70" r="45" fill="none" stroke="rgba(255, 170, 0, 0.1)" strokeWidth="1" strokeDasharray="4 4" />
                  <line className="rotating-line" x1="70" y1="70" x2="70" y2="5" stroke="rgba(255, 170, 0, 0.6)" strokeWidth="1.5" />
                </svg>
              </div>
              <div className="threat-value">0.00%</div>
              <div className="threat-label">NO ANOMALIES</div>
            </div>

            {/* ACTIVE REGIONS CARD */}
            <div className="hud-right-bottom">
              <div className="section-title">ACTIVE REGIONS</div>
              <div className="regions-list">
                <div className="region-item">
                  <span className="region-name">US-EAST</span>
                  <span className="region-status">ONLINE</span>
                  <span className="region-nodes">14 NODES</span>
                </div>
                <div className="region-item">
                  <span className="region-name">EU-WEST</span>
                  <span className="region-status">ONLINE</span>
                  <span className="region-nodes">08 NODES</span>
                </div>
                <div className="region-item">
                  <span className="region-name">AP-SOUTH</span>
                  <span className="region-status">STANDBY</span>
                  <span className="region-nodes">03 NODES</span>
                </div>
              </div>
            </div>

            {/* CAMERA PANEL */}
            <div className={`camera-panel${cameraOn || camera === 'error' ? " visible" : ""}`} style={{ position: 'relative', border: '1px solid rgba(255, 170, 0, 0.45)' }}>
              {camera === 'error' ? (
                <div className="camera-error-display" style={{ padding: '20px', color: '#ff5500', fontSize: '11px', textAlign: 'center', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {error || "CAMERA ACCESS DENIED"}
                </div>
              ) : (
                <>
                  <video ref={videoRef} muted playsInline className="camera-video" />
                  <canvas ref={overlayRef} className="camera-overlay" />
                  <div className="camera-status">
                    {hands > 0 ? `${hands} HAND${hands > 1 ? "S" : ""} · ${mode}` : "SHOW HANDS (KEEP WRISTS VISIBLE)"}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Floating Right Column (only when gestures camera is on) */}
          {cameraOn && (
            <div className="hud-floating-column">
              <div className="floating-panel-4">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">SUBSYSTEMS</div>
                  <div className="subsystem-list">
                    <div className="subsystem-item">
                      <span className="sub-name">VISION</span>
                      <span className="sub-status">OK</span>
                    </div>
                    <div className="subsystem-item">
                      <span className="sub-name">NLP</span>
                      <span className="sub-status">OK</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="floating-panel-3">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">DATA FEED</div>
                  <div className="data-lines">
                    <div className="data-line">0x8F3A &gt;&gt; LOADED</div>
                    <div className="data-line">0x112B &gt;&gt; OK</div>
                  </div>
                </div>
              </div>

              <div className="floating-panel-6">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">SYNC VALUE</div>
                  <div className="sync-value">92.4%</div>
                  <div className="sync-label">FRAME ALIGNED</div>
                </div>
              </div>

              <div className="floating-panel-7">
                <div className="panel-border" />
                <div className="panel-content-small">
                  <div className="panel-title-small">MINI VIZ</div>
                  <div className="core-viz-display">
                    <div className="viz-orb">
                      <div className="viz-ring ring-1" />
                      <div className="viz-ring ring-2" />
                      <div className="viz-ring ring-3" />
                      <div className="viz-core" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

      {/* CONSOLE CONTROL DOCK */}
      <div className={`hud-console-dock mode-${hologramMode}`}>
        <div className="dock-section dock-left">
          <span className="dock-label">TRACKING</span>
          <span className="dock-val">{cameraOn ? `${hands} HANDS · ${mode}` : "STANDBY"}</span>
        </div>

        <div className="dock-center">
          {/* GESTURES CONTROL */}
          <button
            className={`dock-btn-advanced ${cameraOn ? 'active' : ''}`}
            onClick={toggleGestures}
            disabled={camera === 'starting'}
            title="Toggle Hand Gestures (Webcam) [Key: G]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hud-svg-icon">
              <path d="M18 10h-1.25c-.41 0-.75-.34-.75-.75V8.5c0-.83-.67-1.5-1.5-1.5h-5c-.83 0-1.5.67-1.5 1.5v.75c0 .41-.34.75-.75.75H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="14" r="3" />
              <path d="M12 2v3M5 5l2 2M19 5l-2 2" />
            </svg>
            <div className="btn-label-group">
              <span className="btn-title">TRACKING</span>
              <span className="btn-status">{camera === 'starting' ? 'BOOTING' : cameraOn ? 'ONLINE' : 'STANDBY'}</span>
            </div>
          </button>

          {/* VOICE CONTROL */}
          <button
            className={`dock-btn-advanced ${mic ? 'active' : ''}`}
            onClick={toggleMic}
            title="Toggle Mic (Voice Visualizer) [Key: V]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hud-svg-icon">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v3M8 22h8" />
            </svg>
            <div className="btn-label-group">
              <span className="btn-title">VOICE FILTER</span>
              <span className="btn-status">{mic ? 'ACTIVE' : 'OFFLINE'}</span>
            </div>
          </button>

          {/* ATOM SCALE CONTROL */}
          <button
            className={`dock-btn-advanced ${minimized ? 'active' : ''}`}
            onClick={toggleMinimize}
            title="Toggle Minimize (Tony Stark Atom Mode) [Key: M]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hud-svg-icon">
              <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
            </svg>
            <div className="btn-label-group">
              <span className="btn-title">STARK ATOM</span>
              <span className="btn-status">{minimized ? 'MINIMIZED' : 'EXPANDED'}</span>
            </div>
          </button>

          {/* SYSTEM MODE TOGGLE (Avatar Image & Opposite Target System) */}
          <button
            className={`dock-btn-advanced toggle-hologram-btn active ${hologramMode === "jarvis" ? "target-ultron" : "target-jarvis"}`}
            onClick={toggleHologramMode}
            title="Toggle Hologram (Jarvis vs. Ultron) [Key: H]"
          >
            <img 
              src={hologramMode === "jarvis" ? "/ultron.jpg" : "/jarvis.jpg"} 
              className="hologram-avatar" 
              alt="System Avatar"
            />
            <div className="btn-label-group">
              <span className="btn-title">CORE MATRIX</span>
              <span className="btn-status" style={{ textTransform: 'uppercase' }}>
                {hologramMode === "jarvis" ? "ULTRON" : "JARVIS"}
              </span>
            </div>
          </button>

          {/* UTILITY BUTTONS */}
          <button className="dock-btn-advanced" onClick={() => sceneRef.current?.zoomIn()} title="Zoom In">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="hud-svg-icon">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="dock-btn-advanced" onClick={() => sceneRef.current?.zoomOut()} title="Zoom Out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="hud-svg-icon">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="dock-btn-advanced" onClick={() => sceneRef.current?.resetView()} title="Reset View">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="hud-svg-icon">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <div className="btn-label-group">
              <span className="btn-title">VIEWSTATE</span>
              <span className="btn-status">RESET</span>
            </div>
          </button>
        </div>

        <div className="dock-section dock-right">
          <span className="dock-label">POINTER</span>
          <span className="dock-val">X: {coords.x} Y: {coords.y}</span>
        </div>
      </div>
    </>
  );
}
