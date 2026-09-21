# -*- coding: utf-8 -*-
"""Build data.js for the ETRI 3D campus map.

Combines:
  - OSM building footprints (osm_b6.json)  [real geometry]
  - OSM roads (osm_roads.json)             [routing graph + rendering]
  - MeetMap menu structure (menu_structure.json) [floors/rooms]
  - MeetMap rooms (rooms.json) & aliases (alias.json)
  - Building number assignments derived from ETRI visitor-map description
"""
import json, math, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

LAT0, LON0 = 36.38200, 127.36600  # local origin (campus center-ish)
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT0))

def to_xz(lat, lon):
    """world meters: x=east, z=south (three.js ground plane)."""
    return round((lon - LON0) * M_LON, 2), round(-(lat - LAT0) * M_LAT, 2)

def rect(clat, clon, w_m, h_m, deg=0.0):
    """rotated rectangle footprint (w=east-west extent, h=north-south) in lat/lon."""
    cx, cz = (clon - LON0) * M_LON, -(clat - LAT0) * M_LAT
    a = math.radians(deg)
    pts = []
    for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        dx, dz = sx * w_m / 2, sz * h_m / 2
        rx = dx * math.cos(a) - dz * math.sin(a)
        rz = dx * math.sin(a) + dz * math.cos(a)
        pts.append([round(cx + rx, 2), round(cz + rz, 2)])
    return pts

# ---------------- load ----------------
import os
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'source-data')
J = lambda p: json.load(open(os.path.join(BASE, p), encoding='utf-8'))
osm_b = J('osm_b6.json')
osm_r = J('osm_roads.json')
osm_l = J('osm_leisure.json')
menu = J('menu_structure.json')
rooms = J('rooms.json')
alias = J('alias.json')

ways = {e['id']: e for e in osm_b['elements'] if e['type'] == 'way' and 'geometry' in e}

def poly(way_id):
    g = ways[way_id]['geometry']
    pts = [list(to_xz(p['lat'], p['lon'])) for p in g]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts

# ---------------- building assignments ----------------
# confidence: 'osm+anchor' = OSM footprint + independent anchor (name/POI)
#             'osm+layout' = OSM footprint, number inferred from official layout description
#             'approx'     = footprint synthesized (not in OSM)
def pll(pts):
    """(lat,lon) 목록 → 로컬 좌표 다각형"""
    return [list(to_xz(la, lo)) for (la, lo) in pts]


