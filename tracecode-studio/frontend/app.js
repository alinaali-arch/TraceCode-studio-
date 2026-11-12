(() => {
  "use strict";

  /* =====================================================================
     Helpers and state. Every number shown in the UI comes from the
     compiler's own output (/api/analyze, /api/run) or from the browser
     clock. Nothing is estimated or invented.
     ===================================================================== */

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const src = $("src");
  const gutter = $("gutter");
  const LINE_PX = 22;                                   /* must match --code-lh in style.css */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

  const KEYWORDS = new Set(["start", "end", "show", "write", "if", "elif", "else", "while", "for", "in", "to",
    "function", "return", "and", "or", "not", "true", "false", "int", "float", "string", "bool"]);
  const TYPES = new Set(["int", "float", "string", "bool"]);

  const DEFAULT_SOURCE = `start

age: int = 20
name: string = "Alina"
marks: float = 85.5
passed: bool = true

show name
show age
show age + 10

end
`;

  const SAMPLES = {
    "hello.tl": ["Hello world", "Variables, strings and show"],
    "control.tl": ["Control flow", "if, nested if, while and for loops"],
    "functions.tl": ["Functions", "A function with parameters and a return value"],
    "fibonacci.tl": ["Recursion", "Recursive Fibonacci inside a while loop"],
    "primes.tl": ["Primes up to 30", "Nested loops, modulo and a bool flag"],
    "float_math.tl": ["Float math", "Float arithmetic, comparison and negation"],
  };

  const S = {
    last: null,            /* last /api/analyze result */
    facts: null,           /* numbers derived from that result */
    errors: [],            /* compile errors for the current compile */
    run: null,             /* last /api/run result */
    runMs: null,           /* measured round trip of the last run */
    compileMs: null,       /* measured round trip of the last compile */
    asmMode: "opt",
    asmHidden: false,
    busy: false,
    runBusy: false,
    dirty: false,          /* source changed since the last compile */
    activeLine: 1,
    focusLine: 0,
    errLines: new Set(),
    stage: null,           /* pipeline stage shown in the detail panel */
    roots: [],             /* AST root nodes */
    nodes: [],             /* flat AST node list */
    nodeByLine: new Map(),
    tokens: [],            /* {line, col, text, kind} */
    selNode: null,
    examples: [],
  };

  /* =====================================================================
     Theme
     ===================================================================== */

  const ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  let themeTimer = null;

  function applyTheme(t) {
    const root = document.documentElement;
    root.classList.add("theme-anim");
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => root.classList.remove("theme-anim"), 450);
    root.setAttribute("data-theme", t);
    const btn = $("btn-theme");
    btn.innerHTML = t === "dark" ? ICON_SUN : ICON_MOON;
    btn.title = t === "dark" ? "Switch to light theme (Ctrl+Shift+L)" : "Switch to dark theme (Ctrl+Shift+L)";
    btn.setAttribute("aria-label", btn.title);
    try { localStorage.setItem("tc-theme", t); } catch (_) { /* private mode */ }
  }
  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  }
  $("btn-theme").addEventListener("click", toggleTheme);

  /* =====================================================================
     Toasts (error and status notifications)
     ===================================================================== */

  function toast(message, kind = "") {
    const box = document.createElement("div");
    box.className = "toast " + kind;
    box.textContent = message;
    $("toasts").appendChild(box);
    setTimeout(() => box.classList.add("out"), 2800);
    setTimeout(() => box.remove(), 3150);
  }

  /* =====================================================================
     Editor: syntax colour overlay, gutter, cursor, keys
     ===================================================================== */

  const TOKEN_RE = /(#.*)|("(?:[^"\\]|\\.)*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(->|==|!=|<=|>=|[-+*\/%<>=():,])/g;

  function hlLine(line) {
    let out = "", last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(line))) {
      const t = m[0];
      const cls = m[1] ? "hl-com" : m[2] ? "hl-str" : m[3] ? "hl-num"
        : m[4] ? (TYPES.has(t) ? "hl-type" : KEYWORDS.has(t) ? "hl-kw" : "hl-id") : "hl-op";
      out += esc(line.slice(last, m.index)) + `<span class="${cls}">${esc(t)}</span>`;
      last = m.index + t.length;
    }
    return out + esc(line.slice(last));
  }

  function renderGutter() {
    const lines = src.value.split("\n");
    let html = "";
    for (let i = 1; i <= lines.length; i++) {
      const cls = [S.errLines.has(i) ? "err" : "", i === S.activeLine ? "cur" : ""].filter(Boolean).join(" ");
      html += `<div class="gl ${cls}">${i}</div>`;
    }
    gutter.innerHTML = html;
    gutter.scrollTop = src.scrollTop;
    renderHighlight();
  }

  function renderHighlight() {
    const hl = $("hl");
    hl.innerHTML = src.value.split("\n").map((line, i) => {
      const n = i + 1;
      const cls = ["hl-l",
        n === S.activeLine ? "active" : "",
        n === S.focusLine ? "focus" : "",
        S.errLines.has(n) ? "hl-err" : ""].filter(Boolean).join(" ");
      return `<div class="${cls}"><span>${hlLine(line) || " "}</span></div>`;
    }).join("");
    hl.scrollTop = src.scrollTop;
    hl.scrollLeft = src.scrollLeft;
  }

  function lineCount() { return src.value.split("\n").length; }
  function nonBlankLines() { return src.value.split("\n").filter((l) => l.trim()).length; }

  function updateCursor() {
    const before = src.value.slice(0, src.selectionStart).split("\n");
    const line = before.length, col = before[before.length - 1].length + 1;
    $("cursor").textContent = `Ln ${line}, Col ${col}`;
    if (line !== S.activeLine) {
      S.activeLine = line;
      renderGutter();
    }
    updateLinkInfo();
  }

  function insertAtCursor(text) {
    const s = src.selectionStart, e = src.selectionEnd;
    src.value = src.value.slice(0, s) + text + src.value.slice(e);
    src.selectionStart = src.selectionEnd = s + text.length;
  }

  /* Apply a line-level change to the selected lines (comment, indent, outdent) */
  function editLines(fn) {
    const val = src.value;
    const s = src.selectionStart, e = src.selectionEnd;
    const ls = val.lastIndexOf("\n", s - 1) + 1;
    let le = val.indexOf("\n", e);
    if (le < 0) le = val.length;
    const out = fn(val.slice(ls, le).split("\n")).join("\n");
    src.value = val.slice(0, ls) + out + val.slice(le);
    src.selectionStart = ls;
    src.selectionEnd = ls + out.length;
    onEdit();
  }

  function toggleComment(lines) {
    const real = lines.filter((l) => l.trim());
    const allCommented = real.length && real.every((l) => /^\s*#/.test(l));
    if (allCommented) return lines.map((l) => l.replace(/^(\s*)# ?/, "$1"));
    const minIndent = Math.min(...real.map((l) => l.match(/^ */)[0].length), 0);
    return lines.map((l) => (l.trim() ? l.slice(0, minIndent) + "# " + l.slice(minIndent) : l));
  }

  function onEdit() {
    S.dirty = true;
    S.errLines = new Set();
    if (S.last && !S.busy) setStatus("idle", "Edited. Press Compile to refresh the outputs.");
    $("sample-info").textContent = "";
    saveDraft();
    renderGutter();
    updateCursor();
  }

  src.addEventListener("input", onEdit);
  src.addEventListener("keyup", updateCursor);
  src.addEventListener("click", updateCursor);
  src.addEventListener("scroll", () => {
    gutter.scrollTop = src.scrollTop;
    $("hl").scrollTop = src.scrollTop;
    $("hl").scrollLeft = src.scrollLeft;
  });

  src.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "/") {
      ev.preventDefault();
      editLines(toggleComment);
    } else if (ev.key === "Tab" && ev.shiftKey) {
      ev.preventDefault();
      editLines((lines) => lines.map((l) => l.replace(/^ {1,4}/, "")));
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      if (src.selectionStart !== src.selectionEnd && src.value.slice(src.selectionStart, src.selectionEnd).includes("\n")) {
        editLines((lines) => lines.map((l) => "    " + l));
      } else {
        insertAtCursor("    ");
        onEdit();
      }
    } else if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      /* keep the indentation; one more level after a line that ends with ':' */
      ev.preventDefault();
      const before = src.value.slice(0, src.selectionStart);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const indent = line.match(/^ */)[0];
      const extra = line.trimEnd().endsWith(":") ? "    " : "";
      insertAtCursor("\n" + indent + extra);
      onEdit();
    }
  });

  /* Jump to a source position (from a token, a diagnostic or an AST node) */
  function jumpTo(line, col = 1) {
    const lines = src.value.split("\n");
    if (line < 1 || line > lines.length) return;
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
    const start = pos + Math.min(lines[line - 1].length, Math.max(0, col - 1));
    S.focusLine = line;
    src.focus();
    src.setSelectionRange(start, start);
    src.scrollTop = Math.max(0, (line - 1) * LINE_PX - src.clientHeight / 3);
    renderGutter();
    updateCursor();
  }

  /* Draft is remembered for this browser only */
  function saveDraft() {
    try { localStorage.setItem("tc-draft", src.value); } catch (_) { /* private mode */ }
  }

  /* =====================================================================
     Tabs
     ===================================================================== */

  const TAB_LABEL = {
    tokens: "Tokens", ast: "AST", graph: "Graph", symbols: "Symbols", tac: "TAC",
    optimizer: "Optimizer", assembly: "Assembly", terminal: "Terminal", console: "Console", language: "Language",
  };

  function showTab(name) {
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
    if (name === "graph") requestAnimationFrame(playGraph);
    if (name === "ast" && S.selNode) S.selNode.el && S.selNode.el.scrollIntoView({ block: "nearest" });
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  /* =====================================================================
     Pipeline: real stage statuses, real metrics, click for details
     ===================================================================== */

  const PIPE = [
    { id: "source", label: "Source", icon: "file", color: "var(--accent)" },
    { id: "lexer", label: "Lexical analysis", icon: "scan", color: "var(--stage-lex)" },
    { id: "parser", label: "Syntax analysis", icon: "tree", color: "var(--stage-par)" },
    { id: "semantic", label: "Semantic analysis", icon: "shield", color: "var(--stage-sem)" },
    { id: "symbols", label: "Symbol table", icon: "table", color: "var(--stage-sym)" },
    { id: "tac", label: "Intermediate code", icon: "layers", color: "var(--stage-tac)" },
    { id: "optimizer", label: "Optimizer", icon: "bolt", color: "var(--stage-opt)" },
    { id: "codegen", label: "Assembly", icon: "chip", color: "var(--stage-cg)" },
    { id: "run", label: "Run", icon: "play", color: "var(--stage-run)" },
  ];

  const STAGE_INFO = {
    source: { tab: null, desc: "The TraceLang text in the editor. Every later phase reads this text." },
    lexer: { tab: "tokens", desc: "The lexer (Flex) reads characters and groups them into tokens. It also creates INDENT and DEDENT tokens from the indentation." },
    parser: { tab: "ast", desc: "The parser (Bison, LALR(1)) checks the grammar and builds an abstract syntax tree. Operator precedence is applied here." },
    semantic: { tab: "console", desc: "Semantic analysis checks names, types, scopes, function calls and definite assignment. Problems are listed in the Console." },
    symbols: { tab: "symbols", desc: "Every declared name with its kind, type, scope and storage location in the generated code." },
    tac: { tab: "tac", desc: "The AST is lowered to three-address code: each instruction has at most one operator, and results go to temporaries t0, t1, ..." },
    optimizer: { tab: "optimizer", desc: "Constant folding, constant propagation, algebraic simplification, common subexpression elimination and dead code removal." },
    codegen: { tab: "assembly", desc: "The code generator emits NASM x86-64 assembly for Linux." },
    run: { tab: "terminal", desc: "NASM assembles the code into an object file, ld links it into an executable, and the program runs here with a 5-second limit." },
  };

  const ICONS = {
    file: '<path d="M7 3h7l5 5v13H7z M14 3v5h5"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3 M16 4h3a1 1 0 0 1 1 1v3 M20 16v3a1 1 0 0 1-1 1h-3 M8 20H5a1 1 0 0 1-1-1v-3 M8 12h8"/>',
    tree: '<circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v4m0 0-4.5 6M12 11l4.5 6"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
    table: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M10 5v14"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
  };
  const iconSvg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  const STAGE_NOTE = { done: "passed", error: "failed", partial: "incomplete", skipped: "not reached",
    ready: "ready to run", processing: "checking", pending: "waiting", idle: "waiting" };
  const CHIP_FOR = { done: "ok", error: "err", partial: "warn", ready: "info" };

  /* Server statuses per stage. Source always passes once there is a result. */
  function statusOf(id) {
    if (!S.last) return "idle";
    if (S.last.fatal) return id === "source" ? "done" : "skipped";
    if (id === "source") return "done";
    return (S.last.pipeline || []).find((p) => p.id === id)?.status || "skipped";
  }

  function failedStage() {
    return PIPE.find((s) => s.id !== "source" && statusOf(s.id) === "error");
  }

  /* Metric shown on each card: only numbers the compiler produced */
  function metricFor(id) {
    if (id === "source") return plural(nonBlankLines(), "line");
    const st = statusOf(id);
    if (!S.last) return "";
    if (st === "skipped") return "not reached";
    const f = S.facts, d = S.last;
    switch (id) {
      case "lexer": return f.lexErr ? plural(f.lexErr, "error") : plural(f.tokens.length, "token");
      case "parser": return f.synErr ? plural(f.synErr, "error") : plural(f.ast.nodes.length, "AST node");
      case "semantic": return f.semErr ? plural(f.semErr, "error") : "no errors";
      case "symbols": return plural(f.sym.length, "symbol");
      case "tac": return d.report ? plural(d.report.before, "instruction") : "";
      case "optimizer": return d.report ? `${d.report.before} → ${d.report.after} instr` : "";
      case "codegen": return d.asm_instr && d.asm ? `${d.asm_instr.plain} → ${d.asm_instr.opt} instr` : "";
      case "run": return S.run ? runSummary(S.run) : "not run";
      default: return "";
    }
  }

  function runSummary(r) {
    if (r.stage === "compile") return "compile errors";
    if (r.stage === "tools") return "tools missing";
    if (r.stage === "assemble" || r.stage === "link") return `${r.stage} failed`;
    if (r.exit_code === 124) return "time limit";
    return r.ok ? "exit 0" : `exit ${r.exit_code}`;
  }

  function cardHtml(stage, i, st, metric) {
    const sel = S.stage === stage.id ? " selected" : "";
    return `<button class="stage-card ${st}${sel}" data-stage="${stage.id}" style="--i:${i};--c:${stage.color}" ` +
      `aria-label="${esc(stage.label)}: ${esc(STAGE_NOTE[st] || st)}">` +
      `<span class="stage-top"><span class="stage-ico">${iconSvg(stage.icon)}</span><span class="stage-name">${esc(stage.label)}</span></span>` +
      `<span class="stage-metric">${esc(metric || "")}</span>` +
      `<span class="stage-state"><span class="dot"></span>${STAGE_NOTE[st] || esc(st)}</span>` +
      `</button>` + (i < PIPE.length - 1 ? '<span class="pipe-link" aria-hidden="true"></span>' : "");
  }

  function renderPipelineShell(state = "idle") {
    $("pipeline").innerHTML = PIPE.map((s, i) => cardHtml(s, i, state, "")).join("");
  }

  function setCardState(card, st, metric) {
    const stage = card.dataset.stage;
    card.className = `stage-card ${st}` + (S.stage === stage ? " selected" : "");
    card.querySelector(".stage-metric").textContent = metric || "";
    card.querySelector(".stage-state").innerHTML = `<span class="dot"></span>${esc(STAGE_NOTE[st] || st)}`;
    card.setAttribute("aria-label", `${PIPE.find((p) => p.id === stage).label}: ${STAGE_NOTE[st] || st}`);
  }

  let revealTimers = [];
  function clearReveal() { revealTimers.forEach(clearTimeout); revealTimers = []; }

  /* Cards turn on one after another, each showing its real status and metric */
  function revealPipeline(note) {
    clearReveal();
    stopSweep();
    const cards = $$("#pipeline .stage-card");
    cards.forEach((c) => setCardState(c, "pending", ""));
    $("pipeline-note").textContent = note;
    cards.forEach((c, i) => {
      const id = PIPE[i].id;
      revealTimers.push(setTimeout(() => setCardState(c, statusOf(id), metricFor(id)), 210 * (i + 1)));
    });
    revealTimers.push(setTimeout(() => {
      if (S.stage) renderStageDetail(S.stage);
    }, 210 * (cards.length + 1)));
  }

  /* While the request runs, the active card sweeps along the pipeline */
  let sweepTimer = null;
  function startSweep() {
    stopSweep();
    const cards = $$("#pipeline .stage-card");
    let i = 0;
    sweepTimer = setInterval(() => {
      cards.forEach((c, k) => c.classList.toggle("processing", k === i));
      i = (i + 1) % cards.length;
    }, 150);
    $("pipeline-note").textContent = "Compiling…";
  }
  function stopSweep() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    $$("#pipeline .stage-card.processing").forEach((c) => c.classList.remove("processing"));
  }

  function showPipeBand(on) {
    $("band-idle").hidden = on;
    $("band-pipe").hidden = !on;
  }

  function selectStage(id) {
    if (id === "source") {
      S.stage = "source";
      $$("#pipeline .stage-card").forEach((c) => c.classList.toggle("selected", c.dataset.stage === "source"));
      renderStageDetail("source");
      src.focus();
      return;
    }
    S.stage = S.stage === id ? null : id;
    $$("#pipeline .stage-card").forEach((c) => c.classList.toggle("selected", c.dataset.stage === S.stage));
    $("stage-detail").hidden = !S.stage;
    if (S.stage) renderStageDetail(S.stage);
  }

  $("pipeline").addEventListener("click", (ev) => {
    const card = ev.target.closest(".stage-card");
    if (card) selectStage(card.dataset.stage);
  });
  $("sd-close").addEventListener("click", () => selectStage(S.stage));

  function stageFacts(id) {
    const L = (k, v) => [k, v];
    if (id === "source") {
      const lines = src.value.split("\n");
      return [L("Lines", lines.length), L("Non-blank lines", nonBlankLines()), L("Characters", src.value.length)];
    }
    if (!S.last) return [L("Status", "Press Compile to analyse the program")];
    if (S.last.fatal) return [L("Status", "Compiler not built")];
    const f = S.facts, d = S.last;
    switch (id) {
      case "lexer":
        return [L("Tokens", f.tokens.length), L("Keywords", f.tk.keyword), L("Identifiers", f.tk.identifier),
          L("Numbers", f.tk.number), L("Strings", f.tk.string), L("Operators and punctuation", f.tk.operator),
          L("Layout (NEWLINE, INDENT, DEDENT)", f.tk.layout), L("Lexical errors", f.lexErr)];
      case "parser":
        return [L("AST nodes", f.ast.nodes.length), L("Maximum depth", f.ast.maxDepth),
          L("Statements in the program body", f.bodyCount), L("Syntax errors", f.synErr)];
      case "semantic":
        return [L("Semantic and type errors", f.semErr), L("Functions", f.kinds.function || 0),
          L("Variables", f.kinds.variable || 0), L("Parameters", f.kinds.parameter || 0)];
      case "symbols":
        return [L("Symbols", f.sym.length), L("Variables", f.kinds.variable || 0), L("Functions", f.kinds.function || 0),
          L("Parameters", f.kinds.parameter || 0), L("Loop variables", f.kinds["loop var"] || 0)];
      case "tac":
        return d.report ? [L("Instructions before optimization", d.report.before), L("Instructions after optimization", d.report.after),
          L("Labels", f.tacLabels), L("Temporaries used", f.temps)] : [L("Status", "Not generated")];
      case "optimizer":
        return d.report ? TECHNIQUES.map(([k, name]) => L(name, d.report[k])) : [L("Status", "Not generated")];
      case "codegen":
        return d.asm ? [L("Assembly lines (optimized)", f.asm.lines), L("Instructions, unoptimized", d.asm_instr.plain),
          L("Instructions, optimized", d.asm_instr.opt), L("String constants", f.asm.strings),
          L("Global variables", f.asm.globals), L("Functions", f.asm.functions)] : [L("Status", "Not generated")];
      case "run":
        return S.run ? [L("Result", runSummary(S.run)), L("Stage", S.run.stage),
          L("Output lines", (S.run.stdout || "").split("\n").filter((l) => l !== "").length),
          L("Round trip (build and run)", S.runMs != null ? fmtMs(S.runMs) : "")]
          : [L("Status", "Not run yet. Press Run.")];
      default: return [];
    }
  }

  function stagePreview(id) {
    if (!S.last || S.last.fatal) return "";
    const head = (text, n) => (text || "").split("\n").slice(0, n).join("\n");
    switch (id) {
      case "lexer": return head(S.last.tokens, 14);
      case "parser": return head(S.last.ast, 16);
      case "tac": return head(S.last.tac, 14);
      case "codegen": return head(S.asmMode === "opt" ? S.last.asm_opt : S.last.asm, 16);
      case "run": return S.run ? head(S.run.stdout || S.run.message || "(no output)", 12) : "";
      default: return "";
    }
  }

  function renderStageDetail(id) {
    const info = STAGE_INFO[id];
    const label = PIPE.find((p) => p.id === id).label;
    const st = statusOf(id);
    const chip = $("sd-state");
    chip.className = "chip " + (CHIP_FOR[st] || "");
    chip.textContent = S.last ? (STAGE_NOTE[st] || st) : "not compiled";
    $("sd-title").textContent = label;
    $("sd-desc").textContent = info.desc;
    $("sd-facts").innerHTML = stageFacts(id).map(([k, v]) =>
      `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("");

    const errs = S.errors.filter((e) => errorStage(e) === id).slice(0, 6);
    $("sd-errors").innerHTML = errs.map((e) =>
      `<div class="diag" data-line="${e.line}" data-col="${e.col}"><div class="cat">${esc(e.category)} error</div>` +
      `<div class="loc">Line ${e.line}, column ${e.col}</div><div class="msg">${esc(e.message)}</div></div>`).join("");
    $$("#sd-errors .diag").forEach((el) => el.addEventListener("click", () => {
      jumpTo(Number(el.dataset.line), Number(el.dataset.col));
    }));

    const pre = $("sd-preview");
    const preview = stagePreview(id);
    pre.hidden = !preview;
    pre.textContent = preview;

    const open = $("sd-open");
    if (id === "source") { open.textContent = "Go to editor"; open.hidden = false; open.onclick = () => src.focus(); }
    else if (info.tab === "console" || info.tab === "tokens" || info.tab === "ast" || info.tab === "symbols" ||
             info.tab === "tac" || info.tab === "optimizer" || info.tab === "assembly" || info.tab === "terminal") {
      open.textContent = `Open ${TAB_LABEL[info.tab]}`;
      open.hidden = false;
      open.onclick = () => showTab(info.tab);
    } else { open.hidden = true; }
    $("stage-detail").hidden = false;
  }

  function errorStage(e) {
    if (e.category === "Lexical") return "lexer";
    if (e.category === "Syntax") return "parser";
    return "semantic";
  }

  /* =====================================================================
     Facts: counts derived from the compiler's text output
     ===================================================================== */

  const TECHNIQUES = [
    ["folded", "Constant folding"],
    ["propagated", "Constant propagation"],
    ["simplified", "Algebraic simplification"],
    ["cse", "Common subexpression elimination"],
    ["dead", "Dead code elimination"],
  ];

  function tokenKind(t) {
    if (/^<(NEWLINE|INDENT|DEDENT|EOF)>$/.test(t)) return "layout";
    if (KEYWORDS.has(t)) return "keyword";
    if (/^[0-9]/.test(t)) return "number";
    if (t.startsWith('"')) return "string";
    if (/^[A-Za-z_]/.test(t)) return "identifier";
    return "operator";
  }

  function parseTokens(text) {
    const rows = [];
    for (const line of (text || "").split("\n")) {
      const m = line.match(/^\s*(\d+):(\d+)\s+(.*)$/);
      if (m) rows.push({ line: Number(m[1]), col: Number(m[2]), text: m[3], kind: tokenKind(m[3]) });
    }
    return rows;
  }

  const CAT = {
    VarDecl: "cat-decl", Write: "cat-decl", Function: "cat-decl", Param: "cat-decl",
    If: "cat-ctrl", While: "cat-ctrl", For: "cat-ctrl",
    Assign: "cat-stmt", Show: "cat-stmt", Return: "cat-stmt", CallStmt: "cat-stmt",
    BinOp: "cat-expr", UnOp: "cat-expr", Int: "cat-expr", Float: "cat-expr", String: "cat-expr",
    Bool: "cat-expr", Ident: "cat-expr", Call: "cat-expr",
  };
  const CAT_NAME = { "cat-decl": "Declaration", "cat-ctrl": "Control flow", "cat-stmt": "Statement",
    "cat-expr": "Expression", "cat-prog": "Program", "cat-group": "Group of children" };
  const CAT_VAR = { "cat-decl": "var(--cat-decl)", "cat-ctrl": "var(--cat-ctrl)", "cat-stmt": "var(--cat-stmt)",
    "cat-expr": "var(--cat-expr)", "cat-prog": "var(--cat-prog)", "cat-group": "var(--faint)" };

  /* Parses the indented AST dump of `tracec --ast`: two spaces per level */
  function parseAst(text) {
    const roots = [], nodes = [], stack = [];
    let maxDepth = 0;
    for (const raw of (text || "").split("\n")) {
      if (!raw.trim()) continue;
      const depth = raw.match(/^ */)[0].length >> 1;
      const body = raw.trim();
      const m = body.match(/^(.*?)\s+\(line (\d+), col (\d+)\)$/);
      const label = m ? m[1] : body;
      const word = label.split(/\s+/)[0];
      const isGroup = word.startsWith("[");
      const kind = isGroup ? word : word.replace(/[^A-Za-z]/g, "");
      const typeM = label.match(/<(int|float|string|bool|void)>/);
      const node = {
        id: nodes.length, kind, label, depth, children: [], parent: null, open: true, el: null, li: null,
        type: typeM ? typeM[1] : "",
        text: label.slice(word.length).replace(/<(int|float|string|bool|void)>/, "").trim(),
        line: m ? Number(m[2]) : 0, col: m ? Number(m[3]) : 0,
        cat: isGroup ? "cat-group" : (CAT[kind] || "cat-prog"),
      };
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length) { node.parent = stack[stack.length - 1]; node.parent.children.push(node); }
      else roots.push(node);
      stack.push(node);
      nodes.push(node);
      maxDepth = Math.max(maxDepth, depth);
    }
    return { roots, nodes, maxDepth };
  }

  function computeFacts(data) {
    const tokens = parseTokens(data.tokens);
    const ast = parseAst(data.ast);
    const sym = (data.symbols || "").split("\n").filter((l) => l.trim()).slice(1).map((l) => l.split("\t"));
    const kinds = {};
    sym.forEach((r) => { kinds[r[1]] = (kinds[r[1]] || 0) + 1; });
    const tk = { keyword: 0, identifier: 0, number: 0, string: 0, operator: 0, layout: 0 };
    tokens.forEach((t) => { tk[t.kind]++; });
    const errs = data.errors || [];
    const count = (cats) => errs.filter((e) => cats.includes(e.category)).length;
    const program = ast.roots[0];
    const body = program && program.children.find((c) => c.kind === "[body]");
    const tacLines = (data.tac || "").split("\n");
    const temps = new Set((data.tac || "").match(/\bt\d+\b/g) || []);
    const asmLines = (data.asm_opt || "").split("\n");
    const asmText = data.asm_opt || "";
    return {
      tokens, tk, ast, sym, kinds,
      lexErr: count(["Lexical"]),
      synErr: count(["Syntax"]),
      semErr: count(["Semantic", "Type"]),
      bodyCount: body ? body.children.length : 0,
      tacLabels: tacLines.filter((l) => /^\S.*:\s*$/.test(l)).length,
      temps: temps.size,
      asm: {
        lines: asmLines.length,
        strings: (asmText.match(/^str_\d+:/gm) || []).length,
        globals: (asmText.match(/^g_\w+\s+resq/gm) || []).length,
        functions: (asmText.match(/^fn_\w+:/gm) || []).length,
      },
    };
  }

  /* =====================================================================
     Tokens panel
     ===================================================================== */

  const TOKEN_CLASS = { keyword: "kw", identifier: "id", number: "num", string: "str", operator: "punct", layout: "punct" };
  const TOKEN_MEANING = {
    "<NEWLINE>": "end of a statement line", "<INDENT>": "a block starts (indentation increased)",
    "<DEDENT>": "a block ends (indentation decreased)", "<EOF>": "end of the file",
  };

  function tokenMeaning(t) {
    if (TOKEN_MEANING[t.text]) return TOKEN_MEANING[t.text];
    if (t.kind === "keyword") return TYPES.has(t.text) ? "type name" : "keyword";
    if (t.kind === "number") return t.text.includes(".") ? "float literal" : "integer literal";
    if (t.kind === "string") return "string literal";
    if (t.kind === "identifier") return "identifier";
    return "operator or punctuation";
  }

  function renderTokens() {
    const out = $("tokens-out");
    const toks = S.tokens;
    if (!S.last || S.last.fatal) {
      emptyState(out, "Tokens", "Press Compile to see the tokens the lexer produced.");
      $("tokens-count").textContent = "";
      return;
    }
    if (!toks.length) {
      emptyState(out, "No tokens", "The lexer produced no tokens for this source.");
      return;
    }
    let html = `<table class="grid"><thead><tr><th>#</th><th>Line</th><th>Col</th><th>Token</th><th>Kind</th><th>Meaning</th></tr></thead><tbody>`;
    toks.forEach((t, i) => {
      html += `<tr data-idx="${i}" data-line="${t.line}" data-col="${t.col}">` +
        `<td>${i + 1}</td><td>${t.line}</td><td>${t.col}</td>` +
        `<td class="tk ${TOKEN_CLASS[t.kind]}">${esc(t.text)}</td><td>${t.kind}</td><td class="muted">${esc(tokenMeaning(t))}</td></tr>`;
    });
    html += "</tbody></table>";
    out.innerHTML = html;
    out.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => {
      jumpTo(Number(tr.dataset.line), Number(tr.dataset.col));
    }));
    applyTokenFilter();
  }

  function applyTokenFilter() {
    const q = $("token-filter").value.trim().toLowerCase();
    const rows = $$("#tokens-out tbody tr");
    let shown = 0;
    rows.forEach((tr) => {
      const t = S.tokens[Number(tr.dataset.idx)];
      const ok = !q || t.text.toLowerCase().includes(q) || t.kind.includes(q);
      tr.hidden = !ok;
      if (ok) shown++;
    });
    $("tokens-count").textContent = S.tokens.length ? `${shown} of ${S.tokens.length} tokens` : "";
  }
  $("token-filter").addEventListener("input", applyTokenFilter);

  /* =====================================================================
     AST: interactive tree with expand, collapse, colours and details
     ===================================================================== */

  const AST_HELP = {
    Program: "The root of the tree: everything between start and end.",
    VarDecl: "A variable declaration. Its child, if present, is the initial value.",
    Assign: "Assigns a new value to an existing variable. The child is the new value.",
    Write: "Reads one line of input into a variable. With a type, it also declares the variable.",
    Show: "Prints one value followed by a new line. The child is the value to print.",
    If: "A conditional. Children: the condition, the then-body and the else-body. An elif is a nested If inside the else-body.",
    While: "A loop that repeats its body as long as the condition is true.",
    For: "A counting loop: the variable runs from the start value to the end value, both included.",
    Function: "A function declaration: name, return type, parameters and body.",
    Param: "One parameter of a function, with its name and type.",
    Return: "Ends the current function. The child, if present, is the value sent back to the caller.",
    CallStmt: "A function call used as a statement. Any return value is discarded.",
    BinOp: "A binary operator. Children: the left operand and the right operand.",
    UnOp: "A unary operator (not, or minus). Child: the operand.",
    Int: "An integer literal.",
    Float: "A floating-point literal.",
    String: "A string literal (escape sequences already processed).",
    Bool: "A boolean literal: true or false.",
    Ident: "A reference to a variable. Its type comes from the symbol table.",
    Call: "A function call. Children: the argument expressions, in order.",
  };

  function renderAst() {
    const host = $("ast-tree");
    host.innerHTML = "";
    S.nodes.forEach((n) => { n.el = null; n.li = null; });
    if (!S.last || S.last.fatal) { emptyState(host, "AST", "Press Compile to see the abstract syntax tree."); $("ast-explain").innerHTML = ""; return; }
    if (!S.roots.length) {
      emptyState(host, "No AST", "The parser did not produce a tree. Open the Console to see the syntax errors.");
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "tree";
    ul.setAttribute("role", "tree");
    S.roots.forEach((n) => ul.appendChild(treeItem(n)));
    host.appendChild(ul);
    $("ast-info").textContent = `${plural(S.nodes.length, "node")} · depth ${S.facts.ast.maxDepth + 1}`;
    if (S.selNode) selectNode(S.selNode, false);
    else renderDetailEmpty();
    updateLinkInfo();
  }

  function treeItem(n) {
    const li = document.createElement("li");
    li.className = "tn " + n.cat + (n.kind.startsWith("[") ? " tn-group" : "") + (n.open ? "" : " collapsed");
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-expanded", n.open ? "true" : "false");
    const row = document.createElement("div");
    row.className = "tn-row";
    row.title = n.label;
    const hasKids = n.children.length > 0;
    if (hasKids) {
      const tog = document.createElement("button");
      tog.className = "tn-tog";
      tog.setAttribute("aria-label", "Expand or collapse " + n.kind);
      tog.addEventListener("click", (ev) => { ev.stopPropagation(); toggleNode(n); });
      row.appendChild(tog);
    } else {
      const leaf = document.createElement("span");
      leaf.className = "tn-leaf";
      row.appendChild(leaf);
    }
    const dot = document.createElement("span");
    dot.className = "tn-dot";
    row.appendChild(dot);
    const kind = document.createElement("span");
    kind.className = "tn-kind";
    kind.textContent = n.kind;
    row.appendChild(kind);
    if (n.text) {
      const t = document.createElement("span");
      t.className = "tn-text";
      t.textContent = n.text;
      row.appendChild(t);
    }
    if (n.type) {
      const ty = document.createElement("span");
      ty.className = "tn-type";
      ty.textContent = n.type;
      row.appendChild(ty);
    }
    if (n.line) {
      const loc = document.createElement("span");
      loc.className = "tn-loc";
      loc.textContent = `${n.line}:${n.col}`;
      row.appendChild(loc);
    }
    row.addEventListener("click", () => selectNode(n, true));
    li.appendChild(row);
    n.el = row;
    n.li = li;
    if (hasKids) {
      const ul = document.createElement("ul");
      ul.setAttribute("role", "group");
      n.children.forEach((c) => ul.appendChild(treeItem(c)));
      li.appendChild(ul);
    }
    /* colour: decided by the node category, as in the legend */
    li.style.setProperty("--cat-color", CAT_VAR[n.cat] || "var(--cat-prog)");
    return li;
  }

  function toggleNode(n) {
    n.open = !n.open;
    n.li.classList.toggle("collapsed", !n.open);
    n.li.setAttribute("aria-expanded", n.open ? "true" : "false");
  }

  function setAllOpen(open) {
    S.nodes.forEach((n) => {
      n.open = n.children.length ? open : true;
      if (n.li) { n.li.classList.toggle("collapsed", !n.open); n.li.setAttribute("aria-expanded", n.open ? "true" : "false"); }
    });
    /* collapse-all keeps the program node itself open so the top level stays visible */
    if (!open) S.roots.forEach((r) => { r.open = true; if (r.li) r.li.classList.remove("collapsed"); });
  }
  $("ast-expand").addEventListener("click", () => setAllOpen(true));
  $("ast-collapse").addEventListener("click", () => setAllOpen(false));

  /* Make a node visible: open all of its ancestors */
  function revealNode(n) {
    for (let p = n.parent; p; p = p.parent) {
      if (!p.open) { p.open = true; if (p.li) { p.li.classList.remove("collapsed"); p.li.setAttribute("aria-expanded", "true"); } }
    }
  }

  function selectNode(n, fromClick) {
    S.nodes.forEach((x) => x.el && x.el.classList.toggle("sel", x === n));
    S.selNode = n;
    if (fromClick) revealNode(n);
    renderNodeDetail(n);
  }

  function renderDetailEmpty() {
    $("ast-explain").innerHTML = '<div class="empty-mini">Select a node in the tree to see what it means, its type and where it sits in your source.</div>';
  }

  function renderNodeDetail(n) {
    const box = $("ast-explain");
    const info = AST_HELP[n.kind] || (n.kind.startsWith("[") ? "A group of child nodes that belong to the construct above it." : "A node of the abstract syntax tree.");
    const path = [];
    for (let p = n; p; p = p.parent) path.unshift(p.kind);
    const tips = [];
    if (n.type) tips.push(`Semantic analysis gave this ${CAT_NAME[n.cat].toLowerCase()} the type <b>${esc(n.type)}</b>.`);
    if (n.kind === "BinOp" || n.kind === "UnOp") tips.push(`Operator: <code>${esc(n.text.split(/\s+/)[0] || "")}</code>.`);
    if (n.kind === "Function" && /->/.test(n.text)) tips.push(`It returns a value: ${esc(n.text.split("->")[1].trim())}.`);
    if (n.kind === "Ident") tips.push("The name is resolved through the symbol table (see the Symbols tab).");
    tips.push(`${plural(n.children.length, "child node")}${n.children.length ? "" : " (a leaf)"}.`);
    box.innerHTML =
      `<div class="detail-title"><span class="tn-dot" style="background:${CAT_VAR[n.cat]}"></span>${esc(n.kind)}</div>` +
      `<p class="detail-desc">${esc(info)}</p>` +
      `<div class="ex-line">${esc(n.label)}</div>` +
      `<div class="detail-kv">` +
      `<span>Category</span><b>${esc(CAT_NAME[n.cat])}</b>` +
      `<span>Type</span><b>${esc(n.type || "none")}</b>` +
      `<span>Source</span><b>${n.line ? `line ${n.line}, column ${n.col}` : "no position"}</b>` +
      `<span>Depth</span><b>${n.depth}</b>` +
      `</div>` +
      `<ul>${tips.map((t) => `<li>${t}</li>`).join("")}</ul>` +
      `<div class="path">Path: ${esc(path.join(" › "))}</div>` +
      `<div class="detail-actions">` +
      (n.line ? `<button class="btn btn-mini" id="ast-show-src">Show in editor</button>` : "") +
      `</div>`;
    const btn = $("ast-show-src");
    if (btn) btn.addEventListener("click", () => jumpTo(n.line, n.col));
  }

  /* =====================================================================
     Source-to-compiler links: the cursor line lights up its tokens and nodes
     ===================================================================== */

  function updateLinkInfo() {
    const line = S.activeLine;
    const toks = S.tokens.filter((t) => t.line === line);
    const nodes = S.nodeByLine.get(line) || [];
    S.nodes.forEach((n) => n.el && n.el.classList.toggle("match", n.line === line));
    $$("#tokens-out tbody tr").forEach((tr) => tr.classList.toggle("on-line", Number(tr.dataset.line) === line));
    if (!S.last || S.last.fatal) {
      $("src-link").textContent = "";
    } else if (toks.length || nodes.length) {
      $("src-link").textContent = `Line ${line}: ${plural(toks.length, "token")} · ${plural(nodes.length, "AST node")}`;
    } else {
      $("src-link").textContent = `Line ${line}: no tokens start here`;
    }
    updateAsmNote();
  }

  function updateAsmNote() {
    const note = $("asm-note");
    if (!S.last || !S.last.asm) { note.hidden = true; return; }
    note.hidden = false;
    note.innerHTML = `<b>Source mapping:</b> the code generator emits no source-line markers, so assembly instructions ` +
      `cannot be tied to line ${S.activeLine}. Source lines link to the Tokens and AST views instead. ` +
      `<button class="btn btn-mini" id="asm-goto-ast">Show line ${S.activeLine} in the AST</button>`;
    const b = $("asm-goto-ast");
    if (b) b.addEventListener("click", () => {
      const first = (S.nodeByLine.get(S.activeLine) || [])[0];
      showTab("ast");
      if (first) selectNode(first, true);
    });
  }

  /* =====================================================================
     Graph (Graphviz SVG, animated, with an explanation)
     ===================================================================== */

  const LEVEL_MS = 420;
  let graphTimers = [];
  function clearGraphTimers() { graphTimers.forEach(clearTimeout); graphTimers = []; }

  function renderGraph(data) {
    const out = $("graph-out"), note = $("graph-note");
    clearGraphTimers();
    if (!data.ast || data.fatal) {
      out.className = "graph empty";
      emptyState(out, "No graph", "Press Compile. The graph appears when the program parses.");
      note.hidden = true;
      $("graph-info").textContent = "";
      return;
    }
    out.className = "graph";
    if (data.svg) {
      out.innerHTML = data.svg;
      note.hidden = true;
      prepareGraph(out.querySelector("svg"));
    } else {
      out.innerHTML = `<pre class="code">${esc(data.dot || "")}</pre>`;
      note.hidden = false;
      note.textContent = data.svg_note || "The graph image is unavailable.";
    }
    $("graph-info").textContent = "";
  }

  function prepareGraph(svg) {
    if (!svg) return;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.minWidth = "640px";
    svg.style.height = "auto";
    svg.querySelectorAll("g.node").forEach((g) => {
      g.classList.add("gnode");
      g.dataset.nid = (g.querySelector("title") || {}).textContent || "";
      const texts = [...g.querySelectorAll("text")].map((t) => t.textContent.trim());
      g.dataset.label = texts[0] || "";
      const ln = (texts[1] || "").match(/line (\d+)/);
      g.dataset.line = ln ? ln[1] : "";
      g.addEventListener("click", () => selectGraphNode(svg, g));
    });
    svg.querySelectorAll("g.edge").forEach((g) => {
      g.classList.add("gedge");
      const parts = ((g.querySelector("title") || {}).textContent || "").split("->");
      g.dataset.src = (parts[0] || "").trim();
      g.dataset.dst = (parts[1] || "").trim();
    });
  }

  function playGraph() {
    const svg = $("graph-out").querySelector("svg");
    if (!svg) return;
    clearGraphTimers();
    const nodes = [...svg.querySelectorAll("g.gnode")];
    const edges = [...svg.querySelectorAll("g.gedge")];
    nodes.forEach((n) => n.classList.remove("show", "sel", "path"));
    edges.forEach((e) => e.classList.remove("show"));

    const top = new Map(nodes.map((n) => [n, n.getBoundingClientRect().top]));
    const starts = [];
    [...top.values()].sort((a, b) => a - b).forEach((t) => {
      if (!starts.length || t - starts[starts.length - 1] > 12) starts.push(t);
    });
    const level = (n) => {
      const t = top.get(n);
      let r = 0;
      starts.forEach((s, i) => { if (t >= s - 1) r = i; });
      return r;
    };
    const byId = new Map(nodes.map((n) => [n.dataset.nid, n]));

    edges.forEach((e) => {
      const path = e.querySelector("path");
      if (!path) return;
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
    });

    let deepest = 0;
    nodes.forEach((n) => {
      const r = level(n);
      deepest = Math.max(deepest, r);
      graphTimers.push(setTimeout(() => n.classList.add("show"), r * LEVEL_MS));
    });
    edges.forEach((e) => {
      const child = byId.get(e.dataset.dst);
      const r = child ? level(child) : 1;
      const when = Math.max(0, r - 1) * LEVEL_MS + LEVEL_MS * 0.55;
      graphTimers.push(setTimeout(() => {
        e.classList.add("show");
        const path = e.querySelector("path");
        if (path) path.style.strokeDashoffset = "0";
      }, when));
    });
    $("graph-info").textContent = `${plural(nodes.length, "node")} in ${deepest + 1} levels. Click a node to explain it.`;
  }
  $("graph-replay").addEventListener("click", playGraph);

  function selectGraphNode(svg, g) {
    svg.querySelectorAll(".gnode.sel").forEach((n) => n.classList.remove("sel"));
    svg.querySelectorAll(".gnode.path").forEach((n) => n.classList.remove("path"));
    g.classList.add("sel");

    const parent = new Map();
    svg.querySelectorAll("g.gedge").forEach((e) => parent.set(e.dataset.dst, e.dataset.src));
    const byId = new Map([...svg.querySelectorAll("g.gnode")].map((n) => [n.dataset.nid, n]));
    const chain = [];
    for (let id = g.dataset.nid; id && byId.has(id); id = parent.get(id)) chain.push(byId.get(id));
    chain.forEach((n) => { if (n !== g) n.classList.add("path"); });

    const label = g.dataset.label;
    const word = label.split(/\s+/)[0].replace(/[^A-Za-z]/g, "");
    const info = AST_HELP[word] || "A node of the AST.";
    const typed = label.match(/:\s*(int|float|string|bool|void)\s*$/);
    const children = [...svg.querySelectorAll("g.gedge")].filter((e) => e.dataset.src === g.dataset.nid).length;
    const path = chain.reverse().map((n) => n.dataset.label.split(/\s+/)[0]).join(" → ");

    $("graph-explain-body").innerHTML =
      `<div class="ex-title">${esc(word || label)}</div>` +
      `<div>${esc(info)}</div>` +
      `<div class="ex-line">${esc(label)}</div>` +
      `<ul>` +
      `<li>${plural(children, "child node")}${children ? " below it" : " (a leaf)"}.</li>` +
      (typed ? `<li>Semantic analysis gave this expression the type <b>${esc(typed[1])}</b>.</li>` : "") +
      (g.dataset.line ? `<li>Source line ${esc(g.dataset.line)}.</li>` : "") +
      `<li>Path from the root: ${esc(path)}</li>` +
      `</ul>`;
  }

  /* =====================================================================
     Symbols, TAC, optimizer
     ===================================================================== */

  /* Replaces the content only, so the container keeps its layout classes */
  function emptyState(el, title, hint) {
    el.innerHTML = `<div class="empty-state"><div class="es-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/></svg></div>` +
      `<b>${esc(title)}</b><span>${esc(hint)}</span></div>`;
  }

  function renderSymbols(data) {
    const out = $("symbols-out");
    const rows = (data.symbols || "").split("\n").filter((l) => l.trim()).map((l) => l.split("\t"));
    if (!S.last || S.last.fatal) { emptyState(out, "Symbol table", "Press Compile to see every name, its type and where it is stored."); return; }
    if (rows.length < 2) { emptyState(out, "No symbols", "The program declares no names, or the semantic analysis stopped first."); return; }
    const [head, ...body] = rows;
    const kindClass = (k) => ({ variable: "k-variable", function: "k-function", parameter: "k-parameter", "loop var": "k-loop" }[k] || "");
    let html = `<table class="grid"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>`;
    for (const r of body) {
      html += `<tr><td><b>${esc(r[0])}</b></td><td class="${kindClass(r[1])}">${esc(r[1])}</td>` +
        r.slice(2).map((c) => `<td>${esc(c)}</td>`).join("") + `</tr>`;
    }
    html += "</tbody></table>";
    out.className = "";
    out.innerHTML = html;
  }

  const FLOW = [
    ["Source", "#64748b"], ["Lexer", "var(--stage-lex)"], ["Parser", "var(--stage-par)"],
    ["Semantic", "var(--stage-sem)"], ["Symbols", "var(--stage-sym)"], ["TAC", "var(--stage-tac)"],
    ["Optimizer", "var(--stage-opt)"], ["NASM", "var(--stage-cg)"], ["Link & run", "var(--stage-run)"],
  ];

  function renderFlow() {
    $("flow").innerHTML = FLOW.map(([name, col], i) =>
      `<span class="flow-step" style="background:${col}">${name}</span>` +
      (i < FLOW.length - 1 ? '<span class="flow-arrow" aria-hidden="true">&rarr;</span>' : "")).join("");
  }

  /* Light syntax colours for TAC: labels, the opcode, temporaries, numbers, strings */
  function tacLineHtml(line) {
    if (!line.trim()) return "";
    if (/^\S.*:\s*$/.test(line)) return `<span class="c-label">${esc(line)}</span>`;
    const lead = line.match(/^\s*/)[0].length;
    const re = /("(?:[^"\\]|\\.)*")|\b(t\d+)\b|\b(\d+(?:\.\d+)?)\b|\b([a-z_][a-z0-9_]*)\b/g;
    let out = "", last = 0, m;
    while ((m = re.exec(line))) {
      out += esc(line.slice(last, m.index));
      const t = m[0];
      if (m[1]) out += `<span class="c-str">${esc(t)}</span>`;
      else if (m[2]) out += `<span class="c-tmp">${esc(t)}</span>`;
      else if (m[3]) out += `<span class="c-num">${esc(t)}</span>`;
      else if (m.index === lead) out += `<span class="c-op">${esc(t)}</span>`;
      else out += esc(t);
      last = m.index + t.length;
    }
    return out + esc(line.slice(last));
  }

  function renderTac(data) {
    const a = $("tac-out"), b = $("tac-opt-out");
    const ok = S.last && !S.last.fatal && data.tac;
    a.className = ok ? "code tac" : "code tac empty";
    b.className = ok ? "code tac" : "code tac empty";
    a.innerHTML = ok ? data.tac.split("\n").map(tacLineHtml).join("\n") : "Not generated. Fix the errors first.";
    b.innerHTML = ok ? data.tac_opt.split("\n").map(tacLineHtml).join("\n") : "Not generated. Fix the errors first.";
  }

  function renderOptimizer(data) {
    const out = $("report-out");
    if (!data.report) {
      emptyState(out, "No optimization report", "The optimizer runs after a successful semantic analysis.");
      $("asm-diff").className = "code diff empty";
      $("asm-diff").textContent = "";
      return;
    }
    const r = data.report;
    out.className = "";
    const pct = r.before ? Math.round(100 * (r.before - r.after) / r.before) : 0;
    const asmP = data.asm_instr.plain, asmO = data.asm_instr.opt;
    const asmPct = asmP ? Math.round(100 * (asmP - asmO) / asmP) : 0;
    out.innerHTML =
      `<div class="cards">` +
      `<div class="card"><div class="lbl">TAC before</div><div class="big">${r.before}</div></div>` +
      `<div class="card"><div class="lbl">TAC after</div><div class="big">${r.after}</div></div>` +
      `<div class="card"><div class="lbl">Assembly before</div><div class="big">${asmP}</div></div>` +
      `<div class="card"><div class="lbl">Assembly after</div><div class="big">${asmO}</div></div>` +
      `</div>` +
      `<div class="card"><div class="lbl">TAC reduction: ${pct}%</div>` +
      `<div class="bar"><span style="width:${Math.max(0, pct)}%"></span></div>` +
      `<div class="lbl">Assembly reduction: ${asmPct}% (${asmP} to ${asmO} instructions)</div>` +
      `<div class="bar"><span style="width:${Math.max(0, asmPct)}%"></span></div></div>` +
      `<h4>Techniques applied</h4><div class="tech">` +
      TECHNIQUES.map(([k, name]) => `<div>${name}</div><div class="n">${r[k]}</div>`).join("") +
      `</div>`;
    $("asm-diff").className = "code diff";
    $("asm-diff").innerHTML = diffHtml(data.asm || "", data.asm_opt || "");
  }

  /* Line diff (LCS) between the unoptimized and optimized assembly, with context */
  function diffHtml(aText, bText) {
    const a = aText.split("\n"), b = bText.split("\n");
    const n = a.length, m = b.length;
    if (n * m > 4000000) return `<span class="same">Files are too large to compare line by line.</span>`;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push(["same", a[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(["del", a[i]]); i++; }
      else { out.push(["add", b[j]]); j++; }
    }
    while (i < n) out.push(["del", a[i++]]);
    while (j < m) out.push(["add", b[j++]]);

    const keep = out.map(() => false);
    out.forEach(([k], idx) => {
      if (k !== "same") for (let d = -2; d <= 2; d++) if (out[idx + d]) keep[idx + d] = true;
    });
    let html = "", skipping = false;
    out.forEach(([k, t], idx) => {
      if (!keep[idx]) {
        if (!skipping) { html += `<span class="same">   ... unchanged ...</span>`; skipping = true; }
        return;
      }
      skipping = false;
      const mark = k === "add" ? "+ " : k === "del" ? "- " : "  ";
      html += `<span class="${k}">${mark}${esc(t)}</span>`;
    });
    return html || `<span class="same">The two versions are identical.</span>`;
  }

  /* =====================================================================
     Assembly viewer and instruction explainer
     ===================================================================== */

  const ASM_HELP = {
    mov: "Copies the second operand into the first. Flags are not changed.",
    add: "First = first + second. Sets the flags (zero, sign, carry, overflow).",
    sub: "First = first - second. Sets the flags.",
    imul: "Signed multiply: first = first * second. Sets the flags.",
    idiv: "Signed divide of RDX:RAX by the operand. Quotient goes to RAX, remainder to RDX. Faults if the divisor is zero.",
    div: "Unsigned divide of RDX:RAX by the operand. Quotient in RAX, remainder in RDX.",
    cqo: "Sign-extends RAX into RDX. Needed before idiv so that RDX:RAX holds the full dividend.",
    neg: "Two's-complement negation of the operand: value = -value.",
    xor: "Bitwise exclusive or. With the same register twice it sets the register to 0; xor rax, 1 flips the bool.",
    and: "Bitwise and of the two operands; the result is stored in the first.",
    or: "Bitwise or of the two operands; the result is stored in the first.",
    cmp: "Computes first - second only to set the flags. The result is thrown away.",
    test: "Computes first AND second only to set the flags. test rax, rax checks whether RAX is zero.",
    sete: "Sets the byte to 1 if the zero flag is set (equal), otherwise 0.",
    setne: "Sets the byte to 1 if the zero flag is clear (not equal).",
    setl: "Sets the byte to 1 if the first compare operand is less than the second (signed).",
    setle: "Sets the byte to 1 if less than or equal (signed).",
    setg: "Sets the byte to 1 if greater than (signed).",
    setge: "Sets the byte to 1 if greater than or equal (signed).",
    seta: "Sets the byte to 1 if above (unsigned / float comparison).",
    setae: "Sets the byte to 1 if above or equal (unsigned / float comparison).",
    setp: "Sets the byte to 1 if the parity flag is set (unordered floats).",
    setnp: "Sets the byte to 1 if the parity flag is clear (ordered floats).",
    movzx: "Copies a byte into a wider register and fills the upper bits with zeros.",
    jmp: "Unconditional jump to a label.",
    jz: "Jumps to the label if the zero flag is set (value was 0 / false).",
    je: "Jumps to the label if equal (same as jz).",
    jnz: "Jumps to the label if the zero flag is clear.",
    call: "Pushes the return address and jumps to a function or runtime routine.",
    ret: "Pops the return address from the stack and jumps back to the caller.",
    push: "Decrements RSP by 8 and stores the operand at the new top of the stack.",
    pop: "Loads the value at the top of the stack into the operand and increments RSP by 8.",
    lea: "Computes an address and stores it in the register. Memory is not read.",
    leave: "Restores the stack frame: RSP = RBP, then RBP is popped.",
    syscall: "Asks the Linux kernel for a service. RAX selects it (1 write, 0 read, 60 exit).",
    movq: "Copies 64 bits between a general register and an XMM register, unchanged (bit pattern).",
    addsd: "Adds two doubles in XMM registers: first = first + second.",
    subsd: "Subtracts two doubles in XMM registers.",
    mulsd: "Multiplies two doubles in XMM registers.",
    divsd: "Divides two doubles in XMM registers.",
    ucomisd: "Compares two doubles and sets ZF, PF and CF. Used before the set/jump instructions for floats.",
    cvtsi2sd: "Converts a 64-bit integer to a double.",
    cvtsd2si: "Converts a double to a 64-bit integer, rounding to the nearest value.",
    inc: "Adds 1 to the operand.",
    dec: "Subtracts 1 from the operand.",
    rep: "Repeats the following string instruction RCX times (here: copy bytes).",
    movsb: "Copies one byte from [RSI] to [RDI], then advances both pointers.",
    bits: "Assembler directive: generate 64-bit code.",
    default: "Assembler directive: memory operands are RIP-relative by default.",
    section: "Assembler directive: starts a section (.data initialized data, .bss zeroed data, .text code).",
    global: "Exports a symbol so the linker can find it (the entry point _start).",
    db: "Defines initialized bytes (strings are stored as byte lists ending with 0).",
    resq: "Reserves space for one 8-byte value (a global variable).",
  };
  const REG_RE = /\b(rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp|r8|r12|r13|al|cl|xmm0|xmm1)\b/g;

  function asmLineHtml(line) {
    const t = line.trim();
    if (!t) return "";
    if (t.startsWith(";")) return `<span class="c-comment">${esc(line)}</span>`;
    if (t.endsWith(":") && !t.includes(" ")) return `<span class="c-label">${esc(line)}</span>`;
    const m = line.match(/^(\s*)(\S+)(.*)$/);
    if (!m) return esc(line);
    const dirs = ["bits", "default", "section", "global", "db", "resq", "equ"];
    const cls = dirs.includes(m[2]) ? "c-dir" : "c-op";
    return `${esc(m[1])}<span class="${cls}">${esc(m[2])}</span>${esc(m[3])}`;
  }

  function currentAsm() {
    if (!S.last || !S.last.asm) return "";
    return S.asmMode === "opt" ? S.last.asm_opt : S.last.asm;
  }

  function renderAsm() {
    const out = $("asm-out");
    const chip = $("asm-status");
    const text = S.asmHidden ? "" : currentAsm();
    if (S.last && !S.asmHidden) {
      chip.hidden = false;
      chip.className = "chip " + (S.last.asm ? "ok" : "err");
      chip.textContent = S.last.asm ? "Generated" : "Not generated";
    } else {
      chip.hidden = true;
    }
    if (!text) {
      out.className = "code asm empty";
      out.innerHTML = "";
      out.textContent = S.asmHidden ? "Output cleared. Press Compile to generate the assembly again."
        : S.last ? "No assembly: the program has errors. Open the Console to see them."
        : "Press Compile to generate NASM assembly.";
      $("asm-count").textContent = "";
      $("asm-explain").textContent = "Click an instruction to see what it does to registers and memory.";
      return;
    }
    const lines = text.split("\n");
    out.className = "code asm";
    out.innerHTML = lines.map((line, i) =>
      `<div class="ins" data-idx="${i}"><span class="ln">${i + 1}</span><span class="lc">${asmLineHtml(line) || " "}</span></div>`).join("");
    const count = S.asmMode === "opt" ? S.last.asm_instr.opt : S.last.asm_instr.plain;
    $("asm-count").textContent = `${plural(lines.length, "line")} · ${plural(count, "instruction")} (${S.asmMode === "opt" ? "optimized" : "unoptimized"})`;
    out.querySelectorAll(".ins").forEach((el) => el.addEventListener("click", () => {
      out.querySelectorAll(".ins.sel").forEach((n) => n.classList.remove("sel"));
      el.classList.add("sel");
      explainAsm(lines[Number(el.dataset.idx)]);
    }));
  }

  function explainAsm(line) {
    const t = line.trim();
    const box = $("asm-explain");
    if (!t) { box.textContent = "Blank line."; return; }
    let title;
    const text = [];
    if (t.startsWith(";")) {
      title = "Comment";
      text.push("A comment written by the code generator.");
    } else if (t.endsWith(":") && !t.includes(" ")) {
      title = "Label";
      text.push("A named position. Jumps and calls use it as a target.");
    } else {
      const mn = t.split(/\s+/)[0];
      title = mn;
      text.push(ASM_HELP[mn] || "An instruction or directive of the NASM program.");
      if (/\[rel g_/.test(t)) text.push("Memory: reads or writes a global variable in .bss (RIP-relative address).");
      if (/\[rbp[-+]/.test(t)) text.push("Memory: a stack slot relative to RBP (a local, a parameter or a temporary).");
      if (/\[rbp-/.test(t) && !/\[rel/.test(t)) text.push("A negative offset is a local or temporary; a positive one is a parameter the caller pushed.");
      if (mn === "call" && /rt_/.test(t)) text.push("Calls a runtime routine from runtime/runtime.asm (printing, input or an error).");
      if (mn === "call" && /fn_/.test(t)) text.push("Calls a TraceLang function. Arguments were pushed before the call.");
      const regs = [...new Set(t.match(REG_RE) || [])];
      if (regs.length) text.push("Registers involved: " + regs.join(", ") + ".");
    }
    box.innerHTML = `<div class="detail-title">${esc(title)}</div><div class="ex-line">${esc(t)}</div>` +
      `<ul>${text.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  }

  $$(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    S.asmMode = b.dataset.asm;
    $$(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    renderAsm();
    if (S.stage === "codegen") renderStageDetail("codegen");
  }));

  /* =====================================================================
     Console: diagnostics and phase log
     ===================================================================== */

  const ERROR_GROUPS = [
    ["Lexical", "Lexical errors", ["Lexical"]],
    ["Syntax", "Syntax errors", ["Syntax"]],
    ["Semantic", "Semantic and type errors", ["Semantic", "Type"]],
  ];

  function renderConsole(data) {
    const out = $("console-out");
    const errors = data.errors || [];
    const badge = $("err-count");
    badge.hidden = errors.length === 0;
    badge.textContent = errors.length;

    if (!S.last && !data.fatal) {
      emptyState(out, "Console", "Compile errors, warnings and the phase log appear here.");
      return;
    }
    let html = "";
    if (data.fatal) html += `<div class="diag sys"><div class="cat">Setup problem</div><div class="msg">${esc(data.fatal)}</div></div>`;
    ERROR_GROUPS.forEach(([, title, cats]) => {
      const group = errors.filter((e) => cats.includes(e.category));
      if (!group.length) return;
      html += `<div class="group-title">${title}</div>`;
      group.forEach((e) => {
        html += `<div class="diag" data-line="${e.line}" data-col="${e.col}">` +
          `<div class="cat">${esc(e.category)} error</div>` +
          `<div class="loc">Line ${e.line}, column ${e.col} · click to jump to it</div>` +
          `<div class="msg">${esc(e.message)}</div>` +
          (e.fix ? `<div class="fix"><b>Possible correction:</b> ${esc(e.fix)}</div>` : "") + `</div>`;
      });
    });
    if (S.last && !errors.length && !data.fatal) {
      html += `<div class="ok-msg">No errors. The program passed lexical, syntax and semantic analysis.</div>`;
    }
    if (S.last && (S.last.pipeline || []).length) {
      html += `<div class="phase-log"><div class="group-title">Phase log</div><ul>` +
        S.last.pipeline.map((p) => `<li><span class="dot ${p.status}"></span><span>${esc(p.label)}</span>` +
          `<span class="st">${esc(STAGE_NOTE[p.status] || p.status)}</span></li>`).join("") + `</ul></div>`;
    }
    out.innerHTML = html;
    out.querySelectorAll(".diag[data-line]").forEach((el) => el.addEventListener("click", () => {
      jumpTo(Number(el.dataset.line), Number(el.dataset.col));
    }));
  }

  /* =====================================================================
     Terminal: program output, runtime input, classified errors
     ===================================================================== */

  function runtimeMessage(stderr) {
    const first = (stderr || "").split("\n").find((l) => l.trim()) || "";
    if (/division by zero/.test(first)) return { kind: "run", title: "Runtime error", text: "Division by zero at run time: the divisor was 0." };
    if (/expected an integer input/.test(first)) return { kind: "run", title: "Runtime error", text: "The program expected an integer, but the input line was not a valid integer." };
    if (/expected a number input/.test(first)) return { kind: "run", title: "Runtime error", text: "The program expected a number, but the input line was not valid." };
    if (/expected true or false/.test(first)) return { kind: "run", title: "Runtime error", text: "The program expected true or false, but the input line was something else." };
    return null;
  }

  function renderTerminal(r, stdinText, ms) {
    const body = $("run-out");
    const chip = $("term-status");
    const esc2 = esc;
    let html = "";
    let status = { text: "Not run", cls: "" };

    if (r.stage === "compile") {
      status = { text: "Not run · compile errors", cls: "err" };
      html += `<div class="term-verdict err"><span class="term-kind build">Compile error</span>The program has compile errors, so it was not built. Open the Console tab.</div>`;
      html += (r.errors || []).map((e) => `<div class="term-err">line ${e.line}: ${esc2(e.message)}</div>`).join("");
    } else if (r.stage === "tools") {
      status = { text: "Build failed", cls: "err" };
      html += `<div class="term-verdict err"><span class="term-kind build">Setup</span>${esc2(r.message || "Build tools are missing.")}</div>`;
    } else if (r.stage === "assemble" || r.stage === "link") {
      status = { text: "Build failed", cls: "err" };
      html += `<div class="term-verdict err"><span class="term-kind build">${r.stage === "assemble" ? "NASM" : "ld"} error</span></div>` +
        `<div class="term-err">${esc2(r.message || "")}</div>`;
    } else {
      const stdinLines = stdinText.split("\n").filter((l) => l.length);
      if (stdinLines.length) {
        html += `<div class="term-block"><div class="term-label">Input sent</div>` +
          stdinLines.map((l) => `<div class="term-in">› ${esc2(l)}</div>`).join("") + `</div>`;
      }
      html += `<div class="term-block"><div class="term-label">Output</div>` +
        `<div class="term-out">${esc2(r.stdout || "") || '<span class="muted">(no output)</span>'}</div></div>`;
      if (r.stderr && r.stderr.trim()) {
        html += `<div class="term-block"><div class="term-label">Error output</div>` +
          `<div class="term-err">${esc2(r.stderr.trim())}</div></div>`;
      }
      if (r.exit_code === 124) {
        status = { text: "Stopped · time limit", cls: "warn" };
        html += `<div class="term-verdict warn"><span class="term-kind limit">Time limit</span>` +
          `The program was stopped after 5 seconds. It may contain an infinite loop.</div>`;
      } else if (r.ok) {
        status = { text: "Finished · exit 0", cls: "ok" };
        html += `<div class="term-verdict ok">Finished successfully.</div>`;
      } else {
        const rm = runtimeMessage(r.stderr);
        status = { text: rm ? "Runtime error" : `Runtime error · exit ${r.exit_code}`, cls: "err" };
        html += `<div class="term-verdict err"><span class="term-kind run">${rm ? rm.title : "Exit " + r.exit_code}</span>` +
          (rm ? esc2(rm.text) : "The program stopped with a non-zero exit code.") + `</div>`;
      }
      html += `<div class="muted small">[process exited with code ${r.exit_code}]</div>`;
    }
    body.innerHTML = html;
    chip.className = "chip " + status.cls;
    chip.textContent = status.text;
    $("term-time").textContent = ms != null ? `Build and run: ${fmtMs(ms)}` : "";
  }

  /* =====================================================================
     Requests and actions
     ===================================================================== */

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    return data;
  }

  function setStatus(kind, text) {
    const s = $("status");
    s.className = "status " + kind;
    s.textContent = text;
  }

  function setBusy(on, label) {
    S.busy = on;
    $("btn-compile").classList.toggle("loading", on);
    $("btn-compile").disabled = on;
    $("progress").classList.toggle("on", on);
    if (on) setStatus("busy", label);
  }

  function renderStats() {
    const d = S.last, f = S.facts;
    const parts = [["Source lines", nonBlankLines()]];
    if (f) { parts.push(["Tokens", f.tokens.length]); parts.push(["AST nodes", f.ast.nodes.length]); }
    if (d && d.report) parts.push(["TAC", `${d.report.before} → ${d.report.after}`]);
    if (d && d.asm && d.asm_instr) parts.push(["Instructions", `${d.asm_instr.plain} → ${d.asm_instr.opt}`]);
    if (S.compileMs != null) parts.push(["Compile", fmtMs(S.compileMs)]);
    if (S.runMs != null) parts.push(["Run", fmtMs(S.runMs)]);
    $("stats").innerHTML = parts.map(([k, v]) =>
      `<span class="stat"><span>${esc(k)}</span> <b>${esc(v)}</b></span>`).join("");
  }

  function prepareOutputs(data) {
    S.last = data;
    S.errors = data.errors || [];
    S.facts = data.fatal ? null : computeFacts(data);
    S.tokens = S.facts ? S.facts.tokens : [];
    const tree = S.facts ? S.facts.ast : { roots: [], nodes: [] };
    S.roots = tree.roots;
    S.nodes = tree.nodes;
    S.nodeByLine = new Map();
    S.nodes.forEach((n) => {
      if (!n.line) return;
      if (!S.nodeByLine.has(n.line)) S.nodeByLine.set(n.line, []);
      S.nodeByLine.get(n.line).push(n);
    });
    S.errLines = new Set(S.errors.filter((e) => e.line > 0).map((e) => e.line));
    S.selNode = null;
  }

  async function compile() {
    if (S.busy || S.runBusy) return;
    setBusy(true, "Compiling…");
    const t0 = performance.now();
    clearReveal();
    showPipeBand(true);
    renderPipelineShell("idle");
    startSweep();
    try {
      const data = await post("/api/analyze", { source: src.value });
      S.compileMs = performance.now() - t0;
      stopSweep();
      S.dirty = false;
      S.run = null;
      S.runMs = null;
      prepareOutputs(data);
      renderTokens();
      renderAst();
      renderGraph(data);
      renderSymbols(data);
      renderTac(data);
      renderOptimizer(data);
      renderAsm();
      renderConsole(data);
      $("btn-run").disabled = false;
      $("mi-asm").disabled = !data.asm;
      /* a new compile makes the previous run stale */
      $("term-status").className = "chip";
      $("term-status").textContent = "Not run";
      $("run-out").innerHTML = '<div class="term-empty">Press Run to build the program with NASM, link it with ld and execute it here. Compile errors appear in the Console tab.</div>';
      $("term-time").textContent = "";
      renderGutter();
      updateCursor();
      revealPipeline(data.fatal ? "The compiler binary is missing. Run make in the project folder."
        : failedStage() ? `${failedStage().label} failed. Open the Console for the details.`
        : "All phases passed. The program is ready to run.");
      if (data.fatal) setStatus("err", "Compiler not built");
      else if (S.errors.length) setStatus("err", `${plural(S.errors.length, "error")}`);
      else setStatus("ok", "Compiled OK");
      renderStats();
      if (S.stage) renderStageDetail(S.stage);
      showTab(S.errors.length || data.fatal ? "console" : "ast");
      saveDraft();
    } catch (err) {
      stopSweep();
      $("pipeline-note").textContent = "The request failed. Is the server still running?";
      setStatus("err", "Request failed");
      toast("Could not reach the compiler server. Check that it is still running.", "err");
      $("console-out").innerHTML = `<div class="diag sys"><div class="cat">Connection problem</div>` +
        `<div class="msg">${esc(err.message)}. Is the server still running?</div></div>`;
      showTab("console");
    } finally {
      stopSweep();
      setBusy(false);
    }
  }

  async function runProgram() {
    if (S.busy || S.runBusy) return;
    if (!S.last || S.dirty) {
      await compile();
      if (!S.last || S.errors.length) {
        if (S.last && S.errors.length) {
          renderTerminal({ stage: "compile", errors: S.errors }, "", null);
          toast("The program has compile errors. Fix them before running.", "warn");
        }
        return;
      }
    }
    if (!S.last.asm) return;
    S.runBusy = true;
    $("btn-run").disabled = true;
    $("btn-run2").disabled = true;
    showTab("terminal");
    const chip = $("term-status");
    chip.className = "chip info";
    chip.textContent = "Running…";
    $("term-time").textContent = "";
    $("run-out").innerHTML = '<div class="term-empty">Building with NASM, linking with ld and running…</div>';
    setStatus("busy", "Running…");
    const stdinText = $("stdin").value;
    const t0 = performance.now();
    try {
      const r = await post("/api/run", { source: src.value, input: stdinText, optimized: S.asmMode === "opt" });
      S.runMs = performance.now() - t0;
      S.run = r;
      renderTerminal(r, stdinText, S.runMs);
      if (r.stage === "compile") {
        S.errors = r.errors || [];
        renderConsole({ errors: S.errors });
        showTab("console");
        setStatus("err", "Not run");
      } else if (r.stage === "tools" || r.stage === "assemble" || r.stage === "link") {
        setStatus("err", "Build failed");
        toast("The program could not be built. See the Terminal tab.", "err");
      } else {
        setStatus(r.ok ? "ok" : "err", r.ok ? "Program ran" : "Runtime error");
      }
      if (S.stage === "run") renderStageDetail("run");
      revealPipelineStageRun();
    } catch (err) {
      S.runMs = performance.now() - t0;
      $("run-out").innerHTML = `<div class="term-verdict err">Could not reach the compiler server: ${esc(err.message)}</div>`;
      $("term-status").className = "chip err";
      $("term-status").textContent = "Request failed";
      setStatus("err", "Request failed");
      toast("Could not reach the compiler server.", "err");
    } finally {
      S.runBusy = false;
      $("btn-run").disabled = false;
      $("btn-run2").disabled = false;
      renderStats();
    }
  }

  /* Only the Run card changes after a run; the compile phases stay as they were */
  function revealPipelineStageRun() {
    const card = $("pipeline").querySelector('.stage-card[data-stage="run"]');
    if (!card || !S.last) return;
    const st = S.run && S.run.stage === "compile" ? "skipped" : (S.run && S.run.ok ? "done" : "error");
    setCardState(card, st, metricFor("run"));
    applySelectedClass();
  }

  function applySelectedClass() {
    $$("#pipeline .stage-card").forEach((c) => c.classList.toggle("selected", c.dataset.stage === S.stage));
  }

  function clearAll() {
    src.value = "";
    S.last = null; S.facts = null; S.errors = []; S.run = null; S.runMs = null; S.compileMs = null;
    S.tokens = []; S.roots = []; S.nodes = []; S.nodeByLine = new Map(); S.errLines = new Set();
    S.selNode = null; S.stage = null; S.asmHidden = false; S.dirty = false;
    S.activeLine = 1; S.focusLine = 0;
    renderGutter();
    updateCursor();
    clearReveal(); stopSweep();
    showPipeBand(false);
    $("stage-detail").hidden = true;
    renderPipelineShell("idle");
    clearGraphTimers();
    emptyState($("tokens-out"), "Tokens", "Press Compile to see the tokens the lexer produced.");
    $("tokens-count").textContent = "";
    emptyState($("ast-tree"), "AST", "Press Compile to see the abstract syntax tree.");
    renderDetailEmpty();
    $("ast-info").textContent = "";
    $("graph-out").className = "graph empty";
    emptyState($("graph-out"), "Graph", "Press Compile to see the AST graph.");
    $("graph-info").textContent = "";
    $("graph-note").hidden = true;
    emptyState($("symbols-out"), "Symbol table", "Press Compile to see every name, its type and where it is stored.");
    $("tac-out").className = "code tac empty"; $("tac-out").textContent = "Press Compile.";
    $("tac-opt-out").className = "code tac empty"; $("tac-opt-out").textContent = "Press Compile.";
    emptyState($("report-out"), "Optimization report", "Press Compile to see what the optimizer changed.");
    $("asm-diff").className = "code diff empty"; $("asm-diff").textContent = "Press Compile.";
    $("asm-status").hidden = true;
    $("asm-note").hidden = true;
    $("asm-out").className = "code asm empty"; $("asm-out").textContent = "Press Compile to generate NASM assembly.";
    $("asm-count").textContent = "";
    $("asm-explain").textContent = "Click an instruction to see what it does to registers and memory.";
    $("term-status").className = "chip"; $("term-status").textContent = "Not run";
    $("term-time").textContent = "";
    $("run-out").innerHTML = '<div class="term-empty">Press Run to build the program with NASM, link it with ld and execute it here.</div>';
    $("console-out").innerHTML = "";
    emptyState($("console-out"), "Console", "Compile errors, warnings and the phase log appear here.");
    $("err-count").hidden = true;
    $("stats").innerHTML = "";
    $("src-link").textContent = "";
    $("sample-info").textContent = "";
    $("mi-asm").disabled = true;
    setStatus("idle", "Idle");
    try { localStorage.removeItem("tc-draft"); } catch (_) { /* ignore */ }
    src.focus();
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyText(text, label) {
    if (!text) { toast("Nothing to copy yet.", "warn"); return; }
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (__) { /* nothing else to try */ }
      ta.remove();
    }
    toast(`${label} copied.`, "ok");
  }

  /* =====================================================================
     Menus, dialogs, command palette
     ===================================================================== */

  const moreBtn = $("btn-more"), moreMenu = $("more-menu");
  function setMore(open) {
    moreMenu.hidden = !open;
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  moreBtn.addEventListener("click", (ev) => { ev.stopPropagation(); setMore(moreMenu.hidden); });
  document.addEventListener("click", (ev) => { if (!moreMenu.hidden && !ev.target.closest(".more-wrap")) setMore(false); });

  $("btn-compile").addEventListener("click", compile);
  $("btn-run").addEventListener("click", runProgram);
  $("btn-run2").addEventListener("click", runProgram);
  $("btn-term-clear").addEventListener("click", () => {
    $("run-out").innerHTML = '<div class="term-empty">Terminal cleared. Press Run to execute the program again.</div>';
    $("term-status").className = "chip"; $("term-status").textContent = "Not run";
    $("term-time").textContent = "";
  });
  $("btn-copy-src").addEventListener("click", () => copyText(src.value, "Source"));
  $("btn-copy-asm").addEventListener("click", () => copyText(currentAsm(), "Assembly"));
  $("btn-clear-asm").addEventListener("click", () => { S.asmHidden = true; renderAsm(); });
  $("btn-palette").addEventListener("click", openPalette);

  $("mi-asm").addEventListener("click", () => {
    setMore(false);
    if (!S.last || !S.last.asm) { toast("Compile the program first to generate assembly.", "warn"); return; }
    download(S.asmMode === "opt" ? "program_optimized.asm" : "program.asm", currentAsm(), "text/plain");
  });
  $("mi-tl").addEventListener("click", () => { setMore(false); download("program.tl", src.value, "text/plain"); });
  $("mi-copy-src").addEventListener("click", () => { setMore(false); copyText(src.value, "Source"); });
  $("mi-clear").addEventListener("click", () => { setMore(false); clearAll(); });
  $("mi-help").addEventListener("click", () => { setMore(false); openDialog($("help-dialog")); });
  $("mi-about").addEventListener("click", () => { setMore(false); openDialog($("about-dialog")); });
  $("help-close").addEventListener("click", () => $("help-dialog").close());
  $("about-close").addEventListener("click", () => $("about-dialog").close());
  [$("help-dialog"), $("about-dialog")].forEach((d) =>
    d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); }));

  function openDialog(d) {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }

  /* Samples: from the examples folder, described in the header line */
  async function loadExamples() {
    try {
      const res = await fetch("/api/examples");
      const data = await res.json();
      S.examples = data.examples || [];
      const sel = $("sample");
      S.examples.forEach((ex) => {
        const o = document.createElement("option");
        o.value = ex.name;
        o.textContent = (SAMPLES[ex.name] || [ex.name])[0];
        sel.appendChild(o);
      });
    } catch (_) { /* samples are optional */ }
  }

  function loadSample(name) {
    const ex = S.examples.find((e) => e.name === name);
    if (!ex) return;
    src.value = ex.source;
    S.focusLine = 0;
    S.dirty = true;
    const info = SAMPLES[name] || [name, ""];
    $("sample-info").textContent = `${info[0]}: ${info[1]}`;
    onEdit();
    $("sample-info").textContent = `${info[0]}: ${info[1]}`;
    compile();
  }
  $("sample").addEventListener("change", (ev) => {
    const name = ev.target.value;
    if (name) loadSample(name);
    ev.target.selectedIndex = 0;
  });

  /* ---------- command palette (Ctrl+K) ---------- */

  const paletteDlg = $("palette"), paletteInput = $("palette-input"), paletteList = $("palette-list");
  let paletteAll = [], paletteShown = [], paletteIdx = 0;

  function paletteCommands() {
    const cmds = [
      { group: "Build", label: "Compile", hint: "Ctrl+Enter", run: compile },
      { group: "Build", label: "Run program", hint: "Ctrl+Shift+Enter", run: runProgram },
      { group: "Go", label: "Go to editor", run: () => src.focus() },
      { group: "Go", label: "Show the Console", run: () => showTab("console") },
      { group: "Go", label: "Show the Terminal", run: () => showTab("terminal") },
      { group: "Go", label: "Expand all AST nodes", run: () => { showTab("ast"); setAllOpen(true); } },
      { group: "Go", label: "Collapse all AST nodes", run: () => { showTab("ast"); setAllOpen(false); } },
      { group: "Go", label: "Replay the AST graph animation", run: () => { showTab("graph"); playGraph(); } },
      { group: "Assembly", label: "Show optimized assembly", run: () => $$(".seg-btn")[0].click() },
      { group: "Assembly", label: "Show unoptimized assembly", run: () => $$(".seg-btn")[1].click() },
      { group: "Assembly", label: "Copy assembly", run: () => copyText(currentAsm(), "Assembly") },
      { group: "File", label: "Copy source", run: () => copyText(src.value, "Source") },
      { group: "File", label: "Download .asm", run: () => $("mi-asm").click() },
      { group: "File", label: "Download .tl source", run: () => download("program.tl", src.value, "text/plain") },
      { group: "File", label: "Clear everything", run: clearAll },
      { group: "View", label: "Switch dark / light theme", hint: "Ctrl+Shift+L", run: toggleTheme },
      { group: "Help", label: "Keyboard shortcuts", run: () => openDialog($("help-dialog")) },
      { group: "Help", label: "About TraceCode Studio", run: () => openDialog($("about-dialog")) },
    ];
    cmds.push({ group: "Panels", label: "Show saved programs", hint: "Ctrl+B", run: () => setSide(true, "programs") });
    cmds.push({ group: "Panels", label: "Open settings", run: () => setSide(true, "settings") });
    Object.keys(TAB_LABEL).forEach((name) => {
      cmds.push({ group: "Tab", label: `Show ${TAB_LABEL[name]}`, run: () => showTab(name) });
    });
    S.examples.forEach((ex) => {
      cmds.push({ group: "Sample", label: `Load sample: ${(SAMPLES[ex.name] || [ex.name])[0]}`, run: () => loadSample(ex.name) });
    });
    return cmds;
  }

  function openPalette() {
    paletteAll = paletteCommands();
    paletteInput.value = "";
    renderPalette();
    openDialog(paletteDlg);
    paletteInput.focus();
  }

  function renderPalette() {
    const q = paletteInput.value.trim().toLowerCase();
    paletteShown = paletteAll.filter((c) => !q || (c.group + " " + c.label).toLowerCase().includes(q));
    paletteIdx = Math.min(paletteIdx, Math.max(0, paletteShown.length - 1));
    if (!paletteShown.length) {
      paletteList.innerHTML = '<li class="none" aria-disabled="true">No matching command</li>';
      return;
    }
    paletteList.innerHTML = paletteShown.map((c, i) =>
      `<li role="option" data-i="${i}" aria-selected="${i === paletteIdx}">` +
      `<span class="grp">${esc(c.group)}</span><span class="lbl">${esc(c.label)}</span>` +
      (c.hint ? `<span class="hk">${esc(c.hint)}</span>` : "") + `</li>`).join("");
    const sel = paletteList.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function runPaletteItem(i) {
    const cmd = paletteShown[i];
    if (!cmd) return;
    paletteDlg.close();
    cmd.run();
  }

  paletteInput.addEventListener("input", () => { paletteIdx = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); paletteIdx = (paletteIdx + 1) % Math.max(1, paletteShown.length); renderPalette(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); paletteIdx = (paletteIdx - 1 + paletteShown.length) % Math.max(1, paletteShown.length); renderPalette(); }
    else if (ev.key === "Enter") { ev.preventDefault(); runPaletteItem(paletteIdx); }
  });
  paletteList.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-i]");
    if (li) runPaletteItem(Number(li.dataset.i));
  });
  paletteDlg.addEventListener("click", (ev) => { if (ev.target === paletteDlg) paletteDlg.close(); });

  /* =====================================================================
     Keyboard shortcuts
     ===================================================================== */

  document.addEventListener("keydown", (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      if (paletteDlg.open) paletteDlg.close(); else openPalette();
    } else if (mod && ev.key === "Enter" && ev.shiftKey) {
      ev.preventDefault();
      runProgram();
    } else if (mod && ev.key === "Enter") {
      ev.preventDefault();
      compile();
    } else if (mod && ev.shiftKey && (ev.key === "L" || ev.key === "l")) {
      ev.preventDefault();
      toggleTheme();
    } else if (mod && (ev.key === "b" || ev.key === "B")) {
      ev.preventDefault();
      setSide(!sideOpen());
    } else if (ev.key === "Escape" && sideOpen() && !paletteDlg.open) {
      setSide(false);
    } else if (ev.key === "Escape" && !moreMenu.hidden) {
      setMore(false);
    }
  });

  /* =====================================================================
     Resizable split between editor and output
     ===================================================================== */

  const workbench = $("workbench"), splitter = $("splitter");
  const SPLIT_MIN = 30, SPLIT_MAX = 70, SPLIT_DEFAULT = 46;

  function applySplit(pct) {
    const v = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
    workbench.style.setProperty("--split", v + "%");
    splitter.setAttribute("aria-valuenow", String(Math.round(v)));
    return v;
  }
  function saveSplit(v) { try { localStorage.setItem("tc-split", String(v)); } catch (_) { /* ignore */ } }

  splitter.addEventListener("pointerdown", (ev) => {
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add("dragging");
  });
  splitter.addEventListener("pointermove", (ev) => {
    if (!splitter.classList.contains("dragging")) return;
    const r = workbench.getBoundingClientRect();
    const cs = getComputedStyle(workbench);
    const inner = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 10;
    const x = ev.clientX - r.left - parseFloat(cs.paddingLeft);
    applySplit((x / inner) * 100);
  });
  function endDrag() {
    if (!splitter.classList.contains("dragging")) return;
    splitter.classList.remove("dragging");
    saveSplit(parseFloat(workbench.style.getPropertyValue("--split")) || SPLIT_DEFAULT);
  }
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);
  splitter.addEventListener("dblclick", () => { applySplit(SPLIT_DEFAULT); saveSplit(SPLIT_DEFAULT); });
  splitter.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      const cur = parseFloat(workbench.style.getPropertyValue("--split")) || SPLIT_DEFAULT;
      const v = applySplit(cur + (ev.key === "ArrowRight" ? 2 : -2));
      saveSplit(v);
    }
  });

  /* =====================================================================
     Left panel: saved programs (kept in this browser) and settings
     ===================================================================== */

  const PROG_KEY = "tc-programs";
  const MAX_PROGRAMS = 50;
  const MAX_PROGRAM_CHARS = 64 * 1024;
  const FONT_DEFAULT = 13.5;

  function sideOpen() { return $("side").classList.contains("open"); }

  function setSide(open, tab) {
    $("side").classList.toggle("open", open);
    $("side-scrim").hidden = !open || window.innerWidth > 920;
    $("btn-side").setAttribute("aria-expanded", open ? "true" : "false");
    if (open && tab) showSideTab(tab);
    if (open) setTimeout(() => (tab === "settings" ? $("set-font") : $("prog-name")).focus(), 60);
  }

  function showSideTab(name) {
    $$(".side-tab").forEach((t) => {
      const on = t.dataset.side === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("side-programs").hidden = name !== "programs";
    $("side-settings").hidden = name !== "settings";
    if (name === "programs") renderPrograms();
  }

  $("btn-side").addEventListener("click", () => setSide(!sideOpen()));
  $("side-close").addEventListener("click", () => setSide(false));
  $("side-scrim").addEventListener("click", () => setSide(false));
  $$(".side-tab").forEach((t) => t.addEventListener("click", () => showSideTab(t.dataset.side)));

  /* ---------- saved programs ---------- */

  function readPrograms() {
    try {
      const list = JSON.parse(localStorage.getItem(PROG_KEY) || "[]");
      return Array.isArray(list) ? list.filter((p) => p && typeof p.name === "string" && typeof p.source === "string") : [];
    } catch (_) { return []; }
  }

  function writePrograms(list) {
    try {
      localStorage.setItem(PROG_KEY, JSON.stringify(list));
      return true;
    } catch (_) {
      toast("Could not save: browser storage is full or blocked. Export the programs as files instead.", "err");
      return false;
    }
  }

  function cleanName(raw) {
    return String(raw || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  }

  function nextUntitled(list) {
    let n = 1;
    while (list.some((p) => p.name === "Untitled " + n)) n++;
    return "Untitled " + n;
  }

  function saveProgram(name, source) {
    const list = readPrograms();
    const clean = cleanName(name) || nextUntitled(list);
    if (!source.trim()) { toast("The editor is empty. Write a program first.", "warn"); return false; }
    if (source.length > MAX_PROGRAM_CHARS) { toast("Program is too large to save (64 KB limit).", "warn"); return false; }
    const existing = list.findIndex((p) => p.name === clean);
    const entry = { name: clean, source, updated: Date.now() };
    if (existing >= 0) list.splice(existing, 1);
    else if (list.length >= MAX_PROGRAMS) { toast(`You can keep up to ${MAX_PROGRAMS} programs. Delete one first.`, "warn"); return false; }
    list.unshift(entry);
    if (!writePrograms(list)) return false;
    toast(existing >= 0 ? `Updated "${clean}".` : `Saved "${clean}".`, "ok");
    renderPrograms();
    return true;
  }

  function openProgram(name) {
    const p = readPrograms().find((x) => x.name === name);
    if (!p) return;
    const current = src.value.trim();
    if (current && current !== p.source.trim() && !window.confirm(`Replace the editor content with "${p.name}"? Unsaved changes will be lost.`)) return;
    src.value = p.source;
    S.focusLine = 0;
    onEdit();
    $("sample-info").textContent = `Saved program: ${p.name}`;
    compile();
    setSide(false);
  }

  function deleteProgram(name) {
    if (!window.confirm(`Delete the saved program "${name}"? This cannot be undone.`)) return;
    writePrograms(readPrograms().filter((p) => p.name !== name));
    toast(`Deleted "${name}".`, "ok");
    renderPrograms();
  }

  function exportProgram(name) {
    const p = readPrograms().find((x) => x.name === name);
    if (p) download(name.replace(/[^A-Za-z0-9 _.-]/g, "_") + ".tl", p.source, "text/plain");
  }

  function renderPrograms() {
    const list = readPrograms().sort((a, b) => b.updated - a.updated);
    const ul = $("prog-list");
    $("prog-count").textContent = list.length ? `${list.length} saved` : "";
    if (!list.length) {
      ul.innerHTML = '<li class="empty-side">No saved programs yet. Type a name above and press Save to keep the program in the editor.</li>';
      return;
    }
    ul.innerHTML = list.map((p) => {
      const lines = p.source.split("\n").filter((l) => l.trim()).length;
      const when = new Date(p.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      const isCurrent = src.value === p.source;
      return `<li class="prog-item ${isCurrent ? "current" : ""}" data-name="${esc(p.name)}">` +
        `<div class="prog-name" title="${esc(p.name)}">${esc(p.name)}</div>` +
        `<div class="prog-meta">${plural(lines, "line")} · ${esc(when)}${isCurrent ? " · open now" : ""}</div>` +
        `<div class="prog-actions">` +
        `<button class="btn btn-mini" data-act="open">Open</button>` +
        `<button class="btn btn-mini btn-ghost" data-act="export">Export .tl</button>` +
        `<button class="btn btn-mini btn-ghost" data-act="delete">Delete</button>` +
        `</div></li>`;
    }).join("");
  }

  $("prog-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const name = btn.closest(".prog-item").dataset.name;
    const act = btn.dataset.act;
    if (act === "open") openProgram(name);
    else if (act === "export") exportProgram(name);
    else if (act === "delete") deleteProgram(name);
  });

  $("prog-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (saveProgram($("prog-name").value, src.value)) $("prog-name").value = "";
  });

  $("prog-import").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (file.size > MAX_PROGRAM_CHARS) { toast("That file is too large (64 KB limit).", "warn"); return; }
    try {
      const text = await file.text();
      saveProgram(file.name.replace(/\.tl$/i, ""), text);
    } catch (_) {
      toast("Could not read that file.", "err");
    }
  });

  /* ---------- settings ---------- */

  function applyFont(px) {
    const v = Math.min(18, Math.max(12, Number(px) || FONT_DEFAULT));
    document.documentElement.style.setProperty("--code-size", v + "px");
    $("set-font").value = String(v);
    $("set-font-val").textContent = v + " px";
    return v;
  }

  function readFont() {
    try { return parseFloat(localStorage.getItem("tc-font-size")) || FONT_DEFAULT; } catch (_) { return FONT_DEFAULT; }
  }

  $("set-font").addEventListener("input", (ev) => {
    const v = applyFont(ev.target.value);
    try { localStorage.setItem("tc-font-size", String(v)); } catch (_) { /* ignore */ }
  });
  $("set-reset").addEventListener("click", () => {
    try {
      localStorage.setItem("tc-font-size", String(FONT_DEFAULT));
    } catch (_) { /* ignore */ }
    applyFont(FONT_DEFAULT);
    toast("Settings restored to defaults.", "ok");
  });

  /* Ctrl+S saves the program: under the name typed in the panel, or a default name */
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      if (saveProgram($("prog-name").value, src.value)) $("prog-name").value = "";
    }
  });

  /* =====================================================================
     Start
     ===================================================================== */

  let savedTheme = null, savedSplit = null, draft = null;
  try {
    savedTheme = localStorage.getItem("tc-theme");
    savedSplit = parseFloat(localStorage.getItem("tc-split"));
    draft = localStorage.getItem("tc-draft");
  } catch (_) { /* ignore */ }
  applyTheme(savedTheme === "light" ? "light" : "dark");
  applySplit(Number.isFinite(savedSplit) ? savedSplit : SPLIT_DEFAULT);

  applyFont(readFont());
  renderPrograms();
  renderFlow();
  renderPipelineShell("idle");
  src.value = draft && draft.trim() ? draft : DEFAULT_SOURCE;
  renderStats();
  S.dirty = true;
  renderGutter();
  updateCursor();
  emptyState($("tokens-out"), "Tokens", "Press Compile to see the tokens the lexer produced.");
  emptyState($("ast-tree"), "AST", "Press Compile to see the abstract syntax tree.");
  emptyState($("symbols-out"), "Symbol table", "Press Compile to see every name, its type and where it is stored.");
  emptyState($("report-out"), "Optimization report", "Press Compile to see what the optimizer changed.");
  emptyState($("graph-out"), "Graph", "Press Compile to see the AST graph.");
  emptyState($("console-out"), "Console", "Compile errors, warnings and the phase log appear here.");
  loadExamples();
})();

/* Ambient background: a few drifting particles that link when they pass close together.
   Subtle on purpose. Reduced motion draws a single still frame. */
(() => {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LINK = 140;
  let w = 0, h = 0, pts = [];

  function palette() {
    return document.documentElement.getAttribute("data-theme") === "light"
      ? ["109,40,217", "162,28,175", "14,116,144"]
      : ["196,181,253", "216,180,254", "103,232,249"];
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(60, Math.max(18, Math.round((w * h) / 22000)));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      r: 0.9 + Math.random() * 1.3, c: Math.floor(Math.random() * 3),
    }));
  }

  function draw() {
    const cols = palette();
    ctx.clearRect(0, 0, w, h);
    if (!reduce) {
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = w + 20; else if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20; else if (p.y > h + 20) p.y = -20;
      }
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < LINK) {
          ctx.strokeStyle = `rgba(${cols[a.c]}, ${((1 - d / LINK) * 0.22).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const p of pts) {
      ctx.fillStyle = `rgba(${cols[p.c]}, 0.6)`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduce) requestAnimationFrame(draw);
  }

  resize();
  draw();
  window.addEventListener("resize", () => { resize(); if (reduce) draw(); });
  new MutationObserver(() => { if (reduce) draw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
