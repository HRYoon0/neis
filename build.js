/* 크롬 웹스토어 배포용 클린 빌드 생성 스크립트
 * - 원본(neis-autofill)은 그대로 두고, dist/neis-autofill 에 배포본을 만든다.
 * - 개발용 요소 제거: 연습 페이지(test/), 심화진단(deepProbe + 버튼 + 핸들러)
 * - 심사 민감 요소 제거: content_scripts 의 file:// 매칭
 * 실행:  node build.js
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "neis-autofill");
const DIST_ROOT = path.join(__dirname, "dist");
const OUT = path.join(DIST_ROOT, "neis-autofill");

// 0) 이전 산출물 정리 (dist 는 이 스크립트가 만드는 폴더라 삭제 안전)
fs.rmSync(DIST_ROOT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1) 그대로 복사할 파일
for (const f of ["background.js", "content.js", "content.css", "sidepanel.css", "privacy.html"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
// 2) 그대로 복사할 폴더 (연습 페이지 test/ 는 제외)
for (const d of ["lib", "icons", "template"]) {
  fs.cpSync(path.join(SRC, d), path.join(OUT, d), { recursive: true });
}

// 3) manifest: file:// 매칭 제거 (storage 권한은 원본에서 이미 제거됨)
const m = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
m.content_scripts[0].matches = m.content_scripts[0].matches.filter(
  (x) => !x.startsWith("file://")
);
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

// 4) sidepanel.html: 심화진단 버튼 제거 + 남는 '필드 스캔' 버튼을 가로 전체로
let html = fs.readFileSync(path.join(SRC, "sidepanel.html"), "utf8");
html = html.replace(/\s*<button id="btnDeep"[\s\S]*?<\/button>/, "");
html = html.replace(
  '<button id="btnScan" class="btn btn-ghost">',
  '<button id="btnScan" class="btn btn-ghost" style="grid-column:1/-1">'
);
fs.writeFileSync(path.join(OUT, "sidepanel.html"), html);

// 5) sidepanel.js: deepProbe 함수 블록 + btnDeep 핸들러 제거
let js = fs.readFileSync(path.join(SRC, "sidepanel.js"), "utf8");
const dpStart = js.indexOf("// ---------- 심화진단");
const dpEnd = js.indexOf("// ================= NEIS(eXBuilder6)");
if (dpStart >= 0 && dpEnd > dpStart) js = js.slice(0, dpStart) + js.slice(dpEnd);
const hStart = js.indexOf('$("btnDeep").addEventListener');
const hEnd = js.indexOf('$("btnFill").addEventListener');
if (hStart >= 0 && hEnd > hStart) js = js.slice(0, hStart) + js.slice(hEnd);
fs.writeFileSync(path.join(OUT, "sidepanel.js"), js);

// 6) 결과 요약
const list = [];
(function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.join(base, e.name);
    if (e.isDirectory()) walk(p, rel);
    else list.push(rel);
  }
})(OUT, "");
console.log("배포본 생성됨:", path.relative(__dirname, OUT));
console.log("포함 파일:\n  " + list.sort().join("\n  "));
if (js.includes("deepProbe") || html.includes("btnDeep"))
  console.warn("⚠ 심화진단 잔여물이 감지됨 — 앵커 문자열 확인 필요");
