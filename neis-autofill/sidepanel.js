/* NEIS 자동입력 도우미 - 사이드패널 로직 */

const $ = (id) => document.getElementById(id);
let parsedData = []; // [{number, name, content}]

// ---------- 로그 ----------
function log(msg, cls = "") {
  const el = $("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  line.textContent = `[${hh}:${mm}:${ss}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------- NEIS 바이트 계산 (한글 2, ASCII 1) ----------
function neisBytes(str) {
  let n = 0;
  for (const ch of str) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
}

// ---------- 클립보드 표 파서 (엑셀/시트 TSV, 따옴표·개행 처리) ----------
function parseTable(text) {
  const rows = [];
  let row = [],
    cell = "",
    i = 0,
    inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      inQ = true;
      i++;
      continue;
    }
    if (c === "\t") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------- 형식에 따라 데이터 구조화 ----------
function buildData(text, format) {
  const rows = parseTable(text);
  const out = [];
  for (const r of rows) {
    let number = null,
      name = null,
      content = "",
      content2 = "";
    if (format === "sequence") {
      content = r.join(" ").trim();
    } else if (format === "number") {
      number = parseInt((r[0] || "").trim(), 10);
      content = r.slice(1).join(" ").trim();
    } else if (format === "name") {
      name = (r[0] || "").trim();
      content = r.slice(1).join(" ").trim();
    } else if (format === "both") {
      number = parseInt((r[0] || "").trim(), 10);
      name = (r[1] || "").trim();
      content = r.slice(2).join(" ").trim();
    } else if (format === "both2") {
      // 창의적: 번호 · 이름 · 자율·자치활동 · 진로활동
      number = parseInt((r[0] || "").trim(), 10);
      name = (r[1] || "").trim();
      content = (r[2] || "").trim();
      content2 = (r[3] || "").trim();
    }
    if (content === "" && content2 === "") continue;
    out.push({ number: isNaN(number) ? null : number, name: name || null, content, content2 });
  }
  return out;
}

function matchByOf(format) {
  if (format === "sequence") return "sequence";
  if (format === "number") return "number";
  return "name"; // name, both, both2 → 이름 매칭
}

// ---------- 미리보기 렌더 ----------
function renderPreview(data, limit) {
  const box = $("preview");
  if (!data.length) {
    box.innerHTML = '<p class="empty">데이터 없음</p>';
    return;
  }
  let html =
    "<table><thead><tr><th>#</th><th>번호</th><th>이름</th><th>내용</th><th>byte</th></tr></thead><tbody>";
  data.forEach((d, i) => {
    const b = neisBytes(d.content);
    const over = limit > 0 && b > limit;
    html += `<tr>
      <td>${i + 1}</td>
      <td>${d.number ?? ""}</td>
      <td>${d.name ?? ""}</td>
      <td class="content">${escapeHtml(d.content.slice(0, 50))}${
      d.content.length > 50 ? "…" : ""
    }${
      d.content2
        ? `<br><span class="muted">진로: ${escapeHtml(d.content2.slice(0, 50))}${d.content2.length > 50 ? "…" : ""}</span>`
        : ""
    }</td>
      <td class="${over ? "over" : ""}">${b}${over ? " ⚠" : ""}</td>
    </tr>`;
  });
  html += "</tbody></table>";
  box.innerHTML = html;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---------- 현재 탭에 명령 broadcast + 결과 취합 ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// content.js 를 현재 탭에 강제 주입 (이미 있으면 가드로 중복 초기화 방지)
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    return true;
  } catch (e1) {
    // 일부 프레임 실패 시 메인 프레임만 재시도
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      return true;
    } catch (e2) {
      return e2.message || String(e2);
    }
  }
}

let reqSeq = 0;
function sendCommand(type, extra = {}, waitMs = 1500) {
  return new Promise(async (resolve) => {
    const tab = await getActiveTab();
    if (!tab) {
      log("활성 탭을 찾지 못했습니다.", "err");
      resolve([]);
      return;
    }
    const tabId = tab.id;
    const url = tab.url || "";
    if (/^(chrome|edge|about|chrome-extension):/.test(url)) {
      log("이 페이지에서는 실행할 수 없습니다. 나이스 또는 테스트 페이지 탭을 여세요.", "err");
      resolve([]);
      return;
    }
    // 명령 전 스크립트 주입 보장
    const inj = await ensureInjected(tabId);
    if (inj !== true) {
      log(`스크립트 주입 실패: ${inj}`, "err");
      if (url.startsWith("file://"))
        log("→ chrome://extensions 에서 '파일 URL에 대한 액세스 허용'을 켜고 페이지를 새로고침하세요.", "err");
      resolve([]);
      return;
    }
    const reqId = `r${++reqSeq}`;
    const results = [];
    const listener = (msg) => {
      if (msg && msg.type === "NEIS_RESULT" && msg.reqId === reqId) {
        results.push(msg.payload);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
      await chrome.tabs.sendMessage(tabId, { type, reqId, ...extra });
    } catch (e) {
      // content script 미로딩 등
    }
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(results);
    }, waitMs);
  });
}

// ---------- 버튼 핸들러 ----------
$("btnPreview").addEventListener("click", () => {
  const text = $("paste").value;
  const format = $("format").value;
  const limit = 0; // 바이트 제한 폐지 — 경고 없이 카운터만 표시(정보용)
  if (!text.trim()) {
    log("붙여넣은 내용이 없습니다.", "err");
    return;
  }
  parsedData = buildData(text, format);
  renderPreview(parsedData, limit);
  const overCount = parsedData.filter((d) => limit > 0 && neisBytes(d.content) > limit).length;
  log(`파싱 완료: ${parsedData.length}건${overCount ? `, 제한초과 ${overCount}건 ⚠` : ""}`, "info");
});

$("btnScan").addEventListener("click", async () => {
  log("필드 스캔 중…", "info");
  // 1) 나이스(eXBuilder6) 그리드 우선 시도
  const g = await runGrid("scan");
  if (g && g.ok) {
    const d = g.detected;
    log(`✅ 나이스 그리드 감지: ${d.rowCount}명, 컬럼 ${d.colCount}개`, "info");
    log(
      `   컬럼 → 번호=${d.numberCol} 이름=${d.nameCol} 종합의견=${d.opinionCol}${
        d.opinionLabel ? " (" + d.opinionLabel + ")" : ""
      } · DataSet=${d.hasDataSet ? "O" : "X"}${d.opinionField ? " 필드=" + d.opinionField : ""}`,
      "info"
    );
    (d.preview || []).forEach((row, i) => log(`   행${i}: ${JSON.stringify(row)}`));
    log("종합의견 컬럼이 틀리면 위 인덱스를 보고 '종합의견 컬럼'에 직접 입력하세요.", "info");
    return;
  }
  if (g && g.error && !["no-grid", "not-neis", "no-platform"].includes(g.error)) {
    log(`그리드 스캔 오류: ${g.error}`, "err");
  }
  // 2) 일반 페이지(테스트 등) 범용 스캔
  const results = await sendCommand("NEIS_SCAN");
  if (!results.length) {
    log("응답 없음. 나이스(또는 테스트) 페이지에서 실행 중인지 확인하세요.", "err");
    return;
  }
  let total = 0;
  results.forEach((r) => {
    if (r.error) {
      log(`오류: ${r.error}`, "err");
      return;
    }
    total += r.count || 0;
    if (r.count) {
      log(`프레임 필드 ${r.count}개 발견`, "info");
      (r.sample || []).forEach((s) =>
        log(`  · 번호=${s.number ?? "-"} 이름=${s.name ?? "-"} (${s.raw || ""})`)
      );
    }
    if (r.diag) {
      const d = r.diag;
      log(
        `  [진단${d.isTop ? "·top" : "·frame"}] textarea=${d.textarea} input=${d.input}(text ${d.textInput}) CE=${d.contenteditable} iframe=${d.iframe} canvas=${d.canvas} RealGrid=${d.realgrid} nexacro=${d.nexacro}`
      );
      (d.elements || []).forEach((e, i) => {
        log(
          `   #${i} ${e.tag}${e.type ? "[" + e.type + "]" : ""} ${e.w}x${e.h} ${
            e.ro ? "RO " : ""
          }${e.dis ? "DIS " : ""}id=${e.id || "-"} name=${e.name || "-"} cls=${
            e.cls || "-"
          }${e.ml ? " maxlen=" + e.ml : ""}${e.ph ? " ph=" + e.ph : ""}`
        );
      });
    }
  });
  log(`총 편집가능 필드: ${total}개`, "info");
});

