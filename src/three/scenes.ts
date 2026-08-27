/**
 * 12낱말 three.js 연출 — 기본 지오메트리만(Sphere/Cylinder/Cone/Capsule/Box/Torus/Plane),
 * 단색 MeshStandardMaterial, 외부 에셋·텍스처 없음 (지시문 §4).
 * 각 빌더는 {group, animate(t)} 반환 — animate는 등급 4+에서만 구동되는 고유 동작 루프 1개.
 */
import * as THREE from 'three';

export interface WordScene {
  group: THREE.Group;
  animate: (t: number) => void;
}

type Builder = () => WordScene;

function mat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05 });
}

function mesh(
  geo: THREE.BufferGeometry,
  color: number
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  return new THREE.Mesh(geo, mat(color));
}

/** 나무 = Cylinder 줄기 + Sphere 수관 — 바람에 흔들림 */
function tree(): WordScene {
  const g = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.1, 12), 0x8b5a2b);
  trunk.position.y = 0.55;
  const crown = mesh(new THREE.SphereGeometry(0.62, 24, 18), 0x2e9e46);
  crown.position.y = 1.45;
  const crown2 = mesh(new THREE.SphereGeometry(0.42, 20, 16), 0x3cb85a);
  crown2.position.set(0.38, 1.15, 0.1);
  const crown3 = mesh(new THREE.SphereGeometry(0.38, 20, 16), 0x27923f);
  crown3.position.set(-0.36, 1.2, -0.05);
  const sway = new THREE.Group();
  sway.add(trunk, crown, crown2, crown3);
  g.add(sway);
  return {
    group: g,
    animate: (t) => {
      sway.rotation.z = Math.sin(t * 1.8) * 0.06;
    },
  };
}

/** 오리 = Sphere 몸 + Sphere 머리 + Cone 부리 — 뒤뚱뒤뚱 */
function duck(): WordScene {
  const g = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(0.55, 24, 18), 0xffe066);
  body.scale.set(1.15, 0.9, 1);
  body.position.y = 0.5;
  const head = mesh(new THREE.SphereGeometry(0.3, 20, 16), 0xffe066);
  head.position.set(0.45, 1.15, 0);
  const beak = mesh(new THREE.ConeGeometry(0.12, 0.3, 12), 0xff8c42);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.78, 1.12, 0);
  const eye = mesh(new THREE.SphereGeometry(0.045, 10, 8), 0x333333);
  eye.position.set(0.58, 1.24, 0.2);
  const eye2 = eye.clone();
  eye2.position.z = -0.2;
  const waddle = new THREE.Group();
  waddle.add(body, head, beak, eye, eye2);
  g.add(waddle);
  return {
    group: g,
    animate: (t) => {
      waddle.rotation.x = Math.sin(t * 5) * 0.09;
      waddle.position.y = Math.abs(Math.sin(t * 5)) * 0.05;
    },
  };
}

/** 나비 = Capsule 몸 + Plane 날개 2 — 날갯짓 */
function butterfly(): WordScene {
  const g = new THREE.Group();
  const body = mesh(new THREE.CapsuleGeometry(0.09, 0.55, 8, 12), 0x5b4b8a);
  body.position.y = 0.9;
  const wingGeo = new THREE.PlaneGeometry(0.62, 0.85);
  const wingL = new THREE.Group();
  const wl = mesh(wingGeo, 0xff7eb6);
  wl.material.side = THREE.DoubleSide;
  wl.position.x = -0.33;
  wingL.add(wl);
  wingL.position.set(-0.06, 0.95, 0);
  const wingR = new THREE.Group();
  const wr = mesh(wingGeo.clone(), 0xff7eb6);
  wr.material.side = THREE.DoubleSide;
  wr.position.x = 0.33;
  wingR.add(wr);
  wingR.position.set(0.06, 0.95, 0);
  const anten = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), 0x5b4b8a);
  anten.position.set(0.05, 1.35, 0);
  anten.rotation.z = -0.4;
  const anten2 = anten.clone();
  anten2.position.x = -0.05;
  anten2.rotation.z = 0.4;
  g.add(body, wingL, wingR, anten, anten2);
  g.rotation.x = -0.35;
  return {
    group: g,
    animate: (t) => {
      const a = Math.sin(t * 9) * 1.0;
      wingL.rotation.y = a;
      wingR.rotation.y = -a;
      g.position.y = Math.sin(t * 2.2) * 0.08;
    },
  };
}

