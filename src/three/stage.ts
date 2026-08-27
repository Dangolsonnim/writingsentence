/**
 * three.js 스테이지 — 그림 단서 정지컷 렌더, 등급 연동 실체화 연출(3/4/5), 모아 보기.
 * 등급 연동(지시문 §4): 3=스케일 팝(0.3s) / 4=+고유 동작 루프 / 5=+Points 반짝임+짧은 효과음.
 * 점수·스티커·랭킹·타이머 UI 금지.
 */
import * as THREE from 'three';
import { buildWordScene, type WordScene } from './scenes';

function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  return r;
}

function makeScene(bg: number | null): THREE.Scene {
  const scene = new THREE.Scene();
  if (bg !== null) scene.background = new THREE.Color(bg);
  const amb = new THREE.AmbientLight(0xffffff, 0.9);
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(2.5, 4, 3);
  const dir2 = new THREE.DirectionalLight(0xbfd7ff, 0.5);
  dir2.position.set(-3, 2, -2);
  scene.add(amb, dir, dir2);
  return scene;
}

function frameCamera(aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(38, aspect, 0.1, 50);
  cam.position.set(0, 1.35, 3.6);
  cam.lookAt(0, 0.85, 0);
  return cam;
}

/** 그림 단서 정지컷 — 화면용·인쇄용 공용 (같은 씬의 렌더, 인쇄와 화면 일치) */
export function renderCueStill(sceneKey: string, size = 512): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const renderer = makeRenderer(canvas);
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const scene = makeScene(0xfffdf5);
  const cam = frameCamera(1);
  const ws = buildWordScene(sceneKey);
  scene.add(ws.group);
  renderer.render(scene, cam);
  const url = canvas.toDataURL('image/png');
  renderer.dispose();
  return url;
}

const cueCache = new Map<string, string>();
export function cueStill(sceneKey: string): string {
  let url = cueCache.get(sceneKey);
  if (!url) {
    url = renderCueStill(sceneKey);
    cueCache.set(sceneKey, url);
  }
  return url;
}

/** 짧은 효과음 (등급 5) — WebAudio 합성, 외부 에셋 없음 */
export function playSparkleSound(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
    window.setTimeout(() => void ctx.close(), 1500);
  } catch {
    // 오디오 불가 환경 무시
  }
}

export interface RewardHandle {
  stop: () => void;
}

/** 실체화 연출 재생 — rewardLevel 3/4/5 */
export function playReward(canvas: HTMLCanvasElement, sceneKey: string, rewardLevel: number): RewardHandle {
  const renderer = makeRenderer(canvas);
  const resize = () => {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  };
  const scene = makeScene(null);
  const cam = frameCamera(1);
  const ws: WordScene = buildWordScene(sceneKey);
  ws.group.scale.setScalar(0.001);
  scene.add(ws.group);

  let sparkle: THREE.Points | null = null;
  let sparkleMat: THREE.PointsMaterial | null = null;
  if (rewardLevel >= 5) {
    const n = 90;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 1.3 + Math.random() * 0.9;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = 0.9 + r * Math.cos(ph) * 0.7;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sparkleMat = new THREE.PointsMaterial({
      color: 0xffe066,
      size: 0.07,
      transparent: true,
      opacity: 0.95,
    });
    sparkle = new THREE.Points(geo, sparkleMat);
    scene.add(sparkle);
    playSparkleSound();
  }

  resize();
  window.addEventListener('resize', resize);
  const start = performance.now();
  let raf = 0;
  const tick = () => {
    const t = (performance.now() - start) / 1000;
    // 스케일 팝 등장 0.3s (등급 3+ 공통) — overshoot easing
    const p = Math.min(1, t / 0.3);
    const pop = p < 1 ? 1.15 * p * (2 - p) : 1 + Math.max(0, 0.15 * (1 - (t - 0.3) / 0.2));
    ws.group.scale.setScalar(Math.max(0.001, pop));
    if (rewardLevel >= 4 && t > 0.35) ws.animate(t - 0.35);
    if (sparkle && sparkleMat) {
      sparkle.rotation.y = t * 0.7;
      sparkleMat.opacity = 0.55 + Math.sin(t * 8) * 0.4;
    }
    renderer.render(scene, cam);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    stop: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}

/** 세트 완료 모아 보기 — 잔디판(Plane) 위 통과 낱말 배치 */
export function playCollection(
  canvas: HTMLCanvasElement,
  items: Array<{ sceneKey: string; rewardLevel: number }>
): RewardHandle {
  const renderer = makeRenderer(canvas);
  const scene = makeScene(0xdff3ff);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
  cam.position.set(0, 3.1, 7.2);
  cam.lookAt(0, 0.6, 0);
  const resize = () => {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  };

  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 7),
    new THREE.MeshStandardMaterial({ color: 0x7ec850, roughness: 0.95 })
  );
  grass.rotation.x = -Math.PI / 2;
  scene.add(grass);

  const words: WordScene[] = [];
  const spread = Math.max(1, items.length - 1);
  items.forEach((item, i) => {
    const ws = buildWordScene(item.sceneKey);
    ws.group.position.x = (i - spread / 2) * 2.3;
    ws.group.scale.setScalar(0.9);
    scene.add(ws.group);
    words.push(ws);
  });

  resize();
  window.addEventListener('resize', resize);
  let raf = 0;
  const start = performance.now();
  const tick = () => {
    const t = (performance.now() - start) / 1000;
    words.forEach((w, i) => {
      if (items[i].rewardLevel >= 4) w.animate(t + i * 0.6);
    });
    cam.position.x = Math.sin(t * 0.25) * 0.8;
    cam.lookAt(0, 0.6, 0);
    renderer.render(scene, cam);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    stop: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}