// ---------- 심화진단: 페이지 MAIN world 에서 eXBuilder6(cpr) 구조 탐색 ----------
function deepProbe() {
  const out = { globals: {}, dom: {} };
  const g = (n) => {
    try {
      return typeof window[n] !== "undefined";
    } catch (e) {
      return false;
    }
  };
  out.globals.cpr = g("cpr");
  out.globals.nexacro = g("nexacro");
  out.globals.RealGridJS = g("RealGridJS");
  out.globals.jQuery = g("jQuery") || g("$");

  // DOM: cl-* 클래스 팔레트 수집
  try {
    const set = new Set();
    document.querySelectorAll('[class*="cl-"]').forEach((el) => {
      ("" + (el.className.baseVal !== undefined ? el.className.baseVal : el.className))
        .split(/\s+/)
        .forEach((c) => {
          if (c.indexOf("cl-") === 0) set.add(c);
        });
    });
    out.dom.clClasses = Array.from(set).sort().slice(0, 80);
    out.dom.gridCount = document.querySelectorAll('[class*="cl-grid"]').length;
    out.dom.textareaLike = document.querySelectorAll(
      '[class*="cl-textarea"], [class*="cl-memo"], [class*="cl-text"]'
    ).length;
  } catch (e) {
    out.dom.err = String(e);
  }

  // cpr(eXBuilder6) API 구조 탐색 — 정확한 메서드 이름을 알아내기 위한 덤프
  const methodsOf = (obj) => {
    if (!obj) return null;
    try {
      return Object.getOwnPropertyNames(obj)
        .filter((n) => {
          try {
            return typeof obj[n] === "function";
          } catch (e) {
            return false;
          }
        })
        .slice(0, 70);
    } catch (e) {
      return ["err:" + e.message];
    }
  };
  // 읽을 수 있는(난독화 아닌) 메서드 이름만 추출
  const readable = (obj) => {
    if (!obj) return null;
    try {
      return Object.getOwnPropertyNames(obj)
        .filter((n) => {
          if (!/^[a-zA-Z]/.test(n)) return false; // µ..., _... 제외
          try {
            return typeof obj[n] === "function";
          } catch (e) {
            return false;
          }
        })
        .slice(0, 120);
    } catch (e) {
      return ["err:" + e.message];
    }
  };
  if (out.globals.cpr) {
    try {
      const cpr = window.cpr;
      out.cpr = {};
      const PF = cpr.core && cpr.core.Platform;
      const platform = PF && PF.INSTANCE;
      out.cpr.platformOK = !!platform;
      const GridClass = cpr.controls && cpr.controls.Grid;
      const DataSetClass = cpr.data && cpr.data.DataSet;

      const apps =
        platform && typeof platform.getAllRunningAppInstances === "function"
          ? platform.getAllRunningAppInstances()
          : [];
      out.cpr.appCount = apps.length;

      // DataSet 요약: 컬럼명 + 행수 + 샘플값
      const dsInfo = (ds) => {
        const info = { rc: -1, cols: [], sample: [] };
        try {
          info.cols = ds.getColumnNames ? ds.getColumnNames() : [];
        } catch (e) {}
        try {
          info.rc = ds.getRowCount ? ds.getRowCount() : -1;
        } catch (e) {}
        const n = Math.min(info.rc, 2);
        for (let i = 0; i < n; i++) {
          const row = {};
          info.cols.slice(0, 12).forEach((cn) => {
            try {
              row[cn] = String(ds.getValue(i, cn)).slice(0, 18);
            } catch (e) {}
          });
          info.sample.push(row);
        }
        return info;
      };

      // 화면에 보이는 그리드 DOM → findControlsAt 로 Grid 컨트롤 인스턴스 획득
      const gridSet = new Set();
      const vis = Array.from(document.querySelectorAll(".cl-grid")).filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 120 &&
          r.height > 60 &&
          r.top < innerHeight &&
          r.bottom > 0 &&
          r.left < innerWidth &&
          r.right > 0
        );
      });
      out.cpr.visibleGrids = vis.length;
      vis.slice(0, 15).forEach((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + Math.min(r.height / 2, 70);
        try {
          const found = platform.findControlsAt(x, y);
          const arr = Array.isArray(found) ? found : found ? [found] : [];
          arr.forEach((c) => {
            let cur = c;
            for (let i = 0; i < 15 && cur; i++) {
              if (GridClass && cur instanceof GridClass) {
                gridSet.add(cur);
                break;
              }
              cur = typeof cur.getParent === "function" ? cur.getParent() : null;
            }
          });
        } catch (e) {
          out.cpr.facErr = String(e.message);
        }
      });
      const grids = Array.from(gridSet);
      out.cpr.gridCount = grids.length;
      if (grids[0]) out.cpr.gridMethods = readable(Object.getPrototypeOf(grids[0]));

      // 그리드 셀 데이터 미리보기 → 컬럼(번호/이름/종합의견) 식별용
      if (grids[0]) {
        const grid = grids[0];
        const gd = {};
        const T = (fn) => {
          try {
            return fn();
          } catch (e) {
            return undefined;
          }
        };
        gd.rowCount = T(() => grid.getRowCount());
        gd.dataRowCount = T(() => grid.getDataRowCount());
        gd.contentRowCount = T(() => grid.getContentRowCount());
        const widths = T(() => grid.getColumnWidths()) || [];
        gd.colCount = widths.length;
        // 컬럼 정의(이름/필드/헤더텍스트) 추출 시도
        const cfg = T(() => grid.getInitConfig());
        if (cfg && typeof cfg === "object") {
          gd.cfgKeys = Object.keys(cfg).slice(0, 30);
          const cand = cfg.columns || cfg.columnInfos || cfg.cols || cfg.body || cfg.header;
          if (Array.isArray(cand)) {
            gd.colDefs = cand.slice(0, 40).map((cd) => ({
              name: cd && (cd.name || cd.id),
              col: cd && (cd.column || cd.dataField || cd.bindColumn || cd.value),
              text: cd && (cd.text || cd.title || cd.headerText),
            }));
          }
        }
        // 셀 텍스트 2D 미리보기 (앞 3행 × 전체 컬럼)
        const cols = gd.colCount || 25;
        const rn = Math.min(gd.dataRowCount || gd.rowCount || 0, 3);
        gd.preview = [];
        gd.previewVal = [];
        for (let r = 0; r < rn; r++) {
          const tr = [];
          const vr = [];
          for (let c = 0; c < cols; c++) {
            const t = T(() => grid.getCellText(r, c));
            const v = T(() => grid.getCellValue(r, c));
            tr.push(t == null ? "" : String(t).slice(0, 16));
            vr.push(v == null ? "" : String(v).slice(0, 16));
          }
          gd.preview.push(tr);
          gd.previewVal.push(vr);
        }
        // 셀 텍스트/값을 더 많은 행(7행)까지 + 컬럼 메타(getCellInfo)
        gd.moreRows = [];
        for (let r = 0; r < Math.min(gd.dataRowCount || 0, 7); r++) {
          const tr = [];
          for (let c = 0; c < cols; c++) {
            const t = T(() => grid.getCellText(r, c));
            const v = T(() => grid.getCellValue(r, c));
            tr.push((t == null ? "" : String(t).slice(0, 12)) + "|" + (v == null ? "" : String(v).slice(0, 12)));
          }
          gd.moreRows.push(tr);
        }
        gd.cellInfo = [];
        for (let c = 0; c < cols; c++) {
          const ci = T(() => grid.getCellInfo(0, c));
          if (ci && typeof ci === "object") {
            gd.cellInfo.push({
              c,
              name: ci.columnName,
              type: ci.columnType,
              merged: ci.mergedColumnName,
              ctrl: ci.control && ci.control.constructor ? ci.control.constructor.name : undefined,
            });
          }
        }
        // 디테일 밴드(특기사항) 구조 파악용
        gd.detailCellIndices = T(() => grid.getDetailCellIndices());
        gd.headerCellIndices = T(() => grid.getHeaderCellIndices());
        gd.columnLayout = T(() => JSON.stringify(grid.getColumnLayout()).slice(0, 1000));
        out.cpr.gridData = gd;

        // 창의적체험활동용: 그리드 영역 안의 편집 가능한 입력상자(특기사항) 탐지 + 주변 라벨(영역)
        try {
          const ta = [];
          const inputs = document.querySelectorAll(
            "textarea, input, [contenteditable], .cl-inputbox, [class*='cl-textarea'], [class*='cl-memo'], [class*='cl-input']"
          );
          inputs.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.height < 14 || r.top < 60 || r.top > innerHeight) return;
            const cls = ("" + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "")).slice(0, 30);
            ta.push({
              tag: el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : ""),
              cls,
              x: Math.round(r.left),
              y: Math.round(r.top),
              w: Math.round(r.width),
              val: (el.value || el.textContent || "").slice(0, 12),
            });
          });
          out.cpr.editBoxes = ta.sort((a, b) => a.y - b.y).slice(0, 30);
          // 영역 구분 라벨(자율·자치활동/진로활동 등) 위치 — 상자와 y로 매칭
          const areas = [];
          document.querySelectorAll("div,span,td,th").forEach((el) => {
            if (el.children.length) return;
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t.length > 25 || !/자율.?자치|동아리|진로활동|봉사활동|청소년단체|방과후|스포츠클럽/.test(t)) return;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.top < 60 || r.top > innerHeight) return;
            areas.push({ t: t.slice(0, 20), y: Math.round(r.top) });
          });
          out.cpr.areaLabels = areas.sort((a, b) => a.y - b.y).slice(0, 20);
        } catch (e) {
          out.cpr.editBoxesErr = String(e && e.message);
        }
      }

      // DataSet 덕타이핑
      const isDSLike = (o) =>
        o &&
        typeof o === "object" &&
        typeof o.getValue === "function" &&
        typeof o.setValue === "function" &&
        typeof o.getRowCount === "function" &&
        typeof o.getColumnNames === "function";

      // 각 그리드의 모든 무인자 getter 를 호출해 DataSet 류를 탐색 (1단계 드릴다운 포함)
      const dsSet = new Set();
      const dsVias = [];
      const getterMap = {}; // 진단용: getter → 반환 타입
      const scanGrid = (grid) => {
        const proto = Object.getPrototypeOf(grid);
        const names = Object.getOwnPropertyNames(proto).filter(
          (n) => /^get[A-Z]/.test(n) && typeof grid[n] === "function" && grid[n].length === 0
        );
        for (const n of names) {
          let v;
          try {
            v = grid[n]();
          } catch (e) {
            continue;
          }
          if (v == null) continue;
          if (isDSLike(v)) {
            dsVias.push(n);
            dsSet.add(v);
            continue;
          }
          // 진단: 반환 객체 타입 기록
          const tn = v.constructor ? v.constructor.name : typeof v;
          if (typeof v === "object") getterMap[n] = tn;
          // 1단계 드릴다운: 반환 객체가 getDataSet/getDataObject 등을 가지면 호출
          if (typeof v === "object") {
            for (const m of [
              "getDataSet",
              "getDataObject",
              "getData",
              "getDataProvider",
              "getBindDataSet",
            ]) {
              if (typeof v[m] === "function") {
                try {
                  const d = v[m]();
                  if (isDSLike(d)) {
                    dsVias.push(n + "()." + m);
                    dsSet.add(d);
                  }
                } catch (e) {}
              }
            }
          }
        }
      };
      grids.forEach(scanGrid);
      out.cpr.getterMap = getterMap;

      // 전역 predication 으로도 DataSet 수집 시도 (참고용)
      try {
        const r = platform.lookupByPredication(function (c) {
          return isDSLike(c);
        });
        const arr = Array.isArray(r) ? r : r ? Array.from(r) : [];
        arr.forEach((d) => dsSet.add(d));
        out.cpr.predDsCount = arr.length;
      } catch (e) {
        out.cpr.predErr = String(e.message);
      }

      out.cpr.dsVias = Array.from(new Set(dsVias));
      const datasets = Array.from(dsSet);
      out.cpr.dsTotal = datasets.length;
      // 학생 명단 규모(1~300행)인 것만 요약
      out.cpr.datasets = datasets
        .map(dsInfo)
        .filter((d) => d.rc >= 1 && d.rc <= 300 && d.cols.length)
        .slice(0, 12);

      out.cpr.dataNS = cpr.data ? Object.keys(cpr.data).slice(0, 40) : null;
    } catch (e) {
      out.cpr = { err: String(e && e.message ? e.message : e) };
    }
  }
  return out;
}

