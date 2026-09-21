// 단일 HTML 파일 빌드: <script src=...>를 인라인으로 병합
//   node tools/build_standalone.js          → PC판 + 모바일판 생성
//   node tools/build_standalone.js mobile   → 모바일판만
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const only = process.argv[2];

const TARGETS = [
  { src: 'index.html', out: 'etri-3d-map-standalone.html', key: 'desktop' },
  { src: 'mobile.html', out: 'etri-3d-map-mobile.html', key: 'mobile' },
];

TARGETS.forEach(t => {
  if (only && only !== t.key) return;
  const srcPath = path.join(root, t.src);
  if (!fs.existsSync(srcPath)) return;
  let html = fs.readFileSync(srcPath, 'utf8');

  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
    const p = path.join(root, src);
    if (!fs.existsSync(p)) return m;
    const js = fs.readFileSync(p, 'utf8');
    // </script>가 JS 문자열 안에 있으면 파서가 깨지므로 이스케이프
    const safe = js.replace(/<\/script>/gi, '<\\/script>');
    return `<script>\n/* === inlined: ${src} === */\n${safe}\n</script>`;
  });
  // 단일 파일에는 외부 매니페스트·서비스워커가 없으므로 참조 제거
  html = html.replace(/\s*<link rel="manifest"[^>]*>/g, '');

  const out = path.join(root, t.out);
  fs.writeFileSync(out, html);
  console.log(`written: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
});
