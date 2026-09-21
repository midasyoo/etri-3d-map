# -*- coding: utf-8 -*-
"""공개(외부 배포)용 빌드 생성기.

내부 전용 시설정보(층·호실·별칭·부서 배치)를 **데이터 단계에서 제거**한 뒤
별도 디렉터리(../etri-3d-map-public)에 공개판을 만든다.
UI에서 숨기는 방식은 파일을 텍스트로 열면 그대로 보이므로 사용하지 않는다.

사용: python tools/build_public.py
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, '..'))
DST = os.path.abspath(os.path.join(SRC, '..', 'etri-3d-map-public'))

# 건물 성격만 남기는 일반 분류 (내부 조직·부서명 제거)
CATEGORY = {
    '1': '행정·지원 시설', '2': '생활편의 시설(우체국·은행 등)', '3': '연구동',
    '4': '실험시설', '5': '식당·복지 시설', '6': '연구동', '7': '연구동 · 도서관',
    '8': '행정·지원 시설', '9': '방문자 안내 시설', '10': '실험시설',
    '11': '연구동', '12': '연구동', '13': '연구·산업화 시설',
    '901': '시설관리동', '902': '시험시설', '903': '체육시설',
    '701': '지역 연구센터', '702': '지역 연구센터', '801': '지역 연구센터',
}
# 방문객 편의를 위해 남기는 별칭 (건물 단위까지만, 호실 번호는 제거)
PUBLIC_ALIAS_OK = re.compile(
    r'행정동|식당동|융합동|방문동|드론|체육|도서관|카페|에뜨리에|에트리에|에뜰|매점|편의점|'
    r'한식당|양식당|분식당|동편제|서편제|방문접수대|본관|중소기업동'
)
# 호실·연구실 단위 정보는 제외
PUBLIC_ALIAS_NG = re.compile(r'실험실|연구실|회의실|홀딩스|건강|세바소|대강당')


def load_data():
    txt = io.open(os.path.join(SRC, 'data.js'), encoding='utf-8').read()
    body = txt.split('=', 1)[1].strip().rstrip(';')
    return json.loads(body)


def sanitize(d):
    removed = {'floors': 0, 'rooms': 0, 'alias': 0}
    for b in d.get('buildings', []):
        removed['floors'] += len(b.get('floors', []))
        removed['rooms'] += sum(len(f.get('rooms', [])) for f in b.get('floors', []))
        b['floors'] = []                       # 층·호실 정보 제거
        b.pop('roomCount', None)
        b['facil'] = CATEGORY.get(b['id'], '연구시설')   # 부서 배치 → 일반 분류
    for r in d.get('remote', []):
        removed['floors'] += len(r.get('floors', []))
        removed['rooms'] += sum(len(f.get('rooms', [])) for f in r.get('floors', []))
        r['floors'] = []
        r.pop('roomCount', None)
    pub_alias = {}
    for name, target in (d.get('aliases') or {}).items():
        if PUBLIC_ALIAS_NG.search(name) or not PUBLIC_ALIAS_OK.search(name):
            removed['alias'] += 1
            continue
        pub_alias[name] = re.split(r'-', target)[0] + '-'   # 건물 번호까지만
    d['aliases'] = pub_alias
    d['publicMode'] = True
    d.pop('meetmapBase', None)                 # 사내 시스템 주소 제거
    return d, removed


def main():
    data, removed = sanitize(load_data())
    # 리포 메타데이터·문서·배포물은 보존 (재빌드로 사라지지 않도록)
    KEEP = {'.git', '.gitignore', '.nojekyll', 'README.md', 'LICENSE',
            'ETRI-3D-map-promo.mp4'}
    if os.path.isdir(DST):                      # 폴더 자체는 유지(잠금 회피), 내용만 정리
        for name in os.listdir(DST):
            if name in KEEP:
                continue
            p = os.path.join(DST, name)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    os.remove(p)
                except OSError:
                    pass
    os.makedirs(os.path.join(DST, 'tools'), exist_ok=True)
    shutil.copytree(os.path.join(SRC, 'lib'), os.path.join(DST, 'lib'), dirs_exist_ok=True)
    for f in ('index.html', 'app.js'):
        txt = io.open(os.path.join(SRC, f), encoding='utf-8').read()
        if f == 'index.html':       # 사내 시스템 주소·링크 제거
            txt = re.sub(r'데이터:\s*<a href="https://map\.etri\.re\.kr/".*?OpenStreetMap<br>',
                         '데이터: OpenStreetMap · ETRI 공개 배치도<br>', txt, flags=re.S)
            txt = txt.replace('https://map.etri.re.kr/api', '#').replace('https://map.etri.re.kr/', '#')
        io.open(os.path.join(DST, f), 'w', encoding='utf-8').write(txt)
    for f in ('build_data.py', 'parse_menu.py', 'build_public.py', 'build_standalone.js'):
        p = os.path.join(SRC, 'tools', f)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(DST, 'tools', f))
    out = 'const ETRI_DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    io.open(os.path.join(DST, 'data.js'), 'w', encoding='utf-8').write(out)

    # 공개판 단일 파일
    r = subprocess.run(['node', os.path.join(DST, 'tools', 'build_standalone.js')],
                       cwd=DST, capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    src_html = os.path.join(DST, 'etri-3d-map-standalone.html')
    dst_html = os.path.join(DST, 'ETRI-3D-map-public.html')
    if os.path.exists(src_html):
        os.replace(src_html, dst_html)

    print(f"공개판 생성: {DST}")
    print(f"  제거: 층 {removed['floors']}개 · 호실 {removed['rooms']}개 · 별칭 {removed['alias']}건")
    print(f"  남김: 건물 {len(data['buildings'])}동 + 원외 {len(data.get('remote', []))}개소, "
          f"공개 별칭 {len(data['aliases'])}건")
    # 검증: 공개 산출물에 내부 정보가 남아 있지 않은지 확인
    bad = []
    for f in ('data.js', 'ETRI-3D-map-public.html'):
        p = os.path.join(DST, f)
        if not os.path.exists(p):
            continue
        t = io.open(p, encoding='utf-8').read()
        for pat in (r'"7-136"', r'광RF실험실', r'실리콘실험실', r'map\.etri\.re\.kr', r'"1-B0'):
            if re.search(pat, t):
                bad.append(f'{f}: {pat}')
    print('  검증:', '잔여 발견: ' + ', '.join(bad) if bad else '내부 정보 잔여 없음 ✅')


if __name__ == '__main__':
    main()