// ================= NEIS(eXBuilder6) 그리드 직접 입력 엔진 =================
// MAIN world 에서 실행됨. action: 'scan' | 'fill' | 'undo'
function neisGridAction(action, payload) {
  const cpr = window.cpr;
  if (!cpr || !cpr.core || !cpr.core.Platform) return { error: "not-neis" };
  const PF = cpr.core.Platform.INSTANCE;
  const GridClass = cpr.controls && cpr.controls.Grid;
  if (!PF || !GridClass) return { error: "no-platform" };

  // 화면에 보이는 그리드 컨트롤 인스턴스 찾기
  function findGrid() {
    const vis = Array.prototype.slice
      .call(document.querySelectorAll(".cl-grid"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 120 &&
          r.height > 60 &&
          r.top < innerHeight &&
          r.bottom > 0 &&
          r.left < innerWidth &&
          r.right > 0
        );
      });
    for (const el of vis) {
      const r = el.getBoundingClientRect();
      const pts = [
        [r.left + r.width / 2, r.top + Math.min(r.height / 2, 70)],
        [r.left + 30, r.top + 45],
      ];
      for (const p of pts) {
        let found;
        try {
          found = PF.findControlsAt(p[0], p[1]);
        } catch (e) {
          continue;
        }
        const arr = Array.isArray(found) ? found : found ? [found] : [];
        for (let c of arr) {
          for (let i = 0; i < 15 && c; i++) {
            if (c instanceof GridClass) return c;
            c = typeof c.getParent === "function" ? c.getParent() : null;
          }
        }
      }
    }
    return null;
  }

  const grid = findGrid();
  if (!grid) return { error: "no-grid" };

  const T = (fn, d) => {
    try {
      return fn();
    } catch (e) {
      return d;
    }
  };
  const rowCount = T(() => grid.getDataRowCount(), T(() => grid.getRowCount(), 0));
  // 컬럼 폭: getColumnLayout()이 더 정확(getColumnWidths는 창의적 등에서 부정확) → 우선 사용
  let widths = T(() => {
    const cl = grid.getColumnLayout();
    return cl && Array.isArray(cl.columnLayout) ? cl.columnLayout.map((x) => x.width || 0) : null;
  }, null);
  if (!widths || !widths.length) widths = T(() => grid.getColumnWidths(), []) || [];
  const colCount = widths.length;
  const cellT = (r, c) => {
    const v = T(() => grid.getCellText(r, c));
    return v == null ? "" : String(v);
  };

  // ----- 컬럼 자동 감지 -----
  const sampleN = Math.min(rowCount, 6);
  const colS = [];
  for (let c = 0; c < colCount; c++) {
    const s = [];
    for (let r = 0; r < sampleN; r++) s.push(cellT(r, c));
    colS.push(s);
  }
  const isButtonCol = (s) => {
    const ne = s.filter((x) => x !== "");
    return ne.length >= 2 && ne.every((x) => x === ne[0]);
  };
  // 컬럼 헤더 텍스트 추출 (getInitConfig) — 헤더 '이름표'로 컬럼 식별(내용 추측보다 정확)
  let colHeaders = [];
  try {
    const cfg = grid.getInitConfig && grid.getInitConfig();
    const cand = cfg && (cfg.columns || cfg.columnInfos || cfg.cols || cfg.body || cfg.header);
    if (Array.isArray(cand))
      colHeaders = cand.map((cd) => ({
        text: String((cd && (cd.text || cd.title || cd.headerText)) || "").replace(/\s+/g, " ").trim(),
        field: cd && (cd.column || cd.dataField || cd.bindColumn || cd.value || cd.name),
      }));
  } catch (e) {}
  // colHeaders 인덱스가 cellText 인덱스와 정렬됐다고 볼 수 있을 때만 헤더로 인덱스를 특정
  const headerAligned = colHeaders.length === colCount;
  const findByHeader = (re, avoid) => {
    if (!headerAligned) return -1;
    for (let c = 0; c < colCount; c++) {
      const t = colHeaders[c] && colHeaders[c].text;
      if (t && re.test(t) && !(avoid && avoid.test(t))) return c;
    }
    return -1;
  };

  // 이름 컬럼 먼저: 헤더 '성명/이름' 우선 → 없으면 첫 '비숫자 텍스트' 컬럼(=성명)
  let nameCol = findByHeader(/성명|이름/);
  if (nameCol < 0) {
    for (let c = 0; c < colCount; c++) {
      if (isButtonCol(colS[c])) continue;
      if (colS[c].some((x) => x && !/^\d+$/.test(x))) {
        nameCol = c;
        break;
      }
    }
  }

  // 번호 컬럼: 헤더 '번호/학번'(순번 제외) > 성명 바로 왼쪽의 숫자 컬럼 > 표본 1,2,3,… 컬럼
  const numericCol = (c) => {
    const ne = (colS[c] || []).filter((x) => x !== "");
    return ne.length > 0 && ne.every((x) => /^\d+$/.test(x));
  };
  let numberCol = findByHeader(/번호|학번/, /순번/);
  if (numberCol < 0 && nameCol > 0 && numericCol(nameCol - 1)) {
    // 성명 왼쪽 숫자 컬럼 = 번호 (순번이 그 왼쪽에 따로 있어도 정확)
    numberCol = nameCol - 1;
  }
  if (numberCol < 0) {
    for (let c = 0; c < colCount; c++) {
      const s = colS[c];
      let ok = s.length > 0;
      for (let i = 0; i < s.length; i++) {
        if (String(parseInt(s[i], 10)) !== String(i + 1)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        numberCol = c;
        break;
      }
    }
  }

  // 종합의견/특기사항 라벨 + DataSet 필드명 (헤더 텍스트로 탐색 → 인덱스 무관)
  let opinionLabel = "";
  let opinionField = null;
  for (const h of colHeaders) {
    if (h.text && /종합의견|특기사항/.test(h.text)) {
      opinionLabel = h.text;
      if (typeof h.field === "string") opinionField = h.field;
      break;
    }
  }
  // 실제 나이스 그리드는 getInitConfig 헤더가 비어 있음 → 화면의 '…종합의견/특기사항' 제목 텍스트를 라벨로
  if (!opinionLabel && (action === "roster" || action === "scan")) {
    try {
      let best = "";
      let bestTop = Infinity;
      const els = document.querySelectorAll("span,div,td,th,a,strong,b,label,h1,h2,h3,li");
      for (const el of els) {
        if (el.children.length) continue;
        const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!raw || raw.length > 20) continue;
        // 'A - B' 형태면 앞부분만 (예: '행동특성 및 종합의견 - 학교생활기록부 반영기록')
        const t = raw.replace(/\s*-\s*.*$/, "").trim();
        // 진짜 컬럼 제목은 '…종합의견/특기사항'으로 끝남 → 버튼(…가져오기)·상태(…열림) 배제
        if (!/(종합의견|특기사항)$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.top < bestTop) {
          bestTop = r.top;
          best = t;
        }
      }
      if (best) opinionLabel = best;
    } catch (e) {}
  }

  // 종합의견 컬럼(인덱스): 수동지정 > 헤더 '특기사항/종합의견' > 번호/이름/버튼 제외 최대폭
  let opinionCol = -1;
  if (payload && payload.opinionCol != null && payload.opinionCol !== "") {
    opinionCol = parseInt(payload.opinionCol, 10);
  }
  if (!(opinionCol >= 0 && opinionCol < colCount)) {
    opinionCol = findByHeader(/특기사항|종합의견/);
  }
  if (!(opinionCol >= 0 && opinionCol < colCount)) {
    let best = -1,
      bestW = -1;
    for (let c = 0; c < colCount; c++) {
      if (c === numberCol || c === nameCol) continue;
      if (isButtonCol(colS[c])) continue;
      const w = widths[c] || 0;
      if (w > bestW) {
        bestW = w;
        best = c;
      }
    }
    opinionCol = best >= 0 ? best : colCount - 1;
  }
  if (opinionField == null && colHeaders[opinionCol] && typeof colHeaders[opinionCol].field === "string")
    opinionField = colHeaders[opinionCol].field;
  if (!opinionLabel && colHeaders[opinionCol]) opinionLabel = colHeaders[opinionCol].text || "";

  // 바인딩 DataSet 탐색 — setCellValue가 화면만 바꾸고 DataSet에 반영 안 되는 그리드 대응
  const isDSLike = (o) =>
    o &&
    typeof o === "object" &&
    typeof o.getValue === "function" &&
    typeof o.setValue === "function" &&
    typeof o.getRowCount === "function" &&
    typeof o.getColumnNames === "function";
  let ds = null;
  try {
    const proto = Object.getPrototypeOf(grid);
    const names = Object.getOwnPropertyNames(proto).filter(
      (n) => /^get[A-Z]/.test(n) && typeof grid[n] === "function" && grid[n].length === 0
    );
    const cands = [];
    for (const n of names) {
      let v;
      try {
        v = grid[n]();
      } catch (e) {
        continue;
      }
      if (isDSLike(v)) cands.push(v);
      else if (v && typeof v === "object") {
        for (const m of ["getDataSet", "getDataObject", "getData", "getBindDataSet", "getDataProvider"]) {
          if (typeof v[m] === "function") {
            try {
              const d = v[m]();
              if (isDSLike(d)) cands.push(d);
            } catch (e) {}
          }
        }
      }
    }
    // 그리드와 행 수가 같은 DataSet 우선 (엉뚱한 코드테이블/룩업 회피)
    const rcOf = (d) => {
      try {
        return d.getRowCount();
      } catch (e) {
        return -1;
      }
    };
    ds =
      cands.find((d) => rcOf(d) === rowCount) ||
      cands.find((d) => rcOf(d) >= 1 && rcOf(d) <= 400) ||
      cands[0] ||
      null;
  } catch (e) {}

  const detected = {
    rowCount,
    colCount,
    numberCol,
    nameCol,
    opinionCol,
    opinionLabel,
    opinionField: opinionField || "",
    hasDataSet: !!ds,
  };

  if (action === "scan") {
    const preview = [];
    for (let r = 0; r < Math.min(rowCount, 4); r++) {
      const row = [];
      for (let c = 0; c < colCount; c++) row.push(cellT(r, c).slice(0, 18));
      preview.push(row);
    }
    detected.preview = preview;
    return { ok: true, detected };
  }

  // ----- 명렬표 추출: 현재 그리드의 번호/이름을 전부 읽어 반환 -----
  // 템플릿 다운로드 시 학생 명단을 미리 채워주기 위해 사용한다.
  if (action === "roster") {
    // 이름 정규화: 전입/전출 등 괄호 주석과 공백 제거 → 이름만 남긴다
    const norm = (s) =>
      String(s == null ? "" : s)
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(/\s+/g, "");
    const list = [];
    for (let r = 0; r < rowCount; r++) {
      const name = nameCol >= 0 ? norm(cellT(r, nameCol)) : "";
      // 번호 컬럼이 있으면 화면의 '실제 번호'를 그대로 사용한다.
      //  - 결번(예: 22번 없음)은 그리드에 행 자체가 없으므로 21→23으로 자연히 이어짐.
      //  - 특정 행의 번호 칸이 비어 있으면 순번으로 덮지 않고 그대로 비워 둔다.
      // 번호 컬럼이 아예 없을 때만 순번(r+1)으로 채운다.
      let number = "";
      if (numberCol >= 0) {
        const rawNo = parseInt(cellT(r, numberCol), 10);
        number = isNaN(rawNo) ? "" : rawNo;
      } else {
        number = r + 1;
      }
      // 번호·이름이 모두 비어 있는 잉여(빈) 행은 건너뛴다
      if (name === "" && number === "") continue;
      list.push({ number, name });
    }
    // 학생 중복 제거: 창의적체험활동처럼 한 학생이 여러 영역 행을 가지면 이름이 반복됨 → 1명으로
    const seen = new Set();
    const roster = [];
    for (const it of list) {
      const key = String(it.number) + "|" + String(it.name);
      if (seen.has(key)) continue;
      seen.add(key);
      roster.push(it);
    }
    // 학생당 여러 행이면(창의적체험활동) 2칸 입력 대상
    const multiRow = list.length > roster.length;
    return { ok: true, detected, roster, opinionLabel, multiRow };
  }

  if (action === "fill") {
    const data = (payload && payload.data) || [];
    const matchBy = (payload && payload.matchBy) || "sequence";
    const append = !!(payload && payload.append);
    const sepMap = { space: " ", newline: "\n", none: "" };
    const sep = sepMap[(payload && payload.separator) || "space"];
    const limit = payload && payload.limit ? parseInt(payload.limit, 10) : 0;
    const nbytes = (s) => {
      let n = 0;
      for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x7f ? 2 : 1;
      return n;
    };
    // 이름 정규화: 괄호주석((전입학),（전출） 등)·공백 제거
    const norm = (s) =>
      String(s == null ? "" : s)
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(/\s+/g, "");
    window.__neisAutofillUndo = window.__neisAutofillUndo || [];
    let filled = 0;
    const unmatched = [];
    const notReflected = [];
    const overLimit = [];
    const used = {};
    // 한 셀에 값 기록(이어쓰기·DataSet직접쓰기·표준API·반영확인). 반영됐으면 true.
    const writeCell = (row, content) => {
      const prev = T(() => grid.getCellValue(row, opinionCol), "");
      const prevS = prev == null ? "" : String(prev);
      const newVal = append && prevS.trim() !== "" ? prevS + sep + content : content;
      window.__neisAutofillUndo.push({ row, col: opinionCol, field: opinionField, prev });
      if (ds && opinionField) {
        try {
          ds.setValue(row, opinionField, newVal);
        } catch (e) {}
      }
      try {
        grid.setCellValue(row, opinionCol, newVal);
        try {
          grid.updateRow(row);
        } catch (e) {}
      } catch (e) {}
      let after;
      try {
        after = grid.getCellValue(row, opinionCol);
      } catch (e) {}
      if (after == null && ds && opinionField) {
        try {
          after = ds.getValue(row, opinionField);
        } catch (e) {}
      }
      return { reflected: String(after) === String(newVal), newVal };
    };
    // 학생 블록의 마지막 행 찾기(창의적: 진로활동 = 같은 학생 연속 행의 끝)
    const lastRowOfStudent = (gr) => {
      if (nameCol < 0) return gr;
      const baseName = norm(cellT(gr, nameCol));
      const baseNum = numberCol >= 0 ? String(parseInt(cellT(gr, numberCol), 10)) : "";
      let last = gr;
      for (let r = gr + 1; r < rowCount; r++) {
        const sameName = norm(cellT(r, nameCol)) === baseName;
        const sameNum = numberCol >= 0 ? String(parseInt(cellT(r, numberCol), 10)) === baseNum : true;
        if (sameName && sameNum) last = r;
        else break;
      }
      return last;
    };
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      let gr = -1;
      if (matchBy === "sequence") {
        gr = i;
      } else if (matchBy === "number" && numberCol >= 0) {
        for (let r = 0; r < rowCount; r++) {
          if (!used[r] && String(parseInt(cellT(r, numberCol), 10)) === String(item.number)) {
            gr = r;
            break;
          }
        }
      } else if (matchBy === "name" && nameCol >= 0) {
        const target = norm(item.name);
        for (let r = 0; r < rowCount; r++) {
          if (used[r]) continue;
          const gname = norm(cellT(r, nameCol));
          if (
            target &&
            (gname === target ||
              gname.indexOf(target) === 0 ||
              target.indexOf(gname) === 0)
          ) {
            gr = r;
            break;
          }
        }
      }
      if (gr < 0 || gr >= rowCount) {
        unmatched.push(item.name || item.number || "#" + (i + 1));
        continue;
      }
      used[gr] = true;
      // 1칸(자율·자치활동 = 학생 첫 행)에 content 기록
      const w1 = writeCell(gr, item.content);
      if (w1.reflected) {
        filled++;
        if (limit > 0 && nbytes(w1.newVal) > limit)
          overLimit.push((item.name || item.number || "#" + (i + 1)) + `(${nbytes(w1.newVal)}b)`);
      } else {
        notReflected.push(item.name || item.number || "#" + (i + 1));
      }
      // 창의적 2칸: content2가 있으면 같은 학생의 마지막 행(진로활동)에 기록
      if (item.content2 != null && String(item.content2).trim() !== "" && nameCol >= 0) {
        const last = lastRowOfStudent(gr);
        if (last !== gr) {
          used[last] = true;
          const w2 = writeCell(last, item.content2);
          if (w2.reflected) filled++;
          else notReflected.push((item.name || item.number || "#" + (i + 1)) + ":진로");
        } else {
          notReflected.push((item.name || item.number || "#" + (i + 1)) + ":진로행없음");
        }
      }
    }
    const result = { ok: true, detected, filled, unmatched, notReflected, overLimit, append };
    // 반영이 하나도 안 됐으면 그리드 쓰기 API 진단 정보 첨부(원인 파악용)
    if (notReflected.length && filled === 0) {
      try {
        const proto = Object.getPrototypeOf(grid);
        result.diag = {
          hasDataSet: !!ds,
          opinionField: opinionField || "",
          dsColumns: ds
            ? (function () {
                try {
                  return ds.getColumnNames().slice(0, 30);
                } catch (e) {
                  return [];
                }
              })()
            : [],
          headers: colHeaders.map((h) => h.text).filter(Boolean).slice(0, 20),
          writeMethods: Object.getOwnPropertyNames(proto)
            .filter((n) => /set|commit|update|value|refresh/i.test(n) && typeof grid[n] === "function")
            .slice(0, 40),
        };
      } catch (e) {}
    }
    return result;
  }

  if (action === "undo") {
    const store = window.__neisAutofillUndo || [];
    let n = 0;
    const failed = [];
    for (let i = store.length - 1; i >= 0; i--) {
      const u = store[i];
      try {
        if (ds && u.field) {
          try {
            ds.setValue(u.row, u.field, u.prev);
          } catch (e) {}
        }
        grid.setCellValue(u.row, u.col, u.prev);
        n++;
      } catch (e) {
        // 되돌리기 실패한 셀 위치를 기록해 사용자에게 보고 (조용한 실패 방지)
        failed.push("행" + u.row);
      }
    }
    window.__neisAutofillUndo = [];
    return { ok: true, undone: n, failed };
  }
  return { error: "unknown-action" };
}