def rot_rect(cx, cz, L, W, deg):
    """로컬 좌표 기준 회전 직사각형 — 길이 L 방향이 +x에서 +z로 deg만큼 회전"""
    a = math.radians(deg)
    dx, dz = math.cos(a), math.sin(a)
    nx, nz = -math.sin(a), math.cos(a)
    return [[round(cx + sx * L / 2 * dx + sn * W / 2 * nx, 2), round(cz + sx * L / 2 * dz + sn * W / 2 * nz, 2)]
            for sx, sn in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

def rect_xz_ll(cx, cz, w, d):
    """로컬 좌표(x=동, z=남) 기준 직사각형"""
    return [[round(cx - w / 2, 1), round(cz - d / 2, 1)], [round(cx + w / 2, 1), round(cz - d / 2, 1)],
            [round(cx + w / 2, 1), round(cz + d / 2, 1)], [round(cx - w / 2, 1), round(cz + d / 2, 1)]]

# 1동 (행정동): 직육면체 — 2동 동편(대로 건너), 녹색 지붕 (위성사진 기반 위치)
FOOT_B1 = rect(36.38157, 127.36749, 62, 44, 0)

BUILDING_DEFS = [
    dict(id='1',  osm=None, foot=FOOT_B1, lv=3, roofC=0x5f9d78,
         name='1동 (행정동)', conf='approx',
         facil='임원실 · 감사부 · 기획본부 · 홍보부 · 중소기업사업화본부'),
    dict(id='2',  osm=938309503, lv=3, roofC=0x5f9d78,
         name='2동', conf='osm+anchor',
         facil='우체국 · 은행(신협) · 노동조합 · 여행사 · 건강관리실'),
    dict(id='3',  osm=938309514, lv=6,
         name='3동', conf='osm+layout',
         facil='ICT창의연구소 · DMC융합연구단'),
    dict(id='4',  osm=None, foot=rect_xz_ll(-68.0, -85.0, 36, 28), lv=3,   # 4동: 3동 서편, 남측 주차장 북쪽 (정문 남향)
         name='4동', conf='approx',
         facil='ICT창의연구소 실험실 · 광RF실험실 · 실리콘실험실'),
    dict(id='5',  osm=938309504, lv=2, roofC=0x5f9d78,
         name='5동 (식당동)', conf='osm+anchor',
         facil='한식당(동편제·서편제) · 양식당 · 분식당 · 매점 · 카페 에뜰'),
    dict(id='6',  osm=239278707, lv=5,
         name='6동', conf='osm+layout',
         facil='통신미디어연구소 · 카페 에뜨리에'),
    dict(id='7',  osm=227607747, lv=6,
         name='7동', conf='osm+anchor',
         facil='인공지능컴퓨팅연구소 · 지능화융합연구소 · 도서관 · 대강당 · 국제회의실'),
    # 8동(소원의 집): 후문 진입로 동편, 4동 서측 도로(z≈-108.7) 북쪽에 접함 — 정문 남향
    dict(id='8',  osm=None, foot=rect_xz_ll(-156.0, -124.0, 32, 20), lv=2,
         name='8동 (소원의 집)', conf='approx',
         facil='중소기업사업화본부'),
    dict(id='9',  osm=938309512, lv=2,
         name='9동 (방문동)', conf='osm+layout',
         facil='방문접수대 · 안내실'),
    dict(id='10', osm=938309520, lv=3,
         name='10동', conf='osm+layout',
         facil='위성안테나 실험동'),
    dict(id='11', osm=468627318, lv=4,
         name='11동', conf='osm+anchor',
         facil='STP 실험실 · 통신실험실 · 통신미디어연구소'),
    dict(id='12', osm=239278708, lv=8, roofC=0x96705a,
         name='12동', conf='osm+anchor',
         facil='지능화융합연구소 · SDB융합연구단'),
    dict(id='13', osm=664408729, lv=7,
         name='13동 (융합동)', conf='osm+anchor',
         facil='융합기술연구생산센터 · 에트리홀딩스'),
    dict(id='901', osm=None, foot=rect_xz_ll(47, 128, 34, 48), lv=2,
         name='동력동', conf='approx', facil='시설관리 · 동력설비'),
    # 드론시험동: 위성사진 기반 재구성 — 사선(41°) 아치지붕 창고 A 본체 (B동·C동·마당은 structures)
    dict(id='902', osm=None, foot=rot_rect(240.0, 239.5, 33, 15.5, 41), lv=1,
         name='드론시험동', conf='approx', facil='드론 시험장',
         arch=dict(cx=240.0, cz=239.5, L=33, W=15.5, yaw=41, wallH=5.5, archH=4.5)),
    # 체육동: 서측 캠퍼스 도로(x≈-35)와 겹치지 않도록 동쪽으로 이동 (x -29~17)
    dict(id='903', osm=None, foot=rect_xz_ll(-6.0, 201.5, 46, 32), lv=1, roofC=0xd98e4a,
         name='체육동 (실내체육관)', conf='approx', facil='체육관'),
]

# menu lookup by building number prefix
menu_by_id = {}
for m in menu:
    n = m['name']
    key = None
    if '대전본원' in n:
        if '동력동' in n: key = '901'
        elif '드론시험동' in n: key = '902'
        elif '체육동' in n: key = '903'
        else:
            import re as _re
            mm = _re.search(r'(\d+)동', n)
            if mm: key = mm.group(1)
    elif '대경권 1동' in n: key = '701'
    elif '대경권 2동' in n: key = '702'
    elif '호남권 1동' in n: key = '801'
    if key: menu_by_id[key] = m

room_count = {}
for r in rooms['rooms']:
    pref = r.split('-')[0]
    room_count[pref] = room_count.get(pref, 0) + 1

buildings = []
for bd in BUILDING_DEFS:
    foot = poly(bd['osm']) if bd.get('osm') else bd['foot']
    m = menu_by_id.get(bd['id'], {})
    floors = [{'name': f['name'], 'link': f['link'], 'rooms': f['rooms']}
              for f in m.get('floors', [])]
    cx = sum(p[0] for p in foot) / len(foot)
    cz = sum(p[1] for p in foot) / len(foot)
    entry = dict(
        id=bd['id'], name=bd['name'], levels=bd['lv'], conf=bd['conf'],
        facil=bd['facil'], foot=foot, center=[round(cx, 1), round(cz, 1)],
        floors=floors, roomCount=room_count.get(bd['id'], 0),
    )
    if 'roofC' in bd:
        entry['roofC'] = bd['roofC']
    if 'arch' in bd:
        entry['arch'] = bd['arch']
    buildings.append(entry)

# remote sites (list-only)
remote = []
for key, nm, region in (('701', '대경권 1동 (본관)', '대구'), ('702', '대경권 2동 (중소기업동)', '대구'),
                        ('801', '호남권 1동 (본관)', '광주')):
    m = menu_by_id.get(key, {})
    remote.append(dict(id=key, name=nm, region=region,
                       floors=[{'name': f['name'], 'link': f['link'], 'rooms': f['rooms']} for f in m.get('floors', [])],
                       roomCount=room_count.get(key, 0)))

# minor structures (context, unlabeled)
# 938309521은 신축 동력동 부지에 흡수되어 제외
MINOR = [938309511, 938309522, 938309515, 938309516, 938309517, 938309518, 938309519]
structures = []
for wid in MINOR:
    if wid in ways:
        structures.append(dict(foot=poly(wid), h=4))
# parking tower (labeled structure)
parking_tower = dict(foot=poly(938309513), h=12, name='주차빌딩 (3주차장)')
# UST (context)
ust = dict(foot=poly(468359773), h=18, name='UST (과학기술연합대학원대학교)')

# ---------------- leisure / parking / lawns ----------------
pitches, parking = [], []
lways = {e['id']: e for e in osm_l['elements'] if e['type'] == 'way' and 'geometry' in e}
def lpoly(e):
    pts = [list(to_xz(p['lat'], p['lon'])) for p in e['geometry']]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts
for e in lways.values():
    t = e.get('tags', {})
    g = e['geometry']
    clat = sum(p['lat'] for p in g) / len(g)
    clon = sum(p['lon'] for p in g) / len(g)
    # 남측 경계 36.3790: 캠퍼스 담장 남쪽(주차장 남측)의 외부 경기장 5곳(OSM 9383095xx, lat≈36.3786~36.3788) 제외
    if not (36.3790 <= clat <= 36.3860 and 127.3615 <= clon <= 127.3710):
        continue
    if t.get('leisure') == 'pitch':
        sport = t.get('sport', 'generic')
        if e['id'] == 938309506:
            sport = 'ground'                       # 다목적 대운동장(트랙 내부) — 라인 없음
        elif e['id'] == 938309508:
            sport = 'jokgu'                        # 족구장
        pitches.append(dict(foot=lpoly(e), sport=sport,
                            track=(e['id'] == 938309506)))
    elif t.get('amenity') == 'parking' and t.get('parking') == 'surface':
        parking.append(dict(foot=lpoly(e)))
# 11동 서측 대형 주차장 (OSM 폴리곤): 위성사진처럼 동·서 2블록 × 3열 이중 주차열 + 북측 단일열 (rows 지정 시 격자 대신 사용)
# 정문 동측(13동 서편) 주차장 — 위성사진: OSM 통로(약 12° 기울어진 동서 3열 + 외곽 루프) 사이 이중 주차열 3조, 중앙 남북 통로로 2블록
def rows_gate_east(lot):
    # 위성사진: OSM 통로(약 12° 기울어진 동서 3열 + 외곽 루프) 사이에 이중 주차열 3조, 중앙 남북 통로로 동·서 2블록 분리
    A = [((208.0, -178.8), (270.1, -192.2)),                  # 북측 외곽 통로
         ((211.3, -162.6), (273.5, -175.7)),                  # 중간 통로 1
         ((215.1, -144.8), (277.4, -157.2)),                  # 중간 통로 2
         ((219.0, -125.7), (281.2, -138.6))]                  # 남측 외곽 통로
    ux, uz = 62.1, -13.4
    Lu = math.hypot(ux, uz); ux, uz = ux / Lu, uz / Lu          # 통로 방향 (동쪽, 약간 북쪽)
    nx, nz = -uz, ux                                           # 통로 법선 (남쪽)
    lot['rows'] = []
    def _row(a0, off, yaw):
        (sx, sz), (ex, ez) = a0
        sx, sz = sx + nx * off, sz + nz * off
        ex, ez = ex + nx * off, ez + nz * off
        mx, mz = (sx + ex) / 2, (sz + ez) / 2
        for (p0, p1) in (((sx + ux * 5.0, sz + uz * 5.0), (mx - ux * 3.0, mz - uz * 3.0)),     # 서측 블록
                         ((mx + ux * 3.0, mz + uz * 3.0), (ex - ux * 5.0, ez - uz * 5.0))):    # 동측 블록
            lot['rows'].append(dict(x0=round(p0[0], 2), z0=round(p0[1], 2), x1=round(p1[0], 2), z1=round(p1[1], 2), yaw=yaw))
    for k in range(3):
        _row(A[k], 5.75, 3.1416)                                   # 통로 남측 줄 (통로 쪽=북향)
        _row(A[k], 10.75, 0.0)                                     # 다음 통로 북측 줄 (남향)
    m0 = ((A[0][0][0] + A[0][1][0]) / 2, (A[0][0][1] + A[0][1][1]) / 2)
    m3 = ((A[3][0][0] + A[3][1][0]) / 2, (A[3][0][1] + A[3][1][1]) / 2)
    lot['aisles'] = [[[round(m0[0], 2), round(m0[1], 2)], [round(m3[0], 2), round(m3[1], 2)]]]   # 중앙 남북 통로

for lot in parking:
    r0 = lot['foot']
    xs = [p[0] for p in r0]; zs = [p[1] for p in r0]
    if min(xs) < -430 and max(zs) > -90 and min(zs) < -150:     # 11동 서측 주차장 식별
        lot['rows'] = []
        for zc in (-131.0, -116.0, -101.0):                      # 이중 주차열 중심선 (사이 통로 폭 ≈ 6m)
            for (x0, x1) in ((-432.0, -381.0), (-367.0, -316.0)):   # 서측·동측 블록 (중앙 통로 x≈-374)
                lot['rows'].append(dict(x0=x0, x1=x1, z=zc - 2.4, yaw=3.1416))   # 북쪽 줄 (북향)
                lot['rows'].append(dict(x0=x0, x1=x1, z=zc + 2.4, yaw=0.0))      # 남쪽 줄 (남향)
        for (x0, x1) in ((-432.0, -381.0), (-367.0, -316.0)):       # 남측(도로변) 단일열
            lot['rows'].append(dict(x0=x0, x1=x1, z=-89.5, yaw=0.0))
        lot['aisles'] = [[[-374.0, -150.0], [-374.0, -86.0]],       # 중앙 남북 통로
                         [[-436.0, -123.5], [-312.0, -123.5]], [[-436.0, -108.5], [-312.0, -108.5]],
                         [[-436.0, -93.5], [-312.0, -93.5]]]         # 동서 통로 (이중열 사이)
    if min(xs) < 0 and max(xs) > 200 and min(zs) > 240:         # 12동 남측 주차장 식별
        # 동측 블록(중앙 통로 x≈147 동쪽 ~ 동편 도로 x≈205)만 위성사진처럼 이중 주차열 지정.
        # 통로는 이미 OSM 도로(z≈266·283·301·318)로 그려지므로 그 사이 중심선 기준 남·북 줄 + 남측 단일열.
        # 나머지(서측 블록·최상단 태양광 열)는 기존 격자 배치 유지 (rowsRect 안에서만 격자 차량 제외).
        lot['rows'] = []
        for zc in (274.6, 292.5, 310.0):
            lot['rows'].append(dict(x0=151.0, x1=202.0, z=zc - 2.5, yaw=3.1416))   # 북쪽 줄 (북향)
            lot['rows'].append(dict(x0=151.0, x1=202.0, z=zc + 2.5, yaw=0.0))      # 남쪽 줄 (남향)
        lot['rows'].append(dict(x0=151.0, x1=202.0, z=325.0, yaw=0.0))             # 남측(경계) 단일열
        lot['rowsRect'] = [147.5, 209.5, 262.0, 328.5]

# 2주차장 (CTCC 서편, OSM 미등록 — 위성사진 기반 근사)
_lot_ge = dict(foot=rect(36.38345, 127.36870, 110, 55, 0))
for _pt in _lot_ge['foot']:                                   # 동측 경계를 x≈302까지 확장 (위성사진: 동측 열 끝까지 포장)
    if _pt[0] > 290: _pt[0] = 302.0
rows_gate_east(_lot_ge); parking.append(_lot_ge)
# 체육동 북동측 소형 주차장 (도로 x≈-2 / x≈13.7 사이 띠)
parking.append(dict(foot=[[1.5, 134.0], [10.5, 134.0], [10.5, 164.0], [1.5, 164.0]]))
# 9동(방문동) 남측 방문객 주차장 (주차빌딩 동편 ~ 정문 진입로 서편, 남동 모서리는 정문 경비실 부지)
parking.append(dict(foot=[[82.0, -161.0], [117.0, -161.0], [117.0, -153.5], [124.0, -153.5], [124.0, -121.0], [82.0, -121.0]]))
# 1동(행정동) 주변 주차장 — 산 서측 경계를 따라 ㄷ자 반대(⊐) 모양 (북·동·남 3구간, 위성사진 기반)
parking.append(dict(foot=[[137.0, 5.0], [170.0, 5.0], [170.0, 21.0], [137.0, 21.0]]))    # 북측 (진입로 동편)
parking.append(dict(foot=[[170.0, 5.0], [182.0, 5.0], [182.0, 84.0], [170.0, 84.0]]))    # 동측 (산 경계)
parking.append(dict(foot=[[100.0, 73.0], [170.0, 73.0], [170.0, 84.0], [100.0, 84.0]]))  # 남측
lawns = [
    # 8동(소원의 집) 남측 ~ 4동 서측 잔디 (후문 사선 도로 동편, 남측 주차장 북쪽)
    dict(foot=[[-167.0, -95.0], [-140.0, -97.0], [-95.0, -97.0],
               [-95.0, -64.0], [-153.0, -64.0], [-167.0, -86.0]]),   # 북측 경계 z≈-97: 야산 남단(z≈-101)과 겹치지 않게
    # 6동·5동 사이 잔디 (남북 인도 x≈-41 / x≈-3 사이, 북측 도로 ~ 에뜨리에 인도 z≈31)
    dict(foot=[[-36.0, -30.0], [-8.0, -30.0], [-8.0, 26.0], [-36.0, 26.0]]),
    # 7동 동편 잔디 2면 (남북 인도 x≈-41 / x≈-3 사이, 정문 인도 z≈74 위·아래)
    dict(foot=[[-36.0, 35.0], [-8.0, 35.0], [-8.0, 69.0], [-36.0, 69.0]]),
    dict(foot=[[-36.0, 79.0], [-8.0, 79.0], [-8.0, 126.0], [-36.0, 126.0]]),
    # 체육동 북측 잔디 + 수목 (구 주차장 부지, 서측 도로 ~ 동측 도로 사이, 체육동 북면까지)
    dict(foot=[[-30.0, 136.0], [-6.0, 136.0], [-6.0, 183.0], [-30.0, 183.0]],
         trees=[[-24, 141], [-12, 145], [-19, 153], [-9, 160], [-26, 165], [-14, 171], [-22, 178], [-8, 179]]),
    dict(foot=rect(36.38080, 127.36648, 40, 70, 0)),   # 대로 서측 잔디
    dict(foot=[[91.0, -90.5], [127.0, -90.5], [127.0, -18.5], [91.0, -18.5]]),  # 1동 북측 잔디 (정문 진입로 서편, 위성사진)
    dict(foot=[[99.0, 85.0], [188.67, 85.0], [188.67, 165.68], [99.0, 165.68]]),   # 1동~12동 사이 잔디밭 (서쪽 x≈99까지 확장)
    dict(foot=rect(36.38150, 127.36430, 50, 40, 0)),   # 7동 서편
]

# 소규모 숲 (다각형 내부 수목 군락) — 위성사진 기반
groves = [
    # 2동 남측 ~ 동력동 북서측 ㄱ자 숲 (서편 인도 x≈-3 동쪽, 구조물 서편)
    dict(foot=[[1.0, 79.0], [42.0, 79.0], [42.0, 88.0], [12.0, 88.0], [12.0, 104.0], [1.0, 104.0]], n=38),
    # 3동 남측 숲 (3동 남면 ~ 남측 도로 사이, 정문 진입로 서편)
    dict(foot=[[-20.0, -67.0], [11.0, -67.0], [11.0, -42.5], [-20.0, -42.5]], n=30),
    # 3동 남측 숲 동편 구간 (3동 정문 앞 도로 서쪽)
    dict(foot=[[32.0, -67.0], [69.0, -67.0], [69.0, -42.5], [32.0, -42.5]], n=36),
    # 체육동 동측 ~ 동력동 남측 숲 (구조물 동·남편, 캠퍼스 도로 곡선부 서쪽)
    dict(foot=[[36.0, 165.0], [50.0, 165.0], [50.0, 172.0], [58.0, 175.0], [59.0, 185.0], [54.0, 197.0],
               [45.0, 208.0], [33.0, 214.0], [19.0, 214.0], [19.0, 186.0], [36.0, 186.0]], n=48),
    # 운동장(축구장·야구장) 서측 대형 숲 — 서편 도로(x≈-142) 서쪽 ~ x -450, z 172~421 (지형 변경 없음, 수목만)
    dict(foot=[[-450.0, 172.0], [-150.0, 172.0], [-150.0, 421.0], [-450.0, 421.0]], n=1800, safe=True),
    # 정문 → 13동 인도 남측 수목대 — 인도와 정문 동측 주차장 사이 잔디 띠 (인도 선형을 따라 남쪽으로 5~21m)
    dict(foot=[[158.0, -213.5], [180.0, -218.0], [235.0, -223.0], [288.0, -227.0],
               [288.0, -211.0], [235.0, -207.0], [180.0, -202.0], [158.0, -197.5]], n=110, safe=True),
]

# 위성 접시안테나 [x, z, 반지름] — 위성안테나 연구실 동편
dishes = [[-157.0, -25.0, 3.2],
          # 후문 서측 단지 남측 접시안테나 군 (위성사진 기준 동서 배열)
          [-376.0, -184.0, 5.5], [-368.0, -172.0, 4.0], [-358.0, -169.0, 6.0], [-348.0, -165.0, 5.5],
          [-338.0, -163.0, 2.5], [-327.0, -165.0, 6.0], [-314.0, -166.0, 6.0]]

# 단독 소나무 [x, z, scale] — 11동 정문 북측(라운드 인도 안쪽)
pines = [[-262.4, -137.0, 1.6]]

# 잔디정원(산책로·큰나무) + 저수지(잉어) — 위성사진 기반
# 로컬좌표(x=동, z=남) 직접 지정 — 체육관(z≤217)과 주차장(z≥243) 사이 여유 띠 활용
def rect_xz(cx, cz, w, d):
    return [[round(cx - w / 2, 1), round(cz - d / 2, 1)], [round(cx + w / 2, 1), round(cz - d / 2, 1)],
            [round(cx + w / 2, 1), round(cz + d / 2, 1)], [round(cx - w / 2, 1), round(cz + d / 2, 1)]]

garden = dict(                                         # 잔디공원 (체육동 남측 전역)
    # ㄱ자 잔디 일체형: 체육동 남측 띠(z 223~241) + 테니스장 북측 구역(z ~262, 동편 도로 x≈8 서측)
    # 동쪽은 저수지 둔치(x≈50.7)와 맞닿도록 x 51까지 확장
    foot=[[-37, 223], [51, 223], [51, 241], [3.5, 241], [3.5, 262], [-31, 262], [-31, 241], [-37, 241]],
    paths=[
        [[-34, 226], [-10, 229], [15, 229], [38, 229], [50, 229]],   # 북측 가로 오솔길 (서단 → 저수지)
        [[-31, 228], [-22, 240], [-12, 250], [-2, 260]],             # 북서 → 남동 사선 오솔길
    ],
    tree=[-6, 221],                                    # 북쪽 경계 큰 나무
)
pond = dict(                                           # 저수지 (정원 동편, 12동 남서)
    foot=rect_xz(72, 229, 38, 18),
    koi=[[64, 227], [70, 232], [77, 228], [68, 230], [75, 233], [80, 230]],
    fountain=[72, 229],                                # 분수
)

# 정문 → 행정동 중앙 대로 축 (위성사진: 정문에서 곧게 뻗은 직선)
def _axis_lerp(t):
    la0, lo0 = 36.38391, 127.36745
    la1, lo1 = 36.38010, 127.36700
    return (la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t)

AXIS_MAIN = [_axis_lerp(t) for t in (0.0, 0.5, 1.0)]
# 횡단보도 위치 (대로 상, 직선 보간)
CROSSWALKS_LL = [_axis_lerp(t) for t in (0.43, 0.63, 0.95)]   # (0.15: 9동 앞 구 횡단보도 — 삭제)

# ---------------- roads ----------------
rways = [e for e in osm_r['elements'] if e['type'] == 'way' and 'geometry' in e]
KEEP = {'service', 'footway', 'path', 'secondary', 'secondary_link', 'residential', 'unclassified', 'tertiary'}
BB = (36.3785, 36.3856, 127.3615, 127.3706)

roads = []       # for rendering: {pts, kind}
segs = []        # for graph: list of (lat,lon) polylines (campus-internal only)
seg_ways = []    # segs와 병렬: OSM way id
# 보행 경로에서 제외하는 차량 서비스 도로 (렌더링은 유지): 3동·주차빌딩 뒤편 서비스 도로(z≈-112/-124)
NO_PED_WAYS = {1298133949}
# 아예 제외하는 way: 239278709 = 정문 동측 가정로 횡단보도(footway=crossing).
# 실제 가정로가 BB 밖이라 이 횡단보도만 남아 도로처럼 렌더링되는 끊긴 토막이 됨.
DROP_WAYS = {239278709}
for w in rways:
    t = w.get('tags', {})
    hw = t.get('highway')
    if hw not in KEEP or w['id'] in DROP_WAYS:
        continue
    g = w['geometry']
    clat = sum(p['lat'] for p in g) / len(g)
    clon = sum(p['lon'] for p in g) / len(g)
    if not (BB[0] <= clat <= BB[1] and BB[2] <= clon <= BB[3]):
        continue
    kind = 'main' if hw in ('secondary', 'secondary_link', 'tertiary') else 'campus'
    pts = [list(to_xz(p['lat'], p['lon'])) for p in g]
    segs.append([(p['lat'], p['lon']) for p in g])
    seg_ways.append(w['id'])
    roads.append(dict(pts=pts, kind=kind, name=t.get('name', '')))

# ---------------- routing graph ----------------
def snap(lat, lon):
    return (round(lat / 5e-6) * 5e-6, round(lon / 5e-6) * 5e-6)

node_id = {}
nodes = []
def nid(lat, lon):
    k = snap(lat, lon)
    if k not in node_id:
        node_id[k] = len(nodes)
        nodes.append(to_xz(k[0], k[1]))
    return node_id[k]

edges = set()
for seg, wid in zip(segs, seg_ways):
    for a, b in zip(seg, seg[1:]):
        ia, ib = nid(*a), nid(*b)
        if ia != ib and wid not in NO_PED_WAYS:
            edges.add((min(ia, ib), max(ia, ib)))

# ---- 수동 보행로 (위성사진 기반 보정) ----
def nearest_existing(la, lo, rad=6.0):
    x, z = to_xz(la, lo)
    best, bd = None, rad * rad
    for k, idx in node_id.items():
        nx, nz = nodes[idx]
        d = (nx - x) ** 2 + (nz - z) ** 2
        if d < bd:
            bd, best = d, idx
    return best

# 정문 → 13동 보도는 삭제하고 동일 구간을 차도로 대체 (MANUAL_CAMPUS_ROADS 하단 참조)
MANUAL_WALKS = []
def to_ll(x, z):
    return (LAT0 - z / M_LAT, LON0 + x / M_LON)

# 굵은 회색 인도 (로컬 좌표) — 7동 정문·L층 입구, 에뜨리에 입구, 5동/2동/동력동 서편 남북 인도
MANUAL_WALKS_XZ = [
    [(-72.0, 74.0), (-41.0, 74.0), (-3.0, 74.0), (78.6, 74.0)],      # 7동 정문(동측 중앙) → 행정동 서측 도로까지 직선 인도
    [(-41.0, 23.0), (-41.0, -36.0)],                                 # 7동 동편 남북 인도 북측 연장 → 북측 도로
    [(-41.0, 31.0), (-3.0, 31.0), (78.4, 31.0)],                     # 에뜨리에 앞 → 동쪽 직선 → 행정동 서측 도로
    [(-41.0, 23.0), (-41.0, 74.0), (-41.0, 131.6)],                  # 7동 동편 남북 인도
    [(-3.0, -36.0), (-3.0, 131.65)],                                 # 5동·2동·동력동 서편 남북 인도
    [(-82.0, -22.0), (-82.0, -36.0)],                                # 6동 정문(북측) → 북측 메인 도로 직선 인도
    [(-86.0, 112.0), (-86.0, 131.5)],                                # 7동 L층 입구(남측) → 도로
    [(-71.0, 23.0), (-41.0, 31.0)],                                  # 에뜨리에 정문 → 대각선 → 동편 인도 교차점
    [(37.0, 16.5), (37.0, 31.0)],                                    # 5동 정문(분식당·애뜰, 남측) → 에뜨리에 동서 인도
    [(37.0, -23.0), (37.0, -36.0)],                                  # 5동 분식·서편제 출입구(북측, 정문과 동일 x) → 북측 도로
    [(70.5, -4.0), (80.0, -4.0)],                                    # 5동 동·서편제 출입구(동측) → 행정동 서측 도로
    [(70.5, 10.5), (80.0, 10.5)],                                    # 5동 동편제 출입구(동측) → 행정동 서측 도로
    [(5.5, 52.0), (-3.0, 52.0)],                                     # 2동 G층 출입구(서측) → 서편 남북 인도
    [(72.0, 51.0), (80.0, 51.0)],                                    # 2동 정문(동측 돌출부) → 행정동 서측 도로
    [(101.5, 36.5), (79.0, 36.5)],                                   # 1동 서측 출입구(북) → 도로
    [(101.5, 60.6), (79.0, 60.6)],                                   # 1동 서측 출입구(남) → 도로
    [(1.5, -3.0), (-3.0, -3.0)],                                     # 5동 서측 출입구 → 서편 남북 인도
    [(75.5, -83.5), (87.0, -83.5)],                                  # 3동 정문(동측) → 동편 남북 도로
    [(124.5, -120.0), (124.5, -169.0), (124.5, -206.0), (130.4, -212.6)],   # 정문 진입로 서측 인도 (ETRI 정문 노드에 연결)
    [(124.5, -169.0), (98.0, -169.0)],                               # 인도 → 9동(방문동) 정문 앞 (남측 정면)
    [(-165.0, -113.5), (-165.0, -108.7)],                            # 8동 정문(남측 서편) → 남측 도로 (인도)
    [(-194.5, -49.5), (-194.5, -45.0)],                              # 10동 정문 앞 인도 → 진입 도로
    # 11동 정문 앞 라운드형 인도: 서측 사선 도로 → 정문 앞을 지나는 호 → 동측 사선 도로
    [(-296.0, -140.3), (-286.0, -133.5), (-274.0, -129.0), (-262.4, -127.5),
     (-251.0, -129.0), (-240.0, -133.5), (-230.0, -146.8)],
    [(-297.0, -109.6), (-308.0, -109.6)],                            # 11동 서측 출입구 → 서측 도로(주차장 방향)
    [(-67.5, -70.0), (-67.5, -53.4)],                                # 4동 정문(남측) → 주차장 가로질러 남측 도로
]
# 붉은색 진입 인도 (에뜨리에 정문 → 동편 남북 인도, 정면 방향 직선)
MANUAL_WALKS_RED_XZ = []
WALK_SNAP_RAD = [6.0] * len(MANUAL_WALKS) + [3.0] * (len(MANUAL_WALKS_XZ) + len(MANUAL_WALKS_RED_XZ))
WALK_KIND = ['walk'] * (len(MANUAL_WALKS) + len(MANUAL_WALKS_XZ)) + ['walk_red'] * len(MANUAL_WALKS_RED_XZ)
# 렌더링만 끊는 인도 (경로 그래프는 도로까지 연결 유지): 시작점 → 렌더링 종점
WALK_RENDER_END = {
    (-67.5, -70.0): (-67.5, -63.5),    # 4동 정문 인도: 주차장 북측 경계에서 끝냄 (주차장 차로와 겹치지 않게)
}
MANUAL_WALKS += [[to_ll(x, z) for (x, z) in seg] for seg in MANUAL_WALKS_XZ]
MANUAL_WALKS += [[to_ll(x, z) for (x, z) in seg] for seg in MANUAL_WALKS_RED_XZ]

def attach_node(la, lo, edge_rad=8.0, rad=6.0):
    """기존 노드(rad 내) 스냅 → 없으면 가장 가까운 도로 엣지를 분할해 노드 삽입 → 없으면 신규 노드"""
    ni = nearest_existing(la, lo, rad)
    if ni is not None:
        return ni
    x, z = to_xz(la, lo)
    best = (edge_rad * edge_rad, None, None)
    for (a, b) in edges:
        (ax, az), (bx, bz) = nodes[a], nodes[b]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz or 1
        t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / L2))
        qx, qz = ax + t * dx, az + t * dz
        d = (qx - x) ** 2 + (qz - z) ** 2
        if d < best[0] and 0.02 < t < 0.98:
            best = (d, (a, b), (qx, qz))
    if best[1] is None:
        return nid(la, lo)
    (a, b), (qx, qz) = best[1], best[2]
    ni = nid(*to_ll(qx, qz))
    edges.discard((a, b))
    edges.add((min(a, ni), max(a, ni)))
    edges.add((min(ni, b), max(ni, b)))
    return ni