/** 바나나 = 굽힌 Capsule 3 — 시소처럼 흔들림 */
function banana(): WordScene {
  const g = new THREE.Group();
  const bend = new THREE.Group();
  const seg = (rot: number, x: number, y: number) => {
    const c = mesh(new THREE.CapsuleGeometry(0.16, 0.42, 8, 12), 0xffd23f);
    c.rotation.z = rot;
    c.position.set(x, y, 0);
    return c;
  };
  bend.add(seg(0.7, -0.42, 0.62), seg(0, 0, 0.42), seg(-0.7, 0.42, 0.62));
  const tip = mesh(new THREE.SphereGeometry(0.08, 10, 8), 0x8b5a2b);
  tip.position.set(-0.62, 0.85, 0);
  const tip2 = tip.clone();
  tip2.position.set(0.62, 0.85, 0);
  bend.add(tip, tip2);
  bend.position.y = 0.15;
  g.add(bend);
  return {
    group: g,
    animate: (t) => {
      bend.rotation.z = Math.sin(t * 2.6) * 0.18;
    },
  };
}

/** 사과 = Sphere + Cylinder 꼭지 + Plane 잎 — 통통 튐 */
function apple(): WordScene {
  const g = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(0.6, 24, 18), 0xe4393c);
  body.scale.y = 0.92;
  body.position.y = 0.58;
  const stem = mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 8), 0x6b4423);
  stem.position.y = 1.25;
  stem.rotation.z = 0.15;
  const leaf = mesh(new THREE.PlaneGeometry(0.3, 0.16), 0x3cb85a);
  leaf.material.side = THREE.DoubleSide;
  leaf.position.set(0.16, 1.28, 0);
  leaf.rotation.set(-0.5, 0, 0.5);
  const bounce = new THREE.Group();
  bounce.add(body, stem, leaf);
  g.add(bounce);
  return {
    group: g,
    animate: (t) => {
      const p = Math.abs(Math.sin(t * 3.2));
      bounce.position.y = p * 0.25;
      bounce.scale.y = 1 - (1 - p) * 0.08;
    },
  };
}

/** 구름 = Sphere 4~5 군집 — 두둥실 흐름 */
function cloud(): WordScene {
  const g = new THREE.Group();
  const drift = new THREE.Group();
  const puffs: Array<[number, number, number, number]> = [
    [0, 0.9, 0, 0.5],
    [-0.55, 0.82, 0.08, 0.38],
    [0.55, 0.85, -0.06, 0.4],
    [-0.25, 1.12, -0.1, 0.34],
    [0.28, 1.1, 0.1, 0.36],
  ];
  for (const [x, y, z, r] of puffs) {
    const p = mesh(new THREE.SphereGeometry(r, 20, 16), 0xf4f8ff);
    p.position.set(x, y, z);
    drift.add(p);
  }
  g.add(drift);
  return {
    group: g,
    animate: (t) => {
      drift.position.x = Math.sin(t * 0.9) * 0.3;
      drift.position.y = Math.sin(t * 1.7) * 0.06;
    },
  };
}

/** 연필 = Cylinder + Cone 촉 — 끄적끄적 기울여 쓰기 */
function pencil(): WordScene {
  const g = new THREE.Group();
  const write = new THREE.Group();
  const body = mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.5, 6), 0xffb100);
  body.position.y = 1.05;
  const wood = mesh(new THREE.ConeGeometry(0.13, 0.3, 6), 0xf2d0a4);
  wood.rotation.x = Math.PI;
  wood.position.y = 0.15;
  const lead = mesh(new THREE.ConeGeometry(0.05, 0.12, 6), 0x444444);
  lead.rotation.x = Math.PI;
  lead.position.y = 0.06;
  const eraser = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.14, 6), 0xff7eb6);
  eraser.position.y = 1.87;
  write.add(body, wood, lead, eraser);
  write.rotation.z = -0.25;
  g.add(write);
  return {
    group: g,
    animate: (t) => {
      write.rotation.z = -0.25 + Math.sin(t * 6) * 0.1;
      write.position.x = Math.sin(t * 3) * 0.18;
    },
  };
}

