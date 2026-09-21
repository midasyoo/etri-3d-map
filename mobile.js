/* ============================================================
 *  모바일 UI 컨트롤러
 *  app.js는 그대로 재사용하고(동일 DOM id), 화면 조작 방식만 모바일에 맞춘다.
 *   - 바텀시트 3단계(접힘/중간/전체) + 드래그
 *   - 탭 전환(건물 / 길찾기 / 상세)
 *   - 설정 시트(화면·방문일시·날씨·경기)
 * ============================================================ */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const sheet = $('m-sheet');
  const backdrop = $('m-backdrop');
  const settings = $('m-settings');
  const detail = $('detail');
  const detailEmpty = $('m-detail-empty');

  /* ---------- 바텀시트 ---------- */
  const STATES = ['peek', 'half', 'full'];
  let state = 'peek';
  function setSheet(s) {
    state = s;
    sheet.classList.remove('half', 'full');
    if (s !== 'peek') sheet.classList.add(s);
  }
  function openSheet() { if (state === 'peek') setSheet('half'); }

  // 손잡이 드래그
  let dragY = null, dragStart = null;
  const handle = $('m-handle');
  handle.addEventListener('touchstart', e => {
    dragY = e.touches[0].clientY; dragStart = state;
    sheet.style.transition = 'none';
  }, { passive: true });
  handle.addEventListener('touchmove', e => {
    if (dragY === null) return;
    const base = { peek: window.innerHeight * 0.88 - 84, half: window.innerHeight * 0.45, full: 0 }[dragStart];
    const dy = Math.max(0, base + (e.touches[0].clientY - dragY));
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  handle.addEventListener('touchend', e => {
    if (dragY === null) return;
    const dy = e.changedTouches[0].clientY - dragY;
    dragY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    const order = STATES.indexOf(dragStart);
    if (dy < -40) setSheet(STATES[Math.min(2, order + 1)]);
    else if (dy > 40) setSheet(STATES[Math.max(0, order - 1)]);
    else setSheet(dragStart);
  });
  handle.addEventListener('click', () => setSheet(state === 'peek' ? 'half' : 'peek'));

  /* ---------- 탭 ---------- */
  function showPane(name) {
    document.querySelectorAll('.m-tab').forEach(t =>
      t.classList.toggle('on', t.dataset.pane === name));
    document.querySelectorAll('.m-pane').forEach(p =>
      p.classList.toggle('on', p.id === 'm-pane-' + name));
    openSheet();
  }
  document.querySelectorAll('.m-tab').forEach(t =>
    t.addEventListener('click', () => showPane(t.dataset.pane)));

  /* ---------- 검색 ---------- */
  const search = $('search');
  const clearBtn = $('m-clear');
  search.addEventListener('input', () => {
    clearBtn.style.display = search.value ? 'block' : 'none';
  });
  clearBtn.addEventListener('click', () => {
    search.value = '';
    clearBtn.style.display = 'none';
    search.dispatchEvent(new Event('input'));
    search.focus();
  });
  search.addEventListener('focus', () => setSheet('peek'));      // 검색 중엔 지도 넓게
  search.addEventListener('keydown', e => { if (e.key === 'Enter') search.blur(); });
  // 검색 결과를 고르면 시트를 내려 지도를 보여준다
  $('search-results').addEventListener('click', () => {
    setTimeout(() => { search.blur(); setSheet('peek'); }, 30);
  });

  /* ---------- 플로팅 버튼 ---------- */
  $('m-btn-go').addEventListener('click', () => showPane('go'));
  $('m-btn-home').addEventListener('click', () => $('btn-reset').click());
  $('m-btn-settings').addEventListener('click', () => {
    settings.classList.add('open');
    backdrop.classList.add('on');
  });
  const closeSettings = () => {
    settings.classList.remove('open');
    backdrop.classList.remove('on');
  };
  $('m-settings-close').addEventListener('click', closeSettings);
  backdrop.addEventListener('click', closeSettings);

  /* ---------- 상세 패널 연동 ----------
   * app.js가 #detail에 open 클래스를 붙이면 상세 탭으로 전환한다. */
  const obs = new MutationObserver(() => {
    const open = detail.classList.contains('open');
    detailEmpty.style.display = open ? 'none' : 'block';
    if (open) { showPane('detail'); setSheet('half'); }
  });
  obs.observe(detail, { attributes: true, attributeFilter: ['class'] });

  // 건물 카드를 누르면 지도를 보여주기 위해 시트를 살짝 내린다
  $('blist').addEventListener('click', () => setSheet('half'));

  /* ---------- 길 안내 시작 시 지도 노출 ---------- */
  $('rb-go').addEventListener('click', () => setTimeout(() => setSheet('peek'), 120));

  /* ---------- 화면 회전·크기 변경 대응 ---------- */
  let resizeTimer = null;
  window.addEventListener('orientationchange', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
  });

  /* ---------- PWA 서비스워커 (있을 때만) ---------- */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 캐시는 선택 기능 */ });
    });
  }

  /* ---------- 초기 상태 ---------- */
  // 딥링크로 경로가 지정된 경우 지도를 먼저 보여준다
  const p = new URLSearchParams(location.search);
  if (p.get('route') || p.get('b') || p.get('demo')) setSheet('peek');
  else setSheet('peek');
})();