async function runGrid(action, payload) {
  const tab = await getActiveTab();
  if (!tab) return { error: "no-tab" };
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || ""))
    return { error: "bad-page" };
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: neisGridAction,
      args: [action, payload || {}],
    });
    return (res && res[0] && res[0].result) || { error: "no-result" };
  } catch (e) {
    return { error: e.message };
  }
}

$("btnDeep").addEventListener("click", async () => {
  log("심화진단(MAIN world) 실행…", "info");
  const tab = await getActiveTab();
  if (!tab) {
    log("활성 탭 없음", "err");
    return;
  }
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: deepProbe,
    });
  } catch (e) {
    log(`심화진단 실패: ${e.message}`, "err");
    return;
  }
  const out = res && res[0] && res[0].result;
  if (!out) {
    log("결과 없음", "err");
    return;
  }
  log(
    `globals: cpr=${out.globals.cpr} nexacro=${out.globals.nexacro} RealGrid=${out.globals.RealGridJS} jQuery=${out.globals.jQuery}`,
    "info"
  );
  if (out.dom) {
    log(`DOM: cl-grid=${out.dom.gridCount} textarea類=${out.dom.textareaLike}`);
    if (out.dom.clClasses) log(`cl-클래스: ${out.dom.clClasses.join(" ")}`);
  }
  if (out.cpr) {
    const c = out.cpr;
    if (c.err) log(`cpr 오류: ${c.err}`, "err");
    log(`platformOK=${c.platformOK} 실행앱=${c.appCount} 보이는그리드=${c.visibleGrids}`, "info");
    if (c.facErr) log(`findControlsAt 오류: ${c.facErr}`, "err");
    log(`Grid 인스턴스 획득=${c.gridCount}개`, c.gridCount ? "info" : "err");
    if (c.gridMethods) log(`Grid 메서드: ${c.gridMethods.join(", ")}`);
    if (c.dsVias && c.dsVias.length) log(`그리드→DataSet 접근자: ${c.dsVias.join(", ")}`, "info");
    if (c.predErr) log(`predication 오류: ${c.predErr}`, "err");
    if (c.gridData) {
      const g = c.gridData;
      log(`그리드: rowCount=${g.rowCount} dataRow=${g.dataRowCount} contentRow=${g.contentRowCount} 컬럼수=${g.colCount}`, "info");
      if (g.colDefs) log(`컬럼정의: ${JSON.stringify(g.colDefs)}`);
      else if (g.cfgKeys) log(`initConfig keys: ${g.cfgKeys.join(", ")}`);
      (g.preview || []).forEach((row, i) => log(`  text행${i}: ${JSON.stringify(row)}`));
      (g.previewVal || []).forEach((row, i) => log(`  val행${i}: ${JSON.stringify(row)}`));
      (g.moreRows || []).forEach((row, i) => log(`  행${i}(text|val): ${JSON.stringify(row)}`));
      if (g.cellInfo && g.cellInfo.length) log(`  cellInfo: ${JSON.stringify(g.cellInfo)}`);
      if (g.detailCellIndices) log(`  detailCellIndices: ${JSON.stringify(g.detailCellIndices)}`);
      if (g.headerCellIndices) log(`  headerCellIndices: ${JSON.stringify(g.headerCellIndices)}`);
      if (g.columnLayout) log(`  columnLayout: ${g.columnLayout}`);
    }
    if (c.editBoxes)
      log(`  편집상자 ${c.editBoxes.length}개: ${JSON.stringify(c.editBoxes)}`, "info");
    if (c.areaLabels)
      log(`  영역라벨 ${c.areaLabels.length}개: ${JSON.stringify(c.areaLabels)}`, "info");
    if (c.editBoxesErr) log(`  편집상자 탐지 오류: ${c.editBoxesErr}`, "err");
    log(`DataSet 총 ${c.dsTotal ?? 0}개 (predication ${c.predDsCount ?? "-"})`, "info");
    (c.datasets || []).forEach((d, i) => {
      log(`  [DS#${i}] rows=${d.rc} cols=[${d.cols.join(", ")}]`, "info");
      d.sample.forEach((row, ri) =>
        log(`     row${ri}: ${JSON.stringify(row)}`)
      );
    });
    if (!c.datasets || !c.datasets.length) log("적합한 DataSet(1~300행)을 못 찾음", "err");
  }
  log("심화진단 완료. 위 로그를 복사해 주세요.", "info");
});

