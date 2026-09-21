# -*- coding: utf-8 -*-
"""Extract building -> floors -> rooms structure from MeetMap menu page."""
import re, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import os
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'source-data')
with open(os.path.join(BASE, 'etri_map_index.html'), encoding='utf-8') as f:
    html = f.read()

# Split by building blocks
blocks = re.split(r'<div class="building"', html)[1:]
result = []
for b in blocks:
    m = re.search(r'class="building-name">([^<]+)', b)
    if not m:
        continue
    name = m.group(1).strip()
    am = re.search(r'class="building-aliases">([^<]+)', b)
    aliases = am.group(1).strip() if am else ''
    floors = []
    fblocks = re.split(r'<div class="floor-section"', b)[1:]
    for fb in fblocks:
        fm = re.search(r'class="floor-name">([^<]+)', fb)
        fname = fm.group(1).strip() if fm else '?'
        flm = re.search(r'href="(/r/[^"]+)"[^>]*class="floor-link"', fb)
        if not flm:
            flm = re.search(r'class="floor-link"[^>]*href="(/r/[^"]+)"', fb)
        if not flm:
            flm = re.search(r'href="(/r/[^"]+)"', fb)
        flink = flm.group(1) if flm else ''
        rooms = re.findall(r'href="/r/([^"]+)"[^>]*class="room-link"', fb)
        if not rooms:
            # try generic room links inside room list
            rooms = re.findall(r'href="/r/([^"]+)"', fb)
            # first link is the floor link; drop it
            if rooms and flink and rooms[0] == flink.replace('/r/',''):
                rooms = rooms[1:]
        floors.append({'name': fname, 'link': flink, 'rooms': rooms})
    result.append({'name': name, 'aliases': aliases, 'floors': floors})

print(f"buildings: {len(result)}")
for r in result:
    total = sum(len(f['rooms']) for f in r['floors'])
    print(f"  {r['name']} | alias='{r['aliases']}' | floors={[f['name'] for f in r['floors']]} | rooms={total}")

with open(os.path.join(BASE, 'menu_structure.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=1)
print("saved menu_structure.json")
