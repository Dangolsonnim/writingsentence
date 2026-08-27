/**
 * 라이브 카메라 AR 뷰 — 실시간 ArUco 추적 위에 통과 낱말 3D 사물(등급 3/4/5 연출)과
 * 말풍선을 칸 위치에 앵커링. 카메라 불가 시 정지 사진 오버레이 폴백.
 * 추적은 실시간(다운스케일 프레임, ~7fps), 판정(게이트/OCR)은 캡처 1회 — 하이브리드.
 */
import * as THREE from 'three';
import { trackSheet } from '../core/pipeline';
import type { Raster } from '../core/raster';
import { projectPoint, type Homography } from '../core/vision';
import type { DictTemplate } from '../core/worksheet';
import { buildWordScene, type WordScene } from '../three/scenes';
import { playSparkleSound } from '../three/stage';

export interface ArSlotDisplay {
  slotIndex: number;
  sceneKey: string;
  rewardLevel: number; // 0 = 미통과(말풍선만)
  message: string;
  passed: boolean;
}

interface SlotVisual {
  display: ArSlotDisplay;
  scene: WordScene | null;
  sparkle: THREE.Points | null;
  sparkleMat: THREE.PointsMaterial | null;
  bubble: HTMLDivElement;
  smooth: { cx: number; cy: number; w: number } | null;
}

const TRACK_INTERVAL_MS = 140;
const TRACK_WIDTH = 640;