$("btnFill").addEventListener("click", async () => {
  const text = $("paste").value;
  const format = $("format").value;
  const limit = 0; // 바이트 제한 폐지 — 초과 경고/확인창 없음
  const delay = parseInt($("delay").value, 10) || 0;
  if (!text.trim()) {
    log("붙여넣은 내용이 없습니다.", "err");
    return;
  }
  parsedData = buildData(text, format);
  renderPreview(parsedData, limit);
  if (!parsedData.length) {
    log("입력할 데이터가 없습니다.", "err");
    return;
  }
  const matchBy = matchByOf(format);
  log(`자동입력 시작 (${parsedData.length}건, 방식=${matchBy})`, "info");

  // 1) 나이스(eXBuilder6) 그리드 직접 입력 우선
  const opinionColRaw = $("opinionCol").value.trim();
  const append = document.querySelector('input[name="writeMode"]:checked').value === "append";
  const g = await runGrid("fill", {
    data: parsedData,
    matchBy,
    opinionCol: opinionColRaw === "" ? null : opinionColRaw,
    append,
    separator: $("separator").value,
    limit,
  });
  if (g && g.ok) {
    const d = g.detected;
    log(
      `✅ 나이스 그리드 입력: ${g.filled}건${append ? " (이어쓰기)" : ""} (종합의견 컬럼=${d.opinionCol}${
        d.opinionLabel ? " " + d.opinionLabel : ""
      })`,
      "info"
    );
    if (g.unmatched && g.unmatched.length)
      log(`매칭 실패 ${g.unmatched.length}건: ${g.unmatched.join(", ")}`, "err");
    if (g.notReflected && g.notReflected.length)
      log(`⚠ 셀 반영 실패 ${g.notReflected.length}건: ${g.notReflected.join(", ")}`, "err");
    if (g.diag) {
      log(
        `   [진단] DataSet=${g.diag.hasDataSet} 필드=${g.diag.opinionField || "-"} · DS컬럼=[${(g.diag.dsColumns || []).join(", ")}]`,
        "err"
      );
      log(
        `   [진단] 헤더=[${(g.diag.headers || []).join(", ")}] · 쓰기메서드=[${(g.diag.writeMethods || []).join(", ")}]`,
        "err"
      );
    }
    log("값 확인 후 나이스에서 [저장]을 누르세요. 잘못되면 되돌리기.", "info");
    return;
  }
  if (g && g.error && !["no-grid", "not-neis", "no-platform"].includes(g.error)) {
    log(`그리드 입력 오류: ${g.error} → 범용 방식 시도`, "err");
  }

  // 2) 일반 페이지(테스트 등) 범용 입력
  setRunning(true);
  let results = [];
  try {
    results = await sendCommand(
      "NEIS_FILL",
      { data: parsedData, options: { matchBy, delay } },
      Math.max(3000, parsedData.length * (delay + 120) + 2000)
    );
  } finally {
    setRunning(false);
  }
  if (!results.length) {
    log("응답 없음. 페이지에서 실행 중인지, 첫 입력칸을 클릭했는지 확인하세요.", "err");
    return;
  }
  let filled = 0;
  let stopped = false;
  results.forEach((r) => {
    if (r.error) {
      log(`오류: ${r.error}`, "err");
      return;
    }
    filled += r.filled || 0;
    if (r.stopped) stopped = true;
    if (r.filled) log(`입력 완료: ${r.filled}건`, "info");
    if (r.unmatched && r.unmatched.length)
      log(`매칭 실패: ${r.unmatched.join(", ")}`, "err");
  });
  log(
    `${stopped ? "중지됨 · " : ""}총 ${filled}건 입력됨. 값 확인 후 나이스에서 저장하세요.`,
    "info"
  );
});