# 새 4동 부지 안의 소형 OSM 구조물 제거 (건물 내부에 묻히는 부속 구조물)
def _inside_b4(st):
    cx = sum(p[0] for p in st['foot']) / len(st['foot']); cz = sum(p[1] for p in st['foot']) / len(st['foot'])
    return -86 <= cx <= -50 and -99 <= cz <= -71
structures = [st for st in structures if not _inside_b4(st)]

# 후문 서측 단지 (11동 주차장 북쪽, 위성사진 기반 근사): 녹화지붕 건물 2동 + 원형 구조물 + ㄴ자 대형 건물 + 접시안테나 군 + 테니스장
NW_COMPLEX = [
    dict(foot=[[-404.0, -248.0], [-381.0, -248.0], [-381.0, -220.0], [-404.0, -220.0]], h=24.0, color=0xb9c7b3),   # 고층 (녹화지붕)
    dict(foot=[[-372.0, -257.0], [-335.0, -257.0], [-335.0, -246.0], [-343.0, -246.0], [-343.0, -230.0],
               [-365.0, -230.0], [-365.0, -241.0], [-372.0, -241.0]], h=16.0, color=0xb9c7b3),                      # 십자형 (녹화지붕)
    dict(foot=[[-367.0, -205.0], [-318.0, -205.0], [-318.0, -178.0], [-367.0, -178.0]], h=10.0, color=0xd8dde3),   # ㄴ자 본동 (남측 날개)
    dict(foot=[[-309.0, -220.0], [-283.0, -220.0], [-283.0, -179.0], [-309.0, -179.0]], h=10.0, color=0xd8dde3),   # ㄴ자 본동 (동측 날개)
    dict(foot=[[-342.0, -197.0], [-309.0, -197.0], [-309.0, -191.0], [-342.0, -191.0]], h=6.0, color=0xcfd5db),    # 연결 통로
    dict(foot=[[-415.0, -157.0], [-404.0, -157.0], [-404.0, -148.0], [-415.0, -148.0]], h=5.0, color=0x9fb3c8),    # 남서측 소형 (청색 지붕)
    dict(foot=[[-318.0, -251.0], [-306.0, -251.0], [-306.0, -238.0], [-318.0, -238.0]], h=5.0, color=0xcfd5db),    # 북동측 소형
]
import math as _m
def _circle(cx, cz, r, n=16):
    return [[round(cx + r * _m.cos(2 * _m.pi * i / n), 2), round(cz + r * _m.sin(2 * _m.pi * i / n), 2)] for i in range(n)]