export class LiveArView {
  private video: HTMLVideoElement;
  private glCanvas: HTMLCanvasElement;
  private bubbleLayer: HTMLDivElement;
  private staticCanvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene3 = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 1, 0, -100, 100);
  private stream: MediaStream | null = null;
  private trackTimer: number | null = null;
  private raf = 0;
  private trackCanvas = document.createElement('canvas');
  private homography: Homography | null = null; // page mm → 소스 px
  private sourceW = 0;
  private sourceH = 0;
  private lastSeen = 0;
  private visuals: SlotVisual[] = [];
  private startTime = performance.now();
  private staticMode = false;

  /** 추적 상태 콜백 (마커 수, 다른 차시 감지) */
  onTrack: ((found: number, wrongTemplateId: string | null) => void) | null = null;

  constructor(
    private container: HTMLElement,
    private template: DictTemplate,
    private allTemplates: DictTemplate[]
  ) {
    container.classList.add('ar-container');
    this.video = document.createElement('video');
    this.video.className = 'ar-video';
    this.video.playsInline = true;
    this.video.muted = true;
    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.className = 'ar-video';
    this.staticCanvas.style.display = 'none';
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'ar-overlay';
    this.bubbleLayer = document.createElement('div');
    this.bubbleLayer.className = 'ar-bubbles';
    container.append(this.video, this.staticCanvas, this.glCanvas, this.bubbleLayer);

    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(200, 400, 300);
    this.scene3.add(amb, dir);
  }

  /** 카메라 시작. 실패 시 false(폴백 사용). */
  async startCamera(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.sourceW = this.video.videoWidth;
      this.sourceH = this.video.videoHeight;
      this.staticMode = false;
      this.startLoops();
      return true;
    } catch {
      return false;
    }
  }

  /** 폴백: 정지 사진 표시 + 주어진 호모그래피로 앵커링 */
  showStatic(raster: Raster, homography: Homography): void {
    this.stopCameraOnly();
    this.staticMode = true;
    this.video.style.display = 'none';
    this.staticCanvas.style.display = '';
    this.staticCanvas.width = raster.width;
    this.staticCanvas.height = raster.height;
    this.staticCanvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
    this.sourceW = raster.width;
    this.sourceH = raster.height;
    this.homography = homography;
    this.lastSeen = performance.now();
    this.startLoops();
  }

  /** 현재 비디오 프레임을 풀해상도로 캡처 */
  captureFrame(): Raster | null {
    if (!this.stream || this.video.videoWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { data: img.data, width: img.width, height: img.height };
  }

  /** 판정 결과 표시(캡처 시점 호모그래피는 라이브 추적으로 계속 갱신됨) */
  setResults(results: ArSlotDisplay[]): void {
    this.clearVisuals();
    let playedSound = false;
    for (const display of results) {
      const bubble = document.createElement('div');
      bubble.className = `ar-bubble ${display.passed ? 'praise' : 'nudge'}`;
      bubble.textContent = display.message;
      bubble.style.opacity = '0';
      this.bubbleLayer.appendChild(bubble);
      let ws: WordScene | null = null;
      let sparkle: THREE.Points | null = null;
      let sparkleMat: THREE.PointsMaterial | null = null;
      if (display.passed && display.rewardLevel >= 3) {
        ws = buildWordScene(display.sceneKey);
        ws.group.visible = false;
        this.scene3.add(ws.group);
        if (display.rewardLevel >= 5) {
          const n = 40;
          const pos = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            const r = 1.1 + Math.random() * 0.8;
            const th = Math.random() * Math.PI * 2;
            pos[i * 3] = r * Math.cos(th);
            pos[i * 3 + 1] = 0.9 + Math.random() * 1.2;
            pos[i * 3 + 2] = r * Math.sin(th);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          sparkleMat = new THREE.PointsMaterial({ color: 0xffe066, size: 0.09, transparent: true });
          sparkle = new THREE.Points(geo, sparkleMat);
          ws.group.add(sparkle);
          if (!playedSound) {
            playSparkleSound();
            playedSound = true;
          }
        }
      }
      this.visuals.push({ display, scene: ws, sparkle, sparkleMat, bubble, smooth: null });
    }
    this.startTime = performance.now();
  }

  clearResults(): void {
    this.clearVisuals();
  }

  private clearVisuals(): void {
    for (const v of this.visuals) {
      if (v.scene) this.scene3.remove(v.scene.group);
      v.bubble.remove();
    }
    this.visuals = [];
  }

  private startLoops(): void {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    }
    if (!this.staticMode && this.trackTimer === null) {
      this.trackTimer = window.setInterval(() => this.trackOnce(), TRACK_INTERVAL_MS);
    }
    if (!this.raf) {
      const tick = () => {
        this.renderOverlay();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  private trackOnce(): void {
    if (this.video.videoWidth === 0) return;
    const f = TRACK_WIDTH / this.video.videoWidth;
    const tw = TRACK_WIDTH;
    const th = Math.round(this.video.videoHeight * f);
    this.trackCanvas.width = tw;
    this.trackCanvas.height = th;
    const ctx = this.trackCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0, tw, th);
    const img = ctx.getImageData(0, 0, tw, th);
    const res = trackSheet(
      { data: img.data, width: tw, height: th },
      this.template,
      this.allTemplates
    );
    if (res.homography) {
      // 추적 좌표(소축소 px) → 소스(비디오) px 스케일 반영
      const h = res.homography.slice();
      for (let i = 0; i < 6; i++) h[i] = h[i] / f;
      this.homography = h;
      this.sourceW = this.video.videoWidth;
      this.sourceH = this.video.videoHeight;
      this.lastSeen = performance.now();
    }
    this.onTrack?.(res.markerFound, res.wrongTemplateId);
  }

  /** 소스 px → 화면 px (object-fit: contain 매핑) */
  private toScreen(x: number, y: number, cw: number, ch: number): { x: number; y: number; s: number } {
    const scale = Math.min(cw / this.sourceW, ch / this.sourceH);
    const ox = (cw - this.sourceW * scale) / 2;
    const oy = (ch - this.sourceH * scale) / 2;
    return { x: x * scale + ox, y: y * scale + oy, s: scale };
  }

  private renderOverlay(): void {
    const cw = this.container.clientWidth || 1;
    const ch = this.container.clientHeight || 1;
    if (this.glCanvas.width !== cw || this.glCanvas.height !== ch) {
      this.renderer!.setSize(cw, ch, false);
    }
    this.camera.left = 0;
    this.camera.right = cw;
    this.camera.top = ch;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();

    const fresh = performance.now() - this.lastSeen < 700;
    const t = (performance.now() - this.startTime) / 1000;
    if (this.homography && this.sourceW > 0) {
      for (const v of this.visuals) {
        const slot = this.template.note_slots[v.display.slotIndex];
        // 통과(사물 표시) → 그림 단서 이미지(cue_rect_mm) 위에 앵커링,
        // 미달(말풍선만) → 글씨 칸(rect_mm) 위에 안내 (사용자 확정 2026-08-27)
        const [ax, ay, aw, ah] = v.display.passed ? slot.cue_rect_mm : slot.rect_mm;
        const pTL = projectPoint(this.homography, ax, ay);
        const pTR = projectPoint(this.homography, ax + aw, ay);
        const pC = projectPoint(this.homography, ax + aw / 2, ay + ah / 2);
        const sTL = this.toScreen(pTL.x, pTL.y, cw, ch);
        const sTR = this.toScreen(pTR.x, pTR.y, cw, ch);
        const sC = this.toScreen(pC.x, pC.y, cw, ch);
        const boxW = Math.hypot(sTR.x - sTL.x, sTR.y - sTL.y);
        const target = { cx: sC.x, cy: sC.y, w: boxW };
        if (!v.smooth) v.smooth = { ...target };
        else {
          v.smooth.cx += (target.cx - v.smooth.cx) * 0.35;
          v.smooth.cy += (target.cy - v.smooth.cy) * 0.35;
          v.smooth.w += (target.w - v.smooth.w) * 0.35;
        }
        const { cx, cy, w } = v.smooth;

        v.bubble.style.opacity = fresh ? '1' : '0';
        if (v.display.passed) {
          // 사물이 단서 그림 위에 서고, 말풍선은 사물 오른쪽 옆
          const unit = w * 0.38; // 3D 1유닛 ≈ 단서 그림 폭의 38% (사물 높이 ~2유닛)
          const objTopY = cy - unit * 2.1;
          v.bubble.style.transform = `translate(0, -50%) translate(${cx + w * 0.75}px, ${Math.max(30, objTopY + unit * 0.8)}px)`;
          if (v.scene) {
            const g = v.scene.group;
            g.visible = fresh;
            // 스케일 팝 등장 0.3s (등급 3+ 공통)
            const p = Math.min(1, t / 0.3);
            const pop = p < 1 ? 1.15 * p * (2 - p) : 1;
            g.scale.setScalar(unit * pop);
            g.position.set(cx, ch - cy - unit * 0.1, 0); // y-up 변환, 단서 그림 중앙에 바닥 정렬
            if (v.display.rewardLevel >= 4 && t > 0.35) v.scene.animate(t - 0.35);
            if (v.sparkle && v.sparkleMat) {
              v.sparkle.rotation.y = t * 0.7;
              v.sparkleMat.opacity = 0.55 + Math.sin(t * 8) * 0.4;
            }
          }
        } else {
          // 안내 말풍선: 글씨 칸 바로 위 중앙
          const topY = Math.min(sTL.y, sTR.y);
          v.bubble.style.transform = `translate(-50%, -100%) translate(${cx}px, ${Math.max(30, topY - 6)}px)`;
        }
      }
    } else {
      for (const v of this.visuals) {
        v.bubble.style.opacity = '0';
        if (v.scene) v.scene.group.visible = false;
      }
    }
    this.renderer!.render(this.scene3, this.camera);
  }

  private stopCameraOnly(): void {
    if (this.trackTimer !== null) {
      clearInterval(this.trackTimer);
      this.trackTimer = null;
    }
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
  }

  stop(): void {
    this.stopCameraOnly();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clearVisuals();
    this.renderer?.dispose();
    this.renderer = null;
    this.container.innerHTML = '';
    this.container.classList.remove('ar-container');
  }
}
