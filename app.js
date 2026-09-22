/* ============================================================
 * ETRI 본원 3D 조감도
 *  - 건물: OSM 실측 윤곽 + ETRI 배치도 기반 동번호 매핑
 *  - 외형: 층별 창문 텍스처 / 옥상 구조물 / 출입구 표시
 *  - 환경: 위성사진 기반 (숲, 운동장, 주차장, 잔디)
 *  - 층/호실: 사내 MeetMap 데이터 (내부판 전용)
 *  - 경로: OSM 캠퍼스 도로망 Dijkstra 탐색 (정문/후문 → 건물 출입구)
 * ============================================================ */
(function () {
  'use strict';

  const D = ETRI_DATA;
  // 모바일(스마트폰) 품질 스케일 — mobile.html에서 window.__MOBILE__ 설정
  const MOBILE = window.__MOBILE__ === true ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 820);
  const QUALITY = MOBILE ? 0.45 : 1;          // 수목·입자 밀도 배율
  const MM = D.meetmapBase || '';
  const PUBLIC_MODE = D.publicMode === true;      // 외부 공개판: 내부 시설정보 미포함
  const FLOOR_H = 3.4;          // 층고 (m) — 창문 텍스처 정렬 기준

  /* ---------------- palette ---------------- */
  const COLORS = {
    groundOuter: 0x24391f,      // 외곽 숲 바닥
    campus: 0x4e5a4b,           // 캠퍼스 포장면
    roadMain: 0x39404f,
    roadCampus: 0x5a6376,
    highlightEmissive: 0x2a3fae,
    hoverEmissive: 0x1b2a80,
    route: 0xf59e0b,
  };
  // 벽/창/지붕 색 (카테고리별)
  const SKIN = {
    research: { wall: '#b8c4d4', win: '#33475e', roof: 0x8e99a8 },
    admin:    { wall: '#d4c8ae', win: '#4a4436', roof: 0x77906d },  // 녹화지붕(위성사진)
    welfare:  { wall: '#d8c2b0', win: '#54443a', roof: 0x9aa08e },
    special:  { wall: '#c0d2c6', win: '#3c5648', roof: 0x97a29a },
    util:     { wall: '#b0b4ba', win: '#3e4248', roof: 0x82868c },
  };
  const CATEGORY = {
    '1': 'admin', '2': 'admin', '5': 'welfare', '9': 'admin',
    '3': 'research', '6': 'research', '7': 'research', '12': 'research', '13': 'research', '11': 'research',
    '4': 'special', '8': 'admin', '10': 'special', '902': 'special', '903': 'welfare',
    '901': 'util',
  };
  const SOLAR_ROOF = new Set(['5', '6', '7', '13']);   // 위성사진의 태양광 패널

  /* ---------------- three.js scene ---------------- */
  const wrap = document.getElementById('canvas3d');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MOBILE ? 1.5 : 2));
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  wrap.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fbcd9);
  scene.fog = new THREE.Fog(0x8fbcd9, 950, 2300);

  const camera = new THREE.PerspectiveCamera(52, wrap.clientWidth / wrap.clientHeight, 2, 5000);
  const HOME = { pos: new THREE.Vector3(420, 330, -520), tgt: new THREE.Vector3(-20, 0, -40) };
  camera.position.copy(HOME.pos);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.tgt);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 40;
  controls.maxDistance = 1600;
  controls.update();

  // lights
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x35452f, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.0);
  sun.position.set(-300, 420, -220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
  sun.shadow.camera.left = -650; sun.shadow.camera.right = 650;
  sun.shadow.camera.top = 650; sun.shadow.camera.bottom = -650;
  sun.shadow.camera.far = 1600;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // ground: 외곽(숲 바닥) + 캠퍼스 포장면
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4200, 4200),
    new THREE.MeshLambertMaterial({ color: COLORS.groundOuter })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(860, 800),
    new THREE.MeshLambertMaterial({ color: COLORS.campus })
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-55, 0.25, -25);   // 서측 대형 주차장(x≈-438)까지 포장면 확장   // z-fighting 방지 층분리
  pad.receiveShadow = true;
  scene.add(pad);

  /* ---------------- 산 (매봉산 등 — 위성사진 기반) ---------------- */
  // 가우시안 언덕 합: hillHeight(x,z) = Σ h·exp(-d²/s²)
  const HILLS = [
    { x: 620, z: 80, s: 210, h: 78 },     // 매봉산 (동측, 144m)
    { x: 480, z: 420, s: 170, h: 48 },    // 남동 능선
    { x: 60, z: 720, s: 230, h: 62 },     // 남측 산림
    { x: -700, z: 40, s: 200, h: 50 },    // 서측 산림
    { x: 620, z: -560, s: 180, h: 42 },   // 북동 (가정로 건너)
    { x: -520, z: -640, s: 190, h: 38 },  // 북서
    // 1동(행정동) 동측·북동측 야산 — cut: 기슭을 평지로 잘라 주차장(x≤182)을 침범하지 않게 함
    { x: 320, z: 30, s: 105, h: 48, cut: 10, dense: 3, mesh: false },   // 메시는 RIDGE와 합쳐 렌더
  ];
  // 1동(행정동) 북동·동·남동측 얕은 능선 — 정문 진입로 동편 ~ 12동 동편까지의 다각형 영역
  // 높이 = h × (경계로부터의 내측 거리 / ramp, 최대 1) + 완만한 굴곡
  // tight: 건물·도로 사이 좁은 띠 — 나무 배치 시 회피 여유를 최소로 두고 소형 수목 사용
  const RIDGES = [
    { // 1동 동측 (정문 진입로 동편 ~ 12동 동편)
      poly: [[138, -92], [255, -102], [300, -70], [300, 200], [235, 235], [200, 232], [200, 168],
             [192, 168], [192, 88], [186, 88], [186, 0], [138, 0]],
      h: 15, ramp: 42, dense: 260,
    },
    { // 12동 북측·서측 + 저수지 북측 (캠퍼스 도로 동편, 횡단보도 아래) — 연결된 얕은 산
      poly: [[77, 158], [84, 158], [86, 178], [92, 176], [108, 167], [198, 166], [201, 171], [192, 175],
             [138, 175], [138, 191], [114, 192], [110, 203], [96, 204], [96, 216], [48, 216], [57, 208],
             [66, 195], [70, 183], [74, 170]],
      h: 7, ramp: 14, dense: 110, tight: true,
    },
    { // 후문 동측 ~ 가정로 남측 ~ ETRI 정문 서측 대형 야산: 8동 북·동, 4동 서·북, 3동 서·북, 주차빌딩 서·북, 9동 북측
      poly: [[-247, -262], [-45, -214], [118, -201], [118, -196], [105, -190], [-16, -193], [-12, -166],
             [-47, -160], [-47, -112], [-95, -112], [-95, -101], [-113, -101], [-113, -113], [-135, -137],
             [-185, -135], [-232, -156], [-250, -172]],
      h: 14, ramp: 35, dense: 380,
    },
    { // 서측 대형 야산: 11동 남·동측, 10동 북·서·남측, 6동·7동·축구장·야구장 서편 도로(x≈-142) 서쪽 전역
      poly: [[-415, -77], [-300, -77], [-300, -88], [-224, -88], [-224, -120], [-205, -120], [-190, -108],
             [-186, -96], [-181, -85], [-176, -76], [-220, -73], [-220, -12], [-152, -12],
             [-152, 30], [-182, 30], [-182, 80], [-152, 80],
             // 남서측 확장(운동장 서편 도로 x≈-142 서쪽만): x -450~-152, z 172~421 — 운동장·주차장·잔디 영역 밖
             [-152, 421], [-450, 421], [-450, 172], [-366, 172], [-415, 20]],
      h: 16, ramp: 40, dense: 600,
    },
    { // 후문 서측 단지 남측·동측 얕은 야산 띠: 후문 도로 서편(남북) + 단지 접시안테나 남측 ~ 11동 주차장 북측(동서)
      // 후문 도로 서편 남북 띠 — 남단은 사선 도로(후문 삼거리 → 11동 주차장)의 북서 5m 선에서 끝냄
      poly: [[-272, -268], [-263, -268], [-263, -168.4], [-272, -162.3]],
      h: 5, ramp: 6, dense: 120, tight: true, noFlat: true, roadMargin: 3,
    },
    { // 단지 서측 남북 대형 띠(순환도로 x≈-423 서편, z -295~-161) + 단지 남측 동서 띠(테니스장 남측 ~ x -369, 주차장 북측 띠와 연결) — ㄴ자 한 덩어리
      poly: [[-455, -295], [-428, -295], [-428, -161], [-369, -161], [-369, -147], [-374, -147], [-374, -151], [-455, -151]],
      h: 5, ramp: 6, dense: 300, tight: true, noFlat: true, roadMargin: 4.5,
    },
    { // 11동 주차장 북측 경계(z≈-147~-141)를 따라 동쪽으로 → 사선 도로 북서편(4~10m)을 따라 후문 삼거리 방향
      poly: [[-374, -147], [-305.9, -145.7], [-264, -173.8], [-260.6, -168.8], [-302.6, -140.7], [-312, -141], [-374, -141]],
      h: 5, ramp: 6, dense: 120, tight: true, noFlat: true, roadMargin: 3,
    },
    { // 동력동 동측(도로와 건물 사이 띠) + 남측 — 얕은 능선
      poly: [[66, 98], [73, 98], [71, 152], [71, 168], [30, 168], [30, 154], [66, 154]],
      h: 5, ramp: 10, dense: 40, tight: true,
    },
  ];
  function ridgeHeight(x, z) {
    let y = 0;
    for (const R of RIDGES) y += ridgeOne(R, x, z);
    return y;
  }
  function ridgeOne(RIDGE, x, z) {
    const P = RIDGE.poly;
    if (!pointInFoot(P, x, z)) return 0;
    let dmin = Infinity;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const ax = P[j][0], az = P[j][1], bx = P[i][0], bz = P[i][1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx - x, qz = az + t * dz - z;
      dmin = Math.min(dmin, qx * qx + qz * qz);
    }
    const k = Math.min(1, Math.sqrt(dmin) / RIDGE.ramp);
    const wave = 1 + 0.22 * Math.sin(x / 23) * Math.cos(z / 31);
    return RIDGE.h * k * wave * (RIDGE.noFlat ? 1 : flatMask(x, z));
  }
  // 평탄 유지 구역 (주차장 등): 내부 0, 경계 밖 15m에 걸쳐 1로 복귀
  const FLAT_ZONES = [
    [[-445, -160], [-303, -160], [-303, -79], [-445, -79]],   // 11동 서측 대형 주차장
    [[-445, -275], [-262, -275], [-262, -142], [-445, -142]], // 후문 서측 단지
    [[188, 226], [305, 226], [305, 335], [188, 335]],         // 드론시험동 단지 + 12동 주차장 동측 (남동 능선 기슭 평탄화)
    [[184, -194], [304, -194], [304, -129], [184, -129]],     // 정문 동측(13동 서편) 주차장 (매봉산 기슭 평탄화)
  ];
  function flatMask(x, z) {
    let f = 1;
    for (const P of FLAT_ZONES) {
      if (pointInFoot(P, x, z)) return 0;
      let dmin = Infinity;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const ax = P[j][0], az = P[j][1], bx = P[i][0], bz = P[i][1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx - x, qz = az + t * dz - z;
        dmin = Math.min(dmin, qx * qx + qz * qz);
      }
      f = Math.min(f, Math.min(1, Math.sqrt(dmin) / 15));
    }
    return f;
  }
  const hillRaw = (H, x, z) => {
    const d2 = ((x - H.x) ** 2 + (z - H.z) ** 2) / (H.s * H.s);
    return d2 < 9 ? Math.max(0, H.h * Math.exp(-d2) - (H.cut || 0)) * flatMask(x, z) : 0;
  };
  function hillHeight(x, z) {
    let y = 0;
    for (const H of HILLS) y += hillRaw(H, x, z);
    return y + ridgeHeight(x, z);
  }
  // 능선 + 1동 동측 야산: 하나의 격자 메시 (합산 높이 — 나무 배치 높이와 일치)
  (function ridgeMesh() {
    const HE = HILLS.find(H => H.mesh === false);
    const minX = -460, maxX = 560, minZ = -300, maxZ = 430;   // 서측 후문 띠(x<-430)·운동장 서편 야산(z>330)까지 포함
    const nx = 255, nz = 183;
    const g = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, nx, nz);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + (minX + maxX) / 2, wz = pos.getZ(i) + (minZ + maxZ) / 2;
      pos.setY(i, ridgeHeight(wx, wz) + (HE ? hillRaw(HE, wx, wz) : 0) - 0.35);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x2f4a26 }));
    m.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    m.receiveShadow = true;
    scene.add(m);
  })();
  HILLS.forEach(H => {
    if (H.mesh === false) return;
    const size = H.s * 3.4;
    const seg = 36;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + H.x, wz = pos.getZ(i) + H.z;
      // 이 언덕 성분만 반영(겹침 중복 방지) + 가장자리 0 수렴
      pos.setY(i, hillRaw(H, wx, wz) - 0.35);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x2b4022 }));
    m.position.set(H.x, 0, H.z);
    m.receiveShadow = true;
    scene.add(m);
  });

  /* ---------------- helpers ---------------- */
  function centroid(foot) {
    let x = 0, z = 0;
    foot.forEach(p => { x += p[0]; z += p[1]; });
    return [x / foot.length, z / foot.length];
  }
  function bbox(foot) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    foot.forEach(p => {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    });
    return { minX, maxX, minZ, maxZ };
  }
  function pointInFoot(foot, x, z) {
    let inside = false;
    for (let i = 0, j = foot.length - 1; i < foot.length; j = i++) {
      const xi = foot[i][0], zi = foot[i][1], xj = foot[j][0], zj = foot[j][1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }
  function footShape(foot) {
    const s = new THREE.Shape();
    foot.forEach((p, i) => {
      if (i === 0) s.moveTo(p[0], -p[1]); else s.lineTo(p[0], -p[1]);
    });
    s.closePath();
    return s;
  }
  function flatShape(foot, color, y, opacity) {
    const geo = new THREE.ShapeGeometry(footShape(foot));
    geo.rotateX(-Math.PI / 2);   // (x,-z)평면 → XZ 지면
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide,
      transparent: opacity !== undefined, opacity: opacity === undefined ? 1 : opacity
    }));
    m.position.y = y;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  }
  function outlineLoop(foot, color, y, lw) {
    const pts = foot.concat([foot[0]]).map(p => new THREE.Vector3(p[0], y, p[1]));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, linewidth: lw || 1 }));
    scene.add(l);
    return l;
  }
  function scaleFoot(foot, s) {
    const [cx, cz] = centroid(foot);
    return foot.map(p => [cx + (p[0] - cx) * s, cz + (p[1] - cz) * s]);
  }
  // deterministic RNG
  function makeRng(seed) {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  }

  /* ---------------- wall textures (창문) ---------------- */
  const texCache = {};
  function wallTexture(cat) {
    if (texCache[cat]) return texCache[cat];
    const sk = SKIN[cat];
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;               // 1셀 = 가로 3.2m × 세로 3.4m
    const g = c.getContext('2d');
    g.fillStyle = sk.wall;                     // 벽
    g.fillRect(0, 0, 96, 96);
    g.fillStyle = 'rgba(0,0,0,0.10)';          // 층 슬래브 라인
    g.fillRect(0, 90, 96, 6);
    g.fillStyle = sk.win;                      // 창문
    g.fillRect(20, 26, 56, 46);
    const grad = g.createLinearGradient(0, 26, 0, 72);   // 유리 반사
    grad.addColorStop(0, 'rgba(255,255,255,0.32)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.06)');
    grad.addColorStop(1, 'rgba(255,255,255,0.16)');
    g.fillStyle = grad;
    g.fillRect(20, 26, 56, 46);
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2;  // 창틀
    g.strokeRect(20, 26, 56, 46);
    g.beginPath(); g.moveTo(48, 26); g.lineTo(48, 72); g.stroke(); // 중간 창살
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / 3.2, 1 / FLOOR_H);      // 측면 UV가 미터 단위 → 셀 크기 지정
    tex.anisotropy = 4;
    texCache[cat] = tex;
    return tex;
  }

  /* ---------------- buildings ---------------- */
  const pickables = [];
  const bMeshes = {};
  const labels = [];

  // 옥상 구조물 anchor: 최장 변 중점에서 내심 방향으로 이동(오목 다각형 안전)
  function roofAnchor(foot) {
    const [cx, cz] = centroid(foot);
    let bi = 0, bl = -1;
    for (let i = 0; i < foot.length; i++) {
      const a = foot[i], b = foot[(i + 1) % foot.length];
      const L = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (L > bl) { bl = L; bi = i; }
    }
    const a = foot[bi], b = foot[(bi + 1) % foot.length];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const d = Math.hypot(cx - mx, cz - mz) || 1;
    const t = Math.min(7, d * 0.35);
    return [mx + (cx - mx) / d * t, mz + (cz - mz) / d * t];
  }

  function addBuilding(b, idx) {
    const rng = makeRng(1000 + idx * 77);
    const h = b.levels * FLOOR_H + 1.0;        // +1.0 파라펫
    const cat = CATEGORY[b.id] || 'research';
    const sk = SKIN[cat];

    if (b.arch) {                                   // 아치지붕 창고형 건물(드론시험동): 압출 대신 전용 형상
      addArchHall(b.arch, 0xd9dde3, 0xeef0f2, b.id);
      if (b.entry) {
        const [ex, ez] = b.entry;
        const dl = Math.hypot(b.entryDir[0], b.entryDir[1]) || 1;
        addDoor(ex, ez, b.entryDir[0] / dl, b.entryDir[1] / dl);
      }
      const el = document.createElement('div');            // 건물명 라벨 (아치 지붕 위)
      el.className = 'lbl3d'; el.textContent = b.name; wrap.appendChild(el);
      labels.push({ el, pos: new THREE.Vector3(b.center[0], b.arch.wallH + b.arch.archH + 8, b.center[1]), bid: b.id, minDist: 1300 });
      return;
    }

    const geo = new THREE.ExtrudeGeometry(footShape(b.foot), { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const roofMat = new THREE.MeshLambertMaterial({ color: b.roofC || sk.roof, side: THREE.DoubleSide });
    const wallMat = new THREE.MeshLambertMaterial({
      map: wallTexture(cat), side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, [roofMat, wallMat]);   // group0=상하면, group1=측면
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.bid = b.id;
    scene.add(mesh);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 40),
      new THREE.LineBasicMaterial({ color: 0x33405c, transparent: true, opacity: 0.4 })
    );
    scene.add(edge);

    // ---- 옥상 구조물 (계단탑/기계실 + 실외기, 일부 태양광) ----
    const [ax, az] = roofAnchor(b.foot);
    const ph = new THREE.Mesh(
      new THREE.BoxGeometry(5 + rng() * 3, 2.6, 3.5 + rng() * 2),
      new THREE.MeshLambertMaterial({ color: 0x9aa0a6 })
    );
    ph.position.set(ax, h + 1.3, az);
    ph.castShadow = true;
    scene.add(ph);
    const ac = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.0, 1.4),
      new THREE.MeshLambertMaterial({ color: 0xb9bfc6 })
    );
    ac.position.set(ax + 4 + rng() * 2, h + 0.5, az - 2 - rng() * 2);
    scene.add(ac);
    if (SOLAR_ROOF.has(b.id)) {
      const pan = new THREE.Mesh(
        new THREE.BoxGeometry(10 + rng() * 6, 0.3, 6 + rng() * 3),
        new THREE.MeshLambertMaterial({ color: 0x1e3a5f })
      );
      pan.position.set(ax - 6 - rng() * 3, h + 0.35, az + 4 + rng() * 2);
      pan.rotation.y = rng() * 0.4;
      scene.add(pan);
    }

    // ---- 출입구: 도어 + 캐노피 ----
    if (b.entry) {
      const [ex, ez] = b.entry;
      const dirx = b.entryDir ? b.entryDir[0] : ex - b.center[0];
      const dirz = b.entryDir ? b.entryDir[1] : ez - b.center[1];
      const dl = Math.hypot(dirx, dirz) || 1;
      addDoor(ex, ez, dirx / dl, dirz / dl);            // 외측 법선(지정 또는 근사)
    }
    (b.doors || []).forEach(([ex, ez, nx, nz]) => addDoor(ex, ez, nx, nz));   // 보조 출입구
    function addDoor(ex, ez, nx, nz) {
      const yaw = Math.atan2(nx, nz);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 3.0, 0.5),
        new THREE.MeshLambertMaterial({ color: 0x27333f })
      );
      door.position.set(ex + nx * 0.15, 1.5, ez + nz * 0.15);
      door.rotation.y = yaw;
      scene.add(door);
      const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(5.2, 0.35, 3.2),
        new THREE.MeshLambertMaterial({ color: 0x54606e })
      );
      canopy.position.set(ex + nx * 1.7, 3.3, ez + nz * 1.7);
      canopy.rotation.y = yaw;
      canopy.castShadow = true;
      scene.add(canopy);
      [-1.8, 1.8].forEach(off => {
        const px = ex + nx * 3.0 - nz * off, pz = ez + nz * 3.0 + nx * off;
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.14, 3.15, 6),
          new THREE.MeshLambertMaterial({ color: 0x54606e })
        );
        post.position.set(px, 1.6, pz);
        scene.add(post);
      });
    }

    pickables.push(mesh);
    bMeshes[b.id] = { mesh, roofMat, wallMat, height: h };

    const el = document.createElement('div');
    el.className = 'lbl3d';
    el.textContent = b.name;
    wrap.appendChild(el);
    labels.push({ el, pos: new THREE.Vector3(b.center[0], h + 9, b.center[1]), bid: b.id, minDist: 1300 });
  }
  D.buildings.forEach(addBuilding);

  // 선택된 건물의 입구 라벨 (공용 1개)
  const entryLbl = (() => {
    const el = document.createElement('div');
    el.className = 'lbl3d entry';
    el.textContent = '▼ 입구';
    el.style.display = 'none';
    wrap.appendChild(el);
    return { el, pos: new THREE.Vector3(), minDist: 700, visible: false };
  })();
  labels.push(entryLbl);

  // minor structures / parking tower / UST (context)
  // 아치(볼트) 지붕 창고: 직육면체 벽체 + 반원통 지붕(높이 archH로 눌러 씀). yaw: +x→+z 방향 각도(도)
  function addArchHall(a, wallColor, roofColor, bid) {
    const rotY = -a.yaw * Math.PI / 180;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(a.L, a.wallH, a.W),
      new THREE.MeshLambertMaterial({ color: wallColor }));
    walls.position.set(a.cx, a.wallH / 2, a.cz); walls.rotation.y = rotY;
    const rg = new THREE.CylinderGeometry(a.W / 2, a.W / 2, a.L, 28, 1, false, 0, Math.PI);
    rg.rotateZ(Math.PI / 2);                       // 원통축 → 길이(X), 반원 → 위쪽
    rg.scale(1, a.archH / (a.W / 2), 1);
    const roof = new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ color: roofColor, side: THREE.DoubleSide }));
    roof.position.set(a.cx, a.wallH, a.cz); roof.rotation.y = rotY;
    [walls, roof].forEach(m => { m.castShadow = true; m.receiveShadow = true; if (bid) m.userData.bid = bid; scene.add(m); });
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(walls.geometry, 40),
      new THREE.LineBasicMaterial({ color: 0x33405c, transparent: true, opacity: 0.35 }));
    edge.position.copy(walls.position); edge.rotation.y = rotY; scene.add(edge);
  }
  function addSimple(foot, h, color, opacity) {
    const geo = new THREE.ExtrudeGeometry(footShape(foot), { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color, transparent: opacity < 1, opacity, side: THREE.DoubleSide
    }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
  D.structures.forEach(s => {
    if (s.arch) addArchHall(s.arch, 0xd9dde3, s.color || 0xe6e8eb);
    else addSimple(s.foot, s.h, s.color || 0x8b93a1, 1);
    if (s.name) {                                   // 이름 있는 구조물(에뜨리에 연결동 등) 라벨
      const c = centroid(s.foot);
      const el = document.createElement('div');
      el.className = 'lbl3d'; el.style.opacity = '.85'; el.textContent = s.name;
      wrap.appendChild(el);
      labels.push({ el, pos: new THREE.Vector3(c[0], s.h + 5, c[1]), minDist: 500 });
    }
  });
  addSimple(D.parkingTower.foot, D.parkingTower.h, 0x7d8796, 1);
  {
    const c = centroid(D.parkingTower.foot);
    const el = document.createElement('div');
    el.className = 'lbl3d'; el.textContent = 'P 주차빌딩';
    wrap.appendChild(el);
    labels.push({ el, pos: new THREE.Vector3(c[0], D.parkingTower.h + 7, c[1]), minDist: 700 });
  }
  addSimple(D.ust.foot, D.ust.h, 0x6b7280, 0.55);
  {
    const c = centroid(D.ust.foot);
    const el = document.createElement('div');
    el.className = 'lbl3d'; el.style.opacity = '.65'; el.textContent = 'UST';
    wrap.appendChild(el);
    labels.push({ el, pos: new THREE.Vector3(c[0], D.ust.h + 7, c[1]), minDist: 900 });
  }

  /* ---------------- 운동장 / 주차장 / 잔디 ---------------- */
  const avoidRects = [];   // 나무 배치 회피 영역
  D.buildings.forEach(b => { const r = bbox(b.foot); avoidRects.push([r.minX - 8, r.maxX + 8, r.minZ - 8, r.maxZ + 8]); });
  [D.parkingTower, D.ust].concat(D.structures).forEach(s => {
    const r = bbox(s.foot); avoidRects.push([r.minX - 5, r.maxX + 5, r.minZ - 5, r.maxZ + 5]);
  });

  /* ---------------- 경기장 시설 · 선수 (축구/야구/족구) ---------------- */
  const sportsActors = [];
  const SP_SCALE = 2.4;
  let fieldMode = 'play';         // play(낮) | bench(해질녘) | off(한밤중)
  let fieldModeAuto = true;       // 시간에 따라 자동 전환
  const activeSports = new Set(['soccer', 'baseball', 'jokgu', 'tennis']);
  function pushActor(sport, players, props, fn) {
    sportsActors.push({ sport, players, props: props || [], fn, hidden: false });
  }

  // 대기석(더그아웃) 생성 + 퇴장/귀가 처리 헬퍼
  function makeBench(x, z, yaw, seats) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    const W = seats * 1.9;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(W, 0.18, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x8c6b47 }));
    seat.position.y = 1.0;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(W, 0.9, 0.14),
      new THREE.MeshLambertMaterial({ color: 0x7a5c3c }));
    back.position.set(0, 1.5, -0.45);
    g.add(back);
    for (let i = 0; i <= seats; i += Math.max(1, Math.round(seats / 3))) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.0, 0.7),
        new THREE.MeshLambertMaterial({ color: 0x5f4630 }));
      leg.position.set(-W / 2 + (W * i) / seats, 0.5, 0);
      g.add(leg);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.16, 2.6),
      new THREE.MeshLambertMaterial({ color: 0x40566b }));
    roof.position.set(0, 3.1, 0.2);
    g.add(roof);
    [-W / 2 - 0.4, W / 2 + 0.4].forEach(px => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.1, 6),
        new THREE.MeshLambertMaterial({ color: 0x5b6672 }));
      post.position.set(px, 1.55, 1.3);
      g.add(post);
    });
    g.scale.setScalar(SP_SCALE * 0.85);
    g.traverse(o => { o.castShadow = true; });
    scene.add(g);
    // 좌석 좌표(월드)
    const spots = [];
    for (let i = 0; i < seats; i++) {
      const lx = (-W / 2 + 0.95 + i * 1.9) * SP_SCALE * 0.85;
      spots.push([x + Math.cos(yaw) * lx, z - Math.sin(yaw) * lx, yaw]);
    }
    return spots;
  }
  // 대기석 착석 자세 / 귀가(숨김) 처리. play가 아니면 true 반환.
  function idleField(players, benchSpots, props, t) {
    if (fieldMode === 'play') {
      players.forEach(p => {
        p.group.visible = true;
        [p.legL, p.legR].forEach(leg => {                     // 착석 자세 원복
          const calf = leg.children[1], shoe = leg.children[2];
          if (calf.rotation.x !== 0) {
            calf.rotation.x = 0; calf.position.set(0, -0.664, 0);
            if (shoe) { shoe.rotation.x = 0; shoe.position.set(0, -0.86, 0.06); }
          }
        });
      });
      (props || []).forEach(o => { o.visible = true; });
      return false;
    }
    const off = fieldMode === 'off';
    (props || []).forEach(o => { o.visible = false; });
    players.forEach((p, i) => {
      p.group.visible = !off;
      if (off) return;
      const s = benchSpots[i % benchSpots.length];
      const dup = Math.floor(i / benchSpots.length) * 1.6;
      // 좌판에 엉덩이를 붙이고 허벅지는 수평, 무릎 아래 정강이는 수직으로 내림
      const seatTop = 1.09 * SP_SCALE * 0.85;                 // 벤치 좌판 상단(월드)
      const hipH = 0.88 * SP_SCALE;                           // 선 자세의 고관절 높이
      p.group.position.set(s[0] + Math.sin(s[2]) * dup,
        seatTop - hipH, s[1] + Math.cos(s[2]) * dup);
      p.group.rotation.y = s[2];                              // 경기장 쪽을 바라보며 착석
      [p.legL, p.legR].forEach(leg => {
        leg.rotation.x = -Math.PI / 2;                        // 허벅지: 앞으로 수평
        const calf = leg.children[1], shoe = leg.children[2];
        calf.rotation.x = Math.PI / 2;                        // 정강이: 아래로 수직
        calf.position.set(0, -0.462, -0.21);
        if (shoe) { shoe.rotation.x = Math.PI / 2; shoe.position.set(0, -0.53, -0.44); }
      });
      p.armL.rotation.x = -0.25 + Math.sin(t * 1.1 + i) * 0.12;
      p.armR.rotation.x = -0.25 + Math.cos(t * 0.9 + i) * 0.12;
      p.armL.rotation.z = 0; p.armR.rotation.z = 0;
    });
    return true;
  }
  function mkPlayer(topC, botC) {
    const skin = 0xe8b98f;
    const m = c => new THREE.MeshLambertMaterial({ color: c });
    const grp = new THREE.Group();
    const mkLimb = (jx, jy, w, len, c1, c2, shoe) => {
      const g = new THREE.Group();
      g.position.set(jx, jy, 0);
      const up = new THREE.Mesh(new THREE.BoxGeometry(w, len * 0.55, w), m(c1));
      up.position.y = -len * 0.275;
      g.add(up);
      const lo = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, len * 0.5, w * 0.85), m(c2));
      lo.position.y = -len * 0.79;
      g.add(lo);
      if (shoe) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 0.3), m(0x23272c));
        s.position.set(0, -len - 0.02, 0.06);
        g.add(s);
      }
      grp.add(g);
      return g;
    };
    const legL = mkLimb(-0.11, 0.86, 0.16, 0.84, botC, skin, true);
    const legR = mkLimb(0.11, 0.86, 0.16, 0.84, botC, skin, true);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.24), m(topC));
    torso.position.y = 1.18;
    grp.add(torso);
    const armL = mkLimb(-0.29, 1.4, 0.11, 0.58, topC, skin, false);
    const armR = mkLimb(0.29, 1.4, 0.11, 0.58, topC, skin, false);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), m(skin));
    head.position.y = 1.62;
    grp.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.175, 10, 8, 0, Math.PI * 2, 0, Math.PI / 1.9), m(0x2b2118));
    hair.position.y = 1.65;
    grp.add(hair);
    grp.traverse(o => { o.castShadow = true; });
    grp.scale.setScalar(SP_SCALE);
    scene.add(grp);
    const topMats = [torso.material, armL.children[0].material, armR.children[0].material];
    const botMats = [legL.children[0].material, legR.children[0].material];
    return {
      group: grp, legL, legR, armL, armR,
      recolor(top, bot) {
        topMats.forEach(m => m.color.setHex(top));
        botMats.forEach(m => m.color.setHex(bot));
      },
    };
  }
  function mkBall(color, r) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 10),
      new THREE.MeshLambertMaterial({ color }));
    b.castShadow = true;
    scene.add(b);
    return b;
  }
  function runLegs(p, ph, amp) {
    const s = Math.sin(ph) * (amp === undefined ? 0.7 : amp);
    p.legL.rotation.x = s; p.legR.rotation.x = -s;
    p.armL.rotation.x = -s * 0.8; p.armR.rotation.x = s * 0.8;
  }

  function buildSoccerScene(foot) {
    const b = bbox(foot);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const vert = (b.maxZ - b.minZ) > (b.maxX - b.minX);
    const GW = 7.4, GH = 2.6, GD = 2.0;                 // 골대 규격
    const postMat = new THREE.MeshLambertMaterial({ color: 0xf4f7fa });
    const netMat = new THREE.MeshLambertMaterial({
      color: 0xd8e4ee, transparent: true, opacity: 0.32, side: THREE.DoubleSide
    });
    [[1, vert ? b.minZ : b.minX], [-1, vert ? b.maxZ : b.maxX]].forEach(([sgn, end]) => {
      const g = new THREE.Group();
      g.position.set(vert ? cx : end, 0, vert ? end : cz);
      g.rotation.y = vert ? 0 : Math.PI / 2;
      [-GW / 2, GW / 2].forEach(px => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, GH, 8), postMat);
        post.position.set(px, GH / 2, 0);
        g.add(post);
      });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(GW + 0.28, 0.24, 0.24), postMat);
      bar.position.y = GH;
      g.add(bar);
      const net = new THREE.Mesh(new THREE.BoxGeometry(GW, GH, GD), netMat);
      net.position.set(0, GH / 2, sgn * -GD / 2);
      g.add(net);
      g.traverse(o => { o.castShadow = true; });
      scene.add(g);
    });
    // 선수 22명 (양 팀) + 공
    const TEAMS = [0xd93b3b, 0x2a5fd0];
    const players = [];
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < 8; i++) {
        const p = mkPlayer(TEAMS[t], t ? 0xf2f4f7 : 0x1f2937);
        const lane = (i - 3.5) / 3.5;
        players.push({
          p,
          hx: cx + (vert ? lane * (b.maxX - b.minX) * 0.36 : (t ? 0.22 : -0.22) * (b.maxX - b.minX)),
          hz: cz + (vert ? (t ? 0.22 : -0.22) * (b.maxZ - b.minZ) : lane * (b.maxZ - b.minZ) * 0.36),
          rx: 7 + (i % 3) * 4, rz: 6 + (i % 4) * 4,
          sp: 0.55 + (i % 5) * 0.11, ph: i * 0.9 + t * 2.1,
        });
      }
    }
    // 골키퍼 (양 팀 1명씩, 골라인 앞에서 좌우 이동)
    const keepers = [];
    [[1, vert ? b.minZ : b.minX, 0x2fae6a], [-1, vert ? b.maxZ : b.maxX, 0xf0c419]]
      .forEach(([sgn, end, kc], i) => {
        const gk = mkPlayer(kc, 0x1f2937);
        keepers.push({
          gk, sgn, i,
          bx: vert ? cx : end - sgn * -6, bz: vert ? end - sgn * -6 : cz,
          vert, end,
        });
      });
    const benchSpots = makeBench(                             // 축구 대기석 (터치라인 밖, 경기장 쪽을 향함)
      vert ? b.minX - 9 : cx, vert ? cz : b.minZ - 9, vert ? Math.PI / 2 : 0, 9);
    const ball = mkBall(0xf7f9fb, 0.8);
    const ballPath = new THREE.CatmullRomCurve3(
      [[0.0, -0.30], [0.28, -0.12], [-0.22, 0.05], [0.16, 0.28], [-0.30, 0.16], [0.05, -0.08]]
        .map(([u, v]) => new THREE.Vector3(
          cx + (vert ? u : v) * (b.maxX - b.minX) * 0.8,
          1.0,
          cz + (vert ? v : u) * (b.maxZ - b.minZ) * 0.8)),
      true);
    const soccerAll = players.map(q => q.p).concat(keepers.map(k => k.gk));
    pushActor('soccer', soccerAll, [ball], t => {
      if (idleField(soccerAll, benchSpots, [ball], t)) return;
      players.forEach(q => {
        const a = t * q.sp + q.ph;
        const x = q.hx + Math.cos(a) * q.rx, z = q.hz + Math.sin(a * 1.3) * q.rz;
        const dx = -Math.sin(a) * q.rx * q.sp, dz = Math.cos(a * 1.3) * q.rz * q.sp * 1.3;
        q.p.group.position.set(x, 0.05 + Math.abs(Math.cos(a * 4)) * 0.12, z);
        q.p.group.rotation.y = Math.atan2(dx, dz);
        runLegs(q.p, a * 4);
      });
      const u = (t * 0.045) % 1;
      ballPath.getPointAt(u, ball.position);
      ball.position.y = 0.9 + Math.abs(Math.sin(t * 3.1)) * 2.2;
      ball.rotation.x = t * 3;
      // 골키퍼: 공 위치를 따라 골라인 앞에서 좌우로 이동 + 가끔 세이브 동작
      keepers.forEach(k => {
        const lateral = k.vert ? ball.position.x : ball.position.z;
        const homeL = k.vert ? cx : cz;
        const halfW = (k.vert ? (b.maxX - b.minX) : (b.maxZ - b.minZ)) * 0.5;
        const track = homeL + Math.max(-halfW * 0.22, Math.min(halfW * 0.22, (lateral - homeL) * 0.45));
        const depth = k.end + k.sgn * 5.5;
        const a = t * 1.6 + k.i * 2.0;
        if (k.vert) k.gk.group.position.set(track, 0.05, depth);
        else k.gk.group.position.set(depth, 0.05, track);
        k.gk.group.rotation.y = k.vert ? (k.sgn > 0 ? 0 : Math.PI) : (k.sgn > 0 ? Math.PI / 2 : -Math.PI / 2);
        const dive = Math.max(0, Math.sin(a * 0.5));            // 준비 → 점프 세이브
        k.gk.armL.rotation.z = 0.5 + dive * 0.9;
        k.gk.armR.rotation.z = -0.5 - dive * 0.9;
        k.gk.armL.rotation.x = -0.3 * dive;
        k.gk.armR.rotation.x = -0.3 * dive;
        k.gk.legL.rotation.x = 0.25 * dive;
        k.gk.legR.rotation.x = -0.25 * dive;
        k.gk.group.position.y = 0.05 + dive * 0.55;
      });
    });
  }

  function buildBaseballScene(foot) {
    const b = bbox(foot);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const s = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) * 0.3;
    // 구장 방향: 홈플레이트 → 중견수가 북동(NE)을 향하도록 설정
    const TH = 45 * Math.PI / 180;                            // 방위각(북=0, 시계방향)
    const dir = [Math.sin(TH), -Math.cos(TH)];                // (동, 남) 성분
    const rgt = [Math.sin(TH + Math.PI / 2), -Math.cos(TH + Math.PI / 2)];
    const at = (fwd, side) => [cx + dir[0] * fwd + rgt[0] * side, cz + dir[1] * fwd + rgt[1] * side];
    const home = at(-s, 0), second = at(s, 0), first = at(0, s), third = at(0, -s);
    const mPos = at(-s * 0.06, 0);                            // 마운드(홈~2루 사이 중앙부)
    fieldLine([home, first, second, third, home]);            // 내야 라인
    const dirt = new THREE.MeshLambertMaterial({ color: 0xc2a271, side: THREE.DoubleSide });
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.6, 0.5, 16), dirt);
    mound.position.set(mPos[0], 0.72, mPos[1]);               // 투수 마운드
    mound.receiveShadow = true;
    scene.add(mound);
    const rubber = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.4),
      new THREE.MeshLambertMaterial({ color: 0xf4f7fa }));
    rubber.position.set(mPos[0], 1.0, mPos[1]);
    rubber.rotation.y = -TH;
    scene.add(rubber);
    // 파울 라인 (홈 → 1루/3루 연장) — 구장 폴리곤 경계에서 잘라 인접 경기장 침범 방지
    function rayExit(origin, dirv) {
      let best = Infinity;
      for (let i = 0; i < foot.length; i++) {
        const A = foot[i], B = foot[(i + 1) % foot.length];
        const ex = B[0] - A[0], ez = B[1] - A[1];
        const den = dirv[0] * ez - dirv[1] * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((A[0] - origin[0]) * ez - (A[1] - origin[1]) * ex) / den;
        const u = ((A[0] - origin[0]) * dirv[1] - (A[1] - origin[1]) * dirv[0]) / den;
        if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
      }
      return best;
    }
    [first, third].forEach(bs => {
      const dv = [bs[0] - home[0], bs[1] - home[1]];
      const len = Math.hypot(dv[0], dv[1]) || 1;
      const un = [dv[0] / len, dv[1] / len];
      const exit = rayExit(home, un);
      const reach = Math.min(isFinite(exit) ? exit - 2.5 : len * 2.2, len * 2.2);
      fieldLine([home, [home[0] + un[0] * reach, home[1] + un[1] * reach]]);
    });
    [first, second, third].forEach(pos => {                   // 1·2·3루 베이스
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 2.0),
        new THREE.MeshLambertMaterial({ color: 0xf4f7fa }));
      base.position.set(pos[0], 0.6, pos[1]);
      base.castShadow = true;
      scene.add(base);
    });
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.2, 5),
      new THREE.MeshLambertMaterial({ color: 0xf4f7fa }));
    plate.position.set(home[0], 0.6, home[1]);                // 홈 플레이트
    scene.add(plate);
    const box = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 0.14, 20), dirt);
    box.position.set(home[0], 0.55, home[1]);                 // 홈 주변 흙
    scene.add(box);

    const yawTo = (from, to) => Math.atan2(to[0] - from[0], to[1] - from[1]);
    const pitcher = mkPlayer(0xf2f4f7, 0x2a5fd0);
    pitcher.group.position.set(mPos[0], 0.95, mPos[1]);
    pitcher.group.rotation.y = yawTo(mPos, home);             // 홈 방향
    const batterPos = at(-s, -2.6);
    const batter = mkPlayer(0xd93b3b, 0x1f2937);
    batter.group.position.set(batterPos[0], 0.05, batterPos[1]);
    const batYaw = yawTo(batterPos, mPos);
    batter.group.rotation.y = batYaw;
    const bat = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 2.1, 8),
      new THREE.MeshLambertMaterial({ color: 0xb98a4a }));
    bat.position.set(0, -0.72, 0.12);
    bat.rotation.x = -0.5;
    batter.armR.add(bat);
    const catcherPos = at(-s - 4.2, 0);
    const catcher = mkPlayer(0x2a5fd0, 0x1f2937);
    catcher.group.position.set(catcherPos[0], 0.05, catcherPos[1]);
    catcher.group.rotation.y = yawTo(catcherPos, mPos);
    const fielders = [];
    [at(2, s + 3), at(s + 3, 2), at(2, -s - 3),               // 1·2·3루수
     at(s * 1.9, -s * 1.1), at(s * 1.9, s * 1.1), at(s * 2.3, 0)]   // 외야수
      .forEach((pos, i) => {
        const f = mkPlayer(0xf2f4f7, 0x2a5fd0);
        f.group.position.set(pos[0], 0.05, pos[1]);
        f.group.rotation.y = yawTo(pos, home);
        fielders.push({ f, ph: i * 1.3 });
      });
    // 주자 4명 풀 — 야구 룰에 따라 진루
    const runners = [0, 1, 2, 3].map(() => {
      const r = mkPlayer(0xd93b3b, 0x1f2937);
      r.group.visible = false;
      return r;
    });
    const scoreEl = document.createElement('div');            // 스코어보드 (화면 표시 안 함 — 문구 갱신만 유지)
    scoreEl.className = 'lbl3d score';
    // 더그아웃: 1루·3루 라인과 평행, 그라운드 안쪽을 향하도록 배치
    function dugoutAlong(lineTo) {
      const mid = [(home[0] + lineTo[0]) / 2, (home[1] + lineTo[1]) / 2];
      let nx = mid[0] - cx, nz = mid[1] - cz;
      const L = Math.hypot(nx, nz) || 1;
      nx /= L; nz /= L;                                       // 그라운드 바깥 방향
      return makeBench(mid[0] + nx * 15, mid[1] + nz * 15, Math.atan2(-nx, -nz), 7);
    }
    const benchSpots = dugoutAlong(first).concat(dugoutAlong(third));
    const ball = mkBall(0xf7f9fb, 0.55);
    const BASES = [first, second, third];                     // 1·2·3루
    const PERIOD = 6.5;
    // 경기 상태
    let baseRunner = [null, null, null];                      // 각 루의 주자 풀 인덱스
    let prevBase = [null, null, null];
    let outs = 0, inning = 1, half = 0, score = [0, 0], offense = 0;
    let lastCyc = -1, play = null;
    const TEAM_UNI = [[0xd93b3b, 0x1f2937], [0xf2f4f7, 0x2a5fd0]];

    function newPlay(h) {
      const roll = h % 100;
      // 삼진 18% · 뜬공아웃 22% · 땅볼아웃 10% · 안타 30% · 2루타 12% · 실책 4% · 홈런 4%
      let kind, adv, isOut, caught = false;
      if (roll < 18) { kind = 'K'; adv = 0; isOut = true; }
      else if (roll < 40) { kind = 'F'; adv = 0; isOut = true; caught = true; }
      else if (roll < 50) { kind = 'G'; adv = 0; isOut = true; }
      else if (roll < 80) { kind = '1B'; adv = 1; isOut = false; }
      else if (roll < 92) { kind = '2B'; adv = 2; isOut = false; }
      else if (roll < 96) { kind = 'E'; adv = 2; isOut = false; }
      else { kind = 'HR'; adv = 4; isOut = false; }
      // 타구 방향·비거리
      const dirSel = (((h >>> 7) % 7) - 3) / 3;               // -1(좌) ~ +1(우)
      const depth = kind === 'HR' ? 2.9 : kind === 'G' ? 0.75 : 1.4 + ((h >>> 11) % 4) * 0.42;
      const hp = at(s * depth, dirSel * s * depth * 0.85);
      // 진루 계산
      const moves = [];
      const nb = [null, null, null];
      let runsScored = 0;
      for (let i = 2; i >= 0; i--) {
        const idx = baseRunner[i];
        if (idx === null) continue;
        if (adv === 0) { nb[i] = idx; moves.push({ idx, from: BASES[i], to: BASES[i], hold: true }); continue; }
        const tgt = i + adv;
        if (tgt >= 3) { moves.push({ idx, from: BASES[i], to: home, score: true }); runsScored++; }
        else { nb[tgt] = idx; moves.push({ idx, from: BASES[i], to: BASES[tgt] }); }
      }
      let batterTo = null;
      if (!isOut) {
        const tgt = adv - 1;
        if (tgt >= 3) { runsScored++; batterTo = home; }       // 홈런
        else {
          batterTo = BASES[tgt];
          const free = runners.findIndex((r, i) => !nb.includes(i) && !Object.values(baseRunner).includes(i));
          nb[tgt] = free >= 0 ? free : 3;
        }
      }
      return { kind, adv, isOut, caught, hp, moves, nb, runsScored, batterTo };
    }
    function stateText() {
      const on = ['1', '2', '3'].filter((n, i) => baseRunner[i] !== null);
      return `⚾ ${inning}회${half ? '말' : '초'} · ${outs}아웃 · ` +
        (on.length ? `주자 ${on.join('·')}루` : '주자없음') + ` · ${score[0]}:${score[1]}`;
    }

    const bbAll = [pitcher, batter, catcher].concat(fielders.map(q => q.f)).concat(runners);
    pushActor('baseball', bbAll, [ball], t => {
      if (idleField(bbAll, benchSpots, [ball], t)) return;

      const cycIdx = Math.floor(t / PERIOD);
      const u = (t % PERIOD) / PERIOD;
      if (cycIdx !== lastCyc) {                               // 새 타석
        if (play) {                                           // 직전 타석 결과 확정
          baseRunner = play.nb;
          score[offense] += play.runsScored;
          if (play.isOut) outs++;
          if (outs >= 3) {                                    // 3아웃 → 공수 교대
            outs = 0; baseRunner = [null, null, null];
            half ^= 1; if (!half) inning++;
            offense ^= 1;
            const offUni = TEAM_UNI[offense], defUni = TEAM_UNI[offense ^ 1];
            batter.recolor(offUni[0], offUni[1]);
            runners.forEach(r => r.recolor(offUni[0], offUni[1]));
            pitcher.recolor(defUni[0], defUni[1]);
            catcher.recolor(defUni[0], defUni[1]);
            fielders.forEach(q => q.f.recolor(defUni[0], defUni[1]));
          }
        }
        lastCyc = cycIdx;
        prevBase = baseRunner.slice();
        play = newPlay((cycIdx * 2654435761) >>> 0);
        play.fielderIdx = fielders.reduce((bi, q, i) => {
          const hb = fielders[bi].home || [fielders[bi].f.group.position.x, fielders[bi].f.group.position.z];
          const hq = q.home || [q.f.group.position.x, q.f.group.position.z];
          const d0 = (hb[0] - play.hp[0]) ** 2 + (hb[1] - play.hp[1]) ** 2;
          const d1 = (hq[0] - play.hp[0]) ** 2 + (hq[1] - play.hp[1]) ** 2;
          return d1 < d0 ? i : bi;
        }, 0);
        scoreEl.textContent = stateText();
      }
      const isHit = !play.isOut || play.caught;               // 타구 발생 여부
      const hitPt = play.hp;
      const fielderIdx = play.fielderIdx;

      // ---- 투수 · 타자 ----
      let bx = home[0], bz = home[1], by = 1.3;
      if (u < 0.30) {                                         // 와인드업 → 투구
        const k = u / 0.30;
        if (bat.parent !== batter.armR) {                     // 새 타자: 배트 다시 들기
          batter.armR.add(bat);
          bat.position.set(0, -0.72, 0.12);
          bat.rotation.set(-0.5, 0, 0);
        }
        pitcher.armR.rotation.x = -3.1 * k;
        pitcher.legL.rotation.x = 0.6 * Math.sin(k * Math.PI);
        batter.armR.rotation.x = -0.6;
        batter.group.rotation.y = batYaw;
        batter.group.position.set(batterPos[0], 0.05, batterPos[1]);
        runLegs(batter, 0, 0);
        // 투구 전: 주자는 각 루에 대기
        runners.forEach((r, i) => { r.group.visible = prevBase.includes(i); });
        prevBase.forEach((idx, bi) => {
          if (idx === null) return;
          const r = runners[idx];
          r.group.position.set(BASES[bi][0] + 1.2, 0.05, BASES[bi][1] + 0.6);
          r.group.rotation.y = yawTo(BASES[bi], bi < 2 ? BASES[bi + 1] : home);
          runLegs(r, 0, 0);
        });
        const w = Math.max(0, (k - 0.55) / 0.45);
        bx = mPos[0] + (home[0] - mPos[0]) * w; bz = mPos[1] + (home[1] - mPos[1]) * w;
        by = 2.2 - w * 0.9;
        ball.visible = w > 0;
      } else if (u < 0.40) {                                  // 스윙
        const k = (u - 0.30) / 0.10;
        pitcher.armR.rotation.x = -3.1 + 3.1 * k;
        batter.armR.rotation.x = -0.6 - k * 1.5;
        batter.group.rotation.y = batYaw - k * 1.6;
        ball.visible = true;
      } else {                                                // 타구 · 주루
        const k = (u - 0.40) / 0.60;
        pitcher.armR.rotation.x = 0;
        pitcher.legL.rotation.x = 0;
        if (play.kind === 'K') {                              // 삼진 — 포수 포구
          const w = Math.min(1, k / 0.3);
          bx = home[0] + (catcherPos[0] - home[0]) * w;
          bz = home[1] + (catcherPos[1] - home[1]) * w;
          by = 1.3 - w * 0.4;
          batter.group.position.set(batterPos[0], 0.05, batterPos[1]);
          batter.group.rotation.y = batYaw - 1.6 + Math.min(1, k * 2) * 1.6;
          batter.armR.rotation.x = -0.6;
        } else {
          const flyT = play.kind === 'G' ? 0.28 : 0.42;
          const fly = Math.min(1, k / flyT);
          bx = home[0] + (hitPt[0] - home[0]) * fly;
          bz = home[1] + (hitPt[1] - home[1]) * fly;
          const arc = play.kind === 'G' ? 1.6 : play.kind === 'HR' ? 22 : 13;
          by = 1.3 + Math.sin(fly * Math.PI) * arc;
          if (play.kind === 'HR') by = Math.max(by, 1.3 + fly * 10);   // 담장 넘김
          if (k > flyT + 0.06 && play.kind !== 'HR') {
            const th2 = Math.min(1, (k - flyT - 0.06) / 0.34);
            if (play.kind === 'E') {                          // 실책 — 공이 굴러감
              const rx = hitPt[0] + (hitPt[0] - home[0]) * 0.22, rz = hitPt[1] + (hitPt[1] - home[1]) * 0.22;
              bx = hitPt[0] + (rx - hitPt[0]) * th2; bz = hitPt[1] + (rz - hitPt[1]) * th2; by = 0.6;
            } else {                                          // 포구 후 내야 송구
              bx = hitPt[0] + (second[0] - hitPt[0]) * th2;
              bz = hitPt[1] + (second[1] - hitPt[1]) * th2;
              by = 1.2 + Math.sin(th2 * Math.PI) * 7;
            }
          }
          // 배트를 내려놓고 주루 (아웃이어도 1루까지 달림)
          if (bat.parent !== scene) {
            scene.add(bat);
            bat.position.set(home[0] + 1.6, 0.75, home[1] + 1.2);
            bat.rotation.set(Math.PI / 2, 0.6, 0);
          }
          const dest = play.batterTo || first;
          const run = Math.min(1, Math.max(0, (k - 0.05) / (play.adv > 1 ? 0.72 : 0.5)));
          batter.group.position.set(
            home[0] + (dest[0] - home[0]) * run, 0.05 + Math.abs(Math.sin(k * 26)) * 0.12,
            home[1] + (dest[1] - home[1]) * run);
          batter.group.rotation.y = yawTo(home, dest);
          runLegs(batter, k * 26, 0.85);
        }
        // 기존 주자 진루 (진루 폭은 타격 결과에 따라 다름)
        const runU = Math.min(1, Math.max(0, (k - 0.05) / 0.6));
        const moving = new Set(play.moves.map(mv => mv.idx));
        runners.forEach((r, i) => { if (!moving.has(i)) r.group.visible = false; });
        play.moves.forEach(mv => {
          const r = runners[mv.idx];
          if (!r) return;
          r.group.visible = true;
          if (mv.hold) {                                      // 아웃 — 제자리 리드오프
            r.group.position.set(mv.from[0], 0.05, mv.from[1]);
            r.group.rotation.y = yawTo(mv.from, second);
            runLegs(r, 0, 0);
            return;
          }
          r.group.position.set(mv.from[0] + (mv.to[0] - mv.from[0]) * runU,
            0.05 + Math.abs(Math.sin(k * 24)) * 0.12,
            mv.from[1] + (mv.to[1] - mv.from[1]) * runU);
          r.group.rotation.y = yawTo(mv.from, mv.to);
          runLegs(r, k * 24, 0.8);
          if (mv.score && runU > 0.96) r.group.visible = false;   // 득점 후 더그아웃
        });
      }
      ball.position.set(bx, by, bz);

      // ---- 수비: 타구 방향으로 이동 후 복귀 ----
      fielders.forEach((q, i) => {
        const a = t * 1.5 + q.ph;
        const base = q.home || (q.home = [q.f.group.position.x, q.f.group.position.z]);
        let px = base[0], pz = base[1], running = 0;
        let reach = 0;
        if (u >= 0.40 && play.kind !== 'K') {
          const k = (u - 0.40) / 0.60;
          if (i === fielderIdx) {                             // 타구 처리 담당
            const go = Math.min(1, k / 0.42), back = Math.max(0, (k - 0.62) / 0.38);
            const tx = base[0] + (hitPt[0] - base[0]) * go, tz = base[1] + (hitPt[1] - base[1]) * go;
            px = tx + (base[0] - tx) * back; pz = tz + (base[1] - tz) * back;
            running = 1;
            // 포구(뜬공 아웃) 시 글러브 들어올림 / 실책 시 놓치는 동작
            if (play.caught && k > 0.34 && k < 0.6) reach = 1;
            if (play.kind === 'E' && k > 0.34 && k < 0.58) reach = -1;
          } else {                                            // 나머지는 타구 쪽으로 커버
            const cov = Math.min(1, k / 0.6) * 0.22;
            px = base[0] + (hitPt[0] - base[0]) * cov;
            pz = base[1] + (hitPt[1] - base[1]) * cov;
            running = 0.5;
          }
        }
        q.f.group.position.set(px, 0.05 + (reach > 0 ? 0.45 : 0)
          + (running ? Math.abs(Math.sin(t * 16)) * 0.12 : Math.abs(Math.sin(a)) * 0.08), pz);
        if (reach) {                                          // 포구/낙구 동작
          q.f.group.rotation.y = Math.atan2(ball.position.x - px, ball.position.z - pz);
          q.f.armL.rotation.x = reach > 0 ? -2.6 : -1.1;
          q.f.armR.rotation.x = reach > 0 ? -2.4 : -0.6;
          q.f.legL.rotation.x = 0.25; q.f.legR.rotation.x = -0.25;
        } else if (running) {
          q.f.group.rotation.y = Math.atan2(ball.position.x - px, ball.position.z - pz);
          runLegs(q.f, t * 16, 0.7 * running);
        } else {
          q.f.group.rotation.y = yawTo([px, pz], home);
          q.f.armL.rotation.x = -0.5 + Math.sin(a) * 0.15;
          q.f.armR.rotation.x = -0.5 - Math.sin(a) * 0.15;
          q.f.legL.rotation.x = 0; q.f.legR.rotation.x = 0;
        }
      });
      catcher.armL.rotation.x = -1.2;
      catcher.group.position.set(catcherPos[0], -0.2, catcherPos[1]);   // 포수 앉은 자세
      catcher.legL.rotation.x = 1.1; catcher.legR.rotation.x = 1.1;
    });
  }

  /* ---------------- 도로 가로등 (주기 배치, 야간 점등) ---------------- */
  const streetLamps = { headMat: null, glowMat: null };
  const noLampZones = [];        // 태양광 카포트 등 구조물 아래는 가로등 제외
  function buildStreetLamps() {
    const POLE_H = 7.2, SPACING = 34;
    const spots = [];
    D.roads.forEach(r => {
      if (r.kind === 'walk') return;
      const half = (r.kind === 'main' ? 13 : r.kind === 'boulevard' ? 11 : 6.5) / 2 + 2.2;
      let carry = 0, flip = 0;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i], [bx2, bz2] = r.pts[i + 1];
        const dx = bx2 - ax, dz = bz2 - az;
        const L = Math.hypot(dx, dz);
        if (L < 0.1) continue;
        const ux = dx / L, uz = dz / L;
        const nx = -uz, nz = ux;                       // 법선(도로 옆)
        let s = SPACING - carry;
        while (s < L) {
          const side = (flip++ % 2) ? 1 : -1;
          const lx = ax + ux * s + nx * half * side;
          const lz = az + uz * s + nz * half * side;
          const blocked = noLampZones.some(z0 =>
            lx > z0[0] && lx < z0[1] && lz > z0[2] && lz < z0[3]);
          if (!blocked) {
            spots.push({ x: lx, z: lz, yaw: Math.atan2(-nx * side, -nz * side) });
          }
          s += SPACING;
        }
        carry = (L - (s - SPACING)) % SPACING;
      }
    });
    if (!spots.length) return;
    const poleG = new THREE.CylinderGeometry(0.16, 0.24, POLE_H, 7);
    poleG.translate(0, POLE_H / 2, 0);
    const armG = new THREE.BoxGeometry(0.12, 0.12, 2.0);
    armG.translate(0, POLE_H - 0.15, 1.0);
    const headG = new THREE.BoxGeometry(0.62, 0.22, 1.05);
    headG.translate(0, POLE_H - 0.35, 1.9);
    const poleM = new THREE.MeshLambertMaterial({ color: 0x8d949c });
    const headM = new THREE.MeshLambertMaterial({ color: 0xc9cfd5 });
    const mkInst = (geo, mat) => {
      const im = new THREE.InstancedMesh(geo, mat, spots.length);
      im.castShadow = true;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      spots.forEach((s, i) => {
        q.setFromAxisAngle(up, s.yaw);
        m4.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(1, 1, 1));
        im.setMatrixAt(i, m4);
      });
      scene.add(im);
      return im;
    };
    mkInst(poleG, poleM);
    mkInst(armG, poleM);
    mkInst(headG, headM);
    // 바닥 조명 원 (야간)
    const glowG = new THREE.CircleGeometry(7.5, 14);
    glowG.rotateX(-Math.PI / 2);
    const glowM = new THREE.MeshBasicMaterial({
      color: 0xffe0a0, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const gi = new THREE.InstancedMesh(glowG, glowM, spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    spots.forEach((s, i) => {
      q.setFromAxisAngle(up, s.yaw);
      const gx = s.x + Math.sin(s.yaw) * 1.9, gz = s.z + Math.cos(s.yaw) * 1.9;
      m4.compose(new THREE.Vector3(gx, 0.85, gz), q, new THREE.Vector3(1, 1, 1));
      gi.setMatrixAt(i, m4);
    });
    scene.add(gi);
    streetLamps.headMat = headM;
    streetLamps.glowMat = glowM;
  }

  /* ---------------- 야간 조명탑 ---------------- */
  const floodLamps = [];       // {mat, glow} — 야간에 점등
  function makeFloodlight(x, z, aimZ) {
    const g = new THREE.Group();
    const H = 16;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, H, 10),
      new THREE.MeshLambertMaterial({ color: 0xe7ebef }));
    pole.position.y = H / 2;
    pole.castShadow = true;
    g.add(pole);
    const rack = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.35, 1.2),
      new THREE.MeshLambertMaterial({ color: 0xd8dde2 }));
    rack.position.y = H + 0.4;
    g.add(rack);
    const lampMat = new THREE.MeshLambertMaterial({ color: 0xbfc6cd });
    for (let i = 0; i < 6; i++) {                    // 6등 헤드
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.55, 0.95), lampMat);
      lamp.position.set(-2.1 + i * 0.84, H + 0.95, 0.1);
      lamp.rotation.x = 0.35 * (aimZ > z ? 1 : -1);
      g.add(lamp);
    }
    g.position.set(x, 0, z);
    g.traverse(o => { o.castShadow = true; });
    scene.add(g);
    // 점등 시 바닥 조명 원 (야간 전용)
    const glow = new THREE.Mesh(new THREE.CircleGeometry(17, 24),
      new THREE.MeshBasicMaterial({
        color: 0xfff0c8, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(x, 0.72, z + (aimZ > z ? 11 : -11));
    scene.add(glow);
    floodLamps.push({ mat: lampMat, glow });
  }

  function buildTennisScene(foot, withPlayers) {
    const b = bbox(foot);
    const CL = 23.8, CW = 10.97, SW = 8.23, SVC = 6.4;        // 코트 규격(남북 방향)
    const nC = Math.max(1, Math.min(4, Math.floor((b.maxX - b.minX) / 14)));
    const slot = (b.maxX - b.minX) / nC;
    const cz = (b.minZ + b.maxZ) / 2;
    // 코트별 대기석 (서측 가장자리 남북 배열, 코트를 향해 동향) — 경기 종료·야간 모드에서 선수 착석/귀가
    const tnBenches = withPlayers
      ? [-14.4, -4.8, 4.8, 14.4].map(dz => makeBench(b.minX - 3.4, cz + dz, Math.PI / 2, 2)) : null;
    const postMat = new THREE.MeshLambertMaterial({ color: 0xcfd6dd });
    const netMat = new THREE.MeshLambertMaterial({
      color: 0x2f3a45, transparent: true, opacity: 0.55, side: THREE.DoubleSide
    });
    for (let c = 0; c < nC; c++) {
      const cx = b.minX + slot * (c + 0.5);
      const x0 = cx - CW / 2, x1 = cx + CW / 2;
      const z0 = cz - CL / 2, z1 = cz + CL / 2;
      const LY = 0.66;
      fieldLine([[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]], LY);   // 복식 사이드/베이스라인
      fieldLine([[cx - SW / 2, z0], [cx - SW / 2, z1]], LY);               // 단식 사이드라인
      fieldLine([[cx + SW / 2, z0], [cx + SW / 2, z1]], LY);
      fieldLine([[cx - SW / 2, cz - SVC], [cx + SW / 2, cz - SVC]], LY);   // 서비스 라인
      fieldLine([[cx - SW / 2, cz + SVC], [cx + SW / 2, cz + SVC]], LY);
      fieldLine([[cx, cz - SVC], [cx, cz + SVC]], LY);                     // 센터 서비스 라인
      fieldLine([[cx, z0], [cx, z0 + 0.7]], LY);                           // 센터 마크
      fieldLine([[cx, z1 - 0.7], [cx, z1]], LY);
      // 네트 (동서 방향)
      const NH = 1.07;
      [x0 - 0.9, x1 + 0.9].forEach(px => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, NH + 0.25, 8), postMat);
        post.position.set(px, (NH + 0.25) / 2, cz);
        post.castShadow = true;
        scene.add(post);
      });
      // 네트는 코트 폭(X축) 방향으로 펼쳐짐 — PlaneGeometry 기본 XY평면 사용(회전 불필요)
      const net = new THREE.Mesh(new THREE.PlaneGeometry(CW + 1.8, NH * 0.9), netMat);
      net.position.set(cx, NH * 0.55, cz);
      net.castShadow = true;
      scene.add(net);
      const tape = new THREE.Mesh(new THREE.BoxGeometry(CW + 1.8, 0.1, 0.07),
        new THREE.MeshLambertMaterial({ color: 0xf4f7fa }));
      tape.position.set(cx, NH, cz);
      scene.add(tape);
      const band = new THREE.Mesh(new THREE.BoxGeometry(CW + 1.8, 0.12, 0.05),
        new THREE.MeshLambertMaterial({ color: 0x1b2128 }));
      band.position.set(cx, 0.08, cz);                        // 네트 하단
      scene.add(band);

      // 야간 조명탑 (사진 참조: 코트 양측 백색 폴 + 다등 헤드)
      if (c % 2 === 0) {
        [b.minZ + 1.5, b.maxZ - 1.5].forEach(pz => {
          makeFloodlight(cx + slot * 0.5, pz, cz);
        });
      }

      if (!withPlayers) continue;
      const doubles = c < 2;                                   // 코트1·2 복식 / 코트3·4 단식
      const TC = [0xf2f4f7, 0xdce35b];
      const sides = [-1, 1].map((sgn, si) => {
        const list = [];
        const spots = doubles
          ? [[sgn * (CL / 2 + 1.6), -2.6], [sgn * (SVC - 0.5), 2.4]]   // 베이스라인 + 전위
          : [[sgn * (CL / 2 + 1.6), 0]];
        spots.forEach(([dz, dx]) => {
          const p = mkPlayer(TC[si], si ? 0x2a5fd0 : 0x1f2937);
          const px = cx + dx, pz = cz + dz;
          p.group.position.set(px, 0.05, pz);
          p.group.rotation.y = sgn > 0 ? 0 : Math.PI;
          const rk = new THREE.Group();                         // 라켓
          const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 6),
            new THREE.MeshLambertMaterial({ color: 0x2b2f36 }));
          handle.position.y = -0.22;
          rk.add(handle);
          const headR = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 6, 14),
            new THREE.MeshLambertMaterial({ color: 0xd93b3b }));
          headR.position.y = -0.7;
          headR.rotation.x = Math.PI / 2;
          rk.add(headR);
          const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.28, 12),
            new THREE.MeshLambertMaterial({
              color: 0xe8eef4, transparent: true, opacity: 0.45, side: THREE.DoubleSide
            }));
          mesh.position.y = -0.7;
          mesh.rotation.x = Math.PI / 2;
          rk.add(mesh);
          rk.position.set(0, -0.55, 0);
          p.armR.add(rk);
          list.push({ p, hx: px, hz: pz, sgn });
        });
        return list;
      });
      const ball = mkBall(0xd8e84a, 0.34);
      // 코트마다 다른 템포·개성 (같은 동작 반복 방지)
      const rnd = makeRng(9100 + c * 613);
      const T0 = 1.25 + rnd() * 0.75;                          // 코트별 랠리 속도
      const tOff = rnd() * 4;
      const style = sides.map(side => side.map(() => ({
        lunge: 0.7 + rnd() * 0.9,                              // 스윙 크기
        高: 0.8 + rnd() * 0.8,
        step: 0.7 + rnd() * 1.4,                               // 대기 스텝 폭
        stepSp: 1.4 + rnd() * 1.6,
        phase: rnd() * 6.3,
        slice: rnd() < 0.5 ? 1 : -1,                           // 포핸드/백핸드
      })));
      const tnAll = sides[0].concat(sides[1]).map(q => q.p);
      const tnBench = tnBenches[c % tnBenches.length];
      pushActor('tennis', tnAll, [ball], t0 => {
        if (idleField(tnAll, tnBench, [ball], t0)) return;   // 대기석(경기 종료)/야간(귀가) 모드
        const t = t0 + tOff;
        const rally = Math.floor(t / T0);
        const u = (t % T0) / T0;
        const from = rally % 2, to = 1 - from;
        // 랠리마다 타구 강도·코스·담당 선수가 달라짐
        const rh = (rally * 2654435761) >>> 0;                 // 부호 없는 시프트(음수 인덱스 방지)
        const hiIdx = doubles ? (rh >>> 3) % 2 : 0;
        const toIdx = doubles ? (rh >>> 7) % 2 : 0;
        const lob = ((rh >>> 11) % 5 === 0);                   // 가끔 로브
        const cross = (((rh >>> 13) % 3) - 1) * 2.2;           // 코스 변화
        const fa = sides[from][hiIdx], ta = sides[to][toIdx];
        const sx = fa.hx, sz = fa.hz;
        const ex = ta.hx + cross, ez = ta.hz;
        const peak = lob ? 6.4 : 2.6 + ((rh >>> 17) % 5) * 0.4;
        ball.position.set(sx + (ex - sx) * u, 0.9 + Math.sin(u * Math.PI) * peak, sz + (ez - sz) * u);
        sides.forEach((side, si) => side.forEach((q, qi) => {
          const st = style[si][qi];
          const isHitter = (si === from && qi === hiIdx);
          const isReceiver = (si === to && qi === toIdx);
          const w = isHitter ? Math.sin(Math.min(1, u / 0.3) * Math.PI)
            : isReceiver ? Math.sin(Math.max(0, (u - 0.72) / 0.28) * Math.PI) : 0;
          q.p.armR.rotation.x = -0.35 - w * 2.0 * st.lunge;
          q.p.armR.rotation.z = st.slice * w * 0.7;
          q.p.armL.rotation.x = -0.25 + w * 0.7;
          q.p.legL.rotation.x = w * 0.45 * st.lunge;
          q.p.legR.rotation.x = -w * 0.45 * st.lunge;
          // 대기 중에는 공 쪽으로 자연스럽게 이동(코트별·선수별 다른 리듬)
          const chase = isReceiver ? (ex - q.hx) * Math.min(1, u * 1.2) * 0.75 : 0;
          const idle = Math.sin(t * st.stepSp + st.phase) * st.step;
          q.p.group.position.x = q.hx + chase + (w > 0.2 ? 0 : idle);
          q.p.group.position.z = q.hz + (isHitter ? -w * 0.8 : Math.cos(t * st.stepSp * 0.7 + st.phase) * 0.5);
          q.p.group.position.y = 0.05 + (w > 0.1 ? w * 0.3 * st.高
            : Math.abs(Math.sin(t * st.stepSp * 1.6 + st.phase)) * 0.1);
          q.p.group.rotation.y = Math.atan2(ball.position.x - q.p.group.position.x,
            ball.position.z - q.p.group.position.z);
        }));
      });
    }
  }

  function buildJokguScene(foot) {
    const b = bbox(foot);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const vert = (b.maxZ - b.minZ) > (b.maxX - b.minX);
    const span = vert ? (b.maxX - b.minX) : (b.maxZ - b.minZ);
    const NH = 1.1;                                           // 네트 높이
    const netG = new THREE.Group();
    netG.position.set(cx, 0, cz);
    netG.rotation.y = vert ? 0 : Math.PI / 2;
    [-span / 2, span / 2].forEach(px => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, NH + 0.3, 8),
        new THREE.MeshLambertMaterial({ color: 0xcfd6dd }));
      post.position.set(px, (NH + 0.3) / 2, 0);
      netG.add(post);
    });
    const net = new THREE.Mesh(new THREE.PlaneGeometry(span, NH * 0.8),
      new THREE.MeshLambertMaterial({
        color: 0x2f3a45, transparent: true, opacity: 0.5, side: THREE.DoubleSide
      }));
    net.position.y = NH * 0.65;
    netG.add(net);
    const tape = new THREE.Mesh(new THREE.BoxGeometry(span, 0.1, 0.06),
      new THREE.MeshLambertMaterial({ color: 0xf4f7fa }));
    tape.position.y = NH;
    netG.add(tape);
    netG.traverse(o => { o.castShadow = true; });
    scene.add(netG);

    const side = vert ? (b.maxZ - b.minZ) : (b.maxX - b.minX);
    // 코트 좌표 변환: lat=네트와 평행(좌우), dep=네트로부터의 거리(sgn별)
    const pt = (sgn, dep, lat) => vert
      ? [cx + lat, cz + sgn * dep]
      : [cx + sgn * dep, cz + lat];
    const TEAM_C = [0xe08a2e, 0x2a9d5c];
    const teams = [[], []];                                    // 팀당 4명 (전위 2 · 후위 2)
    [-1, 1].forEach((sgn, ti) => {
      const slots = [[side * 0.14, -span * 0.24], [side * 0.14, span * 0.24],
                     [side * 0.34, -span * 0.28], [side * 0.34, span * 0.28]];
      slots.forEach(([dep, lat], i) => {
        const p = mkPlayer(TEAM_C[ti], 0x1f2937);
        const [px, pz] = pt(sgn, dep, lat);
        p.group.position.set(px, 0.05, pz);
        teams[ti].push({ p, sgn, ti, i, hx: px, hz: pz });
      });
    });
    const ball = mkBall(0xf0d24a, 0.45);
    // 족구 대기석: 코트 동쪽(우측)에서 코트를 바라보도록 배치
    const jkBench = makeBench(b.maxX + 8, cz, -Math.PI / 2, 8);
    const PH = 1.15;                                           // 수비/토스/공격 각 단계 시간
    const TURN = PH * 3;
    // 랠리마다 역할(수비·토스·공격)을 바꿔 자유로운 경기 흐름 연출
    const roleOf = (turn, ti) => {
      const h = (turn * 73 + ti * 29) % 12;
      const recv = h % 4;
      const set = (recv + 1 + (h % 3)) % 4;
      let atk = (set + 1 + ((h >> 2) % 3)) % 4;
      if (atk === recv) atk = (atk + 1) % 4;
      return [recv, set, atk];
    };
    const posOf = (ti, idx) => [teams[ti][idx].hx, teams[ti][idx].hz];
    const jkAll = teams[0].concat(teams[1]).map(q => q.p);
    pushActor('jokgu', jkAll, [ball], t => {
      if (idleField(jkAll, jkBench, [ball], t)) return;
      const turn = Math.floor(t / TURN);
      const local = t % TURN;
      const phase = Math.floor(local / PH);                    // 0=수비 1=토스 2=공격
      const u = (local % PH) / PH;
      const ti = turn % 2, sgn = ti ? 1 : -1;
      const [recv, set, atk] = roleOf(turn, ti);
      const [nti] = [(turn + 1) % 2];
      const nRecv = roleOf(turn + 1, nti)[0];
      const rp = posOf(ti, recv), sp2 = posOf(ti, set), ap = posOf(ti, atk);
      const npos = posOf(nti, nRecv);
      // 공 궤적
      let bx, bz, by;
      if (phase === 0) {                                       // 수비: 받아 올림
        bx = rp[0] + (sp2[0] - rp[0]) * u;
        bz = rp[1] + (sp2[1] - rp[1]) * u;
        by = 1.0 + Math.sin(u * Math.PI) * 4.5;
      } else if (phase === 1) {                                // 토스: 공격수 앞으로
        bx = sp2[0] + (ap[0] - sp2[0]) * u;
        bz = sp2[1] + (ap[1] - sp2[1]) * u;
        by = 1.2 + Math.sin(u * Math.PI) * 5.5;
      } else {                                                 // 공격: 네트 넘겨 상대 수비수에게
        bx = ap[0] + (npos[0] - ap[0]) * u;
        bz = ap[1] + (npos[1] - ap[1]) * u;
        by = 4.2 + Math.sin(u * Math.PI) * 2.4 - u * 3.0;
      }
      ball.position.set(bx, Math.max(0.5, by), bz);
      ball.rotation.x = t * 5;

      teams.forEach((team, tIdx) => team.forEach((q, i) => {
        const mine = tIdx === ti;
        let act = 0, kick = 0, jump = 0, face = [bx, bz];
        if (mine && phase === 0 && i === recv) { act = 1; kick = 1; }
        else if (mine && phase === 1 && i === set) { act = 1; kick = 0.7; }
        else if (mine && phase === 2 && i === atk) { act = 1; kick = 1.2; jump = 1; }
        else if (!mine && phase === 2 && i === nRecv) { act = 0.5; }   // 상대 수비 준비
        const w = act ? Math.sin(Math.min(1, u / 0.55) * Math.PI) : 0;
        q.p.legR.rotation.x = -1.7 * kick * w;
        q.p.legL.rotation.x = 0.35 * kick * w;
        q.p.armL.rotation.x = -0.8 * w - 0.25;
        q.p.armR.rotation.x = 0.8 * w - 0.25;
        q.p.group.position.y = 0.05 + jump * w * 1.5 + (act ? 0 : Math.abs(Math.sin(t * 2.2 + i + tIdx)) * 0.12);
        // 항상 공을 바라보며 제자리 스텝
        const step = act ? 0 : Math.sin(t * 1.7 + i * 1.9 + tIdx) * 1.2;
        q.p.group.position.x = q.hx + (vert ? step : 0);
        q.p.group.position.z = q.hz + (vert ? 0 : step);
        q.p.group.rotation.y = Math.atan2(face[0] - q.p.group.position.x, face[1] - q.p.group.position.z);
      }));
    });
  }

  const whiteLine = new THREE.LineBasicMaterial({ color: 0xf1f5f9 });
  function fieldLine(pts, y) {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(q => new THREE.Vector3(q[0], y || 0.64, q[1])));
    scene.add(new THREE.Line(g, whiteLine));
  }
  // 12동 앞 주차장 태양광 카포트 (위성사진 반영)
  (function solarCarports() {
    const b12 = D.buildings.find(x => x.id === '12');
    if (!b12 || !(D.parking || []).length) return;
    let lot = null, best = 1e18;
    D.parking.forEach(l => {                        // 12동에 가장 가까운 대형 주차장
      const r = bbox(l.foot);
      if ((r.maxX - r.minX) * (r.maxZ - r.minZ) < 1500) return;
      const cx0 = (r.minX + r.maxX) / 2, cz0 = (r.minZ + r.maxZ) / 2;
      const dist = (cx0 - b12.center[0]) ** 2 + (cz0 - b12.center[1]) ** 2;
      if (dist < best) { best = dist; lot = r; }
    });
    if (!lot) return;
    // 실제 태양광 모듈 텍스처: 은색 프레임 + 6×10 셀 그리드 + 버스바
    const pvTex = (() => {
      const CELL = 32, COLS = 6, ROWS = 10, PAD = 5;
      const c = document.createElement('canvas');
      c.width = COLS * CELL + PAD * 2;
      c.height = ROWS * CELL + PAD * 2;
      const g = c.getContext('2d');
      g.fillStyle = '#c9d0d8';                        // 알루미늄 프레임
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8edf2';                        // 백시트(셀 사이 흰 배경)
      g.fillRect(PAD, PAD, COLS * CELL, ROWS * CELL);
      for (let r = 0; r < ROWS; r++) {
        for (let q = 0; q < COLS; q++) {
          const x = PAD + q * CELL, y = PAD + r * CELL;
          const m = 2.2, rad = 6;                     // 모서리 깎인 단결정 셀
          const grd = g.createLinearGradient(x, y, x + CELL, y + CELL);
          grd.addColorStop(0, '#1d3f77');
          grd.addColorStop(0.5, '#152c56');
          grd.addColorStop(1, '#0f2143');
          g.fillStyle = grd;
          g.beginPath();
          g.moveTo(x + m + rad, y + m);
          g.lineTo(x + CELL - m - rad, y + m);
          g.lineTo(x + CELL - m, y + m + rad);
          g.lineTo(x + CELL - m, y + CELL - m - rad);
          g.lineTo(x + CELL - m - rad, y + CELL - m);
          g.lineTo(x + m + rad, y + CELL - m);
          g.lineTo(x + m, y + CELL - m - rad);
          g.lineTo(x + m, y + m + rad);
          g.closePath();
          g.fill();
          g.strokeStyle = 'rgba(190,205,225,0.55)';   // 버스바 2줄
          g.lineWidth = 1.4;
          [0.34, 0.66].forEach(f => {
            g.beginPath();
            g.moveTo(x + CELL * f, y + m);
            g.lineTo(x + CELL * f, y + CELL - m);
            g.stroke();
          });
          g.strokeStyle = 'rgba(160,180,205,0.25)';   // 핑거 그리드
          g.lineWidth = 0.6;
          for (let i = 1; i < 7; i++) {
            g.beginPath();
            g.moveTo(x + m, y + (CELL / 7) * i);
            g.lineTo(x + CELL - m, y + (CELL / 7) * i);
            g.stroke();
          }
        }
      }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      return t;
    })();

  if (PUBLIC_MODE) {                  // 외부 공개판 고지 배너
    const nb = document.createElement('div');
    nb.id = 'public-notice';
    nb.innerHTML = '🔒 <b>외부 공개판</b> · 건물 위치·외형·길안내만 제공하며 ' +
      '층·호실·내부 도면 등 내부 시설정보는 포함되어 있지 않습니다';
    document.getElementById('viewport').appendChild(nb);
    const api = document.getElementById('btn-api');
    if (api) api.style.display = 'none';
    const foot = document.querySelector('.side-foot');
    if (foot) {
      foot.innerHTML = '데이터: OpenStreetMap · ETRI 공개 배치도<br>' +
        '외부 공개판 — 내부 시설정보 미포함. 건물 위치·형상은 근사치입니다.';
    }
    const sub = document.querySelector('.side-head .sub');
    if (sub) sub.textContent = '대전본원 · 건물 위치 조회 / 정문 경로 안내 (외부 공개판)';
  }

  buildStreetLamps();                 // 캠퍼스 도로 가로등

  // 가장 큰 테니스장에만 선수 배치 (나머지는 코트 라인만)
  let mainTennis = null, mainTennisW = -1;
  (D.pitches || []).forEach(p => {
    if (p.sport !== 'tennis') return;
    const r = bbox(p.foot);
    if (r.maxX - r.minX > mainTennisW) { mainTennisW = r.maxX - r.minX; mainTennis = p; }
  });
  (D.pitches || []).forEach(p => {
    const r = bbox(p.foot); avoidRects.push([r.minX - 4, r.maxX + 4, r.minZ - 4, r.maxZ + 4]);
    if (p.track) {                       // 대운동장: 파란 트랙 링
      flatShape(scaleFoot(p.foot, 1.09), 0x3d5f94, 0.42);
      outlineLoop(scaleFoot(p.foot, 1.09), 0xdde5f2, 0.55);
    }
    const col = {
      soccer: 0x3d7a47, ground: 0x4d8a52, tennis: 0xb56b42,
      jokgu: 0xc98a4e, baseball: 0xb59a6a, generic: 0x4f7d55
    }[p.sport] || 0x4f7d55;
    // 축구장은 정확한 직사각형으로 정형화 (OSM 폴리곤의 기울어진 변 보정)
    let drawFoot = p.foot;
    if (p.sport === 'soccer') {
      const r0 = bbox(p.foot);
      drawFoot = [[r0.minX, r0.minZ], [r0.maxX, r0.minZ], [r0.maxX, r0.maxZ], [r0.minX, r0.maxZ]];
    }
    flatShape(drawFoot, col, p.sport === 'ground' ? 0.46 : 0.5);   // 코트가 운동장 위에 얹히도록
    outlineLoop(drawFoot, 0xf1f5f9, 0.62);
    const b2 = bbox(drawFoot);
    const cx = (b2.minX + b2.maxX) / 2, cz = (b2.minZ + b2.maxZ) / 2;
    const vert = (b2.maxZ - b2.minZ) > (b2.maxX - b2.minX);
    if (p.sport === 'soccer') {          // 정식 마킹: 하프라인 1개 + 센터서클 + 페널티박스
      fieldLine(vert ? [[b2.minX + 2, cz], [b2.maxX - 2, cz]]
                     : [[cx, b2.minZ + 2], [cx, b2.maxZ - 2]]);
      const circ = [];
      for (let i = 0; i <= 32; i++) {
        const a = i / 32 * Math.PI * 2;
        circ.push([cx + Math.cos(a) * 8, cz + Math.sin(a) * 8]);
      }
      fieldLine(circ);
      const W = vert ? (b2.maxX - b2.minX) : (b2.maxZ - b2.minZ);
      const bw = Math.min(W * 0.62, 36), bd = 14;
      [[1, vert ? b2.minZ : b2.minX], [-1, vert ? b2.maxZ : b2.maxX]].forEach(([sgn, end]) => {
        const inner = end + sgn * bd;
        fieldLine(vert
          ? [[cx - bw / 2, end], [cx - bw / 2, inner], [cx + bw / 2, inner], [cx + bw / 2, end]]
          : [[end, cz - bw / 2], [inner, cz - bw / 2], [inner, cz + bw / 2], [end, cz + bw / 2]]);
      });
      buildSoccerScene(drawFoot);        // 골대 + 경기 장면
    } else if (p.sport === 'jokgu') {    // 족구장: 네트 + 경기
      buildJokguScene(p.foot);
    } else if (p.sport === 'baseball') { // 야구장: 베이스·마운드 + 경기
      buildBaseballScene(p.foot);
    } else if (p.sport === 'tennis') {   // 테니스: 남북 방향 코트 + 복식/단식 경기
      buildTennisScene(p.foot, p === mainTennis);
    }
  });

  (D.lawns || []).forEach(l => {
    flatShape(l.foot, 0x4c8a4a, 0.32);
    const r = bbox(l.foot); avoidRects.push([r.minX, r.maxX, r.minZ, r.maxZ]);
  });
  if (D.garden) { const r = bbox(D.garden.foot); avoidRects.push([r.minX, r.maxX, r.minZ, r.maxZ]); }
  // 화단: 낮은 경계석 상자 + 색색의 꽃 (인스턴스)
  (D.flowerbeds || []).forEach((fb, fi) => {
    const r = bbox(fb.foot);
    const w = r.maxX - r.minX, dep = r.maxZ - r.minZ;
    const bed = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, dep),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2e }));
    bed.position.set((r.minX + r.maxX) / 2, 0.25, (r.minZ + r.maxZ) / 2);
    bed.castShadow = true; bed.receiveShadow = true;
    scene.add(bed);
    const rng = makeRng(9100 + fi * 17);
    const cols = Math.max(2, Math.floor(w / 1.1)), rows = Math.max(1, Math.floor(dep / 1.1));
    const n = cols * rows;
    const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 6, 5),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    const PAL = [0xe0457b, 0xf2c14e, 0xf25c54, 0xffffff, 0xb56ce0, 0xff8c42];
    let i = 0;
    for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
      const x = r.minX + 0.6 + cc * ((w - 1.2) / Math.max(cols - 1, 1)) + (rng() - 0.5) * 0.3;
      const z = r.minZ + 0.6 + rr * ((dep - 1.2) / Math.max(rows - 1, 1)) + (rng() - 0.5) * 0.3;
      const sc = 0.8 + rng() * 0.5;
      m4.compose(new THREE.Vector3(x, 0.55 + sc * 0.2, z), q, new THREE.Vector3(sc, sc * 0.8, sc));
      flowers.setMatrixAt(i, m4);
      flowers.setColorAt(i, c.setHex(PAL[(rng() * PAL.length) | 0]));
      i++;
    }
    flowers.castShadow = true;
    scene.add(flowers);
    avoidRects.push([r.minX - 1, r.maxX + 1, r.minZ - 1, r.maxZ + 1]);
  });
  if (D.pond) { const r = bbox(D.pond.foot); avoidRects.push([r.minX - 3, r.maxX + 3, r.minZ - 3, r.maxZ + 3]); }

  /* ---- 차량 모델 빌더 (주차장별 병합 지오메트리 + 정점색) ---- */
  function CarMeshBuilder() {
    const pos = [], nor = [], col = [];
    const tmpC = new THREE.Color();
    function vert(x, y, z, nx, ny, nz) {
      pos.push(x, y, z);
      nor.push(nx, ny, nz);
      col.push(tmpC.r, tmpC.g, tmpC.b);
    }
    // 야우 회전 박스
    function box(cx, cy, cz, w, h, d, hex, yaw) {
      tmpC.setHex(hex);
      const cs = Math.cos(yaw || 0), sn = Math.sin(yaw || 0);
      const R = (x, z) => [x * cs + z * sn, -x * sn + z * cs];
      const hw = w / 2, hh = h / 2, hd = d / 2;
      const faces = [
        [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd], [0, 0, 1]],
        [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd], [0, 0, -1]],
        [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd], [1, 0, 0]],
        [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd], [-1, 0, 0]],
        [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd], [0, 1, 0]],
        [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd], [0, -1, 0]],
      ];
      faces.forEach(f => {
        const p = f.slice(0, 4).map(([x, y, z]) => {
          const [rx, rz] = R(x, z);
          return [cx + rx, cy + y, cz + rz];
        });
        const [nx0, nz0] = R(f[4][0], f[4][2]);
        const n = [nx0, f[4][1], nz0];
        vert(...p[0], ...n); vert(...p[1], ...n); vert(...p[2], ...n);
        vert(...p[0], ...n); vert(...p[2], ...n); vert(...p[3], ...n);
      });
    }
    // 바퀴: 로컬 X축 8각 실린더
    function wheel(cx, cy, cz, r, len, hex, yaw) {
      tmpC.setHex(hex);
      const cs = Math.cos(yaw || 0), sn = Math.sin(yaw || 0);
      const R = (x, z) => [x * cs + z * sn, -x * sn + z * cs];
      const SEG = 8, hl = len / 2;
      const ring = a => [Math.cos(a) * r, Math.sin(a) * r];
      for (let i = 0; i < SEG; i++) {
        const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
        const [y0, z0] = ring(a0), [y1, z1] = ring(a1);
        const am = (a0 + a1) / 2;
        const [nzr] = [0];
        const nY = Math.cos(am), nZ = Math.sin(am);
        const pts = [[-hl, y0, z0], [hl, y0, z0], [hl, y1, z1], [-hl, y1, z1]];
        const wp = pts.map(([x, y, z]) => {
          const [rx, rz] = R(x, z);
          return [cx + rx, cy + y, cz + rz];
        });
        const [nx, nz2] = R(0, nZ);
        const n = [nx, nY, nz2];
        vert(...wp[0], ...n); vert(...wp[1], ...n); vert(...wp[2], ...n);
        vert(...wp[0], ...n); vert(...wp[2], ...n); vert(...wp[3], ...n);
        // 캡
        [[-hl, -1], [hl, 1]].forEach(([x, s]) => {
          const c0 = [x, 0, 0], p0 = [x, y0, z0], p1 = [x, y1, z1];
          const tri = s > 0 ? [c0, p0, p1] : [c0, p1, p0];
          const [nx2, nz3] = R(s, 0);
          tri.forEach(([tx, ty, tz]) => {
            const [rx, rz] = R(tx, tz);
            vert(cx + rx, cy + ty, cz + rz, nx2, 0, nz3);
          });
        });
      }
    }
    function mesh() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    }
    return { box, wheel, mesh };
  }

  // 개별 차량 조립 — 로컬 +Z 전방, 원점 = 바닥 중심
  function buildCar(B, x, z, yaw, type, rng) {
    const pick = a => a[(rng() * a.length) | 0];
    const NEUTRAL = [0xf1f3f5, 0xd7dade, 0x9aa1a8, 0x3a3f45, 0x22262b, 0x5b6470];
    // 세단/크로스오버 공통 조립
    function sedan(L, W, bodyH, cabL, cabH, cabOff, wr, bodyC, glassC, roofC) {
      const by = wr * 0.7 + bodyH / 2;
      B.box(x, by, z, W, bodyH, L, bodyC, yaw);
      const cy = wr * 0.7 + bodyH + cabH / 2;
      B.box(x + Math.sin(yaw) * cabOff, cy, z + Math.cos(yaw) * cabOff, W * 0.86, cabH, cabL, glassC, yaw);
      B.box(x + Math.sin(yaw) * cabOff, cy + cabH / 2 + 0.03, z + Math.cos(yaw) * cabOff, W * 0.82, 0.07, cabL * 0.86, roofC !== undefined ? roofC : bodyC, yaw);
      const ax = L * 0.32;
      [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz]) => {
        const lx = sx * W * 0.46, lz = sz * ax;
        B.wheel(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wr, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), wr, 0.26, 0x14171a, yaw);
      });
      // 전조등/후미등
      const fz = L / 2 - 0.04;
      [[0.28, fz, 0xfff4cc], [-0.28, fz, 0xfff4cc], [0.28, -fz, 0xd23b33], [-0.28, -fz, 0xd23b33]].forEach(([lx0, lz0, c]) => {
        const lx = lx0 * W;
        B.box(x + lx * Math.cos(yaw) + lz0 * Math.sin(yaw), wr * 0.7 + bodyH * 0.65, z - lx * Math.sin(yaw) + lz0 * Math.cos(yaw), 0.28, 0.14, 0.1, c, yaw);
      });
    }
    const GL = 0x2a3540;   // 유리
    switch (type) {
      case 'compact':  sedan(3.6, 1.68, 0.56, 1.9, 0.5, -0.35, 0.3, pick(NEUTRAL.concat([0xc4453e, 0x2f6fb2])), GL); break;
      case 'sonata':   sedan(4.9, 1.86, 0.58, 2.3, 0.5, -0.15, 0.32, pick([0xf1f3f5, 0xb9bfc6, 0x22262b, 0x2c3e5e]), GL); break;
      case 'grandeur': sedan(5.0, 1.9, 0.6, 2.4, 0.52, -0.1, 0.33, pick([0x22262b, 0x1a1d21, 0xf1f3f5]), GL); break;
      case 'ev6':      sedan(4.7, 1.89, 0.68, 2.5, 0.46, -0.3, 0.36, pick([0xaeb6bd, 0xf1f3f5, 0x3d434a]), GL); break;
      case 'ioniq5':   sedan(4.64, 1.89, 0.74, 2.7, 0.5, 0, 0.36, pick([0xc9cfd4, 0xdfe4e8, 0x565d66]), GL); break;
      case 'ioniq6':   sedan(4.86, 1.88, 0.5, 2.9, 0.46, -0.05, 0.31, pick([0x8e959d, 0xe8eaec, 0x2b3138]), GL); break;
      case 'bmw3':     sedan(4.72, 1.83, 0.56, 2.2, 0.48, -0.12, 0.32, pick([0x2f5d9e, 0xf1f3f5, 0x22262b]), GL); break;
      case 'bmw5':     sedan(4.96, 1.87, 0.58, 2.3, 0.5, -0.1, 0.33, pick([0x30363d, 0xdfe3e7, 0x1d3f6e]), GL); break;
      case 'bmw7':     sedan(5.26, 1.9, 0.62, 2.5, 0.52, -0.05, 0.34, pick([0x1a1d21, 0x2b3138]), GL); break;
      case 'benzC':    sedan(4.75, 1.82, 0.56, 2.2, 0.48, -0.12, 0.32, pick([0xc9ced3, 0xf1f3f5, 0x22262b]), GL); break;
      case 'benzE':    sedan(4.95, 1.86, 0.58, 2.3, 0.5, -0.1, 0.33, pick([0xb9bfc6, 0x30363d]), GL); break;
      case 'benzS':    sedan(5.29, 1.92, 0.62, 2.55, 0.52, -0.05, 0.34, pick([0x1a1d21, 0x30363d]), GL); break;
      case 'tesla':    sedan(4.7, 1.85, 0.52, 2.7, 0.46, 0, 0.33, pick([0xf4f6f8, 0xc4453e, 0x2b3138]), GL); break;
      case 'maybach': {                             // 투톤 롱 세단
        sedan(5.5, 1.92, 0.62, 2.6, 0.52, -0.05, 0.34, 0xb9bfc6, GL, 0x1a1d21);
        B.box(x, 0.34 + 0.62 + 0.1, z, 1.94, 0.16, 5.5 * 0.97, 0x1a1d21, yaw);  // 상부 블랙 밴드
        break;
      }
      case 'bmwConv': case 'benzConv': {            // 컨버터블 (오픈탑)
        const bc = type === 'bmwConv' ? pick([0xc4453e, 0xf1f3f5, 0x2f5d9e]) : pick([0xb9bfc6, 0x22262b]);
        const L = 4.55, W = 1.83, bodyH = 0.56, wr = 0.32;
        const by = wr * 0.7 + bodyH / 2;
        B.box(x, by, z, W, bodyH, L, bc, yaw);
        B.box(x + Math.sin(yaw) * 0.1, wr * 0.7 + bodyH + 0.08, z + Math.cos(yaw) * 0.1, W * 0.8, 0.16, 2.2, 0x1c2025, yaw); // 오픈 콕핏
        B.box(x + Math.sin(yaw) * 1.15, wr * 0.7 + bodyH + 0.3, z + Math.cos(yaw) * 1.15, W * 0.84, 0.55, 0.1, GL, yaw);     // 윈드실드
        [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz]) => {
          const lx = sx * W * 0.46, lz = sz * L * 0.32;
          B.wheel(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wr, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), wr, 0.26, 0x14171a, yaw);
        });
        break;
      }
      case 'patrol': {                              // 연구원 패트롤카
        sedan(4.9, 1.86, 0.58, 2.3, 0.5, -0.15, 0.32, 0xf4f6f8, GL);
        B.box(x, 0.32 * 0.7 + 0.58 + 0.06, z, 1.92, 0.14, 4.9 * 0.9, 0x2456a4, yaw);       // 청색 스트라이프
        B.box(x + Math.sin(yaw) * -0.15, 0.32 * 0.7 + 0.58 + 0.5 + 0.12, z + Math.cos(yaw) * -0.15, 0.9, 0.14, 0.3, 0xd23b33, yaw); // 경광등
        break;
      }
      case 'yongdal': {                             // 용달차 (캡오버 소형트럭)
        const W = 1.74, wr = 0.34;
        const cabOff = 1.65;
        B.box(x + Math.sin(yaw) * cabOff, wr + 0.75, z + Math.cos(yaw) * cabOff, W, 1.5, 1.5, pick([0x9cc2e5, 0xf1f3f5, 0x6f9ed6]), yaw);
        B.box(x + Math.sin(yaw) * cabOff, wr + 1.15, z + Math.cos(yaw) * cabOff + 0.0, W * 0.9, 0.5, 1.3, GL, yaw);
        B.box(x - Math.sin(yaw) * 0.85, wr + 0.35, z - Math.cos(yaw) * 0.85, W, 0.24, 3.1, 0x8e959d, yaw);          // 적재함 바닥
        B.box(x - Math.sin(yaw) * 0.85, wr + 0.62, z - Math.cos(yaw) * 0.85, W, 0.3, 0.08, 0x7d858d, yaw);
        [[-1, 1.65], [1, 1.65], [-1, -1.5], [1, -1.5]].forEach(([sx, lz]) => {
          const lx = sx * W * 0.46;
          B.wheel(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wr, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), wr, 0.26, 0x14171a, yaw);
        });
        break;
      }
      case 'truck': {                               // 트럭 (박스 카고)
        const W = 2.2, wr = 0.44;
        B.box(x + Math.sin(yaw) * 2.5, wr + 0.95, z + Math.cos(yaw) * 2.5, W, 1.9, 2.0, pick([0x2f6fb2, 0xd23b33, 0xf1f3f5]), yaw);
        B.box(x + Math.sin(yaw) * 2.5, wr + 1.45, z + Math.cos(yaw) * 2.5, W * 0.92, 0.6, 1.8, GL, yaw);
        B.box(x - Math.sin(yaw) * 1.3, wr + 1.5, z - Math.cos(yaw) * 1.3, W, 2.4, 4.6, pick([0xe8eaec, 0xcfd6dd]), yaw);   // 카고 박스
        [[-1, 2.5], [1, 2.5], [-1, -0.6], [1, -0.6], [-1, -2.4], [1, -2.4]].forEach(([sx, lz]) => {
          const lx = sx * W * 0.44;
          B.wheel(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wr, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), wr, 0.32, 0x14171a, yaw);
        });
        break;
      }
      case 'forklift': {                            // 지게차
        const wr = 0.3;
        B.box(x - Math.sin(yaw) * 0.2, wr + 0.5, z - Math.cos(yaw) * 0.2, 1.15, 1.0, 1.7, 0xe8952f, yaw);      // 차체
        B.box(x - Math.sin(yaw) * 0.9, wr + 0.55, z - Math.cos(yaw) * 0.9, 1.1, 0.7, 0.5, 0x3a3f45, yaw);      // 카운터웨이트
        [[-0.5, -0.65], [0.5, -0.65], [-0.5, 0.55], [0.5, 0.55]].forEach(([lx, lz]) => {                        // 롤케이지
          B.box(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wr + 1.55, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), 0.08, 1.1, 0.08, 0x30363d, yaw);
        });
        B.box(x - Math.sin(yaw) * 0.05, wr + 2.12, z - Math.cos(yaw) * 0.05, 1.15, 0.07, 1.35, 0x30363d, yaw);  // 캐노피
        [[-0.35], [0.35]].forEach(([lx]) => {                                                                    // 마스트
          B.box(x + lx * Math.cos(yaw) + 1.0 * Math.sin(yaw), wr + 1.05, z - lx * Math.sin(yaw) + 1.0 * Math.cos(yaw), 0.1, 2.1, 0.12, 0x565d66, yaw);
        });
        [[-0.3], [0.3]].forEach(([lx]) => {                                                                      // 포크
          B.box(x + lx * Math.cos(yaw) + 1.55 * Math.sin(yaw), 0.08, z - lx * Math.sin(yaw) + 1.55 * Math.cos(yaw), 0.16, 0.06, 1.0, 0x8e959d, yaw);
        });
        [[-1, 0.55], [1, 0.55], [-1, -0.6], [1, -0.6]].forEach(([sx, lz]) => {
          const lx = sx * 0.55;
          B.wheel(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wr, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), wr, 0.24, 0x14171a, yaw);
        });
        break;
      }
      default: sedan(4.8, 1.85, 0.58, 2.3, 0.5, -0.1, 0.32, pick(NEUTRAL), GL);
    }
  }

  // 차종 가중 랜덤 (소형~마이바흐·테슬라·특수차)
  const CAR_POOL = [];
  [['compact', 30], ['sonata', 30], ['grandeur', 25], ['ev6', 14], ['ioniq5', 14], ['ioniq6', 10],
   ['bmw3', 10], ['bmw5', 9], ['bmw7', 5], ['bmwConv', 3],
   ['benzC', 10], ['benzE', 9], ['benzS', 5], ['benzConv', 3], ['maybach', 3],
   ['tesla', 18], ['yongdal', 8], ['truck', 6], ['forklift', 2]]
    .forEach(([t, w]) => { for (let i = 0; i < w; i++) CAR_POOL.push(t); });

  (D.parking || []).forEach((lot, li) => {
    const r = bbox(lot.foot); avoidRects.push([r.minX - 3, r.maxX + 3, r.minZ - 3, r.maxZ + 3]);
    flatShape(lot.foot, 0x474e59, 0.38);
    outlineLoop(lot.foot, 0x9aa3b0, 0.5);
    const rng = makeRng(7000 + li * 131);
    const B = CarMeshBuilder();
    const w = r.maxX - r.minX, dep = r.maxZ - r.minZ;
    let placed = 0;
    if (lot.rows) {                                     // 지정 주차열 (위성사진 기반 배치)
      const aisleMat = new THREE.MeshLambertMaterial({ color: 0x5a616c });
      (lot.aisles || []).forEach(a => {
        const m = new THREE.Mesh(roadStrip(a, 5.5, 0.4), aisleMat);
        scene.add(m);
      });
      const lineMat = new THREE.MeshBasicMaterial({ color: 0xd9dee5 });
      lot.rows.forEach(row => {
        // 열 정의: 동서 직선(x0~x1, z) 또는 임의 방향 선분(x0,z0 → x1,z1: 기울어진 주차장)
        const seg = row.z0 !== undefined;
        const x0 = row.x0, z0 = seg ? row.z0 : row.z;
        const dx = row.x1 - x0, dz = seg ? row.z1 - z0 : 0;
        const L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
        const th = Math.atan2(-uz, ux);                 // 열 방향 회전각 (동서 열이면 0)
        const n = Math.floor(L / 2.7);
        for (let i = 0; i < n; i++) {                   // 주차구획선
          const ln = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 4.8), lineMat);
          ln.position.set(x0 + ux * i * 2.7, 0.42, z0 + uz * i * 2.7);
          ln.rotation.y = th;
          scene.add(ln);
        }
        for (let i = 0; i < n; i++) {
          if (rng() < 0.15) continue;                     // 빈 자리 15%
          const a = 1.35 + i * 2.7, jit = (rng() - 0.5) * 0.3;
          const x = x0 + ux * a - uz * jit, z = z0 + uz * a + ux * jit;
          if (!pointInFoot(lot.foot, x, z)) continue;
          const type = placed === 0 ? 'patrol' : CAR_POOL[(rng() * CAR_POOL.length) | 0];
          buildCar(B, x, z, row.yaw + th + (rng() - 0.5) * 0.04, type, rng);
          placed++;
        }
      });
      if (!lot.rowsRect) { if (placed) scene.add(B.mesh()); return; }
    }
    const RR = lot.rowsRect;                            // 지정 주차열 구역: 격자 차량 제외
    const rows = Math.max(1, Math.floor(dep / 12));
    const cols = Math.max(2, Math.floor(w / 3.4));
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        if (rng() < 0.45) continue;                      // 빈 자리
        const x = r.minX + 3 + cc * ((w - 6) / Math.max(cols - 1, 1));
        const z = r.minZ + 7 + rr * (dep - 12) / Math.max(rows - 1, 1) + (rng() - 0.5) * 1.2;
        if (!pointInFoot(lot.foot, x, z)) continue;      // 주차장 폴리곤 내부만
        if (RR && x > RR[0] && x < RR[1] && z > RR[2] && z < RR[3]) continue;
        const yaw = (w >= dep ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.05;
        // 주차장마다 패트롤카 1대 배치, 이후 가중 랜덤
        const type = placed === 0 ? 'patrol' : CAR_POOL[(rng() * CAR_POOL.length) | 0];
        buildCar(B, x, z, yaw, type, rng);
        placed++;
      }
    }
    if (placed) scene.add(B.mesh());
  });

    const panelTop = new THREE.MeshPhongMaterial({    // 유리 반사감
      map: pvTex, shininess: 85, specular: 0x9fb6d4,
    });
    const panelSide = new THREE.MeshLambertMaterial({ color: 0xb9c1ca });
    const panelMat = [panelSide, panelSide, panelTop, panelSide, panelSide, panelSide];
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ae });
    const lotW = lot.maxX - lot.minX, lotD = lot.maxZ - lot.minZ;
    const along = lotW >= lotD;                     // 긴 축 방향으로 열 배치
    // 우측(동편) 구간에만 설치 — 첫 행 ~ 두 번째 열까지
    const full = along ? lotW : lotD;
    const len = full * 0.34;
    const shift = full * 0.5 - len * 0.5 - full * 0.06;   // 동쪽 끝으로 이동
    // 12동에 가까운 쪽(우측 상단) 앞 2개 열에만 설치
    const ROW_W = 11, rows = 4;
    const lotCx = (lot.minX + lot.maxX) / 2, lotCz = (lot.minZ + lot.maxZ) / 2;
    const nearSign = along
      ? Math.sign(b12.center[1] - lotCz) || -1
      : Math.sign(b12.center[0] - lotCx) || 1;
    let rowSeq = 0;
    for (let r0 = 0; r0 < rows; r0++) {
      const off = ((r0 + 0.5) / rows - 0.5) * (along ? lotD : lotW) * 0.76;
      if (Math.sign(off) !== nearSign) continue;   // 12동 반대편 열은 제외
      rowSeq++;                                    // 1번행 = 12동에 가장 가까운 행
      // 2번행은 동쪽 1열(모듈 1칸 폭)만 설치
      const isSecond = rowSeq === 2;
      const rowLen = isSecond ? len * 0.34 : len;
      const rowShift = isSecond ? shift + (len - rowLen) / 2 : shift;
      const cxR = (lot.minX + lot.maxX) / 2 + (along ? rowShift : off);
      const czR = (lot.minZ + lot.maxZ) / 2 + (along ? off : -rowShift);
      const geo = new THREE.BoxGeometry(along ? rowLen : ROW_W, 0.28, along ? ROW_W : rowLen);
      const panel = new THREE.Mesh(geo, panelMat.slice());
      // 모듈 단위로 텍스처 반복 (모듈 ≈ 1.7m × 1.0m)
      const topTex = pvTex.clone();
      topTex.needsUpdate = true;
      topTex.wrapS = topTex.wrapT = THREE.RepeatWrapping;
      topTex.repeat.set(Math.max(1, Math.round((along ? rowLen : ROW_W) / 1.7)),
        Math.max(1, Math.round((along ? ROW_W : rowLen) / 1.0)));
      panel.material[2] = new THREE.MeshPhongMaterial({
        map: topTex, shininess: 85, specular: 0x9fb6d4,
      });
      panel.position.set(cxR, 5.1, czR);
      panel.rotation[along ? 'x' : 'z'] = 0.16;     // 남향 경사
      panel.castShadow = true;
      scene.add(panel);
      // 카포트 아래에는 가로등을 세우지 않음 (패널 관통 방지)
      const hw = (along ? rowLen : ROW_W) / 2 + 2, hd = (along ? ROW_W : rowLen) / 2 + 2;
      noLampZones.push([cxR - hw, cxR + hw, czR - hd, czR + hd]);
      const n = Math.max(2, Math.round(rowLen / 13));  // 지지 기둥
      for (let i = 0; i <= n; i++) {
        const t2 = (i / n - 0.5) * rowLen;
        const px = cxR + (along ? t2 : 0), pz = czR + (along ? 0 : t2);
        [-ROW_W * 0.36, ROW_W * 0.36].forEach(sd => {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 5, 6), frameMat);
          post.position.set(px + (along ? 0 : sd), 2.5, pz + (along ? sd : 0));
          post.castShadow = true;
          scene.add(post);
        });
      }
    }
  })();

  /* ---------------- 큰 나무 (단일 수목) ---------------- */
  function bigTree(tx, tz) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 9, 8),
      new THREE.MeshLambertMaterial({ color: 0x5d452b }));
    trunk.position.set(tx, 4.5, tz);
    trunk.castShadow = true;
    scene.add(trunk);
    [[0, 11.5, 8.2], [-4, 9.5, 6.0], [4.2, 9.8, 6.4], [0.5, 14.2, 5.4]].forEach(([ox, oy, rr]) => {
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(rr, 1),
        new THREE.MeshLambertMaterial({ color: 0x2f7a38 }));
      crown.position.set(tx + ox, oy, tz + (ox === 0 ? 0 : ox * 0.3));
      crown.castShadow = true;
      scene.add(crown);
    });
  }

  // 위성 접시안테나 (data.dishes: [x, z, 반지름]) — 받침대 + 기둥 + 포물면 접시(남쪽 하늘 방향으로 기울임) + 피드 암
  (D.dishes || []).forEach(([dx, dz, dr]) => {
    const g = new THREE.Group();
    const metal = new THREE.MeshLambertMaterial({ color: 0xeef1f4, side: THREE.DoubleSide });
    const dark = new THREE.MeshLambertMaterial({ color: 0x5f6773 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(dr * 0.4, dr * 0.5, 0.7, 12), dark);
    base.position.y = 0.35; g.add(base);
    const postH = dr * 1.1;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(dr * 0.12, dr * 0.15, postH, 10), dark);
    post.position.y = 0.7 + postH / 2; g.add(post);
    // 포물면: y = k·r² (개구부 +Y) → x축 회전으로 남쪽 하늘(+Z 위쪽)을 향하게
    const pts = [];
    for (let i = 0; i <= 12; i++) { const r = dr * i / 12; pts.push(new THREE.Vector2(r, 0.18 * r * r / dr)); }
    const dish = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), metal);
    const hub = new THREE.Group();
    hub.position.y = 0.7 + postH;
    hub.rotation.x = 0.95;                            // 개구부가 남쪽(+Z)으로 약 55° 기울어짐
    dish.position.y = 0.15;
    hub.add(dish);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, dr * 0.9, 6), dark);
    arm.position.y = 0.15 + dr * 0.45;
    hub.add(arm);
    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 8), dark);
    feed.position.y = 0.15 + dr * 0.9;
    hub.add(feed);
    g.add(hub);
    g.traverse(o => { o.castShadow = true; });
    g.position.set(dx, 0, dz);
    scene.add(g);
    avoidRects.push([dx - dr * 2, dx + dr * 2, dz - dr * 2, dz + dr * 2]);
  });

  // 단독 소나무 (data.pines: [x, z, scale]) — 줄기 + 3단 원뿔 수관
  (D.pines || []).forEach(([px, pz, ps]) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 5, 7),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2b }));
    trunk.position.y = 2.5;
    g.add(trunk);
    const needle = new THREE.MeshLambertMaterial({ color: 0x2f6b34 });
    [[4.2, 5.5, 4.0], [3.3, 4.8, 7.2], [2.2, 4.0, 10.0]].forEach(([r, h, y]) => {
      const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), needle);
      c.position.y = y;
      g.add(c);
    });
    g.traverse(o => { o.castShadow = true; });
    g.position.set(px, 0, pz);
    g.scale.set(ps, ps, ps);
    scene.add(g);
    avoidRects.push([px - 6, px + 6, pz - 6, pz + 6]);
  });

  /* ---------------- 잔디정원 (산책로 + 큰 나무) ---------------- */
  if (D.garden) {
    flatShape(D.garden.foot, 0x58a352, 0.34);                 // 잔디
    outlineLoop(D.garden.foot, 0x7fbf76, 0.45);
    const matPath = new THREE.MeshLambertMaterial({ color: 0xb9ae94, side: THREE.DoubleSide });
    (D.garden.paths || []).forEach(p => {                     // 산책로 (녹색 표시 구간)
      if (p.length < 2) return;
      const m = new THREE.Mesh(roadStrip(p, 2.6, 0.42), matPath);
      m.receiveShadow = true;
      scene.add(m);
    });
    if (D.garden.tree) bigTree(D.garden.tree[0], D.garden.tree[1]);   // 북쪽 경계 큰 나무
  }
  // 1동(행정동) 북서측(11시 방향) 큰 나무 — 진입로 서편, 건물 모서리 앞 (위성사진)
  bigTree(93, 12);

  /* ---------------- 저수지 (잉어 · 분수) ---------------- */
  const kois = [];
  let fountain = null;
  if (D.pond) {
    // 물가 둔치 + 수면
    flatShape(scaleFoot(D.pond.foot, 1.12), 0x7a6a4e, 0.3);
    const water = flatShape(D.pond.foot, 0x2f6d8c, 0.42);
    water.material.transparent = true;
    water.material.opacity = 0.9;
    outlineLoop(D.pond.foot, 0x8fb8c9, 0.5);
    const koiMat = [0xe8622e, 0xf2f5f7, 0xe8a12e];
    (D.pond.koi || []).forEach((k, i) => {
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshLambertMaterial({ color: koiMat[i % koiMat.length] }));
      body.scale.set(0.45, 0.35, 1.5);
      grp.add(body);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.42),
        new THREE.MeshLambertMaterial({ color: koiMat[i % koiMat.length] }));
      tail.position.z = -0.85;
      grp.add(tail);
      grp.position.set(k[0], 0.5, k[1]);
      grp.scale.setScalar(1.6);
      scene.add(grp);
      kois.push({ grp, cx: k[0], cz: k[1], r: 2.5 + (i % 3) * 1.6, sp: 0.5 + (i % 4) * 0.14, ph: i * 1.1 });
    });

    // 분수: 석재 받침 + 중앙 물기둥 + 방사형 물줄기 + 물보라
    if (D.pond.fountain) {
      const [fx, fz] = D.pond.fountain;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 1.0, 16),
        new THREE.MeshLambertMaterial({ color: 0x9aa3ae }));
      base.position.set(fx, 0.5, fz);
      base.castShadow = true;
      scene.add(base);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 1.2, 8),
        new THREE.MeshLambertMaterial({ color: 0x7a8490 }));
      nozzle.position.set(fx, 1.4, fz);
      scene.add(nozzle);

      const wMat = new THREE.MeshLambertMaterial({
        color: 0xdff1fb, transparent: true, opacity: 0.72
      });
      // 중앙 분출 기둥
      const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.0, 9, 10), wMat);
      jet.position.set(fx, 6.4, fz);
      scene.add(jet);
      const crest = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), wMat);
      crest.position.set(fx, 11.2, fz);
      scene.add(crest);
      // 방사형 아치 물줄기
      const arcs = [];
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2;
        const pts = [];
        for (let s = 0; s <= 10; s++) {
          const t = s / 10;
          const rr = t * 6.4;
          pts.push(new THREE.Vector3(fx + Math.cos(a) * rr, 2.4 + Math.sin(t * Math.PI) * 4.6, fz + Math.sin(a) * rr));
        }
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.22, 6, false), wMat);
        scene.add(tube);
        arcs.push(tube);
      }
      // 낙수 물보라 링
      const ring = new THREE.Mesh(new THREE.TorusGeometry(6.4, 0.35, 6, 24),
        new THREE.MeshLambertMaterial({ color: 0xeaf6fd, transparent: true, opacity: 0.55 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(fx, 0.6, fz);
      scene.add(ring);
      fountain = { jet, crest, arcs, ring };
    }
  }

  /* ---------------- 숲 (인스턴스 트리) ---------------- */
  (function forest() {
    const rng = makeRng(4242);
    const inAvoid = (x, z) => avoidRects.some(r => x > r[0] && x < r[1] && z > r[2] && z < r[3]);
    // 도로 선분(폭 포함)과의 간격 검사 — 노드만 보면 구간 중간에 나무가 박힘
    const ROAD_SEGS = [];
    D.roads.forEach(r => {
      const half = (r.kind === 'main' ? 13 : r.kind === 'boulevard' ? 11 : (r.kind === 'walk' || r.kind === 'walk_red') ? 5.0 : 6.5) / 2;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        ROAD_SEGS.push([r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], half]);
      }
    });
    function roadDistOK(x, z, margin) {
      for (let i = 0; i < ROAD_SEGS.length; i++) {
        const s = ROAD_SEGS[i];
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const L2 = dx * dx + dz * dz || 1;
        let t = ((x - s[0]) * dx + (z - s[1]) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s[0] + t * dx - x, qz = s[1] + t * dz - z;
        const need = s[4] + margin;
        if (qx * qx + qz * qz < need * need) return false;
      }
      return true;
    }
    const nearRoad = (x, z) => !roadDistOK(x, z, 6.5);   // 일반 수목: 도로 가장자리 +6.5m
    const CAMPUS = { minX: -400, maxX: 300, minZ: -420, maxZ: 370 };
    const conif = [], broad = [];
    const put = (x, z) => {
      const s = 0.7 + rng() * 1.0;
      (rng() < 0.45 ? conif : broad).push({ x, z, s, y: hillHeight(x, z) });
    };
    // 평지·외곽 산개
    let tries = 0;
    while (conif.length + broad.length < Math.round(1100 * QUALITY) && tries < 30000) {
      tries++;
      const x = -900 + rng() * 1800, z = -900 + rng() * 1800;
      const inside = x > CAMPUS.minX && x < CAMPUS.maxX && z > CAMPUS.minZ && z < CAMPUS.maxZ;
      if (inside) {
        if (rng() < 0.86) continue;                      // 캠퍼스 내부는 듬성듬성
        if (inAvoid(x, z) || nearRoad(x, z)) continue;
      }
      put(x, z);
    }
    // 체육관 동쪽 수목대 — 캠퍼스 도로 동편 (도로를 막지 않도록 서편 열은 제외)
    const nearRoadTight = (x, z) => !roadDistOK(x, z, 4.5);  // 가로수: 도로 가장자리 +4.5m
    [[[88, 112], [92, 136], [95, 160], [96, 184], [90, 206]],     // 도로 동편 열
     [[104, 118], [108, 146], [110, 172]]].forEach(line => {      // 12동 서편 열
      for (let s = 0; s < line.length - 1; s++) {
        const [x0, z0] = line[s], [x1, z1] = line[s + 1];
        const n = Math.max(3, Math.round(Math.hypot(x1 - x0, z1 - z0) / 5));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = x0 + (x1 - x0) * t + (rng() - 0.5) * 3.5;
          const z = z0 + (z1 - z0) * t + (rng() - 0.5) * 3.5;
          if (inAvoid(x, z) || nearRoadTight(x, z)) continue;
          put(x, z);
        }
      }
    });
    // 신축 동력동 주변 수목 (건물 둘레 링 — 도로·건물 회피)
    {
      const b901 = D.buildings.find(b => b.id === '901');
      if (b901) {
        const [cx, cz] = b901.center;
        for (let i = 0; i < 46; i++) {
          const a = i / 46 * Math.PI * 2;
          const rr = 27 + (i % 3) * 7 + rng() * 5;
          const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr * 1.15;
          if (inAvoid(x, z) || nearRoadTight(x, z)) continue;
          put(x, z);
        }
      }
    }
    // 1동~12동 사이 가로지르는 나무숲 띠 (위성사진)
    const TREE_STRIP = [[55, 150], [120, 166], [205, 170]];
    for (let s = 0; s < TREE_STRIP.length - 1; s++) {
      const [x0, z0] = TREE_STRIP[s], [x1, z1] = TREE_STRIP[s + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.round(L / 5);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const tx = x0 + (x1 - x0) * t + (rng() - 0.5) * 7;
        const tz = z0 + (z1 - z0) * t + (rng() - 0.5) * 7;
        if (inAvoid(tx, tz) || nearRoadTight(tx, tz)) continue;
        put(tx, tz);
      }
    }
    // 잔디밭 내 지정 수목 (data.lawns[].trees)
    (D.lawns || []).forEach(l => (l.trees || []).forEach(([x, z]) => put(x, z)));
    // 얕은 능선 군락 (다각형 내부) — tight 영역은 건물 외곽 +1.5m·도로 가장자리 +1m만 회피, 소형 수목
    const bldRects = D.buildings.concat(D.structures || []).map(b => { const r = bbox(b.foot); return [r.minX - 1.5, r.maxX + 1.5, r.minZ - 1.5, r.maxZ + 1.5]; });
    const inBld = (x, z) => bldRects.some(r => x > r[0] && x < r[1] && z > r[2] && z < r[3]);
    // 소규모 숲 (data.groves: 다각형 내부, 건물 +1.5m·도로 가장자리 +1m 회피)
    (D.groves || []).forEach(gv => {
      const r = bbox(gv.foot);
      let n = 0, tr = 0;
      while (n < gv.n && tr < 6000) {
        tr++;
        const x = r.minX + rng() * (r.maxX - r.minX), z = r.minZ + rng() * (r.maxZ - r.minZ);
        if (!pointInFoot(gv.foot, x, z) || inBld(x, z) || !roadDistOK(x, z, 1.0)) continue;
        if (gv.safe && inAvoid(x, z)) continue;          // safe: 주차장·잔디·경기장 등 회피 영역도 존중
        const s = 0.6 + rng() * 0.6;
        (rng() < 0.45 ? conif : broad).push({ x, z, s, y: hillHeight(x, z) });
        n++;
      }
    });
    RIDGES.forEach(R => {
      const r = bbox(R.poly);
      let n = 0, tr = 0;
      while (n < R.dense && tr < 20000) {
        tr++;
        const x = r.minX + rng() * (r.maxX - r.minX), z = r.minZ + rng() * (r.maxZ - r.minZ);
        if (ridgeOne(R, x, z) < (R.tight ? 0.4 : 1.0)) continue;
        if (R.tight) {
          if (inBld(x, z) || !roadDistOK(x, z, R.roadMargin || 2.5)) continue;
          const s = 0.5 + rng() * 0.4;
          (rng() < 0.45 ? conif : broad).push({ x, z, s, y: hillHeight(x, z) });
        } else {
          if (inAvoid(x, z) || nearRoadTight(x, z)) continue;
          put(x, z);
        }
        n++;
      }
    });
    // 산 위 밀집 군락 (우거진 숲)
    HILLS.forEach(H => {
      const n = Math.round(H.s * H.s / 130 * (H.dense || 1) * QUALITY);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * H.s * 1.7;
        const x = H.x + Math.cos(a) * r, z = H.z + Math.sin(a) * r;
        if (hillHeight(x, z) < 1.5) continue;
        const inside = x > CAMPUS.minX && x < CAMPUS.maxX && z > CAMPUS.minZ && z < CAMPUS.maxZ;
        if (inAvoid(x, z) || nearRoad(x, z)) continue;   // 산지 군락도 도로 침범 금지
        put(x, z);
      }
    });
    function planted(list, geo, color, yFn) {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color }), list.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      list.forEach((t, i) => {
        m4.compose(new THREE.Vector3(t.x, t.y + yFn(t.s), t.z), q, new THREE.Vector3(t.s, t.s, t.s));
        inst.setMatrixAt(i, m4);
      });
      inst.castShadow = true;
      scene.add(inst);
    }
    planted(conif, new THREE.ConeGeometry(3.4, 9.5, 6), 0x2c6132, s => 4.75 * s + 1.2);
    planted(broad, new THREE.IcosahedronGeometry(3.6, 0), 0x39743c, s => 4.6 * s + 1.5);
    // 줄기 (공유)
    const all = conif.concat(broad);
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.35, 0.5, 3, 5),
      new THREE.MeshLambertMaterial({ color: 0x5d452b }), all.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    all.forEach((t, i) => {
      m4.compose(new THREE.Vector3(t.x, t.y + 1.5, t.z), q, new THREE.Vector3(t.s, 1, t.s));
      trunks.setMatrixAt(i, m4);
    });
    scene.add(trunks);
  })();

  /* ---------------- roads ---------------- */
  function roadStrip(pts, width, y) {
    const half = width / 2;
    const verts = [], idx = [];
    const p = pts.map(q => new THREE.Vector2(q[0], q[1]));
    for (let i = 0; i < p.length; i++) {
      const dirA = i > 0 ? p[i].clone().sub(p[i - 1]).normalize() : null;
      const dirB = i < p.length - 1 ? p[i + 1].clone().sub(p[i]).normalize() : null;
      let dir = dirA && dirB ? dirA.clone().add(dirB).normalize() : (dirA || dirB);
      if (!dir || dir.lengthSq() < 1e-6) dir = dirA || dirB || new THREE.Vector2(1, 0);
      const n = new THREE.Vector2(-dir.y, dir.x);
      verts.push(p[i].x + n.x * half, y, p[i].y + n.y * half);
      verts.push(p[i].x - n.x * half, y, p[i].y - n.y * half);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  const matRoadMain = new THREE.MeshLambertMaterial({ color: COLORS.roadMain, side: THREE.DoubleSide });
  const matRoadCampus = new THREE.MeshLambertMaterial({ color: COLORS.roadCampus, side: THREE.DoubleSide });
  const matWalk = new THREE.MeshLambertMaterial({ color: 0x9aa3ae, side: THREE.DoubleSide });
  const matWalkRed = new THREE.MeshLambertMaterial({ color: 0xb23a2e, side: THREE.DoubleSide });
  D.roads.forEach(r => {
    if (r.pts.length < 2) return;
    const cfg = r.kind === 'main' ? [13, 0.75, matRoadMain]
      : r.kind === 'boulevard' ? [11, 0.73, matRoadMain]
      : r.kind === 'walk' ? [5.0, 0.8, matWalk]
      : r.kind === 'walk_red' ? [5.0, 0.82, matWalkRed]
      : [6.5, 0.7, matRoadCampus];
    const m = new THREE.Mesh(roadStrip(r.pts, cfg[0], cfg[1]), cfg[2]);
    m.receiveShadow = true;
    scene.add(m);
  });

  // 횡단보도 (대로 위 흰 줄무늬)
  (D.crosswalks || []).forEach(cw => {
    const cs = Math.cos(cw.yaw), sn = Math.sin(cw.yaw);
    for (let k = -3; k <= 3; k++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.05, 3.4),
        new THREE.MeshBasicMaterial({ color: 0xf1f5f9 })
      );
      // 도로 진행방향의 수직(좌우)으로 반복 배치
      stripe.position.set(cw.x + cs * k * 1.55, 0.9, cw.z - sn * k * 1.55);
      stripe.rotation.y = cw.yaw;
      scene.add(stripe);
    }
  });

  /* ---------------- gates ---------------- */
  const gateInfo = {
    main: { node: D.gates.main, name: '정문', color: 0xd97706 },
    back: { node: D.gates.back, name: '후문', color: 0x92400e },
  };

  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }
  // ETRI CI 색상: E 파랑, T 파랑, R 빨강, I 파랑
  const CI_BLUE = '#1e56a0', CI_RED = '#e03127';
  // ETRI 워드마크를 캔버스에 그림. 반환값: 끝 x 좌표
  function drawEtri(g, x, yb, hpx) {
    g.font = `900 ${hpx}px Arial, sans-serif`;
    g.textBaseline = 'alphabetic';
    let cx = x;
    [['E', CI_BLUE], ['T', CI_BLUE], ['R', CI_RED], ['I', CI_BLUE]].forEach(([ch, col]) => {
      g.fillStyle = col;
      g.fillText(ch, cx, yb);
      cx += g.measureText(ch).width * 1.02;
    });
    return cx;
  }
  function etriLogoTex() {
    return canvasTex(512, 168, g => {
      g.font = '900 130px Arial, sans-serif';       // 폭 측정 후 중앙 정렬
      const w = ['E', 'T', 'R'].reduce((a, ch) => a + g.measureText(ch).width * 1.02, 0)
        + g.measureText('I').width;
      drawEtri(g, (512 - w) / 2, 148, 130);
    });
  }

  // ---- 정문: 표지탑 + 경비동 + 횡단보도 (사진 기반) ----
  (function mainGate() {
    const gi = gateInfo.main;
    const [gx, gz] = D.graph.nodes[gi.node];
    // 진입 방향: 게이트 노드에서 캠퍼스 안쪽(남측) 이웃 노드로
    let dir = new THREE.Vector2(0, 1);
    let bestZ = -Infinity;
    D.graph.edges.forEach(([a, b]) => {
      const other = a === gi.node ? b : (b === gi.node ? a : -1);
      if (other < 0) return;
      const [ox, oz] = D.graph.nodes[other];
      if (oz > bestZ) { bestZ = oz; dir.set(ox - gx, oz - gz).normalize(); }
    });
    const left = new THREE.Vector2(dir.y, -dir.x);      // 진입 기준 좌측(동편)
    const yaw = Math.atan2(-dir.x, -dir.y);             // +Z가 원외(가정로) 방향

    // 표지탑 그룹
    const mon = new THREE.Group();
    mon.position.set(gx + left.x * 13 + dir.x * 6, 0, gz + left.y * 13 + dir.y * 6);
    mon.rotation.y = yaw;
    const stone = new THREE.MeshLambertMaterial({ color: 0xece9e2 });
    const t1 = new THREE.Mesh(new THREE.BoxGeometry(3.2, 15, 2.0), stone);
    t1.position.y = 7.5;
    mon.add(t1);
    // 루버(환기 슬릿) 패널
    const louver = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 10.8),
      new THREE.MeshBasicMaterial({
        map: canvasTex(96, 640, g => {
          g.fillStyle = '#585f66'; g.fillRect(0, 0, 96, 640);
          g.fillStyle = '#2e343a';
          for (let y = 8; y < 640; y += 16) g.fillRect(6, y, 84, 6);
        })
      })
    );
    louver.position.set(-0.55, 6.4, 1.02);
    mon.add(louver);
    // ETRI 로고 (탑 상단)
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 1.45),
      new THREE.MeshBasicMaterial({ map: etriLogoTex(), transparent: true })
    );
    logo.position.set(0, 13.7, 1.02);              // 탑 전면 중앙
    mon.add(logo);
    // 보조탑 + 세로 "한국전자통신연구원"
    const t2 = new THREE.Mesh(new THREE.BoxGeometry(2.0, 11, 1.6), stone);
    t2.position.set(2.55, 5.5, -0.15);
    mon.add(t2);
    const vtext = new THREE.Mesh(
      new THREE.PlaneGeometry(1.25, 9.6),
      new THREE.MeshBasicMaterial({
        map: canvasTex(128, 1024, g => {
          g.fillStyle = '#eceae4'; g.fillRect(0, 0, 128, 1024);
          g.fillStyle = CI_BLUE;
          g.font = '800 92px "Malgun Gothic", sans-serif';
          g.textAlign = 'center';
          const chars = '한국전자통신연구원';
          chars.split('').forEach((ch, i) => g.fillText(ch, 64, 100 + i * 103));
        })
      })
    );
    vtext.position.set(2.55, 5.6, 0.68);
    mon.add(vtext);
    mon.traverse(o => { o.castShadow = true; });
    scene.add(mon);

    // 경비동 (우측: 백색 기둥 + 녹색 유리)
    const guard = new THREE.Group();
    guard.position.set(gx - left.x * 11 + dir.x * 10, 0, gz - left.y * 11 + dir.y * 10);
    guard.rotation.y = yaw;
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(7, 4.6, 5),
      new THREE.MeshLambertMaterial({ color: 0x8fb4a6, transparent: true, opacity: 0.72 })
    );
    glass.position.y = 2.3;
    guard.add(glass);
    [-3.0, -0.4, 2.2].forEach(off => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.1, 7.2, 0.9), stone);
      p.position.set(off, 3.6, 2.35);
      guard.add(p);
    });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(8, 0.4, 5.6),
      new THREE.MeshLambertMaterial({ color: 0x3c454f }));
    roof.position.y = 4.85;
    guard.add(roof);
    guard.traverse(o => { o.castShadow = true; });
    scene.add(guard);

    // 횡단보도
    for (let k = -3; k <= 3; k++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.06, 3.2),
        new THREE.MeshBasicMaterial({ color: 0xf1f5f9 })
      );
      stripe.position.set(gx + dir.x * 16 + left.x * k * 1.6, 0.92, gz + dir.y * 16 + left.y * k * 1.6);
      stripe.rotation.y = yaw;
      scene.add(stripe);
    }

    const el = document.createElement('div');
    el.className = 'lbl3d gate';
    el.textContent = '🚩 정문';
    wrap.appendChild(el);
    labels.push({ el, pos: new THREE.Vector3(gx, 18, gz), minDist: 2000 });
  })();

  // ---- 후문: 기존 아치 ----
  (function backGate() {
    const g = gateInfo.back;
    const [x, z] = D.graph.nodes[g.node];
    const grp = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0xe5e7eb });
    [-7, 7].forEach(dx => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 9, 8), postMat);
      post.position.set(dx, 4.5, 0);
      grp.add(post);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(16.5, 1.6, 1.6),
      new THREE.MeshLambertMaterial({ color: g.color }));
    beam.position.y = 9.2;
    grp.add(beam);
    grp.position.set(x, 0, z);
    grp.traverse(o => { o.castShadow = true; });
    scene.add(grp);

    const el = document.createElement('div');
    el.className = 'lbl3d gate';
    el.textContent = '🚩 후문';
    wrap.appendChild(el);
    labels.push({ el, pos: new THREE.Vector3(x, 16, z), minDist: 2000 });
  })();

  // ---- 3동 북측 외벽 좌측 상단 간판 "ETRI 한국전자통신연구원" ----
  (function b3Sign() {
    const b = D.buildings.find(x => x.id === '3');
    if (!b) return;
    const bm = bMeshes['3'];
    const f = b.foot;
    const [ccx, ccz] = b.center;
    // 북쪽(-z)을 바라보는 가장 긴 외벽 에지 탐색
    let wall = null, wallLen = -1;
    for (let i = 0; i < f.length; i++) {
      const A = f[i], B = f[(i + 1) % f.length];
      const dx = B[0] - A[0], dz = B[1] - A[1];
      const L = Math.hypot(dx, dz);
      if (L < 8) continue;
      let n = { x: dz / L, z: -dx / L };                      // 후보 법선
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      if ((mid[0] - ccx) * n.x + (mid[1] - ccz) * n.z < 0) { n = { x: -n.x, z: -n.z }; }  // 외향으로
      if (n.z < -0.8 && L > wallLen) { wall = { A, B, n, L }; wallLen = L; }
    }
    if (!wall) return;
    const { A, B, n } = wall;
    // 북쪽에서 바라볼 때 좌측 = 동쪽(+x) 끝
    const eastEnd = A[0] > B[0] ? A : B;
    const westDir = { x: (A[0] > B[0] ? B[0] - A[0] : A[0] - B[0]) / wall.L, z: (A[0] > B[0] ? B[1] - A[1] : A[1] - B[1]) / wall.L };

    // 옥상 간판: ETRI + 한국전자통신연구원 — 좌측(동쪽 끝에서 안쪽으로) 상단
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 3.4),
      new THREE.MeshBasicMaterial({
        map: canvasTex(2048, 268, g => {
          const end = drawEtri(g, 24, 218, 210);
          g.font = '800 118px "Malgun Gothic", sans-serif';
          g.fillStyle = CI_BLUE;
          g.textBaseline = 'alphabetic';
          g.fillText('한국전자통신연구원', end + 42, 206);
        }),
        transparent: true, side: THREE.DoubleSide
      })
    );
    const sy = bm.height - 1.9;
    const sc = {
      x: eastEnd[0] + westDir.x * 17 + n.x * 1.0,
      z: eastEnd[1] + westDir.z * 17 + n.z * 1.0
    };
    sign.position.set(sc.x, sy, sc.z);
    sign.lookAt(sc.x + n.x * 50, sy, sc.z + n.z * 50);
    scene.add(sign);
  })();

  /* ---------------- routing (Dijkstra) ---------------- */
  const graphAdj = D.graph.nodes.map(() => []);
  D.graph.edges.forEach(([a, b]) => {
    const [x1, z1] = D.graph.nodes[a], [x2, z2] = D.graph.nodes[b];
    const w = Math.hypot(x1 - x2, z1 - z2);
    graphAdj[a].push([b, w]);
    graphAdj[b].push([a, w]);
  });

  function dijkstra(src, dst) {
    const N = D.graph.nodes.length;
    const dist = new Array(N).fill(Infinity);
    const prev = new Array(N).fill(-1);
    const done = new Array(N).fill(false);
    dist[src] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u === -1 || u === dst) break;
      done[u] = true;
      for (const [v, w] of graphAdj[u]) {
        if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
      }
    }
    if (!isFinite(dist[dst])) return null;
    const path = [];
    for (let u = dst; u !== -1; u = prev[u]) path.push(u);
    path.reverse();
    return { path, length: dist[dst] };
  }

  /* ---------------- 안내 캐릭터 (사람/동물) ----------------
   * 각 캐릭터: { group, speed(m/s), tick(dist) → y오프셋 }  */
  const cmat = c => new THREE.MeshLambertMaterial({ color: c });
  const CHAR_SCALE = 4.5, SMALL_SCALE = 5.6;      // 캐릭터 표시 배율 (소형 동물은 더 크게)
  function finish(grp, scale) {
    grp.traverse(o => { o.castShadow = true; });
    grp.scale.set(scale, scale, scale);
    return grp;
  }
  function pivotBox(grp, w, len, c, jx, jy, jz) {   // 상단(관절) 피벗 박스
    const geo = new THREE.BoxGeometry(w, len, w);
    geo.translate(0, -len / 2, 0);
    const m = new THREE.Mesh(geo, cmat(c));
    m.position.set(jx, jy, jz || 0);
    grp.add(m);
    return m;
  }

  function makeHuman(gender) {
    const f = gender === 'f';
    const skin = 0xe8b98f;
    const C = f
      ? { hair: 0x4a2c1a, top: 0xd6537a, sleeve: 0xc94a6e, bottom: 0xb23a5f, legs: skin, shoe: 0x6d4634 }
      : { hair: 0x2b2118, top: 0x2f6fb2, sleeve: 0x28619c, bottom: 0x3a4149, legs: 0x3a4149, shoe: 0x23272c };
    const grp = new THREE.Group();
    // 다리(허벅지+종아리 톤 차이) + 신발 — 고관절 그룹 피벗
    const mkLeg = jx => {
      const g = new THREE.Group();
      g.position.set(jx, 0.88, 0);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.46, 0.19), cmat(C.legs));
      thigh.position.y = -0.23;
      g.add(thigh);
      const calf = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.42, 0.16), cmat(C.legs));
      calf.position.y = -0.63;
      g.add(calf);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.32), cmat(C.shoe));
      shoe.position.set(0, -0.86, 0.06);
      g.add(shoe);
      grp.add(g);
      return g;
    };
    const legL = mkLeg(-0.11), legR = mkLeg(0.11);
    // 몸통: 상의 + 벨트/하의 + 목
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.52, 0.26), cmat(C.top));
    torso.position.y = 1.2;
    grp.add(torso);
    const hip = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.25), cmat(C.bottom));
    hip.position.y = 0.9;
    grp.add(hip);
    if (f) {
      const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.33, 0.4, 10), cmat(C.bottom));
      skirt.position.y = 0.86;
      grp.add(skirt);
    }
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.2), cmat(0xf1f5f9));
    collar.position.y = 1.47;
    grp.add(collar);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 8), cmat(skin));
    neck.position.y = 1.5;
    grp.add(neck);
    // 팔: 소매+맨팔+손 — 어깨 그룹 피벗
    const mkArm = jx => {
      const g = new THREE.Group();
      g.position.set(jx, 1.42, 0);
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.13), cmat(C.sleeve));
      sleeve.position.y = -0.15;
      g.add(sleeve);
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.11), cmat(skin));
      fore.position.y = -0.42;
      g.add(fore);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), cmat(skin));
      hand.position.y = -0.58;
      g.add(hand);
      grp.add(g);
      return g;
    };
    const armL = mkArm(-0.3), armR = mkArm(0.3);
    // 머리 + 얼굴 + 헤어
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 12), cmat(skin));
    head.position.y = 1.68;
    grp.add(head);
    [-0.06, 0.06].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), cmat(0x22262b));
      eye.position.set(ex, 1.7, 0.155);
      grp.add(eye);
    });
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.185, 12, 10, 0, Math.PI * 2, 0, Math.PI / 1.85), cmat(C.hair));
    hair.position.y = 1.71;
    grp.add(hair);
    const back = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), cmat(C.hair));
    back.scale.set(0.95, f ? 1.0 : 0.8, 0.6);
    back.position.set(0, 1.66, -0.07);
    grp.add(back);
    if (f) {
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.028, 0.5, 8), cmat(C.hair));
      tail.position.set(0, 1.42, -0.19);
      tail.rotation.x = 0.22;
      grp.add(tail);
    }
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 12,
      tick(dist) {
        const ph = dist * 2.4;
        const s = Math.sin(ph) * 0.6;
        legL.rotation.x = s; legR.rotation.x = -s;
        armL.rotation.x = -s * 0.7; armR.rotation.x = s * 0.7;
        grp.rotation.z = Math.sin(ph) * 0.03;          // 미세한 상체 스웨이
        return 0.05 + Math.abs(Math.cos(ph)) * 0.09;
      }
    };
  }

  function makeTiger() {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.52, 1.35), cmat(0xd97b29));
    body.position.y = 0.8;
    grp.add(body);
    for (let i = 0; i < 4; i++) {                 // 줄무늬
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.57, 0.5, 0.07), cmat(0x3a2a18));
      st.position.set(0, 0.82, -0.45 + i * 0.3);
      grp.add(st);
    }
    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 1.15), cmat(0xf3e3cd));
    belly.position.y = 0.56;
    grp.add(belly);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.42, 0.42), cmat(0xe08a35));
    head.position.set(0, 1.02, 0.85);
    grp.add(head);
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.17, 0.14), cmat(0xf3e3cd));
    muzzle.position.set(0, 0.92, 1.12);
    grp.add(muzzle);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.05), cmat(0x2b1d12));
    nose.position.set(0, 0.99, 1.2);
    grp.add(nose);
    [-0.11, 0.11].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), cmat(0x1d1408));
      eye.position.set(ex, 1.1, 1.07);
      grp.add(eye);
    });
    [-0.14, 0.14].forEach(ex => {
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.06), cmat(0x3a2a18));
      ear.position.set(ex, 1.29, 0.76);
      grp.add(ear);
    });
    const tailGeo = new THREE.CylinderGeometry(0.045, 0.028, 0.8, 6);
    tailGeo.translate(0, 0.4, 0);                  // 꼬리 밑동 피벗
    const tail = new THREE.Mesh(tailGeo, cmat(0xd97b29));
    tail.position.set(0, 0.85, -0.68);
    tail.rotation.x = -2.2;
    grp.add(tail);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), cmat(0x3a2a18));
    tip.position.set(0, 0.82, 0);
    tail.add(tip);
    const FL = pivotBox(grp, 0.16, 0.64, 0xc9702a, -0.19, 0.64, 0.5);
    const FR = pivotBox(grp, 0.16, 0.64, 0xc9702a, 0.19, 0.64, 0.5);
    const BL = pivotBox(grp, 0.17, 0.64, 0xc9702a, -0.19, 0.64, -0.5);
    const BR = pivotBox(grp, 0.17, 0.64, 0xc9702a, 0.19, 0.64, -0.5);
    [FL, FR, BL, BR].forEach(l => {                // 발 (흰 양말)
      const paw = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.12, 0.18), cmat(0xf3e3cd));
      paw.position.set(0, -0.6, 0.02);
      l.add(paw);
    });
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 20,
      tick(dist) {                                 // 대각 보행(trot) 질주
        const ph = dist * 1.6;
        const s = Math.sin(ph) * 0.75;
        FL.rotation.x = s; BR.rotation.x = s;
        FR.rotation.x = -s; BL.rotation.x = -s;
        tail.rotation.z = Math.sin(ph * 0.7) * 0.25;
        return 0.05 + Math.abs(Math.cos(ph)) * 0.22;
      }
    };
  }

  function makePenguin() {
    const grp = new THREE.Group();
    const rig = new THREE.Group();                 // 뒤뚱거림용
    grp.add(rig);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 12), cmat(0x1c232b));
    body.scale.set(0.8, 1.15, 0.8);
    body.position.y = 0.62;
    rig.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 12), cmat(0xf2f5f7));
    belly.scale.set(0.7, 1.02, 0.62);
    belly.position.set(0, 0.58, 0.14);
    rig.add(belly);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), cmat(0x1c232b));
    head.position.y = 1.2;
    rig.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.24, 6), cmat(0xe8952f));
    beak.position.set(0, 1.16, 0.3);
    beak.rotation.x = Math.PI / 2;
    rig.add(beak);
    [-0.09, 0.09].forEach(ex => {                  // 눈 (흰자+동공)
      const w2 = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), cmat(0xf2f5f7));
      w2.position.set(ex, 1.26, 0.17);
      rig.add(w2);
      const p2 = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), cmat(0x14171a));
      p2.position.set(ex, 1.26, 0.21);
      rig.add(p2);
    });
    const ptail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.2), cmat(0x1c232b));
    ptail.position.set(0, 0.28, -0.32);
    ptail.rotation.x = 0.5;
    rig.add(ptail);
    const wing = sx => {
      const geo = new THREE.BoxGeometry(0.07, 0.5, 0.24);
      geo.translate(0, -0.25, 0);
      const m = new THREE.Mesh(geo, cmat(0x1c232b));
      m.position.set(sx * 0.34, 1.0, 0);
      m.rotation.z = -sx * 0.25;
      rig.add(m);
      return m;
    };
    const wingL = wing(-1), wingR = wing(1);
    [-0.13, 0.13].forEach(fx => {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.3), cmat(0xe8952f));
      foot.position.set(fx, 0.04, 0.08);
      grp.add(foot);
    });
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 8,
      tick(dist) {                                 // 뒤뚱뒤뚱
        const ph = dist * 4.0;
        rig.rotation.z = Math.sin(ph) * 0.18;
        wingL.rotation.z = 0.28 + Math.sin(ph) * 0.18;
        wingR.rotation.z = -0.28 + Math.sin(ph) * 0.18;
        return 0.02 + Math.abs(Math.sin(ph)) * 0.08;
      }
    };
  }

  function makeDolphin() {
    const grp = new THREE.Group();
    const rig = new THREE.Group();                 // 도약 피치용
    grp.add(rig);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 12), cmat(0x6f8ca3));
    body.scale.set(0.72, 0.78, 2.2);
    body.position.y = 0.45;
    rig.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), cmat(0xc7d5de));
    belly.scale.set(0.62, 0.6, 1.9);
    belly.position.y = 0.32;
    rig.add(belly);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 8), cmat(0x60798f));
    snout.position.set(0, 0.42, 1.12);
    snout.rotation.x = Math.PI / 2;
    rig.add(snout);
    [-0.17, 0.17].forEach(ex => {                  // 눈
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), cmat(0x1d242b));
      eye.position.set(ex, 0.52, 0.85);
      rig.add(eye);
    });
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 4), cmat(0x546a7d));
    dorsal.scale.z = 0.4;
    dorsal.position.set(0, 0.95, -0.1);
    dorsal.rotation.x = -0.35;
    rig.add(dorsal);
    const finGeo = new THREE.BoxGeometry(0.4, 0.04, 0.22);
    [-1, 1].forEach(sx => {
      const fin = new THREE.Mesh(finGeo, cmat(0x546a7d));
      fin.position.set(sx * 0.32, 0.3, 0.35);
      fin.rotation.z = -sx * 0.5;
      rig.add(fin);
    });
    const flukeGeo = new THREE.BoxGeometry(0.55, 0.05, 0.3);
    flukeGeo.translate(0, 0, -0.15);
    const fluke = new THREE.Mesh(flukeGeo, cmat(0x546a7d));
    fluke.position.set(0, 0.5, -1.05);
    rig.add(fluke);
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 16,
      tick(dist) {                                 // 돌고래 점프 유영
        const ph = dist * 0.45;
        const j = Math.max(0, Math.sin(ph));
        rig.rotation.x = -Math.cos(ph) * 0.5 * (j > 0 ? 1 : 0.15);
        fluke.rotation.x = Math.sin(dist * 2.2) * 0.45;
        return 0.35 + j * 4.2;
      }
    };
  }

  function makeEagle() {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), cmat(0x6b4a2b));
    body.scale.set(0.7, 0.65, 1.5);
    grp.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 10), cmat(0xf2f5f7));
    head.position.set(0, 0.14, 0.62);
    grp.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 6), cmat(0xe8b21f));
    beak.position.set(0, 0.1, 0.84);
    beak.rotation.x = Math.PI / 2;
    grp.add(beak);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.5), cmat(0xf2f5f7));
    tail.position.set(0, 0, -0.75);
    grp.add(tail);
    [-0.07, 0.07].forEach(ex => {                  // 눈
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), cmat(0x1d1408));
      eye.position.set(ex, 0.2, 0.72);
      grp.add(eye);
    });
    [-0.08, 0.08].forEach(ex => {                  // 발톱
      const talon = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.16), cmat(0xe8b21f));
      talon.position.set(ex, -0.28, 0.1);
      grp.add(talon);
    });
    const wing = sx => {
      const m = new THREE.Group();                 // 날개: 내측 + 접힌 외측 + 흰 깃끝
      m.position.set(sx * 0.2, 0.1, 0.05);
      const inner = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.6), cmat(0x59391f));
      inner.position.x = sx * 0.5;
      m.add(inner);
      const outer = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.05, 0.48), cmat(0x6b4a2b));
      outer.position.set(sx * 1.32, 0.02, -0.04);
      m.add(outer);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.4), cmat(0xf2f5f7));
      tip.position.set(sx * 1.78, 0.02, -0.06);
      m.add(tip);
      grp.add(m);
      return m;
    };
    const wingL = wing(-1), wingR = wing(1);
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 24,
      tick(dist) {                                 // 상공 활공+날갯짓
        const ph = dist * 0.5;
        wingL.rotation.z = Math.sin(ph * 3) * 0.45;
        wingR.rotation.z = -Math.sin(ph * 3) * 0.45;
        return 11 + Math.sin(ph) * 1.3;
      }
    };
  }

  function makeCroc() {
    const grp = new THREE.Group();
    const rig = new THREE.Group();                 // 좌우 스웨이용
    grp.add(rig);
    const G1 = 0x4a7038, G2 = 0x3a5a2c, BELLY = 0xb9c48f;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.26, 1.5), cmat(G1));
    body.position.y = 0.28;
    rig.add(body);
    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 1.3), cmat(BELLY));
    belly.position.y = 0.14;
    rig.add(belly);
    for (let i = 0; i < 5; i++) {                  // 등갑(스쿠트)
      const sc = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.12), cmat(G2));
      sc.position.set(0, 0.44, -0.55 + i * 0.28);
      rig.add(sc);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.42), cmat(G1));
    head.position.set(0, 0.3, 0.92);
    rig.add(head);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.13, 0.5), cmat(G2));
    snout.position.set(0, 0.26, 1.33);
    rig.add(snout);
    for (let i = 0; i < 4; i++) {                  // 이빨
      [-0.12, 0.12].forEach(ex => {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.07, 0.035), cmat(0xf2f5f7));
        tooth.position.set(ex, 0.185, 1.16 + i * 0.11);
        rig.add(tooth);
      });
    }
    [-0.07, 0.07].forEach(ex => {                  // 콧구멍 융기
      const nb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.08), cmat(G1));
      nb.position.set(ex, 0.34, 1.54);
      rig.add(nb);
    });
    [-0.11, 0.11].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), cmat(0x1c231c));
      eye.position.set(ex, 0.44, 0.8);
      rig.add(eye);
    });
    const tailGeo = new THREE.BoxGeometry(0.34, 0.2, 0.85);
    tailGeo.translate(0, 0, -0.42);
    const tail = new THREE.Mesh(tailGeo, cmat(G1));
    tail.position.set(0, 0.26, -0.75);
    rig.add(tail);
    const tipGeo = new THREE.BoxGeometry(0.18, 0.13, 0.7);
    tipGeo.translate(0, 0, -0.35);
    const tailTip = new THREE.Mesh(tipGeo, cmat(G2));
    tailTip.position.set(0, 0, -0.8);
    tail.add(tailTip);
    const leg = (sx, jz) => {                      // 옆으로 뻗은 짧은 다리
      const geo = new THREE.BoxGeometry(0.13, 0.34, 0.13);
      geo.translate(0, -0.17, 0);
      const m = new THREE.Mesh(geo, cmat(G2));
      m.position.set(sx * 0.32, 0.3, jz);
      m.rotation.z = -sx * 0.5;
      rig.add(m);
      return m;
    };
    const FL = leg(-1, 0.55), FR = leg(1, 0.55), BL = leg(-1, -0.45), BR = leg(1, -0.45);
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 6,
      tick(dist) {                                 // 포복 (몸통 좌우 스웨이 + 대각 다리)
        const ph = dist * 2.6;
        const s = Math.sin(ph) * 0.5;
        rig.rotation.y = Math.sin(ph) * 0.1;
        tail.rotation.y = Math.sin(ph - 0.9) * 0.35;
        FL.rotation.x = s; BR.rotation.x = s;
        FR.rotation.x = -s; BL.rotation.x = -s;
        return 0.02;
      }
    };
  }

  function makeCat() {
    const grp = new THREE.Group();
    const FUR = 0xd28a4a, DARK = 0xa05f2a, WHITE = 0xf3ece2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.72), cmat(FUR));
    body.position.y = 0.38;
    grp.add(body);
    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.6), cmat(WHITE));
    belly.position.y = 0.27;
    grp.add(belly);
    for (let i = 0; i < 3; i++) {                  // 등 줄무늬
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.24, 0.05), cmat(DARK));
      st.position.set(0, 0.39, -0.2 + i * 0.2);
      grp.add(st);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), cmat(FUR));
    head.position.set(0, 0.54, 0.43);
    grp.add(head);
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.08), cmat(WHITE));
    muzzle.position.set(0, 0.49, 0.57);
    grp.add(muzzle);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.025, 0.02), cmat(0xd97a8a));
    nose.position.set(0, 0.52, 0.61);
    grp.add(nose);
    [-0.06, 0.06].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), cmat(0x2c4a1e));
      eye.position.set(ex, 0.58, 0.57);
      grp.add(eye);
    });
    [-0.08, 0.08].forEach(ex => {                  // 귀
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 4), cmat(FUR));
      ear.position.set(ex, 0.7, 0.38);
      grp.add(ear);
    });
    const tailGeo = new THREE.CylinderGeometry(0.035, 0.025, 0.52, 6);
    tailGeo.translate(0, 0.26, 0);
    const tail = new THREE.Mesh(tailGeo, cmat(FUR));
    tail.position.set(0, 0.42, -0.36);
    tail.rotation.x = -2.5;                        // 위로 감아올린 꼬리
    grp.add(tail);
    const ttip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), cmat(DARK));
    ttip.position.y = 0.53;
    tail.add(ttip);
    const FL = pivotBox(grp, 0.07, 0.34, FUR, -0.1, 0.34, 0.26);
    const FR = pivotBox(grp, 0.07, 0.34, FUR, 0.1, 0.34, 0.26);
    const BL = pivotBox(grp, 0.08, 0.34, FUR, -0.1, 0.34, -0.26);
    const BR = pivotBox(grp, 0.08, 0.34, FUR, 0.1, 0.34, -0.26);
    [FL, FR, BL, BR].forEach(l => {                // 흰 발
      const paw = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.09), cmat(WHITE));
      paw.position.set(0, -0.31, 0.01);
      l.add(paw);
    });
    finish(grp, SMALL_SCALE);
    return {
      group: grp, speed: 10,
      tick(dist) {
        const ph = dist * 3.2;
        const s = Math.sin(ph) * 0.7;
        FL.rotation.x = s; BR.rotation.x = s;
        FR.rotation.x = -s; BL.rotation.x = -s;
        tail.rotation.z = Math.sin(ph * 0.45) * 0.35;
        return 0.02 + Math.abs(Math.cos(ph)) * 0.05;
      }
    };
  }

  // 청설모/다람쥐 공용 (도약 이동)
  function makeRodent(kind) {
    const chip = kind === 'chipmunk';
    const FUR = chip ? 0xb5834a : 0x453e38;
    const BELLY = chip ? 0xf0e3cc : 0xd8d2c8;
    const grp = new THREE.Group();
    const rig = new THREE.Group();                 // 도약 피치용
    grp.add(rig);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), cmat(FUR));
    body.scale.set(0.55, 0.6, 1.1);
    body.position.y = 0.26;
    rig.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), cmat(BELLY));
    belly.scale.set(0.45, 0.42, 0.95);
    belly.position.y = 0.18;
    rig.add(belly);
    if (chip) {                                    // 다람쥐 등줄무늬 (흑-백-흑)
      [[-0.05, 0x4a382a], [0, 0xf0e3cc], [0.05, 0x4a382a]].forEach(([ex, c]) => {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.02, 0.42), cmat(c));
        st.position.set(ex, 0.395, -0.02);
        st.rotation.x = -0.06;
        rig.add(st);
      });
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 10), cmat(FUR));
    head.position.set(0, 0.42, 0.28);
    rig.add(head);
    [-0.05, 0.05].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), cmat(0x14100c));
      eye.position.set(ex, 0.46, 0.38);
      rig.add(eye);
    });
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), cmat(0x2b2018));
    nose.position.set(0, 0.4, 0.41);
    rig.add(nose);
    [-0.06, 0.06].forEach(ex => {                  // 귀 (청설모는 깃털 귀)
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.035, chip ? 0.07 : 0.12, 4), cmat(FUR));
      ear.position.set(ex, chip ? 0.53 : 0.56, 0.25);
      rig.add(ear);
    });
    // 북슬꼬리 (S자 3구)
    const tail = new THREE.Group();
    tail.position.set(0, 0.22, -0.28);
    [[0, 0.1, -0.04, 0.1], [0, 0.28, 0.0, chip ? 0.1 : 0.14], [0, 0.44, 0.07, chip ? 0.08 : 0.12]].forEach(([tx, ty, tz, r]) => {
      const seg = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), cmat(FUR));
      seg.scale.set(0.7, 1, 0.8);
      seg.position.set(tx, ty, tz);
      tail.add(seg);
    });
    rig.add(tail);
    const FL = pivotBox(rig, 0.05, 0.18, FUR, -0.08, 0.2, 0.18);
    const FR = pivotBox(rig, 0.05, 0.18, FUR, 0.08, 0.2, 0.18);
    const BL = pivotBox(rig, 0.07, 0.22, FUR, -0.09, 0.22, -0.14);
    const BR = pivotBox(rig, 0.07, 0.22, FUR, 0.09, 0.22, -0.14);
    finish(grp, SMALL_SCALE);
    return {
      group: grp, speed: chip ? 8 : 9,
      tick(dist) {                                 // 바운딩(깡충) 도약
        const ph = dist * (chip ? 4.0 : 3.5);
        const s = Math.sin(ph);
        FL.rotation.x = s * 0.9; FR.rotation.x = s * 0.9;
        BL.rotation.x = -s * 0.9; BR.rotation.x = -s * 0.9;
        rig.rotation.x = -Math.cos(ph) * 0.22;
        tail.rotation.x = Math.sin(ph) * 0.25;
        return 0.02 + Math.abs(Math.sin(ph)) * 0.34;
      }
    };
  }

  function makeDeer() {                            // 고라니 (송곳니, 무각)
    const grp = new THREE.Group();
    const BR = 0x8a6a48, BELLY = 0xcbb59a, DARK = 0x5c4630;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 1.05), cmat(BR));
    body.position.y = 0.95;
    grp.add(body);
    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.9), cmat(BELLY));
    belly.position.y = 0.72;
    grp.add(belly);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.5, 0.22), cmat(BR));
    neck.position.set(0, 1.32, 0.5);
    neck.rotation.x = 0.35;
    grp.add(neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.22, 0.36), cmat(BR));
    head.position.set(0, 1.56, 0.68);
    grp.add(head);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.14), cmat(DARK));
    snout.position.set(0, 1.51, 0.88);
    grp.add(snout);
    [-0.07, 0.07].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), cmat(0x1d1408));
      eye.position.set(ex, 1.62, 0.8);
      grp.add(eye);
    });
    [-0.09, 0.09].forEach(ex => {                  // 큰 둥근 귀
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.04), cmat(BR));
      ear.position.set(ex * 1.4, 1.74, 0.6);
      ear.rotation.z = -ex * 4;
      grp.add(ear);
    });
    [-0.05, 0.05].forEach(ex => {                  // 송곳니 (고라니 특징)
      const fang = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.09, 0.022), cmat(0xf2efe6));
      fang.position.set(ex, 1.43, 0.86);
      grp.add(fang);
    });
    const dtail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.08), cmat(BELLY));
    dtail.position.set(0, 1.05, -0.55);
    grp.add(dtail);
    const legs = [];
    [[-0.14, 0.4], [0.14, 0.4], [-0.14, -0.4], [0.14, -0.4]].forEach(([jx, jz]) => {
      const l = pivotBox(grp, 0.09, 0.75, BR, jx, 0.78, jz);
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.1), cmat(0x2b2018));
      hoof.position.set(0, -0.72, 0.01);
      l.add(hoof);
      legs.push(l);
    });
    const [FL, FR, BL, BR2] = legs;
    finish(grp, CHAR_SCALE);
    return {
      group: grp, speed: 18,
      tick(dist) {                                 // 경쾌한 질주
        const ph = dist * 1.8;
        const s = Math.sin(ph) * 0.7;
        FL.rotation.x = s; BR2.rotation.x = s;
        FR.rotation.x = -s; BL.rotation.x = -s;
        return 0.05 + Math.abs(Math.cos(ph)) * 0.24;
      }
    };
  }

  /* ---- 십이지 동물 (공통 4족 보행 템플릿 + 종별 특징) ---- */
  const ZODIAC = {
    rat:     { body: 0x8b8680, belly: 0xd8d2c8, h: 0.30, len: 0.62, legs: 0.22, ear: 'round', earR: 0.09, tail: 'thin', speed: 9, scale: 4.2 },
    ox:      { body: 0x4a3b30, belly: 0x6b5748, h: 0.95, len: 1.55, legs: 0.72, ear: 'side', horn: 'ox', tail: 'tuft', speed: 11, scale: 2.8 },
    rabbit:  { body: 0xe8e3dc, belly: 0xf6f3ee, h: 0.42, len: 0.66, legs: 0.30, ear: 'long', tail: 'puff', hop: true, speed: 10, scale: 4.0 },
    dragon:  { body: 0x2f8f5b, belly: 0xd9e86a, h: 0.72, len: 1.7, legs: 0.5, ear: 'horn', horn: 'dragon', tail: 'long', fly: true, speed: 20, scale: 3.0 },
    snake:   { body: 0x6b8f3a, belly: 0xcfd98a, h: 0.24, len: 2.0, legs: 0, tail: 'long', slither: true, speed: 8, scale: 3.4 },
    horse:   { body: 0x7a4a24, belly: 0x9a6a3a, h: 1.0, len: 1.6, legs: 0.82, ear: 'side', mane: true, tail: 'hair', speed: 22, scale: 2.8 },
    sheep:   { body: 0xf0ece4, belly: 0xe2ddd3, h: 0.66, len: 1.05, legs: 0.46, ear: 'side', horn: 'curl', wool: true, speed: 9, scale: 3.2 },
    monkey:  { body: 0x8a5a33, belly: 0xd9b48a, h: 0.62, len: 0.8, legs: 0.42, ear: 'round', earR: 0.12, tail: 'curl', speed: 12, scale: 3.4 },
    rooster: { body: 0xd8c7a0, belly: 0xf0e6cf, h: 0.6, len: 0.62, legs: 0.34, comb: true, tail: 'fan', speed: 9, scale: 3.6 },
    dog:     { body: 0xbf8a4a, belly: 0xe6d3b4, h: 0.6, len: 0.95, legs: 0.44, ear: 'flop', tail: 'wag', speed: 14, scale: 3.2 },
    pig:     { body: 0xeaa6a6, belly: 0xf6cccc, h: 0.6, len: 1.0, legs: 0.36, ear: 'flop', snout: true, tail: 'curl', speed: 9, scale: 3.2 },
  };
  function makeZodiac(key) {
    const C = ZODIAC[key];
    const grp = new THREE.Group();
    const rig = new THREE.Group();
    grp.add(rig);
    const bodyY = C.legs + C.h * 0.5;
    const body = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.85, C.h, C.len), cmat(C.body));
    body.position.y = bodyY;
    rig.add(body);
    if (C.wool) {                                   // 양: 복슬복슬한 몸통
      for (let i = 0; i < 7; i++) {
        const w = new THREE.Mesh(new THREE.SphereGeometry(C.h * 0.42, 8, 8), cmat(C.body));
        w.position.set((i % 2 ? 1 : -1) * C.h * 0.28, bodyY + C.h * 0.24, -C.len * 0.4 + i * C.len * 0.13);
        rig.add(w);
      }
    }
    const belly = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.7, C.h * 0.35, C.len * 0.85), cmat(C.belly));
    belly.position.y = bodyY - C.h * 0.34;
    rig.add(belly);
    // 머리
    const headY = bodyY + C.h * (C.slither ? 0.1 : 0.45);
    const headZ = C.len * 0.55;
    const head = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.7, C.h * 0.65, C.h * 0.7), cmat(C.body));
    head.position.set(0, headY, headZ);
    rig.add(head);
    if (C.snout || key === 'dog' || key === 'horse' || key === 'ox') {
      const sn = new THREE.Mesh(
        new THREE.BoxGeometry(C.h * (C.snout ? 0.4 : 0.34), C.h * 0.3, C.h * (key === 'horse' ? 0.65 : 0.4)),
        cmat(C.snout ? 0xf2b9b9 : C.belly));
      sn.position.set(0, headY - C.h * 0.12, headZ + C.h * 0.5);
      rig.add(sn);
    }
    [-1, 1].forEach(sx => {                         // 눈
      const eye = new THREE.Mesh(new THREE.SphereGeometry(C.h * 0.09, 6, 6), cmat(0x14110c));
      eye.position.set(sx * C.h * 0.22, headY + C.h * 0.14, headZ + C.h * 0.3);
      rig.add(eye);
    });
    [-1, 1].forEach(sx => {                         // 귀
      let ear = null;
      if (C.ear === 'long') {                       // 토끼
        ear = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.16, C.h * 0.95, C.h * 0.1), cmat(C.body));
        ear.position.set(sx * C.h * 0.2, headY + C.h * 0.75, headZ - C.h * 0.05);
        ear.rotation.z = sx * 0.16;
      } else if (C.ear === 'round') {
        ear = new THREE.Mesh(new THREE.CircleGeometry(C.earR || 0.1, 10), cmat(C.belly));
        ear.position.set(sx * C.h * 0.38, headY + C.h * 0.3, headZ);
        ear.rotation.y = sx * Math.PI / 2;
      } else if (C.ear === 'flop') {
        ear = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.12, C.h * 0.42, C.h * 0.22), cmat(C.body));
        ear.position.set(sx * C.h * 0.34, headY + C.h * 0.16, headZ - C.h * 0.06);
        ear.rotation.z = sx * 0.5;
      } else if (C.ear === 'side') {
        ear = new THREE.Mesh(new THREE.ConeGeometry(C.h * 0.12, C.h * 0.3, 5), cmat(C.body));
        ear.position.set(sx * C.h * 0.3, headY + C.h * 0.4, headZ - C.h * 0.08);
        ear.rotation.z = sx * 0.3;
      }
      if (ear) rig.add(ear);
      if (C.horn === 'ox' || C.horn === 'curl') {   // 뿔
        const horn = new THREE.Mesh(
          new THREE.ConeGeometry(C.h * 0.1, C.h * (C.horn === 'ox' ? 0.5 : 0.36), 6),
          cmat(C.horn === 'ox' ? 0xe8e2d4 : 0xcdb78f));
        horn.position.set(sx * C.h * 0.3, headY + C.h * 0.5, headZ - C.h * 0.05);
        horn.rotation.z = sx * (C.horn === 'ox' ? 1.1 : 1.6);
        rig.add(horn);
      }
      if (C.horn === 'dragon') {                    // 용 뿔
        const horn = new THREE.Mesh(new THREE.ConeGeometry(C.h * 0.1, C.h * 0.6, 5), cmat(0xf0d98a));
        horn.position.set(sx * C.h * 0.22, headY + C.h * 0.55, headZ - C.h * 0.2);
        horn.rotation.x = -0.5;
        rig.add(horn);
      }
    });
    if (C.comb) {                                   // 닭 볏 · 부리
      for (let i = 0; i < 3; i++) {
        const cb = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.08, C.h * 0.22, C.h * 0.14), cmat(0xd93b3b));
        cb.position.set(0, headY + C.h * 0.45, headZ - C.h * 0.16 + i * C.h * 0.16);
        rig.add(cb);
      }
      const beak = new THREE.Mesh(new THREE.ConeGeometry(C.h * 0.12, C.h * 0.3, 5), cmat(0xe8a12e));
      beak.position.set(0, headY, headZ + C.h * 0.45);
      beak.rotation.x = Math.PI / 2;
      rig.add(beak);
    }
    if (C.mane) {                                   // 말 갈기
      for (let i = 0; i < 5; i++) {
        const mn = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.1, C.h * 0.3, C.h * 0.16), cmat(0x2f241a));
        mn.position.set(0, bodyY + C.h * 0.55, headZ - C.h * 0.1 - i * C.h * 0.22);
        rig.add(mn);
      }
    }
    if (C.fly) {                                    // 용 갈기·날개
      [-1, 1].forEach(sx => {
        const wing = new THREE.Mesh(new THREE.BoxGeometry(C.len * 0.9, 0.05, C.len * 0.35), cmat(0x59b07a));
        wing.position.set(sx * C.len * 0.5, bodyY + C.h * 0.4, -C.len * 0.05);
        wing.rotation.z = sx * 0.2;
        rig.add(wing);
      });
    }
    // 꼬리
    let tail = null;
    if (C.tail) {
      const tl = C.tail === 'long' ? C.len * 0.9 : C.tail === 'hair' ? C.len * 0.5 : C.len * 0.35;
      const geo = new THREE.CylinderGeometry(C.h * 0.09, C.h * (C.tail === 'thin' ? 0.03 : 0.06), tl, 6);
      geo.translate(0, -tl / 2, 0);
      tail = new THREE.Mesh(geo, cmat(C.tail === 'hair' ? 0x2f241a : C.body));
      tail.position.set(0, bodyY + C.h * 0.25, -C.len * 0.52);
      tail.rotation.x = C.tail === 'curl' ? -0.6 : 0.8;
      rig.add(tail);
      if (C.tail === 'puff' || C.tail === 'tuft') {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(C.h * 0.22, 8, 8),
          cmat(C.tail === 'puff' ? 0xffffff : 0x2f241a));
        puff.position.y = -tl;
        tail.add(puff);
      }
      if (C.tail === 'fan') {                       // 닭 꼬리깃
        for (let i = 0; i < 4; i++) {
          const f = new THREE.Mesh(new THREE.BoxGeometry(C.h * 0.06, C.h * 0.7, C.h * 0.18), cmat(0x3b6f4a));
          f.position.set((i - 1.5) * C.h * 0.1, -tl * 0.4, 0);
          f.rotation.x = -0.5;
          tail.add(f);
        }
      }
    }
    // 다리
    const legs = [];
    if (C.legs > 0) {
      [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz]) => {
        legs.push(pivotBox(rig, C.h * 0.22, C.legs, C.body,
          sx * C.h * 0.34, C.legs, sz * C.len * 0.33));
      });
    }
    finish(grp, C.scale);
    return {
      group: grp, speed: C.speed,
      tick(dist) {
        const ph = dist * (C.slither ? 2.0 : 2.4 / Math.max(0.5, C.len));
        if (C.slither) {                            // 뱀: 좌우 물결
          rig.rotation.y = Math.sin(ph) * 0.35;
          if (tail) tail.rotation.y = Math.sin(ph - 1.1) * 0.6;
          return 0.02;
        }
        if (C.fly) {                                // 용: 공중 비행
          rig.rotation.z = Math.sin(ph * 0.8) * 0.12;
          if (tail) tail.rotation.y = Math.sin(ph) * 0.4;
          return 7 + Math.sin(ph * 0.7) * 1.4;
        }
        if (C.hop) {                                // 토끼: 깡충
          const j = Math.abs(Math.sin(ph));
          legs.forEach((l, i) => { l.rotation.x = (i < 2 ? 1 : -1) * Math.sin(ph) * 0.8; });
          rig.rotation.x = -Math.cos(ph) * 0.16;
          return 0.02 + j * 0.5 * C.scale * 0.1;
        }
        const s2 = Math.sin(ph) * 0.7;
        legs.forEach((l, i) => { l.rotation.x = (i === 0 || i === 3) ? s2 : -s2; });
        if (tail) tail.rotation.z = Math.sin(ph * 0.8) * (C.tail === 'wag' ? 0.5 : 0.2);
        return 0.03 + Math.abs(Math.cos(ph)) * 0.14;
      },
    };
  }

  function makeCharacter(kind) {
    if (ZODIAC[kind]) return makeZodiac(kind);
    switch (kind) {
      case 'tiger': return makeTiger();
      case 'penguin': return makePenguin();
      case 'dolphin': return makeDolphin();
      case 'eagle': return makeEagle();
      case 'croc': return makeCroc();
      case 'cat': return makeCat();
      case 'squirrel': return makeRodent('squirrel');
      case 'chipmunk': return makeRodent('chipmunk');
      case 'deer': return makeDeer();
      case 'f': return makeHuman('f');
      default: return makeHuman('m');
    }
  }

  /* ---------------- 캐릭터 음성 · 혼잣말 ---------------- */
  const VOICE_LINES = {
    m: ['어디로 가야 하지?', '이 길이 맞나…', '거의 다 왔다!', '지도 보니 이쪽이네', '조금만 더 가자', '오늘 날씨 좋네'],
    f: ['여기가 맞나?', '음… 이쪽인가?', '금방 도착하겠다!', '길이 참 예쁘네', '다 왔어요!', '천천히 가볼까'],
    tiger: ['어흥!', '크르르릉…', '으르렁!'],
    penguin: ['꽥! 꽥!', '뒤뚱뒤뚱…', '꾸엑!'],
    dolphin: ['끼익끼익!', '휘이익~', '끼이익!'],
    eagle: ['끼야아악!', '휘익—', '끼익!'],
    croc: ['크르르…', '쉬익—', '으르릉'],
    cat: ['야옹~', '갸르릉…', '냐옹!'],
    squirrel: ['찍! 찍!', '까르륵!', '치칫!'],
    chipmunk: ['찍찍!', '쪼르륵~', '찌익!'],
    deer: ['캭! 캭!', '삐이익—', '컹!'],
    rat: ['찍! 찍!', '찍찍—'],
    ox: ['음메—', '무우우…'],
    rabbit: ['깡충깡충!', '뀨욱!'],
    dragon: ['크아아앙!', '우르르릉—'],
    snake: ['쉬이익—', '스으윽…'],
    horse: ['히히힝!', '푸르르—'],
    sheep: ['메에에—', '음메에!'],
    monkey: ['우끼끼!', '끼익끼익!'],
    rooster: ['꼬끼오—!', '꼬꼬댁!'],
    dog: ['멍! 멍!', '왈왈!'],
    pig: ['꿀꿀!', '꾸잉—'],
  };
  // iOS는 ① AudioContext가 무음 스위치에 묶이고 ② 오디오 재생에 사용자 제스처가 필요하며
  // ③ 음성합성도 첫 호출이 제스처 안이어야 한다. → 합성음을 WAV로 만들어 <audio>로 재생한다.
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);

  const Voice = {
    on: false, ctx: null, lastAt: -99,
    useWav: IS_IOS,            // iOS: 무음 스위치 우회를 위해 <audio> 경로 사용
    unlocked: false, el: null, _pending: [],
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    // 최초 사용자 제스처에서 호출 — 오디오·음성합성 잠금 해제
    unlock() {
      if (this.unlocked) return;
      this.unlocked = true;
      const ctx = this.ensure();
      if (ctx) {                                     // 무음 버퍼 1회 재생(컨텍스트 활성화)
        try {
          const b = ctx.createBufferSource();
          b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          b.connect(ctx.destination);
          b.start(0);
        } catch (e) { /* 무시 */ }
      }
      if (!this.el) {                                // <audio> 엘리먼트도 제스처 안에서 해제
        this.el = new Audio();
        this.el.setAttribute('playsinline', '');
        this.el.preload = 'auto';
      }
      try {
        this.el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        const p = this.el.play();
        if (p && p.catch) p.catch(() => { /* 무시 */ });
      } catch (e) { /* 무시 */ }
      if (window.speechSynthesis) {                  // 음성합성 예열(이후 자동 발화 허용)
        try {
          const w = new SpeechSynthesisUtterance(' ');
          w.volume = 0.01; w.lang = 'ko-KR';
          window.speechSynthesis.speak(w);
        } catch (e) { /* 무시 */ }
      }
    },
    // WAV 인코딩 (16bit PCM 모노)
    _wav(buf) {
      const n = buf.length, sr = buf.sampleRate;
      const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
      const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, n * 2, true);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([ab], { type: 'audio/wav' });
    },
    // 모아둔 소리를 오프라인 렌더 → <audio>로 재생 (무음 스위치 영향 없음)
    _flush() {
      const list = this._pending;
      this._pending = [];
      if (!list.length) return;
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) { list.forEach(o => this._schedule(this.ensure(), o)); return; }
      const dur = list.reduce((m, o) => Math.max(m, (o.delay || 0) + o.dur), 0) + 0.15;
      const sr = 44100;
      let off;
      try { off = new OAC(1, Math.ceil(sr * dur), sr); } catch (e) { return; }
      list.forEach(o => this._schedule(off, o));
      const done = buf => {
        if (!this.el) { this.el = new Audio(); this.el.setAttribute('playsinline', ''); }
        const url = URL.createObjectURL(this._wav(buf));
        this.el.src = url;
        this.el.currentTime = 0;
        const p = this.el.play();
        if (p && p.catch) p.catch(() => { /* 정책 차단 시 무시 */ });
        setTimeout(() => URL.revokeObjectURL(url), (dur + 1) * 1000);
      };
      const r = off.startRendering();
      if (r && r.then) r.then(done);                 // 표준
      else off.oncomplete = e => done(e.renderedBuffer);   // 구형 Safari
    },
    // 기본 합성음: 주파수 스윕 + 엔벨로프 (+ 비브라토/노이즈)
    tone(o) {
      if (this.useWav) { this._pending.push(o); return; }   // iOS: 모았다가 WAV로 재생
      const ctx = this.ensure();
      if (ctx) this._schedule(ctx, o);
    },
    _schedule(ctx, o) {
      if (!ctx) return;
      const base = ctx.currentTime || 0;
      const t0 = base + (o.delay || 0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(o.gain || 0.18, t0 + (o.atk || 0.03));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = o.cutoff || 6000;
      g.connect(filt); filt.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f0, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1 || o.f0), t0 + o.dur);
      osc.connect(g);
      osc.start(t0); osc.stop(t0 + o.dur + 0.02);
      if (o.vib) {                                   // 비브라토(울음 떨림)
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = o.vib; lg.gain.value = o.vibAmt || 18;
        lfo.connect(lg); lg.connect(osc.frequency);
        lfo.start(t0); lfo.stop(t0 + o.dur);
      }
      if (o.noise) {                                 // 거친 숨소리
        const n = ctx.createBufferSource();
        const len = Math.ceil(ctx.sampleRate * o.dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        n.buffer = buf;
        const ng = ctx.createGain();
        ng.gain.value = o.noise;
        n.connect(ng); ng.connect(filt);
        n.start(t0); n.stop(t0 + o.dur);
      }
    },
    // 한국어 음성 중 성별에 맞는 보이스 선택
    pickVoice(female) {
      if (!window.speechSynthesis) return null;
      const all = window.speechSynthesis.getVoices() || [];
      const ko = all.filter(v => /ko/i.test(v.lang));
      const pool = ko.length ? ko : all;
      const byName = pool.find(v => female
        ? /(female|여성|여자|SunHi|Heami|Yuna|Ji-?Min|Seo-?Hyeon|Soon-?Bok)/i.test(v.name)
        : /(male|남성|남자|InJoon|Gook-?Min|Hyun-?su|Bong-?Jin)/i.test(v.name));
      return byName || pool[female ? 0 : Math.min(1, pool.length - 1)] || null;
    },
    cry(kind) {
      if (!this.on || this.silent) return;
      this._play(kind);
      if (this.useWav) this._flush();               // iOS: 모아둔 소리를 한 번에 재생
    },
    _play(kind) {
      switch (kind) {
        case 'tiger':
          this.tone({ type: 'sawtooth', f0: 110, f1: 62, dur: 1.0, gain: 0.3, cutoff: 900, vib: 14, vibAmt: 12, noise: 0.06 });
          break;
        case 'cat':
          this.tone({ type: 'sine', f0: 620, f1: 880, dur: 0.22, gain: 0.16 });
          this.tone({ type: 'sine', f0: 880, f1: 430, dur: 0.42, gain: 0.16, delay: 0.2, vib: 9, vibAmt: 25 });
          break;
        case 'penguin':
          [0, 0.18, 0.36].forEach((d, i) => this.tone({
            type: 'square', f0: 900 + i * 120, f1: 640, dur: 0.12, gain: 0.1, delay: d, cutoff: 3000
          }));
          break;
        case 'dolphin':
          this.tone({ type: 'sine', f0: 1700, f1: 4200, dur: 0.3, gain: 0.12 });
          this.tone({ type: 'sine', f0: 3800, f1: 1500, dur: 0.28, gain: 0.12, delay: 0.3 });
          break;
        case 'eagle':
          this.tone({ type: 'sawtooth', f0: 2100, f1: 900, dur: 0.55, gain: 0.13, cutoff: 5200, vib: 22, vibAmt: 120, noise: 0.05 });
          break;
        case 'croc':
          this.tone({ type: 'sawtooth', f0: 78, f1: 52, dur: 0.9, gain: 0.26, cutoff: 600, vib: 26, vibAmt: 9, noise: 0.1 });
          break;
        case 'squirrel': case 'chipmunk':
          [0, 0.13, 0.26, 0.39].forEach(d => this.tone({
            type: 'square', f0: 2400, f1: 2900, dur: 0.07, gain: 0.07, delay: d, cutoff: 6000
          }));
          break;
        case 'deer':
          this.tone({ type: 'sawtooth', f0: 820, f1: 470, dur: 0.22, gain: 0.15, cutoff: 3000, noise: 0.05 });
          this.tone({ type: 'sawtooth', f0: 780, f1: 450, dur: 0.22, gain: 0.13, cutoff: 3000, delay: 0.32 });
          break;
        // ---- 십이지 ----
        case 'rat':
          [0, 0.1, 0.2].forEach(d => this.tone({
            type: 'square', f0: 3000, f1: 3600, dur: 0.06, gain: 0.06, delay: d, cutoff: 7000
          }));
          break;
        case 'ox':
          this.tone({ type: 'sawtooth', f0: 160, f1: 110, dur: 1.2, gain: 0.26, cutoff: 700, vib: 6, vibAmt: 10, noise: 0.05 });
          break;
        case 'rabbit':
          this.tone({ type: 'sine', f0: 1500, f1: 1900, dur: 0.12, gain: 0.09 });
          break;
        case 'dragon':
          this.tone({ type: 'sawtooth', f0: 130, f1: 58, dur: 1.3, gain: 0.32, cutoff: 800, vib: 11, vibAmt: 22, noise: 0.12 });
          this.tone({ type: 'sawtooth', f0: 420, f1: 190, dur: 0.9, gain: 0.1, cutoff: 2200, delay: 0.1 });
          break;
        case 'snake':
          this.tone({ type: 'sine', f0: 5200, f1: 4200, dur: 1.0, gain: 0.02, cutoff: 9000, noise: 0.16 });
          break;
        case 'horse':
          [0, 0.13, 0.26, 0.39].forEach((d, i) => this.tone({
            type: 'sawtooth', f0: 760 - i * 70, f1: 480 - i * 50, dur: 0.15,
            gain: 0.15, delay: d, cutoff: 2600, vib: 30, vibAmt: 60
          }));
          break;
        case 'sheep':
          this.tone({ type: 'sawtooth', f0: 560, f1: 430, dur: 0.85, gain: 0.16, cutoff: 2000, vib: 17, vibAmt: 48 });
          break;
        case 'monkey':
          [0, 0.11, 0.22, 0.33].forEach((d, i) => this.tone({
            type: 'square', f0: 1400 + i * 260, f1: 2200, dur: 0.09, gain: 0.08, delay: d, cutoff: 5200
          }));
          break;
        case 'rooster':                              // 꼬-끼-오
          this.tone({ type: 'sawtooth', f0: 900, f1: 1150, dur: 0.22, gain: 0.15, cutoff: 3600 });
          this.tone({ type: 'sawtooth', f0: 1350, f1: 1250, dur: 0.3, gain: 0.15, cutoff: 3600, delay: 0.24, vib: 14, vibAmt: 40 });
          this.tone({ type: 'sawtooth', f0: 1000, f1: 700, dur: 0.45, gain: 0.13, cutoff: 3000, delay: 0.56, vib: 9, vibAmt: 30 });
          break;
        case 'dog':
          this.tone({ type: 'sawtooth', f0: 520, f1: 260, dur: 0.16, gain: 0.2, cutoff: 2200, noise: 0.07 });
          this.tone({ type: 'sawtooth', f0: 500, f1: 250, dur: 0.16, gain: 0.18, cutoff: 2200, delay: 0.26, noise: 0.06 });
          break;
        case 'pig':
          [0, 0.16, 0.32].forEach(d => this.tone({
            type: 'sawtooth', f0: 330, f1: 220, dur: 0.13, gain: 0.17, delay: d, cutoff: 1500, noise: 0.09
          }));
          break;
        default: {                                   // 사람: 성별에 맞는 음성 합성
          const female = kind === 'f';
          const text = VOICE_LINES[female ? 'f' : 'm'];
          if (window.speechSynthesis) {
            const u = new SpeechSynthesisUtterance(this.lastText || text[0]);
            u.lang = 'ko-KR';
            u.rate = female ? 1.05 : 0.95;
            u.pitch = female ? 1.45 : 0.6;           // 여성 높게 / 남성 낮게
            u.volume = 0.95;
            const v = this.pickVoice(female);
            if (v) u.voice = v;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(u);
          } else {
            this.tone({ type: 'triangle', f0: female ? 420 : 200, f1: female ? 330 : 150, dur: 0.25, gain: 0.12 });
          }
        }
      }
    },
  };
  // 최초 사용자 제스처에서 오디오 잠금 해제 (iOS 필수)
  ['pointerdown', 'touchend', 'click'].forEach(ev =>
    document.addEventListener(ev, () => Voice.unlock(), { once: true, passive: true }));

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'bubble3d';
  bubbleEl.style.display = 'none';
  wrap.appendChild(bubbleEl);
  let bubbleUntil = -1, lastSpeak = -99;

  function speakWalker(kind, t) {
    const lines = VOICE_LINES[kind] || VOICE_LINES.m;
    const line = lines[Math.floor(Math.abs(Math.sin(t * 13.7)) * lines.length) % lines.length];
    Voice.lastText = line;
    bubbleEl.textContent = line;
    bubbleEl.style.display = 'block';
    bubbleUntil = t + 2.6;
    Voice.cry(kind);
  }

  /* ---------------- route rendering ---------------- */
  let routeGroup = null, routeWalker = null, routeCurve = null, routeLen = 0, routeT = 0;
  let routePaused = false;                        // ?pause=1 (캡처/정지용)

  function clearRoute() {
    if (routeGroup) { scene.remove(routeGroup); routeGroup = null; }
    routeWalker = null; routeCurve = null;
    document.getElementById('routebar').classList.remove('show');
  }

  function showRoute(gateKey, b) {
    clearRoute();
    const gate = gateInfo[gateKey];
    const dstNode = b.entryNode;
    const r = dijkstra(gate.node, dstNode);
    if (!r) { toast('경로를 찾을 수 없습니다'); return; }

    const pts = r.path.map(i => {
      const [x, z] = D.graph.nodes[i];
      return new THREE.Vector3(x, 1.4, z);
    });
    // 마지막 도로 노드 → 건물 출입구
    const entry = new THREE.Vector3(b.entry[0], 1.4, b.entry[1]);
    const last = pts[pts.length - 1];
    const spurLen = last.distanceTo(entry);
    if (spurLen > 1.5) pts.push(entry);
    const total = r.length + spurLen;

    routeGroup = new THREE.Group();
    routeCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.08);
    routeLen = total;

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(routeCurve, Math.max(pts.length * 6, 48), 1.5, 8, false),
      new THREE.MeshBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.85 })
    );
    routeGroup.add(tube);

    const mkPin = (v, color) => {
      const pin = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 12),
        new THREE.MeshBasicMaterial({ color }));
      pin.position.copy(v).setY(5);
      routeGroup.add(pin);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 5, 6),
        new THREE.MeshBasicMaterial({ color }));
      pole.position.copy(v).setY(2.5);
      routeGroup.add(pole);
    };
    mkPin(pts[0], 0x16a34a);
    mkPin(pts[pts.length - 1], 0xdc2626);

    routeWalker = makeCharacter(document.getElementById('rb-person').value);
    routeGroup.add(routeWalker.group);
    routeT = 0;

    scene.add(routeGroup);

    const mins = total / 67;
    document.getElementById('route-title').textContent = `${gate.name} → ${b.name} 입구`;
    document.getElementById('route-desc').textContent =
      `약 ${Math.round(total)} m · 도보 ${mins < 1 ? '1분 이내' : '약 ' + Math.ceil(mins) + '분'}`;
    document.getElementById('routebar').classList.add('show');

    const box = new THREE.Box3();
    pts.forEach(p => box.expandByPoint(p));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    flyTo(
      new THREE.Vector3(c.x + size * 0.55, Math.max(size * 0.8, 180), c.z + size * 0.55),
      c
    );
  }

  /* ---------------- camera fly ---------------- */
  let flyAnim = null;
  function flyTo(pos, tgt) {
    flyAnim = {
      t: 0,
      p0: camera.position.clone(), p1: pos.clone(),
      t0: controls.target.clone(), t1: tgt.clone(),
    };
  }

  /* ---------------- picking ---------------- */
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let hovered = null, selected = null;

  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(pickables, false);
    return hits.length ? hits[0].object.userData.bid : null;
  }

  renderer.domElement.addEventListener('pointermove', ev => {
    const bid = pick(ev);
    if (hovered && hovered !== bid) setGlow(hovered, null);
    hovered = bid;
    if (bid && bid !== (selected && selected.id)) setGlow(bid, COLORS.hoverEmissive);
    renderer.domElement.style.cursor = bid ? 'pointer' : 'default';
  });

  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', ev => { downXY = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener('pointerup', ev => {
    if (ev.button !== 0) { downXY = null; return; }
    if (!downXY) return;
    const moved = Math.hypot(ev.clientX - downXY[0], ev.clientY - downXY[1]);
    downXY = null;
    if (moved > 6) return;
    // 캐릭터 클릭 → 즉시 한 마디 (음성 꺼져 있으면 자동으로 켬)
    if (routeWalker && routeWalker.group.visible) {
      const r2 = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - r2.left) / r2.width) * 2 - 1;
      mouse.y = -((ev.clientY - r2.top) / r2.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      if (ray.intersectObject(routeWalker.group, true).length) {
        if (!Voice.on) {
          Voice.on = true;
          const vb = document.getElementById('btn-voice');
          vb.classList.add('on');
          vb.textContent = '🔊 음성 ON';
        }
        Voice.unlock();
        lastSpeak = elapsed;
        speakWalker(document.getElementById('rb-person').value, elapsed);
        return;
      }
    }
    const bid = pick(ev);
    if (bid) selectBuilding(bid, { fly: false });
    else deselect();
  });

  let nightEmissive = 0x000000;      // 야간 창문 불빛 (건물 식별용)
  function refreshBuildingLights() {
    Object.keys(bMeshes).forEach(bid => {
      if (hovered === bid || (selected && selected.id === bid)) return;
      setGlow(bid, null);
    });
  }
  function setGlow(bid, emissive) {
    const bm = bMeshes[bid];
    if (!bm) return;
    let e = emissive;
    if (e === null) e = (selected && selected.id === bid) ? COLORS.highlightEmissive : nightEmissive;
    const inten = e === COLORS.highlightEmissive ? 0.5 : e === nightEmissive ? 1 : 0.35;
    bm.roofMat.emissive.setHex(e === nightEmissive ? 0x000000 : e);
    bm.roofMat.emissiveIntensity = inten;
    bm.wallMat.emissive.setHex(e);
    bm.wallMat.emissiveIntensity = inten;
  }

  /* ---------------- selection & detail panel ---------------- */
  const detail = document.getElementById('detail');

  function deselect() {
    if (selected) { const old = selected; selected = null; setGlow(old.id, null); }
    labels.forEach(l => l.el.classList.remove('sel'));
    entryLbl.visible = false;
    detail.classList.remove('open');
    document.querySelectorAll('.bcard.active').forEach(e => e.classList.remove('active'));
  }

  function selectBuilding(bid, opt) {
    opt = opt || {};
    const b = D.buildings.find(x => x.id === bid);
    if (!b) return;
    if (selected) { const old = selected; selected = null; setGlow(old.id, null); }
    selected = b;
    setGlow(bid, COLORS.highlightEmissive);
    labels.forEach(l => l.el.classList.toggle('sel', l.bid === bid));
    if (b.entry) {
      entryLbl.pos.set(b.entry[0], 6.5, b.entry[1]);
      entryLbl.visible = true;
    }

    document.querySelectorAll('.bcard').forEach(e =>
      e.classList.toggle('active', e.dataset.bid === bid));
    const card = document.querySelector(`.bcard[data-bid="${bid}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    renderDetail(b);
    detail.classList.add('open');

    if (opt.fly !== false) {
      const bm = bMeshes[bid];
      flyTo(
        new THREE.Vector3(b.center[0] + 110, bm.height + 110, b.center[1] + 110),
        new THREE.Vector3(b.center[0], bm.height / 2, b.center[1])
      );
    }
  }

  function renderDetail(b) {
    document.getElementById('d-name').textContent = b.name;
    document.getElementById('d-num').textContent = PUBLIC_MODE
      ? '대전본원 · 외부 공개판 (건물 내부 정보 미제공)'
      : `대전본원 · 지상 ${b.levels}층 · 층 도면 ${b.floors.length}개 · 호실 ${b.roomCount}개`;
    const body = document.getElementById('d-body');

    const confHtml = b.conf === 'approx'
      ? `<div class="conf-note">⚠️ 이 건물의 위치·형상은 공개 지도에 없어 배치도 설명을 바탕으로 한 <b>근사 표현</b>입니다.</div>`
      : `<div class="conf-note ok">✅ OpenStreetMap 실측 윤곽 기반 형상입니다. 출입구 위치는 도로 접근성 기반 추정입니다.</div>`;

    const floorsHtml = b.floors.length
      ? b.floors.map(f => `
        <div class="floor-row">
          <div><span class="fn">${f.name}</span><span class="fc">호실 ${f.rooms.length}개</span></div>
          <div class="fbtns">
            <button class="fbtn" data-link="${f.link}" data-title="${b.name} ${f.name} 도면">도면 보기</button>
          </div>
        </div>`).join('')
      : '<div style="font-size:.8em;color:#94a3b8">층 정보 없음</div>';

    body.innerHTML = `
      <div class="d-sec">
        <h3>주요 시설 · 부서</h3>
        <div class="d-fac">${b.facil}</div>
      </div>
      <div class="d-sec">
        <h3>길 안내 (건물 입구까지)</h3>
        <div class="d-actions">
          <button class="abtn route" id="d-route-main">🚶 정문에서 경로</button>
          <button class="abtn route alt" id="d-route-back">후문에서 경로</button>
        </div>
      </div>
      ${PUBLIC_MODE ? `
      <div class="d-sec">
        <div class="conf-note">🔒 <b>외부 공개판</b>입니다. 보안상 건물의 층 구성 · 호실 · 내부 도면 등
        내부 시설정보는 제공하지 않습니다. 내부 이용자는 사내망 전용 버전을 이용해 주세요.</div>
      </div>` : `
      <div class="d-sec">
        <h3>층별 도면 (MeetMap)</h3>
        ${floorsHtml}
      </div>
      <div class="d-sec">
        <h3>MeetMap 바로가기</h3>
        <div class="d-actions">
          <a class="abtn mm" href="${MM}/" target="_blank">전체 디렉터리 ↗</a>
        </div>
      </div>`}
      <div class="d-sec">${confHtml}</div>
    `;
    body.querySelector('#d-route-main').addEventListener('click', () => showRoute('main', b));
    body.querySelector('#d-route-back').addEventListener('click', () => showRoute('back', b));
    body.querySelectorAll('.fbtn').forEach(btn =>
      btn.addEventListener('click', () => openModal(btn.dataset.title, MM + btn.dataset.link)));
  }

  document.getElementById('d-close').addEventListener('click', deselect);

  /* ---------------- sidebar list & 길찾기 박스 ---------------- */
  const blist = document.getElementById('blist');
  function buildList() {
    let html = '<div class="group-title">대전본원</div>';
    D.buildings.forEach(b => {
      html += `
        <div class="bcard" data-bid="${b.id}">
          <div class="row1">
            <span class="bname">${b.name}</span>
            <span class="bnum">${/^\d+$/.test(b.id) && +b.id < 100 ? b.id + '동' : '부속'}</span>
          </div>
          <div class="bfac">${b.facil}</div>
          ${PUBLIC_MODE ? '' : `<div class="bmeta">지상 ${b.levels}층 · 호실 ${b.roomCount}개</div>`}
        </div>`;
    });
    html += '<div class="group-title">지역 연구센터 (원외)</div>';
    D.remote.forEach(r => {
      html += `
        <div class="bcard" data-remote="${r.id}">
          <div class="row1">
            <span class="bname">${r.name}</span>
            <span class="bnum remote">${r.region}</span>
          </div>
          <div class="bmeta">${PUBLIC_MODE ? r.region + ' 지역 연구센터' : `층 ${r.floors.length}개 · 호실 ${r.roomCount}개 · 클릭하여 도면 보기`}</div>
        </div>`;
    });
    blist.innerHTML = html;
    blist.querySelectorAll('.bcard[data-bid]').forEach(card =>
      card.addEventListener('click', () => selectBuilding(card.dataset.bid, {})));
    blist.querySelectorAll('.bcard[data-remote]').forEach(card =>
      card.addEventListener('click', () => {
        const r = D.remote.find(x => x.id === card.dataset.remote);
        if (r && r.floors.length) openModal(r.name + ' ' + r.floors[0].name + ' 도면', MM + r.floors[0].link);
        else openModal(r.name, MM + '/');
      }));
  }
  buildList();

  // 길찾기 퀵 박스 (출발 게이트 → 도착 건물)
  (function routeBox() {
    const destSel = document.getElementById('rb-dest');
    D.buildings.forEach(b => {
      const o = document.createElement('option');
      o.value = b.id; o.textContent = b.name;
      destSel.appendChild(o);
    });
    document.getElementById('rb-go').addEventListener('click', () => {
      const bid = destSel.value;
      const from = document.getElementById('rb-from').value;
      if (!bid) { toast('도착 건물을 선택하세요'); return; }
      const b = D.buildings.find(x => x.id === bid);
      selectBuilding(bid, { fly: false });
      showRoute(from, b);
    });
    // 안내 캐릭터 변경 시 진행 중 경로에도 즉시 반영
    document.getElementById('rb-person').addEventListener('change', ev => {
      if (routeWalker && routeGroup) {
        routeGroup.remove(routeWalker.group);
        routeWalker = makeCharacter(ev.target.value);
        routeGroup.add(routeWalker.group);
      }
    });
  })();

  /* ---------------- search ---------------- */
  const searchInput = document.getElementById('search');
  const searchRes = document.getElementById('search-results');

  const roomIndex = [];
  D.buildings.concat(D.remote).forEach(b => {
    (b.floors || []).forEach(f => {
      f.rooms.forEach(rm => roomIndex.push({ room: rm, bid: b.id, bname: b.name, floor: f.name }));
    });
  });
  const aliasEntries = Object.entries(D.aliases);

  function doSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { searchRes.classList.remove('open'); return; }
    const out = [];

    D.buildings.forEach(b => {
      if (b.name.toLowerCase().includes(q) || (b.id + '동').includes(q)) {
        out.push({
          kind: '건물', title: b.name, desc: b.facil, routeBid: b.id,
          act: () => selectBuilding(b.id, {})
        });
      }
    });
    D.remote.forEach(r => {
      if (r.name.toLowerCase().includes(q)) {
        out.push({
          kind: '원외', title: r.name, desc: r.region + ' · 도면 열기',
          act: () => r.floors.length && openModal(r.name, MM + r.floors[0].link)
        });
      }
    });

    aliasEntries.forEach(([name, target]) => {
      if (out.length > 24) return;
      if (name.toLowerCase().includes(q)) {
        const bid = target.split('-')[0];
        out.push({
          kind: '별칭', title: name, desc: '→ ' + target,
          routeBid: (/^\d+-/.test(target) && D.buildings.some(b => b.id === bid)) ? bid : null,
          act: () => resolveAlias(name, target)
        });
      }
    });

    if (/^[\d가-힣a-z]/.test(q)) {
      let n = 0;
      for (const r of roomIndex) {
        if (r.room.toLowerCase().includes(q)) {
          out.push({
            kind: '호실', title: r.room, desc: `${r.bname} ${r.floor}`,
            routeBid: D.buildings.some(b => b.id === r.bid) ? r.bid : null,
            act: () => { openRoomView(r.room); if (bMeshes[r.bid]) selectBuilding(r.bid, {}); }
          });
          if (++n >= 12) break;
        }
      }
    }

    if (!out.length) {
      searchRes.innerHTML = '<div class="sr-none">검색 결과가 없습니다</div>';
    } else {
      searchRes.innerHTML = out.slice(0, 26).map((o, i) => `
        <div class="sr-item" data-i="${i}">
          <div class="sr-main">
            <div class="t"><span class="tag">${o.kind}</span>${o.title}</div>
            <div class="d">${o.desc}</div>
          </div>
          ${o.routeBid ? `
          <div class="sr-actions">
            <button class="sr-go" data-i="${i}" data-from="main" title="정문에서 길찾기">🚶 정문</button>
            <button class="sr-go" data-i="${i}" data-from="back" title="후문에서 길찾기">후문</button>
          </div>` : ''}
        </div>`).join('');
      searchRes.querySelectorAll('.sr-item').forEach(el =>
        el.addEventListener('click', ev => {
          if (ev.target.closest('.sr-go')) return;
          out[+el.dataset.i].act();
          searchRes.classList.remove('open');
          searchInput.blur();
        }));
      searchRes.querySelectorAll('.sr-go').forEach(btn =>
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const o = out[+btn.dataset.i];
          const b = D.buildings.find(x => x.id === o.routeBid);
          selectBuilding(b.id, { fly: false });
          showRoute(btn.dataset.from, b);
          searchRes.classList.remove('open');
          searchInput.blur();
        }));
    }
    searchRes.classList.add('open');
  }

  function resolveAlias(name, target) {
    if (/^\d+-$/.test(target)) {
      const bid = target.slice(0, -1);
      if (bMeshes[bid]) selectBuilding(bid, {});
      else {
        const r = D.remote.find(x => x.id === bid);
        if (r && r.floors.length) openModal(r.name, MM + r.floors[0].link);
      }
    } else {
      const bid = target.split('-')[0];
      openRoomView(target, name);
      if (bMeshes[bid]) selectBuilding(bid, {});
    }
  }

  searchInput.addEventListener('input', () => doSearch(searchInput.value));
  searchInput.addEventListener('focus', () => searchInput.value && doSearch(searchInput.value));
  document.addEventListener('click', ev => {
    if (!ev.target.closest('.searchbox')) searchRes.classList.remove('open');
  });

  /* ---------------- MeetMap modal ---------------- */
  const modal = document.getElementById('modal');
  const mFrame = document.getElementById('m-frame');
  function openModal(title, url) {
    if (PUBLIC_MODE) { toast('외부 공개판에서는 사내망 자료를 제공하지 않습니다'); return; }
    document.getElementById('m-title').textContent = title;
    document.getElementById('m-open').href = url;
    mFrame.src = url;
    modal.classList.add('open');
  }
  function openRoomView(roomId, note) {
    if (PUBLIC_MODE) { toast('외부 공개판에서는 내부 도면을 제공하지 않습니다'); return; }
    let url = `${MM}/v/${encodeURIComponent(roomId)}`;
    if (note) url += `?note=${encodeURIComponent(note)}`;
    openModal(`호실 ${roomId} 위치 (MeetMap)`, url);
  }
  document.getElementById('m-close').addEventListener('click', () => {
    modal.classList.remove('open');
    mFrame.src = 'about:blank';
  });
  modal.addEventListener('click', ev => {
    if (ev.target === modal) { modal.classList.remove('open'); mFrame.src = 'about:blank'; }
  });

  /* ---------------- top bar ---------------- */
  document.getElementById('btn-side').addEventListener('click', () =>
    document.getElementById('sidebar').classList.toggle('hidden'));
  document.getElementById('btn-reset').addEventListener('click', () => flyTo(HOME.pos, HOME.tgt));
  document.getElementById('btn-top').addEventListener('click', () =>
    flyTo(new THREE.Vector3(-10, 780, -29), new THREE.Vector3(-10, 0, -30)));
  let showLabels = true;
  document.getElementById('btn-labels').addEventListener('click', ev => {
    showLabels = !showLabels;
    ev.currentTarget.classList.toggle('on', showLabels);
  });
  let spinning = false;
  document.getElementById('btn-spin').addEventListener('click', ev => {
    spinning = !spinning;
    ev.currentTarget.classList.toggle('on', spinning);
    controls.autoRotate = spinning;
    controls.autoRotateSpeed = 0.8;
  });
  document.getElementById('btn-api').addEventListener('click', () =>
    openModal('MeetMap API 안내', MM + '/api'));
  document.getElementById('btn-voice').addEventListener('click', ev => {
    Voice.on = !Voice.on;
    ev.currentTarget.classList.toggle('on', Voice.on);
    ev.currentTarget.textContent = Voice.on ? '🔊 음성 ON' : '🔈 음성';
    if (Voice.on) {
      Voice.unlock();                                 // 사용자 제스처로 오디오 활성화
      lastSpeak = -99;                                // 즉시 한 마디
      toast(IS_IOS ? '음성을 켰습니다 · 소리가 없으면 측면 무음 스위치를 확인하세요'
                   : '캐릭터 음성·혼잣말을 켰습니다');
    } else {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      bubbleEl.style.display = 'none';
      toast('캐릭터 음성을 껐습니다');
    }
  });
  document.getElementById('route-clear').addEventListener('click', clearRoute);

  // 나침반: 클릭 시 북쪽 정렬 (거리·고도 유지)
  const compassRose = document.getElementById('compass-rose');
  document.getElementById('compass').addEventListener('click', () => {
    const t = controls.target.clone();
    const off = camera.position.clone().sub(t);
    const r = Math.max(Math.hypot(off.x, off.z), 40);
    flyTo(new THREE.Vector3(t.x, camera.position.y, t.z + r), t);
  });

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ============================================================
   *  시간 · 날씨 환경 (해 / 노을 / 달 / 별 / 구름 / 비 / 눈 / 안개)
   * ============================================================ */
  const LAT = D.origin.lat * Math.PI / 180;
  const SKY_R = 1900;

  // 해 · 달 · 별 · 구름
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(58, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4 }));
  scene.add(sunDisc);
  const sunHalo = new THREE.Mesh(new THREE.SphereGeometry(110, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.22, depthWrite: false }));
  scene.add(sunHalo);

  function moonTexture(phase) {          // 0=삭, 0.5=보름
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = '#eef2f7';
    g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.fill();
    // 그림자: 위상에 따라 가림
    const k = (phase * 2) % 2;                       // 0→2
    const illum = 1 - Math.abs(1 - k);               // 0(삭)~1(보름)
    g.globalCompositeOperation = 'destination-out';
    const off = (1 - illum) * 240 * (phase < 0.5 ? 1 : -1);
    g.beginPath(); g.arc(128 + off, 128, 122, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'source-over';
    // 크레이터
    g.fillStyle = 'rgba(150,160,175,0.35)';
    [[95, 100, 18], [150, 145, 13], [120, 175, 10], [165, 95, 8]].forEach(([mx, my, r]) => {
      g.beginPath(); g.arc(mx, my, r, 0, Math.PI * 2); g.fill();
    });
    return new THREE.CanvasTexture(c);
  }
  const moonMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const moonDisc = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), moonMat);
  scene.add(moonDisc);
  let moonPhaseCache = -1;

  const starGeo = new THREE.BufferGeometry();
  {
    const rs = makeRng(20260917), pos = [];
    for (let i = 0; i < 700; i++) {
      const th = rs() * Math.PI * 2, ph = Math.acos(rs() * 0.85 + 0.05);
      pos.push(Math.sin(ph) * Math.cos(th) * SKY_R, Math.cos(ph) * SKY_R, Math.sin(ph) * Math.sin(th) * SKY_R);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 9, transparent: true, opacity: 0, depthWrite: false });
  scene.add(new THREE.Points(starGeo, starMat));

  // 구름 (판형 스프라이트)
  const cloudTex = (() => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 70, 10, 128, 70, 110);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 128);
    return new THREE.CanvasTexture(c);
  })();
  const clouds = [];
  {
    const rc = makeRng(777);
    for (let i = 0; i < 26; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(320 + rc() * 380, 130 + rc() * 120),
        new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: 0, depthWrite: false }));
      m.position.set(-1400 + rc() * 2800, 330 + rc() * 190, -1400 + rc() * 2800);
      m.rotation.x = -Math.PI / 2.2;
      scene.add(m);
      clouds.push({ m, sp: 4 + rc() * 7 });
    }
  }

  // 비 · 눈
  function makeParticles(n, size, color, spread) {
    const g = new THREE.BufferGeometry();
    const rp = makeRng(4242 + n), pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = -spread + rp() * spread * 2;
      pos[i * 3 + 1] = rp() * 420;
      pos[i * 3 + 2] = -spread + rp() * spread * 2;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0, depthWrite: false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    scene.add(pts);
    return { pts, mat: m, arr: pos, n };
  }
  const rain = makeParticles(2600, 2.6, 0xaecbe0, 900);
  const snow = makeParticles(1500, 11, 0xffffff, 900);
  // 눈송이: 육각 결정체 텍스처
  snow.mat.map = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.translate(32, 32);
    g.strokeStyle = '#ffffff';
    g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {                 // 6방향 가지 + 곁가지
      g.rotate(Math.PI / 3);
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -26); g.stroke();
      g.lineWidth = 3;
      [[-9, 8], [-16, 6.5], [-22, 5]].forEach(([y, len]) => {
        g.beginPath(); g.moveTo(0, y); g.lineTo(len * 0.8, y - len * 0.7); g.stroke();
        g.beginPath(); g.moveTo(0, y); g.lineTo(-len * 0.8, y - len * 0.7); g.stroke();
      });
    }
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(0, 0, 4.5, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  })();
  snow.mat.alphaTest = 0.12;
  snow.mat.needsUpdate = true;

  // 태양 고도/방위 (간이 천문 계산)
  function solar(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const doy = Math.floor((date - start) / 86400000);
    const decl = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (doy - 81) / 365);
    const hrs = date.getHours() + date.getMinutes() / 60;
    // 태양시 보정: 경도차(표준자오선 135°E) + 균시차
    const B = 2 * Math.PI * (doy - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);   // 분
    const solarHrs = hrs + (4 * (D.origin.lon - 135) + eot) / 60;
    const H = (solarHrs - 12) * 15 * Math.PI / 180;
    const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT));
    return { el, az, doy };
  }
  function moonPhase(date) {                          // 0=삭 0.5=보름
    const known = Date.UTC(2000, 0, 6, 18, 14);       // 기준 삭
    const days = (date.getTime() - known) / 86400000;
    return ((days % 29.53059) + 29.53059) % 29.53059 / 29.53059;
  }
  const lerpC = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

  let envState = { rain: 0, snow: 0, night: 0 };
  function applyEnv(date, weatherKey) {
    const { el, az } = solar(date);
    const elDeg = el * 180 / Math.PI;
    // 하늘색: 낮 → 노을 → 박명 → 밤
    let skyC, fogC, sunI, hemiI, sunC;
    if (elDeg > 12) {
      const k = Math.min(1, (elDeg - 12) / 30);
      skyC = lerpC(0x9fc6e0, 0x6fa8d8, k); fogC = lerpC(0xbcd4e6, 0x8fbcd9, k);
      sunI = 0.85 + k * 0.35; hemiI = 0.8 + k * 0.25; sunC = lerpC(0xffe6bb, 0xfff6e2, k);
    } else if (elDeg > 0) {
      const k = elDeg / 12;                            // 노을
      skyC = lerpC(0xe98a4e, 0x9fc6e0, k); fogC = lerpC(0xe6a878, 0xbcd4e6, k);
      sunI = 0.35 + k * 0.5; hemiI = 0.45 + k * 0.35; sunC = lerpC(0xff9046, 0xffe6bb, k);
    } else if (elDeg > -8) {
      const k = (elDeg + 8) / 8;                       // 박명
      skyC = lerpC(0x2b3f68, 0xe98a4e, k); fogC = lerpC(0x33456b, 0xe6a878, k);
      sunI = 0.06 + k * 0.3; hemiI = 0.4 + k * 0.2; sunC = lerpC(0x8091bd, 0xff9046, k);
    } else {
      skyC = new THREE.Color(0x101a33); fogC = new THREE.Color(0x14203e);
      sunI = 0.05; hemiI = 0.34; sunC = new THREE.Color(0x9db0d4);
    }
    const night = elDeg < -2 ? 1 : elDeg < 4 ? (4 - elDeg) / 6 : 0;

    // 날씨 보정
    const W = weatherKey;
    let fogNear = 900, fogFar = 2300, cloudOp = 0, rainOp = 0, snowOp = 0;
    if (W === 'cloudy') {
      skyC = skyC.clone().lerp(new THREE.Color(0x9aa6b4), 0.55);
      fogC = fogC.clone().lerp(new THREE.Color(0xa8b3bf), 0.5);
      sunI *= 0.45; hemiI *= 0.95; cloudOp = 0.75; fogNear = 700; fogFar = 2000;
    } else if (W === 'rain') {
      skyC = skyC.clone().lerp(new THREE.Color(0x5b6874), 0.7);
      fogC = fogC.clone().lerp(new THREE.Color(0x6b7784), 0.7);
      sunI *= 0.25; hemiI *= 0.8; cloudOp = 0.9; rainOp = 0.62; fogNear = 420; fogFar = 1500;
    } else if (W === 'snow') {
      skyC = skyC.clone().lerp(new THREE.Color(0xb9c4cf), 0.65);
      fogC = fogC.clone().lerp(new THREE.Color(0xccd6df), 0.65);
      sunI *= 0.4; hemiI *= 1.05; cloudOp = 0.85; snowOp = 0.9; fogNear = 380; fogFar = 1300;
    } else if (W === 'fog') {
      skyC = skyC.clone().lerp(new THREE.Color(0xb4bcc4), 0.6);
      fogC = fogC.clone().lerp(new THREE.Color(0xbcc4cc), 0.75);
      sunI *= 0.35; cloudOp = 0.45; fogNear = 60; fogFar = 560;
    } else {                                           // sunny
      cloudOp = 0.18;
    }

    scene.background = skyC;
    scene.fog.color = fogC;
    scene.fog.near = fogNear; scene.fog.far = fogFar;
    sun.intensity = sunI; sun.color = sunC;
    hemi.intensity = hemiI;
    hemi.color = skyC.clone().lerp(new THREE.Color(0xffffff), 0.35);

    // 태양 위치 (방위: 남=0 기준, 서쪽 +)
    const sr = 1500, ce = Math.cos(el), se = Math.sin(el);
    const sx = Math.sin(az) * ce * sr, sy = se * sr, sz = Math.cos(az) * ce * sr;
    sun.position.set(sx, Math.max(sy, 60), sz);
    sunDisc.position.set(sx, sy, sz);
    sunHalo.position.copy(sunDisc.position);
    const sunVis = elDeg > -3;
    sunDisc.visible = sunHalo.visible = sunVis;
    if (sunVis) {
      sunDisc.material.color = sunC.clone().lerp(new THREE.Color(0xffffff), 0.35);
      sunHalo.material.opacity = elDeg < 10 ? 0.4 : 0.18;
    }

    // 달: 위상 + 태양 반대편
    const ph = moonPhase(date);
    if (Math.abs(ph - moonPhaseCache) > 0.01) {
      moonMat.map = moonTexture(ph);
      moonMat.needsUpdate = true;
      moonPhaseCache = ph;
    }
    const mAz = az + Math.PI * (1 + (ph - 0.5) * 1.2);
    const mEl = Math.max(0.18, -el + 0.35 * Math.cos(ph * Math.PI * 2));
    const mce = Math.cos(mEl), mse = Math.sin(mEl);
    moonDisc.position.set(Math.sin(mAz) * mce * sr, mse * sr, Math.cos(mAz) * mce * sr);
    moonDisc.lookAt(0, 120, 0);
    const moonVis = night > 0.15 && ph > 0.06 && ph < 0.94 && (W === 'sunny' || W === 'cloudy' || W === 'fog');
    moonDisc.visible = moonVis;
    moonMat.opacity = moonVis ? Math.min(1, night) * (W === 'sunny' ? 1 : 0.55) : 0;

    starMat.opacity = (W === 'sunny' ? 0.95 : W === 'cloudy' ? 0.25 : 0.05) * Math.max(0, night - 0.25) * 1.4;

    clouds.forEach(c => { c.m.material.opacity = cloudOp; });
    rain.mat.opacity = rainOp; snow.mat.opacity = snowOp;
    envState = { rain: rainOp, snow: snowOp, night };

    // 야간 조명탑 · 가로등 점등
    const lampOn = night > 0.35;
    floodLamps.forEach(f => {
      f.mat.color.setHex(lampOn ? 0xfff6d8 : 0xbfc6cd);
      f.mat.emissive = new THREE.Color(lampOn ? 0xfff0c0 : 0x000000);
      f.glow.material.opacity = lampOn ? 0.3 * Math.min(1, night) : 0;
    });
    if (streetLamps.headMat) {
      streetLamps.headMat.color.setHex(lampOn ? 0xfff3cf : 0xc9cfd5);
      streetLamps.headMat.emissive = new THREE.Color(lampOn ? 0xffedb8 : 0x000000);
      streetLamps.glowMat.opacity = lampOn ? 0.5 * Math.min(1, night) : 0;
    }
    // 야간 창문 불빛 (건물 식별)
    const nv = Math.round(Math.min(1, night) * 255);
    nightEmissive = lampOn
      ? (Math.round(nv * 0.60) << 16) | (Math.round(nv * 0.50) << 8) | Math.round(nv * 0.30)
      : 0x000000;
    if (typeof refreshBuildingLights === 'function') refreshBuildingLights();

    // 경기장 모드: 낮=경기, 해질녘=대기석, 한밤중=귀가
    if (fieldModeAuto) fieldMode = elDeg > 1 ? 'play' : elDeg > -9 ? 'bench' : 'off';
    renderer.toneMappingExposure = 1;
  }

  // 파티클 낙하 애니메이션
  function stepWeather(dt) {
    const camX = camera.position.x, camZ = camera.position.z;
    if (envState.rain > 0) {
      const a = rain.arr;
      for (let i = 0; i < rain.n; i++) {
        a[i * 3 + 1] -= dt * 260;
        if (a[i * 3 + 1] < 0) { a[i * 3 + 1] = 400; }
      }
      rain.pts.geometry.attributes.position.needsUpdate = true;
      rain.pts.position.set(camX, 0, camZ);
    }
    if (envState.snow > 0) {
      const a = snow.arr;
      for (let i = 0; i < snow.n; i++) {
        a[i * 3 + 1] -= dt * 26;
        a[i * 3] += Math.sin((a[i * 3 + 1] + i) * 0.03) * dt * 7;
        if (a[i * 3 + 1] < 0) { a[i * 3 + 1] = 400; }
      }
      snow.pts.geometry.attributes.position.needsUpdate = true;
      snow.pts.position.set(camX, 0, camZ);
    }
    clouds.forEach(c => {
      if (c.m.material.opacity <= 0.01) return;
      c.m.position.x += c.sp * dt;
      if (c.m.position.x > 1500) c.m.position.x = -1500;
    });
  }

  /* ---------------- 시간·날씨 UI ---------------- */
  let envDate = new Date();
  let envWeather = 'auto';
  const WEATHER_KEYS = ['sunny', 'cloudy', 'rain', 'snow', 'fog'];
  function autoWeather(date) {           // 날짜 기반 의사난수 + 계절 반영
    const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    const h = (doy * 2654435761 + date.getFullYear() * 97 + date.getHours() * 13) >>> 0;
    const m = date.getMonth();
    const r = (h % 100) / 100;
    if (m === 11 || m === 0 || m === 1) {            // 겨울
      if (r < 0.2) return 'snow';
      if (r < 0.34) return 'cloudy';
      if (r < 0.42) return 'fog';
      return 'sunny';
    }
    if (m >= 5 && m <= 8) {                          // 여름·장마
      if (r < 0.3) return 'rain';
      if (r < 0.5) return 'cloudy';
      return 'sunny';
    }
    if (r < 0.13) return 'rain';
    if (r < 0.3) return 'cloudy';
    if (r < 0.38) return 'fog';
    return 'sunny';
  }
  const WLABEL = { sunny: '☀️ 맑음', cloudy: '☁️ 흐림', rain: '🌧️ 비', snow: '❄️ 눈', fog: '🌫️ 안개' };
  function refreshEnv() {
    const w = envWeather === 'auto' ? autoWeather(envDate) : envWeather;
    applyEnv(envDate, w);
    const { el } = solar(envDate);
    const elD = el * 180 / Math.PI;
    const ph = moonPhase(envDate);
    const moonName = ph < 0.06 || ph > 0.94 ? '삭' : ph < 0.22 ? '초승달'
      : ph < 0.28 ? '상현달' : ph < 0.45 ? '상현망' : ph < 0.55 ? '보름달'
      : ph < 0.72 ? '하현망' : ph < 0.78 ? '하현달' : '그믐달';
    const phase = elD > 12 ? '낮' : elD > 0 ? '노을' : elD > -8 ? '박명' : '밤';
    const el2 = document.getElementById('env-info');
    if (el2) {
      el2.textContent = `${phase} · ${WLABEL[w]}${elD < 2 ? ' · ' + moonName : ''}`;
    }
  }
  (function envUI() {
    const dEl = document.getElementById('env-date');
    const tEl = document.getElementById('env-time');
    const wEl = document.getElementById('env-weather');
    const pad = n => String(n).padStart(2, '0');
    const syncInputs = () => {
      dEl.value = `${envDate.getFullYear()}-${pad(envDate.getMonth() + 1)}-${pad(envDate.getDate())}`;
      tEl.value = `${pad(envDate.getHours())}:${pad(envDate.getMinutes())}`;
    };
    syncInputs();
    const onChange = () => {
      const [y, mo, d] = dEl.value.split('-').map(Number);
      const [hh, mm] = tEl.value.split(':').map(Number);
      if (y && mo && d && !isNaN(hh)) envDate = new Date(y, mo - 1, d, hh, mm || 0);
      envWeather = wEl.value;
      refreshEnv();
    };
    dEl.addEventListener('change', onChange);
    tEl.addEventListener('change', onChange);
    wEl.addEventListener('change', onChange);
    // 경기 모드 / 종목 선택 (외부 방문자용 성능 옵션)
    const smEl = document.getElementById('sport-mode');
    const spEl = document.getElementById('sport-pick');
    const applySport = () => {
      fieldModeAuto = smEl.value === 'auto';
      if (!fieldModeAuto) fieldMode = smEl.value;
      const pick = spEl.value;
      activeSports.clear();
      (pick === 'all' ? ['soccer', 'baseball', 'jokgu', 'tennis'] : [pick])
        .forEach(k => activeSports.add(k));
      refreshEnv();
    };
    smEl.addEventListener('change', applySport);
    spEl.addEventListener('change', applySport);
    document.getElementById('env-now').addEventListener('click', () => {
      envDate = new Date();
      envWeather = 'auto';
      wEl.value = 'auto';
      syncInputs();
      refreshEnv();
      toast('현재 날짜·시간으로 설정했습니다');
    });
    refreshEnv();                                    // 접속 시각 자동 반영
  })();

  /* ---------------- render loop ---------------- */
  const tmpV = new THREE.Vector3();
  function updateLabels() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    labels.forEach(l => {
      if (!showLabels || l.visible === false) { l.el.style.display = 'none'; return; }
      tmpV.copy(l.pos).project(camera);
      const dist = camera.position.distanceTo(l.pos);
      if (tmpV.z > 1 || dist > l.minDist) { l.el.style.display = 'none'; return; }
      l.el.style.display = 'block';
      l.el.style.left = ((tmpV.x + 1) / 2 * w) + 'px';
      l.el.style.top = ((-tmpV.y + 1) / 2 * h) + 'px';
      l.el.style.opacity = String(Math.min(1, Math.max(0.35, 1.6 - dist / l.minDist)));
    });
  }

  /* ============================================================
   *  데모(홍보 영상) 모드 — ?demo=1
   *  정문에서 1동~체육동까지 다양한 캐릭터가 찾아가는 60초 시네마틱
   * ============================================================ */
  const DEMO = {
    on: false, t: 0, seg: -1, intro: 5.0, per: 4.0, outro: 7.0,
    // 비행 캐릭터(용·독수리·돌고래)는 화면 흔들림이 커서 제외
    chars: ['m', 'tiger', 'f', 'dog', 'rabbit', 'horse', 'cat', 'monkey',
            'penguin', 'deer', 'rooster', 'pig', 'squirrel', 'ox', 'chipmunk', 'croc'],
    // 건물 8곳 + 경기장 관람 4곳
    seq: [{ b: '1' }, { b: '3' }, { b: '5' }, { s: 'soccer' }, { b: '6' }, { b: '7' },
          { s: 'baseball' }, { b: '11' }, { b: '12' }, { s: 'jokgu' }, { b: '903' }, { s: 'tennis' }],
    sports: {
      soccer: ['⚽ 축구장', '점심시간마다 열리는 사내 리그'],
      baseball: ['⚾ 야구장', '주말이면 함성이 가득한 그라운드'],
      jokgu: ['🏐 족구장', '연구원들에게 가장 인기 있는 종목'],
      tennis: ['🎾 테니스 코트', '야간 조명까지 갖춘 4면 코트'],
    },
    tips: ['국내 최고의 ICT 연구기관', 'AI · 반도체 · 6G 원천기술', '40여 년의 연구 헤리티지',
           '캠퍼스 어디든 3D로 길안내', '일하고 운동하고, 활기찬 캠퍼스', '오늘도 미래를 만듭니다'],
    els: {},
  };
  function demoBuildings() { return DEMO.seq; }
  function setupDemoUI() {
    ['sidebar'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    ['topbar', 'envbar', 'hint', 'routebar'].forEach(id => {
      const e = document.getElementById(id); if (e) e.style.display = 'none';
    });
    const d = document.getElementById('detail'); if (d) d.style.display = 'none';
    const pn = document.getElementById('public-notice');   // 데모 중에는 자막과 겹치지 않게 숨김
    if (pn) pn.style.display = 'none';
    const host = document.getElementById('viewport');
    const mk = (cls, html) => {
      const e = document.createElement('div');
      e.className = cls;
      if (html) e.innerHTML = html;
      host.appendChild(e);
      return e;
    };
    DEMO.els.scrim = mk('demo-scrim');
    DEMO.els.title = mk('demo-title',
      '<div class="dt-logo"><span class="e">E</span><span class="t">T</span>' +
      '<span class="r">R</span><span class="i">I</span></div>' +
      '<div class="dt-main">대전본원 3D 캠퍼스</div>' +
      '<div class="dt-sub">정문에서 건물까지, 신나게 찾아가는 길</div>');
    DEMO.els.lower = mk('demo-lower',
      '<div class="dl-chip"></div><div class="dl-name"></div><div class="dl-fac"></div>');
    DEMO.els.route = mk('demo-route');
    DEMO.els.tip = mk('demo-tip');
    DEMO.els.bar = mk('demo-bar', '<i></i>');
    DEMO.els.end = mk('demo-end',
      '<div class="de-main">ETRI에서 만나요!</div>' +
      '<div class="de-sub">한국전자통신연구원 · 대전광역시 유성구 가정로 218</div>' +
      '<div class="de-url">midasyoo.github.io/etri-3d-map</div>');
    DEMO.els.flash = mk('demo-flash');
    window.dispatchEvent(new Event('resize'));   // 사이드바 숨김 후 전체 폭으로 렌더
  }
  function runDemo(dt) {
    DEMO.t += dt;
    const T = DEMO.t, list = demoBuildings();
    const total = DEMO.intro + list.length * DEMO.per + DEMO.outro;
    const E = DEMO.els;
    // 시간대: 오전 9시 30분 → 일몰 무렵으로 자연스럽게 흐름
    const segEnd = DEMO.intro + list.length * DEMO.per;
    const hour = T <= segEnd ? 9.5 + (T / segEnd) * 7.0
                             : 16.5 + Math.min(1, (T - segEnd) / DEMO.outro) * 2.1;
    if (Math.floor(T * 2) !== DEMO._envTick) {
      DEMO._envTick = Math.floor(T * 2);
      envDate = new Date(2026, 8, 17, Math.floor(hour), Math.round((hour % 1) * 60));
      refreshEnv();
    }
    E.bar.firstChild.style.width = Math.min(100, (T / total) * 100) + '%';

    if (T < DEMO.intro) {                       // ── 인트로: 캠퍼스 상공 선회
      const k = T / DEMO.intro;
      const a = -0.85 + k * 0.8;
      const r = 700 - k * 260, h = 330 - k * 140;
      camera.position.set(Math.sin(a) * r, h, Math.cos(a) * r + 40);
      controls.target.set(-10, 0, 0);
      controls.update();
      showLabels = false;                       // 타이틀 카드: 화면 정돈
      if (routeWalker) routeWalker.group.visible = false;
      bubbleEl.style.display = 'none';
      E.title.classList.toggle('show', k > 0.12 && k < 0.92);
      E.scrim.classList.toggle('show', k > 0.06 && k < 0.95);
      E.tip.textContent = DEMO.tips[0];
      E.tip.classList.toggle('show', k > 0.35);
      return;
    }
    const after = T - DEMO.intro;
    const idx = Math.floor(after / DEMO.per);
    if (idx >= list.length) {                   // ── 아웃트로: 전경 + 마무리 카드
      E.title.classList.remove('show');
      E.lower.classList.remove('show');
      E.route.classList.remove('show');
      const k = Math.min(1, (after - list.length * DEMO.per) / DEMO.outro);
      const a = 0.5 + k * 1.4;
      camera.position.set(Math.sin(a) * (440 + k * 300), 250 + k * 170, Math.cos(a) * (440 + k * 300));
      controls.target.set(0, 0, 0);
      controls.update();
      showLabels = false;
      if (routeWalker) routeWalker.group.visible = false;
      bubbleEl.style.display = 'none';
      E.end.classList.toggle('show', k > 0.18);
      E.scrim.classList.toggle('show', k > 0.1);
      E.tip.classList.remove('show');
      return;
    }
    const item = list[idx], u = (after % DEMO.per) / DEMO.per;
    const b = item.b ? D.buildings.find(x => x.id === item.b) : null;
    if (idx !== DEMO.seg) {                     // 새 구간 진입
      DEMO.seg = idx;
      showLabels = true;
      E.scrim.classList.remove('show');
      E.title.classList.remove('show');
      E.lower.classList.add('show');
      E.tip.textContent = DEMO.tips[idx % DEMO.tips.length];
      E.tip.classList.add('show');
      E.flash.classList.remove('go');
      void E.flash.offsetWidth;
      E.flash.classList.add('go');
      lastSpeak = -99;
      flyAnim = null;
      const dEl = document.getElementById('detail');
      if (dEl) dEl.classList.remove('open');
      if (b) {                                  // ── 건물: 캐릭터가 정문에서 출발
        document.getElementById('rb-person').value = DEMO.chars[idx % DEMO.chars.length];
        selectBuilding(b.id, { fly: false });
        showRoute('main', b);
        E.lower.querySelector('.dl-chip').textContent =
          /^\d+$/.test(b.id) && +b.id < 100 ? b.id + '동' : '부속시설';
        E.lower.querySelector('.dl-name').textContent = b.name;
        E.lower.querySelector('.dl-fac').textContent = b.facil;
        E.route.classList.add('show');
      } else {                                  // ── 경기장: 경기 관람
        deselect();
        clearRoute();
        const meta = DEMO.sports[item.s] || ['경기장', ''];
        E.lower.querySelector('.dl-chip').textContent = '캠퍼스 스포츠';
        E.lower.querySelector('.dl-name').textContent = meta[0];
        E.lower.querySelector('.dl-fac').textContent = meta[1];
        E.route.classList.remove('show');
      }
    }
    if (!b) {                                   // 경기장 구간: 필드 상공 선회
      fieldModeAuto = false; fieldMode = 'play';
      const pitch = (D.pitches || []).find(p2 => p2.sport === item.s);
      if (pitch) {
        let mnX = 1e9, mxX = -1e9, mnZ = 1e9, mxZ = -1e9;
        pitch.foot.forEach(q => {
          mnX = Math.min(mnX, q[0]); mxX = Math.max(mxX, q[0]);
          mnZ = Math.min(mnZ, q[1]); mxZ = Math.max(mxZ, q[1]);
        });
        const fx = (mnX + mxX) / 2, fz = (mnZ + mxZ) / 2;
        const span = Math.max(mxX - mnX, mxZ - mnZ);
        const r = Math.max(span * 0.95, 55) * (1.18 - u * 0.3);   // 서서히 다가감
        const a = idx * 1.7 + T * 0.30;
        camera.position.set(fx + Math.sin(a) * r, 22 + span * 0.42, fz + Math.cos(a) * r);
        controls.target.set(fx, 3, fz);
        controls.update();
      }
      return;
    }
    fieldModeAuto = true;
    if (routeCurve && routeWalker) {            // 구간 내 진행률 직접 제어
      routeT = 0.02 + u * 0.95;
      const mins = routeLen / 67;
      E.route.textContent = `🚩 정문 → ${b.name} 입구 · ${Math.round(routeLen)}m · 도보 ${Math.max(1, Math.ceil(mins))}분`;
      // 카메라: 전반부는 캐릭터 추적, 후반부는 건물 정면으로 안착
      const wp = routeWalker.group.position;
      routeCurve.getTangentAt(Math.min(0.98, routeT), tmpV);
      const yaw = Math.atan2(tmpV.x, tmpV.z);
      const swing = Math.sin(T * 0.9) * 0.5;
      const follow = new THREE.Vector3(
        wp.x - Math.sin(yaw + swing) * 30, 19 + Math.sin(T * 0.7) * 4, wp.z - Math.cos(yaw + swing) * 30);
      const bm = bMeshes[b.id];
      const arrive = new THREE.Vector3(
        b.center[0] + Math.sin(T * 0.35) * 95, (bm ? bm.height : 20) + 62,
        b.center[1] + Math.cos(T * 0.35) * 95);
      const mix = Math.max(0, Math.min(1, (u - 0.55) / 0.35));
      const ease = mix * mix * (3 - 2 * mix);
      camera.position.lerpVectors(follow, arrive, ease);
      const tgt = new THREE.Vector3().lerpVectors(
        new THREE.Vector3(wp.x, wp.y + 7, wp.z),
        new THREE.Vector3(b.center[0], (bm ? bm.height : 20) * 0.5, b.center[1]), ease);
      controls.target.copy(tgt);
      controls.update();
      if (elapsed - lastSpeak > 2.2) {          // 말풍선(무음)
        lastSpeak = elapsed;
        speakWalker(DEMO.chars[idx % DEMO.chars.length], elapsed);
      }
    }
  }

  const clock = new THREE.Clock();
  let elapsed = 0;
  let captureMode = false;
  function animate() {
    requestAnimationFrame(animate);
    if (captureMode) return;            // 캡처 모드: 외부에서 __frame(dt)로 구동
    stepFrame(clock.getDelta());
  }
  function stepFrame(dt) {
    if (DEMO.on) runDemo(dt);

    if (flyAnim) {
      flyAnim.t = Math.min(flyAnim.t + dt / 1.1, 1);
      const e = flyAnim.t < 0.5
        ? 2 * flyAnim.t * flyAnim.t
        : 1 - Math.pow(-2 * flyAnim.t + 2, 2) / 2;
      camera.position.lerpVectors(flyAnim.p0, flyAnim.p1, e);
      controls.target.lerpVectors(flyAnim.t0, flyAnim.t1, e);
      if (flyAnim.t >= 1) flyAnim = null;
    }

    if (routeWalker && routeCurve) {
      if (!routePaused) routeT = (routeT + dt * routeWalker.speed / routeLen) % 1;
      routeCurve.getPointAt(routeT, routeWalker.group.position);
      routeCurve.getTangentAt(routeT, tmpV);
      // 경로 튜브 옆(우측 2.2m)에서 이동
      routeWalker.group.position.x += tmpV.z * 2.2;
      routeWalker.group.position.z += -tmpV.x * 2.2;
      routeWalker.group.rotation.y = Math.atan2(tmpV.x, tmpV.z);
      routeWalker.group.position.y = routeWalker.tick(routeT * routeLen);
      // 혼잣말 · 울음소리 (주기적)
      const kind = document.getElementById('rb-person').value;
      if (Voice.on && elapsed - lastSpeak > 5.0) {
        lastSpeak = elapsed;
        speakWalker(kind, elapsed);
      }
      if (elapsed < bubbleUntil) {                    // 말풍선 위치 갱신
        tmpV.copy(routeWalker.group.position);
        tmpV.y += 11;
        tmpV.project(camera);
        if (tmpV.z < 1) {
          bubbleEl.style.display = 'block';
          bubbleEl.style.left = ((tmpV.x + 1) / 2 * wrap.clientWidth) + 'px';
          bubbleEl.style.top = ((-tmpV.y + 1) / 2 * wrap.clientHeight) + 'px';
        } else bubbleEl.style.display = 'none';
      } else bubbleEl.style.display = 'none';
    } else {
      bubbleEl.style.display = 'none';
    }

    elapsed += dt;
    stepWeather(dt);

    // 경기 장면 (축구·야구·족구·테니스) — 비활성 종목은 숨겨 성능 확보
    for (let i = 0; i < sportsActors.length; i++) {
      const a = sportsActors[i];
      const on = activeSports.has(a.sport);
      if (!on) {
        if (!a.hidden) {
          a.players.forEach(p => { p.group.visible = false; });
          a.props.forEach(o => { o.visible = false; });
          a.hidden = true;
        }
        continue;
      }
      if (a.hidden) {
        a.players.forEach(p => { p.group.visible = true; });
        a.props.forEach(o => { o.visible = true; });
        a.hidden = false;
      }
      a.fn(elapsed);
    }

    // 분수 맥동
    if (fountain) {
      const pulse = 1 + Math.sin(elapsed * 1.6) * 0.16;
      fountain.jet.scale.set(1, pulse, 1);
      fountain.jet.position.y = 6.4 * pulse;
      fountain.crest.position.y = 11.2 * pulse;
      fountain.crest.scale.setScalar(0.9 + Math.sin(elapsed * 2.3) * 0.12);
      fountain.arcs.forEach((a, i) => {
        a.scale.y = 1 + Math.sin(elapsed * 1.9 + i * 0.5) * 0.14;
      });
      fountain.ring.scale.setScalar(1 + Math.sin(elapsed * 1.6) * 0.04);
    }

    // 잉어 유영
    if (kois.length) {
      kois.forEach(k => {
        const a = elapsed * k.sp + k.ph;
        k.grp.position.set(k.cx + Math.cos(a) * k.r, 0.5, k.cz + Math.sin(a) * k.r * 0.6);
        k.grp.rotation.y = Math.atan2(-Math.sin(a) * k.r, Math.cos(a) * k.r * 0.6) + Math.PI / 2;
      });
    }

    controls.update();

    // 나침반 회전 (시선 방위각 반영)
    tmpV.copy(controls.target).sub(camera.position);
    const az = Math.atan2(tmpV.x, -tmpV.z) * 180 / Math.PI;
    compassRose.setAttribute('transform', `rotate(${-az.toFixed(2)} 40 40)`);

    updateLabels();
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = wrap.clientWidth / wrap.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  });


  // deep link: ?b=7 / ?room=7-136 / ?route=7&from=main|back / ?person=m|f / ?cam=x,y,z,tx,ty,tz
  const params = new URLSearchParams(location.search);
  if (params.get('dt')) {                            // ?dt=2026-09-17T19:30
    const dd = new Date(params.get('dt'));
    if (!isNaN(dd)) { envDate = dd; }
  }
  if (params.get('voice') === '1') {                 // 말풍선 미리보기(소리는 클릭 후 재생)
    Voice.on = true;
    const vb = document.getElementById('btn-voice');
    vb.classList.add('on');
    vb.textContent = '🔊 음성 ON';
  }
  if (WEATHER_KEYS.includes(params.get('weather'))) envWeather = params.get('weather');
  if (params.get('dt') || params.get('weather')) {
    const dEl = document.getElementById('env-date'), tEl = document.getElementById('env-time');
    const pad = n => String(n).padStart(2, '0');
    dEl.value = `${envDate.getFullYear()}-${pad(envDate.getMonth() + 1)}-${pad(envDate.getDate())}`;
    tEl.value = `${pad(envDate.getHours())}:${pad(envDate.getMinutes())}`;
    document.getElementById('env-weather').value = envWeather;
    refreshEnv();
  }
  if (['m', 'f', 'tiger', 'penguin', 'dolphin', 'eagle', 'croc', 'cat', 'squirrel', 'chipmunk', 'deer',
       'rat', 'ox', 'rabbit', 'dragon', 'snake', 'horse', 'sheep', 'monkey', 'rooster', 'dog', 'pig']
      .includes(params.get('person'))) {
    document.getElementById('rb-person').value = params.get('person');
  }
  if (params.get('route')) {
    const bid = params.get('route');
    const b = D.buildings.find(x => x.id === bid);
    if (b) {
      selectBuilding(bid, { fly: false });
      showRoute(params.get('from') === 'back' ? 'back' : 'main', b);
      const rt = parseFloat(params.get('rt'));
      if (isFinite(rt) && rt >= 0 && rt < 1) routeT = rt;   // 진행률 지정(캡처용)
      if (params.get('pause') === '1') routePaused = true;
    }
  } else if (params.get('b')) selectBuilding(params.get('b'), {});
  else if (params.get('room')) {
    const rm = params.get('room');
    openRoomView(rm);
    const bid = rm.split('-')[0];
    if (bMeshes[bid]) selectBuilding(bid, {});
  }
  if (params.get('demo') === '1') {         // 홍보 영상 데모 모드
    DEMO.on = true;
    Voice.silent = true;                    // 말풍선만 (무음)
    Voice.on = true;
    envWeather = 'sunny';
    setupDemoUI();
    controls.enabled = false;
    const sec = parseFloat(params.get('seg'));
    if (isFinite(sec)) DEMO.per = sec;
  }
  if (params.get('capture') === '1') {      // 프레임 단위 결정론적 렌더 (영상 캡처용)
    captureMode = true;
    window.__frame = function (dt) { stepFrame(dt); };
    window.__reset = function () { DEMO.t = 0; DEMO.seg = -1; elapsed = 0; };
    window.__seek = function (sec) { const st = 0.25; for (let q = 0; q < sec / st; q++) stepFrame(st); };
    window.__reset();
    window.__ready = true;
  }
  if (params.get('cam')) {                 // cam은 마지막에 적용 (자동 프레이밍보다 우선)
    const a = params.get('cam').split(',').map(Number);
    if (a.length === 6 && a.every(isFinite)) {
      flyAnim = null;
      camera.position.set(a[0], a[1], a[2]);
      controls.target.set(a[3], a[4], a[5]);
      controls.update();
    }
  }
})();