function setRunning(running) {
  $("btnFill").disabled = running;
  $("btnStop").disabled = !running;
}

$("btnStop").addEventListener("click", async () => {
  log("중지 요청…", "info");
  await sendCommand("NEIS_STOP", {}, 500);
  setRunning(false);
});

$("btnUndo").addEventListener("click", async () => {
  log("되돌리는 중…", "info");
  let n = 0;
  let failed = 0;
  const g = await runGrid("undo");
  if (g && g.ok) {
    n += g.undone || 0;
    failed += (g.failed || []).length;
  }
  const results = await sendCommand("NEIS_UNDO");
  results.forEach((r) => {
    n += r.undone || 0;
    failed += r.failed || 0;
  });
  if (n === 0 && failed === 0) {
    log("되돌릴 내역이 없습니다. (자동입력 후에만 되돌릴 수 있어요)", "info");
    return;
  }
  log(`${n}건 되돌림.`, "info");
  if (failed)
    log(`⚠ ${failed}건은 되돌리지 못했습니다. 해당 값은 화면에서 직접 지워 주세요.`, "err");
});

// ---------- 파일 업로드 (엑셀/CSV) ----------
// 2차원 배열 → 탭 구분 텍스트(특수문자 포함 셀은 따옴표 처리)
function toTSV(rows) {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = c == null ? "" : String(c);
          return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join("\t")
    )
    .join("\n");
}

