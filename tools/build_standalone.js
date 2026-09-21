// 단일 HTML 파일 빌드: index.html의 <script src=...>를 인라인으로 병합
// 사용법: node tools/build_standalone.js  → etri-3d-map-standalone.html 생성
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const js = fs.readFileSync(path.join(root, src), 'utf8');
  // </script>가 JS 문자열 안에 있으면 파서가 깨지므로 이스케이프
  const safe = js.replace(/<\/script>/gi, '<\\/script>');
  return `<script>\n/* === inlined: ${src} === */\n${safe}\n</script>`;
});

const out = path.join(root, 'etri-3d-map-standalone.html');
fs.writeFileSync(out, html);
console.log(`written: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
