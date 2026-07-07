/* NEIS 종합의견 자동입력 도우미 - content script
 * 각 프레임에서 독립 실행된다. 사이드패널이 broadcast 한 명령을 받아
 * "자기 프레임 안에서 처리 가능한 부분만" 수행하고 결과를 runtime 메시지로 되돌린다.
 */
(() => {
  if (window.__neisAutofillLoaded) return;
  window.__neisAutofillLoaded = true;

  const undoStack = []; // [{el, prev, isCE}]
  let lastFields = []; // 최근 스캔된 필드 캐시
  let cancelFill = false; // 자동입력 중지 플래그

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 유틸: 편집 가능한 필드 탐지 ----------
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return ["text", "search", ""].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")
      return false;
    return true;
  }

  function collectFields() {
    const nodes = document.querySelectorAll(
      'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"], [contenteditable=""]'
    );
    const out = [];
    nodes.forEach((el) => {
      if (isEditable(el) && isVisible(el)) out.push(el);
    });
    // 화면상의 위치(위→아래, 좌→우) 순으로 정렬
    out.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const dy = ra.top - rb.top;
      if (Math.abs(dy) > 8) return dy;
      return ra.left - rb.left;
    });
    return out;
  }

  // ---------- 유틸: 필드 주변에서 번호/이름 추출 ----------
  function nearbyText(field) {
    // field 를 감싸는 조상들을 올라가며, field 자신의 값은 제외한 짧은 텍스트를 수집
    let el = field;
    for (let depth = 0; depth < 6 && el; depth++, el = el.parentElement) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          // 입력필드 내부 텍스트는 제외
          let p = node.parentElement;
          while (p) {
            if (isEditable(p)) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          const t = node.nodeValue.trim();
          return t ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const texts = [];
      let n;
      while ((n = walker.nextNode())) texts.push(n.nodeValue.trim());
      const joined = texts.join(" ");
      const info = parseIdentifier(joined);
      if (info.name || info.number != null) {
        info.raw = joined.slice(0, 40);
        return info;
      }
    }
    return { name: null, number: null, raw: "" };
  }

  function parseIdentifier(text) {
    if (!text) return { name: null, number: null };
    // 번호: 1~60 사이의 독립된 숫자 우선
    let number = null;
    const numMatch = text.match(/\b([1-9]\d?)\b/);
    if (numMatch) {
      const v = parseInt(numMatch[1], 10);
      if (v >= 1 && v <= 60) number = v;
    }
    // 이름: 2~4자 한글 (흔한 성씨/이름 토큰). 너무 긴 문장에서는 첫 토큰만.
    let name = null;
    const nameMatch = text.match(/[가-힣]{2,4}/);
    if (nameMatch && text.length <= 20) name = nameMatch[0];
    return { name, number };
  }

  // ---------- 유틸: 프레임워크 안전한 값 주입 ----------
  function setNativeValue(el, value) {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    // 여러 프레임워크(React/Vue/nexacro 등) 반영을 위해 폭넓게 이벤트 발생
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function recordUndo(el) {
    undoStack.push({
      el,
      prev: el.isContentEditable ? el.textContent : el.value,
      isCE: el.isContentEditable,
    });
  }

  function readValue(el) {
    return el.isContentEditable ? el.textContent : el.value;
  }

  // ---------- 하이라이트 ----------
  function flash(el, color) {
    const prev = el.style.outline;
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = "1px";
    setTimeout(() => {
      el.style.outline = prev;
    }, 900);
  }

  // ---------- 다음 편집 필드 찾기 (가상스크롤 대응) ----------
  function findNextEditable(current) {
    const fields = collectFields();
    const idx = fields.indexOf(current);
    if (idx === -1) return fields[0] || null;
    return fields[idx + 1] || null;
  }

  // ---------- 실행: 순서대로 (포커스/첫칸 기준) ----------
  async function fillSequential(dataList, opts) {
    const delay = opts.delay ?? 120;
    const ae = document.activeElement;
    let field = null;
    if (isEditable(ae)) {
      // 사용자가 클릭한 바로 그 입력칸에서 시작
      field = ae;
    } else if (ae && ae.tagName === "IFRAME") {
      // 포커스가 하위 프레임에 있음 → 이 프레임은 담당 아님
      return { frame: location.href, filled: 0, note: "하위 프레임이 담당" };
    } else if (document.hasFocus()) {
      // 이 프레임에 포커스가 있고 활성 입력칸이 없으면 첫 칸부터
      const fields = collectFields();
      field = fields[opts.startIndex || 0] || null;
    } else {
      return { frame: location.href, filled: 0, note: "포커스 없음" };
    }
    if (!field) return { frame: location.href, filled: 0, note: "편집 가능한 필드 없음" };

    cancelFill = false;
    let filled = 0;
    for (const item of dataList) {
      if (cancelFill) return { frame: location.href, filled, stopped: true };
      if (!isEditable(field)) break;
      field.scrollIntoView({ block: "center", behavior: "instant" });
      await sleep(20);
      recordUndo(field);
      setNativeValue(field, item.content);
      flash(field, "#2e7d32");
      filled++;
      await sleep(delay);
      const next = findNextEditable(field);
      if (!next) break;
      next.focus();
      field = next;
      await sleep(30);
    }
    return { frame: location.href, filled };
  }

  // ---------- 실행: 번호/이름 매칭 ----------
  async function fillByMatch(dataList, opts) {
    const delay = opts.delay ?? 60;
    const key = opts.matchBy; // 'number' | 'name'
    const fields = collectFields();
    const rows = fields.map((f) => ({ el: f, info: nearbyText(f) }));

    cancelFill = false;
    let filled = 0;
    const unmatched = [];
    for (const item of dataList) {
      if (cancelFill) return { frame: location.href, filled, unmatched, stopped: true };
      const target = rows.find((r) => {
        if (r.__used) return false;
        if (key === "number") return r.info.number != null && r.info.number === item.number;
        if (key === "name") return r.info.name && item.name && r.info.name === item.name;
        return false;
      });
      if (!target) {
        unmatched.push(item.name || item.number);
        continue;
      }
      target.__used = true;
      target.el.scrollIntoView({ block: "center", behavior: "instant" });
      await sleep(20);
      recordUndo(target.el);
      setNativeValue(target.el, item.content);
      flash(target.el, "#2e7d32");
      filled++;
      await sleep(delay);
    }
    return { frame: location.href, filled, unmatched };
  }

  // ---------- 되돌리기 ----------
  function undoAll() {
    let n = 0;
    let failed = 0;
    while (undoStack.length) {
      const { el, prev, isCE } = undoStack.pop();
      try {
        setNativeValue(el, prev);
        if (isCE) el.textContent = prev;
        n++;
      } catch (e) {
        // 필드가 화면에서 사라졌거나(가상스크롤) DOM이 바뀌어 되돌리기 실패.
        // 조용히 삼키지 않고 카운트해서 사이드패널이 사용자에게 알리도록 한다.
        failed++;
      }
    }
    return { frame: location.href, undone: n, failed };
  }

  // ---------- 스캔(미리보기) ----------
  function scan() {
    const fields = collectFields();
    lastFields = fields;
    const sample = fields.slice(0, 8).map((f) => {
      const info = nearbyText(f);
      return { number: info.number, name: info.name, raw: info.raw };
    });
    // 스캔 결과 강조
    fields.forEach((f) => flash(f, "#1565c0"));
    // 진단: 화면 구조 파악용 (필드 0개일 때 원인 추적)
    const q = (sel) => {
      try {
        return document.querySelectorAll(sel).length;
      } catch (e) {
        return 0;
      }
    };
    const diag = {
      textarea: q("textarea"),
      input: q("input"),
      textInput: q('input[type="text"], input[type="search"], input:not([type])'),
      contenteditable: q("[contenteditable]"),
      iframe: q("iframe"),
      canvas: q("canvas"),
      realgrid:
        !!(window.RealGridJS || window.realgrid) ||
        q('[class*="realgrid"], [id*="realgrid"], [class*="rg-"], canvas.rg-') > 0,
      nexacro: !!window.nexacro,
      isTop: window.top === window.self,
    };
    // 모든 입력 후보 요소의 속성 덤프 (무엇이 걸러졌는지 파악용)
    const cls = (el) => {
      const c = el.className;
      return (c && c.baseVal !== undefined ? c.baseVal : c || "").toString();
    };
    diag.elements = Array.from(
      document.querySelectorAll("textarea, input, [contenteditable]")
    )
      .slice(0, 25)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") || "").toLowerCase(),
          ro: el.readOnly || el.hasAttribute("readonly"),
          dis: !!el.disabled,
          w: Math.round(r.width),
          h: Math.round(r.height),
          id: (el.id || "").slice(0, 30),
          name: (el.getAttribute("name") || "").slice(0, 30),
          cls: cls(el).slice(0, 40),
          ph: (el.getAttribute("placeholder") || "").slice(0, 20),
          ml: el.getAttribute("maxlength") || "",
        };
      });
    return { frame: location.href, count: fields.length, sample, diag };
  }

  // ---------- 메시지 처리 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type || !msg.type.startsWith("NEIS_")) return;

    const reply = (payload) => {
      chrome.runtime.sendMessage({
        type: "NEIS_RESULT",
        reqId: msg.reqId,
        payload,
      });
    };

    (async () => {
      try {
        if (msg.type === "NEIS_PING") {
          reply({ frame: location.href, alive: true });
        } else if (msg.type === "NEIS_STOP") {
          cancelFill = true;
          reply({ frame: location.href, stopping: true });
        } else if (msg.type === "NEIS_SCAN") {
          reply(scan());
        } else if (msg.type === "NEIS_FILL") {
          const result =
            msg.options.matchBy === "sequence"
              ? await fillSequential(msg.data, msg.options)
              : await fillByMatch(msg.data, msg.options);
          reply(result);
        } else if (msg.type === "NEIS_UNDO") {
          reply(undoAll());
        }
      } catch (e) {
        reply({ frame: location.href, error: String(e && e.message ? e.message : e) });
      }
    })();

    // 응답은 runtime.sendMessage 로 별도 전송하므로 sendResponse 미사용
    return false;
  });
})();