/** 눈사람 = Sphere 2단 + Cone 코 — 갸웃갸웃 */
function snowman(): WordScene {
  const g = new THREE.Group();
  const tilt = new THREE.Group();
  const bottom = mesh(new THREE.SphereGeometry(0.6, 24, 18), 0xffffff);
  bottom.position.y = 0.55;
  const top = mesh(new THREE.SphereGeometry(0.4, 22, 16), 0xffffff);
  top.position.y = 1.4;
  const nose = mesh(new THREE.ConeGeometry(0.08, 0.34, 10), 0xff8c42);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.45, 0.5);
  const eyeL = mesh(new THREE.SphereGeometry(0.05, 8, 8), 0x333333);
  eyeL.position.set(-0.14, 1.56, 0.35);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.14;
  const btn = mesh(new THREE.SphereGeometry(0.05, 8, 8), 0x333333);
  btn.position.set(0, 0.75, 0.56);
  const btn2 = btn.clone();
  btn2.position.y = 0.52;
  tilt.add(bottom, top, nose, eyeL, eyeR, btn, btn2);
  g.add(tilt);
  return {
    group: g,
    animate: (t) => {
      tilt.rotation.z = Math.sin(t * 2.4) * 0.12;
    },
  };
}

/** 딸기 = Sphere(적) + 작은 Sphere 씨 + Cone 꼭지 — 콩콩 스쿼시 */
function strawberry(): WordScene {
  const g = new THREE.Group();
  const squash = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(0.55, 24, 18), 0xe4393c);
  body.scale.set(0.95, 1.1, 0.95);
  body.position.y = 0.6;
  squash.add(body);
  const seedGeo = new THREE.SphereGeometry(0.035, 6, 6);
  const golden = 2.39996;
  for (let i = 0; i < 18; i++) {
    const s = mesh(seedGeo, 0xfff3b0);
    const phi = Math.acos(1 - (2 * (i + 0.5)) / 22);
    const theta = golden * i;
    const r = 0.56;
    s.position.set(
      r * Math.sin(phi) * Math.cos(theta) * 0.95,
      0.6 + r * Math.cos(phi) * 1.1,
      r * Math.sin(phi) * Math.sin(theta) * 0.95
    );
    squash.add(s);
  }
  const calyx = mesh(new THREE.ConeGeometry(0.28, 0.2, 8), 0x3cb85a);
  calyx.position.y = 1.25;
  squash.add(calyx);
  g.add(squash);
  return {
    group: g,
    animate: (t) => {
      const p = Math.abs(Math.sin(t * 4));
      squash.position.y = p * 0.22;
      squash.scale.set(1 + (1 - p) * 0.06, 1 - (1 - p) * 0.08, 1 + (1 - p) * 0.06);
    },
  };
}

/** 토끼 = Sphere + Capsule 귀 2 — 깡충깡충 */
function rabbit(): WordScene {
  const g = new THREE.Group();
  const hop = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(0.48, 24, 18), 0xf5f5f5);
  body.scale.set(1, 0.92, 1.05);
  body.position.y = 0.46;
  const head = mesh(new THREE.SphereGeometry(0.32, 22, 16), 0xf5f5f5);
  head.position.set(0, 1.05, 0.18);
  const earGeo = new THREE.CapsuleGeometry(0.09, 0.5, 8, 12);
  const earL = mesh(earGeo, 0xf5f5f5);
  earL.position.set(-0.14, 1.62, 0.1);
  earL.rotation.z = 0.15;
  const earR = mesh(earGeo.clone(), 0xf5f5f5);
  earR.position.set(0.14, 1.62, 0.1);
  earR.rotation.z = -0.15;
  const eyeL = mesh(new THREE.SphereGeometry(0.04, 8, 8), 0x333333);
  eyeL.position.set(-0.12, 1.12, 0.46);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.12;
  const noseP = mesh(new THREE.SphereGeometry(0.045, 8, 8), 0xffa3b1);
  noseP.position.set(0, 1.02, 0.5);
  const tail = mesh(new THREE.SphereGeometry(0.12, 10, 8), 0xffffff);
  tail.position.set(0, 0.5, -0.5);
  hop.add(body, head, earL, earR, eyeL, eyeR, noseP, tail);
  g.add(hop);
  return {
    group: g,
    animate: (t) => {
      const p = Math.abs(Math.sin(t * 4.2));
      hop.position.y = p * 0.35;
      hop.rotation.x = Math.sin(t * 4.2) * 0.06;
    },
  };
}