const HEADER_KEYS = ["번호", "이름", "성명", "의견", "내용", "세특", "특기", "행발", "종합"];

// 헤더 유무와 열 구성으로 입력 방식(format) 자동 판별
function detectFormat(aoa) {
  if (!aoa.length) return { rows: aoa, format: "sequence", hasHeader: false };
  const head = aoa[0].map((c) => String(c || ""));
  const hasHeader = head.some((h) => HEADER_KEYS.some((k) => h.includes(k)));
  const width = Math.max(...aoa.map((r) => r.length));
  let format = "sequence";
  if (hasHeader) {
    const hasNo = head.some((h) => h.includes("번호"));
    const hasName = head.some((h) => h.includes("이름") || h.includes("성명"));
    // 창의적: 번호·이름 + 내용 2열 이상(진로활동/자율·자치활동 등)
    const isChangwi = head.some((h) => h.includes("진로활동") || h.includes("자율")) && width >= 4;
    if (isChangwi && hasNo && hasName) format = "both2";
    else if (hasNo && hasName) format = "both";
    else if (hasNo) format = "number";
    else if (hasName) format = "name";
    else format = "sequence";
  } else {
    // 헤더 없으면 열 개수로 추정
    if (width >= 4) format = "both2";
    else if (width === 3) format = "both";
    else if (width === 2) format = "number";
    else format = "sequence";
  }
  const rows = hasHeader ? aoa.slice(1) : aoa;
  return { rows, format, hasHeader };
}