NW_COMPLEX.append(dict(foot=_circle(-400.0, -256.0, 8.0), h=6.0, color=0xc4c9cf))     # 북서측 원형 구조물
NW_COMPLEX.append(dict(foot=_circle(-304.0, -243.0, 7.0), h=5.0, color=0xc4c9cf))     # 북동측 원형 구조물
structures.extend(NW_COMPLEX)
parking.append(dict(foot=[[-390.0, -228.0], [-358.0, -228.0], [-358.0, -212.0], [-390.0, -212.0]]))   # 단지 내 주차
parking.append(dict(foot=[[-309.0, -237.0], [-283.0, -237.0], [-283.0, -223.0], [-309.0, -223.0]]))   # 동측 주차
pitches.append(dict(foot=[[-417.0, -202.0], [-395.0, -202.0], [-395.0, -166.0], [-417.0, -166.0]], sport='tennis', track=False))

# 위성안테나 연구실 (10동 남측, 접시안테나 서편)
structures.append(dict(foot=[[-189.0, -34.0], [-166.0, -34.0], [-166.0, -19.0], [-189.0, -19.0]],
                       h=7.0, color=0xd6dde6, name='위성안테나 연구실'))

# 정문 경비실 (방문객 주차장 남동 모서리, 진입로 횡단보도 앞)
# 드론시험동 단지 (위성사진 기반): B 사선 아치 창고, C 남북 평지붕 홀(서측 갈색 처마), 자갈 마당
structures.append(dict(foot=rot_rect(274.0, 263.0, 43, 20, 41), h=11.0, color=0xe6e8eb,
                       arch=dict(cx=274.0, cz=263.0, L=43, W=20, yaw=41, wallH=6.0, archH=5.0)))
