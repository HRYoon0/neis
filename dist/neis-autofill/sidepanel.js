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
      content = "";
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
    }
    if (content === "") continue;
    out.push({ number: isNaN(number) ? null : number, name: name || null, content });
  }
  return out;
}

function matchByOf(format) {
  if (format === "sequence") return "sequence";
  if (format === "number") return "number";
  return "name"; // name, both → 이름 매칭
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
      <td class="content">${escapeHtml(d.content.slice(0, 60))}${
      d.content.length > 60 ? "…" : ""
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
    log(`   컬럼 위치 → 번호=${d.numberCol} 이름=${d.nameCol} 종합의견=${d.opinionCol}`, "info");
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
  const widths = T(() => grid.getColumnWidths(), []) || [];
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
  // 번호 컬럼: 표본이 1,2,3,... 인 컬럼
  let numberCol = -1;
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
  // 이름 컬럼: 번호 다음의, 버튼 아닌 텍스트 컬럼
  let nameCol = -1;
  for (let c = numberCol >= 0 ? numberCol + 1 : 0; c < colCount; c++) {
    if (isButtonCol(colS[c])) continue;
    if (colS[c].some((x) => x && !/^\d+$/.test(x))) {
      nameCol = c;
      break;
    }
  }
  // 종합의견 컬럼: 수동지정 우선, 없으면 번호/이름/버튼 제외한 가장 넓은 컬럼
  let opinionCol = -1;
  if (payload && payload.opinionCol != null && payload.opinionCol !== "") {
    opinionCol = parseInt(payload.opinionCol, 10);
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
  const detected = { rowCount, colCount, numberCol, nameCol, opinionCol };

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
    return { ok: true, detected, roster: list };
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
    const overLimit = [];
    const used = {};
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
      const prev = T(() => grid.getCellValue(gr, opinionCol), "");
      const prevS = prev == null ? "" : String(prev);
      // 이어쓰기: 기존 내용이 있으면 구분자 넣고 뒤에 추가
      const newVal =
        append && prevS.trim() !== "" ? prevS + sep + item.content : item.content;
      window.__neisAutofillUndo.push({ row: gr, col: opinionCol, prev });
      try {
        grid.setCellValue(gr, opinionCol, newVal);
        filled++;
        if (limit > 0 && nbytes(newVal) > limit)
          overLimit.push((item.name || item.number || "#" + (i + 1)) + `(${nbytes(newVal)}b)`);
      } catch (e) {
        unmatched.push((item.name || item.number) + ":err");
      }
    }
    return { ok: true, detected, filled, unmatched, overLimit, append };
  }

  if (action === "undo") {
    const store = window.__neisAutofillUndo || [];
    let n = 0;
    const failed = [];
    for (let i = store.length - 1; i >= 0; i--) {
      const u = store[i];
      try {
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
      `✅ 나이스 그리드 입력: ${g.filled}건${append ? " (이어쓰기)" : ""} (번호=${d.numberCol} 이름=${d.nameCol} 종합의견=${d.opinionCol})`,
      "info"
    );
    if (g.unmatched && g.unmatched.length)
      log(`매칭 실패 ${g.unmatched.length}건: ${g.unmatched.join(", ")}`, "err");
    if (g.overLimit && g.overLimit.length)
      log(`⚠ 바이트 초과 ${g.overLimit.length}건: ${g.overLimit.join(", ")}`, "err");
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
    if (hasNo && hasName) format = "both";
    else if (hasNo) format = "number";
    else if (hasName) format = "name";
    else format = "sequence";
  } else {
    // 헤더 없으면 열 개수로 추정
    if (width >= 3) format = "both";
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
  ws["!cols"] = [{ wch: 6 }, { wch: 10 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws, "입력");
  XLSX.writeFile(wb, filename);
}

$("btnTemplate").addEventListener("click", async () => {
  // 1) 현재 나이스 화면의 명렬표(번호/이름)를 읽어 미리 채우기 시도
  try {
    const g = await runGrid("roster");
    if (g && g.ok && g.roster && g.roster.length) {
      const rows = [TEMPLATE_HEADER, ...g.roster.map((s) => [s.number, s.name, ""])];
      downloadTemplate(rows, "NEIS_종합의견_템플릿(명단채움).xlsx");
      log(
        `✅ [학기말 종합의견] 화면 명단 ${g.roster.length}명(번호·이름)을 템플릿에 채웠습니다. 종합의견 칸만 입력해 다시 올리면 이름으로 매칭됩니다.`,
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