async function handleFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils
      .sheet_to_json(ws, { header: 1, blankrows: false, defval: "" })
      .filter((r) => r.some((c) => String(c).trim() !== ""));
    if (!aoa.length) {
      log("파일에서 데이터를 찾지 못했습니다.", "err");
      return;
    }
    const { rows, format } = detectFormat(aoa);
    $("format").value = format;
    $("paste").value = toTSV(rows);
    log(`파일 '${file.name}' 읽음: ${rows.length}행, 방식 자동설정=${format}`, "info");
    $("btnPreview").click();
  } catch (e) {
    log(`파일 읽기 오류: ${e.message}`, "err");
  }
}

$("file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) {
    const drop = document.querySelector(".file-drop");
    if (drop) drop.classList.add("has-file");
    const fn = $("fileName");
    if (fn) fn.textContent = "📎 " + f.name;
    handleFile(f);
  }
});

// 기록 방식(덮어쓰기/이어쓰기)에 따라 구분자 활성화
function syncSepState() {
  const append = document.querySelector('input[name="writeMode"]:checked').value === "append";
  $("separator").disabled = !append;
  $("separator").style.opacity = append ? "1" : "0.5";
}
document.querySelectorAll('input[name="writeMode"]').forEach((el) =>
  el.addEventListener("change", syncSepState)
);
syncSepState();

// ---------- 템플릿 다운로드 ----------
const TEMPLATE_HEADER = ["번호", "이름", "학기말 종합의견"];

// 2차원 배열 → .xlsx 워크북 생성 후 파일로 저장
function downloadTemplate(rows, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const ncol = (rows[0] || []).length;
  // 번호·이름 좁게, 내용 열은 넓게 (4열 창의적이면 내용 2열)
  ws["!cols"] = [{ wch: 6 }, { wch: 10 }].concat(
    Array.from({ length: Math.max(1, ncol - 2) }, () => ({ wch: ncol >= 4 ? 55 : 80 }))
  );
  XLSX.utils.book_append_sheet(wb, ws, "입력");
  XLSX.writeFile(wb, filename);
}

$("btnTemplate").addEventListener("click", async () => {
  // 1) 현재 나이스 화면의 명렬표(번호/이름)를 읽어 미리 채우기 시도
  try {
    const g = await runGrid("roster");
    if (g && g.ok && g.roster && g.roster.length) {
      if (g.multiRow) {
        // 창의적체험활동: 학생당 여러 영역 행 → 자율·자치활동 + 진로활동 2칸 템플릿
        const rows = [
          ["번호", "이름", "자율·자치활동 동아리활동", "진로활동"],
          ...g.roster.map((s) => [s.number, s.name, "", ""]),
        ];
        downloadTemplate(rows, "NEIS_창의적체험활동_템플릿(명단채움).xlsx");
        $("format").value = "both2";
        log(
          `✅ 창의적체험활동 명단 ${g.roster.length}명을 채웠습니다. [자율·자치활동 동아리활동]·[진로활동] 두 칸을 입력해 다시 올리면 각 영역에 자동입력됩니다. (입력 방식이 '창의적'으로 설정됨)`,
          "info"
        );
        return;
      }
      // 3번째 열 제목: 현재 화면의 종합의견 컬럼 헤더(예: '행동특성 및 종합의견'). 못 읽으면 기본값.
      const label = (g.opinionLabel || "").trim() || "학기말 종합의견";
      const rows = [["번호", "이름", label], ...g.roster.map((s) => [s.number, s.name, ""])];
      const safe = label.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "");
      downloadTemplate(rows, `NEIS_${safe}_템플릿(명단채움).xlsx`);
      log(
        `✅ [${label}] 화면 명단 ${g.roster.length}명(번호·이름)을 템플릿에 채웠습니다. ${label} 칸만 입력해 다시 올리면 이름으로 매칭됩니다.`,
        "info"
      );
      return;
    }
    if (g && g.error && !["no-grid", "not-neis", "no-platform", "bad-page"].includes(g.error))
      log(`명단 읽기 오류: ${g.error} → 예시 템플릿으로 대체`, "err");
  } catch (e) {
    log(`명단 읽기 실패(${e.message}) → 예시 템플릿으로 대체`, "err");
  }

  // 2) 나이스 명단 화면이 아니면 예시 템플릿 다운로드
  const rows = [
    TEMPLATE_HEADER,
    [1, "김민준", "(예시) 성실하고 책임감이 강하며 학급 활동에 적극적으로 참여함. 교우관계가 원만함."],
    [2, "이서연", "(예시) 창의적 사고력을 지녔으며 모둠 활동에서 협동심을 발휘함."],
    [3, "", "(예시 행은 지우고 실제 내용을 입력하세요)"],
  ];
  try {
    downloadTemplate(rows, "NEIS_종합의견_템플릿.xlsx");
    log(
      "예시 템플릿(.xlsx) 다운로드됨. 나이스에서 [학기말 종합의견] 탭을 열고 [조회] 버튼을 누른 상태로 이 버튼을 누르면 그 화면의 번호·이름이 자동으로 채워집니다.",
      "info"
    );
  } catch (e) {
    log(`템플릿 생성 오류: ${e.message}`, "err");
  }
});

// 붙여넣기 시 자동 미리보기
$("paste").addEventListener("paste", () => {
  setTimeout(() => $("btnPreview").click(), 50);
});

// ---------- 테마 전환 (시스템 / 라이트 / 다크) ----------
(function () {
  const order = ["system", "light", "dark"];
  const ICON = {
    system:
      '<svg class="ic" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    light:
      '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  };
  const meta = {
    system: { label: "시스템" },
    light: { label: "라이트" },
    dark: { label: "다크" },
  };
  const root = document.documentElement;
  function apply(mode) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    const m = meta[mode] || meta.system;
    const ico = $("themeIco");
    const lbl = $("themeLabel");
    if (ico) ico.innerHTML = ICON[mode] || ICON.system;
    if (lbl) lbl.textContent = m.label;
  }
  let cur = "system";
  try {
    const saved = localStorage.getItem("neis-theme");
    if (saved && order.includes(saved)) cur = saved;
  } catch (e) {}
  apply(cur);

  const btn = $("btnTheme");
  const menu = $("themeMenu");
  function markActive() {
    if (!menu) return;
    menu.querySelectorAll(".theme-opt").forEach((o) =>
      o.classList.toggle("active", o.dataset.themeVal === cur)
    );
  }
  function openMenu() {
    if (!menu) return;
    markActive();
    menu.hidden = false;
    if (btn) btn.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  if (btn)
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu && menu.hidden) openMenu();
      else closeMenu();
    });
  if (menu)
    menu.querySelectorAll(".theme-opt").forEach((opt) =>
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        cur = opt.dataset.themeVal;
        apply(cur);
        try {
          localStorage.setItem("neis-theme", cur);
        } catch (e2) {}
        closeMenu();
      })
    );
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
})();

// ---------- 입력 옵션 카드 접기/펼치기 ----------
(function () {
  const card = $("cardOptions");
  const toggle = $("optToggle");
  if (!card || !toggle) return;
  function setCollapsed(c) {
    card.classList.toggle("collapsed", c);
    toggle.setAttribute("aria-expanded", c ? "false" : "true");
  }
  // 항상 접힌 상태로 시작
  setCollapsed(true);
  toggle.addEventListener("click", () =>
    setCollapsed(!card.classList.contains("collapsed"))
  );
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setCollapsed(!card.classList.contains("collapsed"));
    }
  });
})();

log("준비됨. 나이스 종합의견 화면을 열고 시작하세요.", "info");