structures.append(dict(foot=[[232.0, 258.0], [249.0, 258.0], [249.0, 315.0], [232.0, 315.0]], h=9.5, color=0xb4b8bd))
structures.append(dict(foot=[[232.0, 258.0], [235.5, 258.0], [235.5, 315.0], [232.0, 315.0]], h=9.8, color=0xb07a45))
structures.append(dict(foot=[[249.0, 262.0], [264.0, 262.0], [264.0, 318.0], [249.0, 318.0]], h=0.35, color=0xbdb6a6))
structures.append(dict(foot=[[117.5, -160.5], [123.5, -160.5], [123.5, -154.0], [117.5, -154.0]],
                       h=3.6, color=0xdfe3e8, name='정문 경비실'))

for wseg, wrad, wkind in zip(MANUAL_WALKS, WALK_SNAP_RAD, WALK_KIND):
    idxs = []
    for (la, lo) in wseg:
        ni = attach_node(la, lo, edge_rad=3.5 if wrad <= 3.0 else 8.0, rad=wrad)
        idxs.append(ni)
    for a, b in zip(idxs, idxs[1:]):
        if a != b:
            edges.add((min(a, b), max(a, b)))
    wpts = [list(nodes[i]) for i in idxs]
    # 렌더링용 폴리라인: 도로 위에 놓인 양 끝점을 도로 폭만큼 뒤로 물려 인도가 차도와 겹치지 않게 함
    def _road_half_at(x, z):
        best = None
        for r in roads:
            if r['kind'] not in ('campus', 'main', 'boulevard'):
                continue
            half = 6.5 if r['kind'] == 'main' else 5.5 if r['kind'] == 'boulevard' else 3.25
            pl = r['pts']
            for (a, b) in zip(pl, pl[1:]):
                dx, dz = b[0] - a[0], b[1] - a[1]
                L2 = dx * dx + dz * dz or 1
                t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2))
                d = math.hypot(a[0] + t * dx - x, a[1] + t * dz - z)
                if d < half * 0.5 and (best is None or half > best):
                    best = half
        return best
    def _trim(p_end, p_prev):
        half = _road_half_at(*p_end)
        if half is None:
            return p_end
        dx, dz = p_prev[0] - p_end[0], p_prev[1] - p_end[1]
        L = math.hypot(dx, dz)
        back = half + 0.4
        if L <= back + 1.0:
            return p_end
        return [round(p_end[0] + dx / L * back, 2), round(p_end[1] + dz / L * back, 2)]
    if len(wpts) >= 2:
        wpts[0] = _trim(wpts[0], wpts[1])
        wpts[-1] = _trim(wpts[-1], wpts[-2])
        for (sx, sz), (ex, ez) in WALK_RENDER_END.items():
            if abs(wpts[0][0] - sx) < 1.0 and abs(wpts[0][1] - sz) < 1.0:
                wpts = [wpts[0], [ex, ez]]
    roads.append(dict(pts=wpts, kind=wkind, name=''))
    print(f"manual walk added ({wkind}): nodes {idxs}")