/** 돼지 = Sphere + Cylinder 코 + Cone 귀 — 뒤뚱 + 코 씰룩 */
function pig(): WordScene {
  const g = new THREE.Group();
  const waddle = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(0.58, 24, 18), 0xffb3c1);
  body.scale.set(1.1, 0.95, 1);
  body.position.y = 0.55;
  const snout = mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.16, 14), 0xff8fa3);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, 0.62, 0.62);
  const nostrilL = mesh(new THREE.SphereGeometry(0.03, 6, 6), 0xc9184a);
  nostrilL.position.set(-0.06, 0.62, 0.71);
  const nostrilR = nostrilL.clone();
  nostrilR.position.x = 0.06;
  const earGeo = new THREE.ConeGeometry(0.14, 0.24, 10);
  const earL = mesh(earGeo, 0xff8fa3);
  earL.position.set(-0.28, 1.06, 0.12);
  earL.rotation.x = -0.3;
  const earR = mesh(earGeo.clone(), 0xff8fa3);
  earR.position.set(0.28, 1.06, 0.12);
  earR.rotation.x = -0.3;
  const eyeL = mesh(new THREE.SphereGeometry(0.045, 8, 8), 0x333333);
  eyeL.position.set(-0.2, 0.82, 0.5);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.2;
  waddle.add(body, snout, nostrilL, nostrilR, earL, earR, eyeL, eyeR);
  g.add(waddle);
  return {
    group: g,
    animate: (t) => {
      waddle.rotation.z = Math.sin(t * 4.6) * 0.07;
      snout.scale.setScalar(1 + Math.max(0, Math.sin(t * 4.6)) * 0.12);
    },
  };
}

/** 무지개 = Torus 절반 5색 — 반짝 스케일 물결 */
function rainbow(): WordScene {
  const g = new THREE.Group();
  const arcs = new THREE.Group();
  const colors = [0xe4393c, 0xff8c42, 0xffd23f, 0x3cb85a, 0x3a86ff];
  const rings: THREE.Mesh[] = [];
  colors.forEach((c, i) => {
    const r = 1.05 - i * 0.14;
    const ring = mesh(new THREE.TorusGeometry(r, 0.055, 12, 48, Math.PI), c);
    rings.push(ring);
    arcs.add(ring);
  });
  const baseL = mesh(new THREE.SphereGeometry(0.16, 12, 10), 0xf4f8ff);
  baseL.position.set(-0.8, 0, 0);
  const baseR = baseL.clone();
  baseR.position.x = 0.8;
  arcs.add(baseL, baseR);
  arcs.position.y = 0.15;
  g.add(arcs);
  return {
    group: g,
    animate: (t) => {
      rings.forEach((ring, i) => {
        const s = 1 + Math.sin(t * 3 - i * 0.5) * 0.03;
        ring.scale.set(s, s, 1);
      });
    },
  };
}

export const WORD_BUILDERS: Record<string, Builder> = {
  tree,
  duck,
  butterfly,
  banana,
  apple,
  cloud,
  pencil,
  snowman,
  strawberry,
  rabbit,
  pig,
  rainbow,
};

export function buildWordScene(sceneKey: string): WordScene {
  const b = WORD_BUILDERS[sceneKey];
  if (!b) throw new Error(`unknown scene: ${sceneKey}`);
  return b();
}