# ---- 수동 캠퍼스 도로 (위성사진 기반 보정) — 로컬 좌표(x=동, z=남) ----
MANUAL_CAMPUS_ROADS = [
    # 정문 진입로(대로 남단 x≈131) → 1동(행정동) 북측 정면 입구까지 직진 연장
    [(131.06, -14.06), (133.5, 21.5)],
    # 12동 남측 정면 → 남쪽 주차장 앞 도로(x≈147 남북 도로 북단)까지 연결
    [(147.0, 248.0), (147.0, 225.5)],
    # 10동 정문 앞 → 동쪽 사선 도로까지 직선 진입 도로 (도로색, 본선과 자연스럽게 합류)
    [(-194.5, -46.0), (-149.0, -46.0)],
    # 후문 서측 단지 내부 도로 (렌더링용): 북측 진입 → 남북 축 → 동서 축 → 남서측
    [(-322.0, -266.0), (-322.0, -213.0), (-423.0, -213.0), (-423.0, -160.0)],
    [(-322.0, -213.0), (-277.0, -213.0), (-277.0, -160.0)],
    # 12동 남측 주차장 동편 ↔ 드론시험동 단지 사이 남북 진입로 (위성사진): 주차장 북동 루프 → 남쪽 → 마당 남측으로 동진
    [(205.68, 258.41), (217.0, 266.0), (217.0, 318.0), (238.0, 318.0)],
    # 정문 동측 → 13동(융합동) 진입 차도 — 기존 보도 구간 대체.
    # 정문 동편 남북 도로(x≈148)에서 분기 → 동진 → 13동 서측 도로 북단(294.4,-249.5) 합류
    [(130.4, -212.9), (148.5, -216.3), (179.0, -223.0), (233.0, -228.0), (285.0, -232.0), (291.0, -240.5), (294.38, -249.48)],
    # 13동 정문 진입 도로: 13동 서측 도로(311.6,-214.2 → 320.8,-175.2) 위에서 분기 → 정문 앞까지 (정문 정면으로 진입)
    [(316.9, -191.3), (326.2, -193.7)],
    # 드론시험동 A동 정문(북서향 벽면) → 위 진입로 사선 구간까지 직선 연결 도로
    [(228.9, 240.2), (211.3, 262.1)],
]
# 수동 대로(main) 구간 — OSM 가정로 서단(-212,-278)이 후문 앞에서 끊겨 있어 후문 노드까지 연장
MANUAL_MAIN_ROADS = [
    [(-212.0, -278.0), (-257.2, -272.7)],
]
for rseg, rkind in [(seg, 'campus') for seg in MANUAL_CAMPUS_ROADS] + [(seg, 'main') for seg in MANUAL_MAIN_ROADS]:
    idxs = []
    for (x, z) in rseg:
        la, lo = to_ll(x, z)
        ni = attach_node(la, lo, edge_rad=3.5, rad=3.0)   # 본선 위 끝점은 엣지 분할로 접속
        idxs.append(ni)
    for a, b in zip(idxs, idxs[1:]):
        if a != b:
            edges.add((min(a, b), max(a, b)))
    pts_new = [list(nodes[i]) for i in idxs]
    if rkind == 'main':
        # 대로는 별도 구간을 덧붙이지 않고, 시작점에서 끝나는 기존 대로 폴리라인을 이어 그려 폭·이음새가 연속되게 함
        tgt = next((r for r in roads if r['kind'] == 'main' and r.get('name') == '가정로'
                    and math.hypot(r['pts'][-1][0] - pts_new[0][0], r['pts'][-1][1] - pts_new[0][1]) < 3.0), None)
        if tgt:
            tgt['pts'].extend(pts_new[1:])
            print(f"manual main road: extended '{tgt['name']}' polyline by {len(pts_new) - 1} pt(s), nodes {idxs}")
            continue
    roads.append(dict(pts=pts_new, kind=rkind, name='가정로' if rkind == 'main' else ''))
    print(f"manual {rkind} road added: nodes {idxs}")

# 횡단보도: 실제 캠퍼스 도로 위 최근접 지점으로 스냅
campus_pls = [r['pts'] for r in roads if r['kind'] == 'campus']

def snap_to_road(la, lo):
    x, z = to_xz(la, lo)
    best = (1e18, x, z, 0.0)
    for pl in campus_pls:
        for (a, b) in zip(pl, pl[1:]):
            dx, dz = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dz * dz or 1
            tt = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2))
            qx, qz = a[0] + tt * dx, a[1] + tt * dz
            d = (qx - x) ** 2 + (qz - z) ** 2
            if d < best[0]:
                best = (d, qx, qz, math.atan2(dx, dz))
    return best[1], best[2], best[3]

crosswalks = []
# 체육동 ↔ 잔디공원 사이 캠퍼스 도로(z≈220) 횡단보도 — 큰 나무 동편, 공원 남북 오솔길과 연결
CROSSWALKS_LL.append(to_ll(4.0, 220.3))
# 체육동 북측 잔디 서편 — 서측 캠퍼스 도로(x≈-35) 횡단보도
CROSSWALKS_LL.append(to_ll(-35.4, 152.0))
# 정문 → 행정동 진입로(x≈130) 횡단보도 4개: 9동 출입구 앞 / 서측 도로(z≈-112) 북편 / 3동 방향 지선(z≈-95) 남편 / 지선 위
for (x, z) in ((130.5, -177.0), (130.5, -119.0), (130.5, -88.0), (123.5, -95.4)):
    CROSSWALKS_LL.append(to_ll(x, z))
for (la, lo) in CROSSWALKS_LL:
    qx, qz, yaw = snap_to_road(la, lo)
    crosswalks.append(dict(x=round(qx, 1), z=round(qz, 1), yaw=round(yaw, 3)))
# 도로 스냅 없이 직접 지정하는 횡단보도: 진입로 서측 인도(x≈124.5) 위, 정문 경비실 ↔ 9동 사이 (남북 보행 방향)
crosswalks.append(dict(x=124.5, z=-167.0, yaw=-1.571))

# 입구 수동 지정 (없으면 자동 계산)
ENTRY_DIR = {'7': [1, 0], '5': [0, 1], '2': [1, 0], '3': [1, 0], '9': [0, 1], '8': [0, 1], '11': [0, -1], '4': [0, 1], '10': [0, 1], '902': [-0.656, 0.755], '6': [0, -1], '13': [-0.98, 0.21]}   # 출입구 외측 법선 수동 지정
ENTRY_OVERRIDE = {
    '13': to_ll(328.0, -194.0),    # 13동 정문: 북서측 벽면 중앙 (서향) — 기존 좌표는 벽에서 20m 떨어져 출입구가 공중에 뜸
    '1': to_ll(133.5, 25.87),      # 행정동 북측 정면 (정문 진입로 끝)
    '12': to_ll(147.0, 223.1),     # 12동 남측 1층 정면 (남측 진입로 끝)
    '903': to_ll(-29.0, 201.5),    # 체육동 정문: 서측 벽면 중앙 (서측 캠퍼스 도로 방향)
    '7': to_ll(-73.5, 74.0),       # 7동 정문: 동측 요철부 서벽 중앙 (건물 남북 중심, 동향)
    '5': to_ll(37.0, 15.2),        # 5동 정문(분식당·애뜰): 남측 벽면, 반원 돌출부 동편 (남향)
    '2': to_ll(71.2, 51.0),        # 2동 정문: 동측 돌출부 동벽 중앙 (동향, 도로 횡단보도 앞)
    '3': to_ll(74.5, -83.5),       # 3동 정문: 동측 벽면 (동향)
    '9': to_ll(98.0, -171.6),      # 9동 정문: 남측 벽면 (남향) — 인도 끝 노드(98,-169)에 연결
    '8': to_ll(-165.0, -114.0),    # 8동 정문: 남측 벽면 서편 (남향)
    '11': to_ll(-262.4, -124.0),   # 11동 정문: 북측 벽면 (북향)
    '4': to_ll(-67.5, -71.0),      # 4동 정문: 남측 벽면 중앙 (남향)
    '10': to_ll(-194.5, -50.0),    # 10동 정문: 남측 벽면 (남향)
    '902': to_ll(228.9, 240.2),    # 드론시험동 A동: 남서측 장변 서편 (신설 진입로 방향)
    '6': to_ll(-82.0, -22.0),      # 6동 정문: 북측 벽면 중앙 서편 (북향, 북측 메인 도로 방향)
}

def dist(i, j):
    (x1, z1), (x2, z2) = nodes[i], nodes[j]
    return math.hypot(x1 - x2, z1 - z2)

# connect fragmented components (OSM ways not always share nodes)
import collections
adj = collections.defaultdict(list)
for a, b in edges:
    adj[a].append(b); adj[b].append(a)

def components():
    seen, comps = set(), []
    for s in range(len(nodes)):
        if s in seen: continue
        q, comp = [s], []
        seen.add(s)
        while q:
            u = q.pop()
            comp.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v); q.append(v)
        comps.append(comp)
    return comps

comps = components()
comps.sort(key=len, reverse=True)
print(f"nodes={len(nodes)} edges={len(edges)} components={len(comps)} sizes={[len(c) for c in comps[:8]]}")

# bridge components to the largest one when close enough
main = set(comps[0])
for comp in comps[1:]:
    best = (1e9, None, None)
    for u in comp:
        for v in main:
            d = dist(u, v)
            if d < best[0]:
                best = (d, u, v)
    d, u, v = best
    if d < 90:
        edges.add((min(u, v), max(u, v)))
        adj[u].append(v); adj[v].append(u)
        main |= set(comp)
    else:
        print(f"  dropped component size={len(comp)} (gap {d:.0f}m)")

comps2 = components()
comps2.sort(key=len, reverse=True)
print(f"after bridging: components={len(comps2)} sizes={[len(c) for c in comps2[:5]]}")

# gate detection: nodes where 'main' road kinds meet 'campus' kinds
main_nodes, campus_nodes = set(), set()
for seg, r in zip(segs, roads):
    for p in seg:
        k = node_id[snap(*p)]
        (main_nodes if r['kind'] == 'main' else campus_nodes).add(k)
shared = main_nodes & campus_nodes
print("gate candidates (main∩campus):")
for s in shared:
    print(f"   node {s} at {nodes[s]}")

def nearest_node(lat, lon, pool):
    x, z = to_xz(lat, lon)
    return min(pool, key=lambda i: (nodes[i][0]-x)**2 + (nodes[i][1]-z)**2)

# 정문: near ETRI bus stop (36.38378,127.36693); 후문: near 다름고개삼거리 (36.38446,127.36440)
pool = shared if shared else campus_nodes
gate_main = nearest_node(36.38378, 127.36693, pool)
# 후문: 서측 진입로(way 562459889) 북단이 가정북로와 만나는 지점
gate_back = nearest_node(36.38445, 127.36313, campus_nodes)
print(f"정문 node={gate_main} at {nodes[gate_main]}, 후문 node={gate_back} at {nodes[gate_back]}")

# keep only the gate's connected component (routing safety)
comp_of = {}
for ci, comp in enumerate(comps2):
    for u in comp:
        comp_of[u] = ci
gc = comp_of[gate_main]
print(f"gate in component {gc} (size {len(comps2[gc])}); back gate comp {comp_of[gate_back]}")
keep = set(comps2[gc])
if comp_of[gate_back] != gc:
    # force-bridge back gate's component
    bcomp = comps2[comp_of[gate_back]]
    best = (1e9, None, None)
    for u in bcomp:
        for v in keep:
            d = dist(u, v)
            if d < best[0]:
                best = (d, u, v)
    d, u, v = best
    print(f"  force-bridging back-gate component (gap {d:.0f}m)")
    edges.add((min(u, v), max(u, v)))
    keep |= set(bcomp)

# remap nodes to kept subset
remap = {old: i for i, old in enumerate(sorted(keep))}
nodes_out = [nodes[old] for old in sorted(keep)]
edges_out = sorted([remap[a], remap[b]] for a, b in edges if a in keep and b in keep)
gate_main_o, gate_back_o = remap[gate_main], remap[gate_back]
print(f"exported graph: nodes={len(nodes_out)} edges={len(edges_out)}")

# entrances: closest (road node, footprint edge point) pair per building
def pt_seg(px, pz, ax, az, bx, bz):
    """closest point on segment ab to p; returns (dist, x, z)."""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = 0 if L2 == 0 else max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L2))
    qx, qz = ax + t * dx, az + t * dz
    return math.hypot(px - qx, pz - qz), qx, qz

for b in buildings:
    if b['id'] in ENTRY_OVERRIDE:
        ex, ez = to_xz(*ENTRY_OVERRIDE[b['id']])
        b['entry'] = [round(ex, 1), round(ez, 1)]
        b['entryNode'] = min(range(len(nodes_out)),
                             key=lambda i: (nodes_out[i][0] - ex) ** 2 + (nodes_out[i][1] - ez) ** 2)
        if b['id'] in ENTRY_DIR:
            b['entryDir'] = ENTRY_DIR[b['id']]
        print(f"  {b['name']}: entrance OVERRIDE at {b['entry']} node {b['entryNode']}")
        continue
    best = (1e18, None, None)
    f = b['foot']
    for ni, (nx, nz) in enumerate(nodes_out):
        cx, cz = b['center']
        if (nx - cx) ** 2 + (nz - cz) ** 2 > 200 ** 2:
            continue
        for i in range(len(f)):
            ax, az = f[i]
            bx, bz = f[(i + 1) % len(f)]
            d, qx, qz = pt_seg(nx, nz, ax, az, bx, bz)
            if d < best[0]:
                best = (d, ni, (round(qx, 1), round(qz, 1)))
    d, ni, q = best
    b['entry'] = list(q)
    b['entryNode'] = ni
    flag = ' ⚠' if d > 80 else ''
    print(f"  {b['name']}: entrance {d:.0f}m from road node {ni}{flag}")

# 6동·7동 연결동 (에뜨리에 카페): 6동 남측 돌출부를 6동 본체에서 분리해 2층 높이의 별도 블록으로,
# 7동 북면(z≈36)까지 연장해 두 건물을 잇는다
for b in buildings:
    if b['id'] == '6':
        f = b['foot']
        i0 = next(i for i, pt in enumerate(f) if pt == [-78.03, 5.93])
        i1 = next(i for i, pt in enumerate(f) if pt == [-92.14, 5.84])
        link = [list(pt) for pt in f[i0:i1 + 1]]
        for pt in link:
            if pt[1] in (27.33, 27.07):
                pt[1] = 36.6
        b['foot'] = f[:i0 + 1] + f[i1:]
        structures.append(dict(foot=link, h=6.8, color=0xc9d3df, name='에뜨리에 (카페)'))

# 7동 정문 좌우 화단 (정문에서 동쪽을 바라볼 때 좌=북, 우=남)
flowerbeds = [
    dict(foot=[[-72.5, 67.5], [-48.5, 67.5], [-48.5, 70.5], [-72.5, 70.5]]),
    dict(foot=[[-72.5, 77.5], [-48.5, 77.5], [-48.5, 80.5], [-72.5, 80.5]]),
]

# 보조 출입구 (도어+캐노피만, 경로 안내 대상 아님): [x, z, nx, nz] — 외측 법선 방향
EXTRA_DOORS = {
    '5': [[37.0, -21.7, 0, -1],      # 분식·서편제 출입구 (북측, 정문 x=37과 동일선상)
          [69.6, -4.0, 1, 0],        # 동·서편제 출입구 (동측)
          [69.6, 10.5, 1, 0],        # 동편제 출입구 (동측)
          [1.7, -3.0, -1, 0]],       # 5동 서측 출입구
    '2': [[6.5, 52.0, -1, 0]],       # 2동 G층 출입구 (서측)
    '9': [[115.02, -176.2, 1, 0]],   # 9동 동측 출입구 (진입로 횡단보도 앞)
    '11': [[-295.8, -109.6, -1, 0]], # 11동 서측 출입구 (주차장 방향)
    '1': [[102.54, 36.5, -1, 0],     # 1동 서측 출입구 (북쪽)
          [102.54, 60.6, -1, 0],     # 1동 서측 출입구 (남쪽)
          [164.54, 58.5, 1, 0],      # 1동 동측 출입구 (남쪽 1/4 지점)
          [133.5, 69.87, 0, 1]],     # 1동 남측 출입구
    '7': [[-86.0, 110.6, 0, 1]],     # 7동 L층 입구 (남측)
    '6': [[-73.0, 23.0, 1, 0]],      # 에뜨리에(카페) 입구 — 6동·7동 연결동 동측
}
for b in buildings:
    if b['id'] in EXTRA_DOORS:
        b['doors'] = EXTRA_DOORS[b['id']]

# ---------------- write data.js ----------------
data = dict(
    origin=dict(lat=LAT0, lon=LON0),
    buildings=buildings,
    remote=remote,
    structures=structures,
    parkingTower=parking_tower,
    ust=ust,
    roads=roads,
    pitches=pitches,
    parking=parking,
    lawns=lawns,
    garden=garden,
    groves=groves,
    flowerbeds=flowerbeds,
    pines=pines,
    dishes=dishes,
    pond=pond,
    crosswalks=crosswalks,
    graph=dict(nodes=[list(n) for n in nodes_out], edges=edges_out),
    gates=dict(main=gate_main_o, back=gate_back_o),
    aliases=alias,
    meetmapBase='https://map.etri.re.kr',
)
out = 'const ETRI_DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data.js')
with open(dst, 'w', encoding='utf-8') as f:
    f.write(out)
print(f"data.js written: {len(out)/1024:.0f} KB, buildings={len(buildings)}")
