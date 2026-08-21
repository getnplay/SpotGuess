/* =====================================================
   SpotGuess — game logic
   Plain JS, no frameworks, no backend, no external APIs.
   ===================================================== */

(function () {
  "use strict";

  /* ---------------- Config ---------------- */
  const GRID = 10; // 10x10 = 100 cells -> 1 cell = 1%
  const STAGES = [
    { percent: 10, points: 1000 },
    { percent: 25, points: 750 },
    { percent: 50, points: 500 },
    { percent: 75, points: 250 },
  ];
  const QUESTIONS_PER_GAME = 10;
  const DIFFICULTY_TIMER = { all: 15, easy: 20, medium: 15, hard: 10 };
  const TILE_COLOR_VAR = "--tile-hidden";
  const TICK_COLOR_VAR = "--tile-hidden-tick";
  const STORAGE_KEYS = {
    dark: "spotguess-dark",
    bestStreak: "spotguess-best-streak",
    dailyPrefix: "spotguess-daily-",
  };

  /* ---------------- State ---------------- */
  const state = {
    data: null,           // parsed questions.json
    mode: "flags",
    difficulty: "all",
    isDaily: false,
    timerLimit: 15,
    round: 0,             // 0-indexed
    questions: [],         // array of question objects for this game
    score: 0,
    streak: 0,
    bestStreakThisGame: 0,
    results: [],           // per-round result: {points, correct, stagePercent}
    stageIndex: 0,
    revealOrder: [],       // shuffled cell indices for current question
    revealedCount: 0,
    timeLeft: 15,
    timerHandle: null,
    answered: false,
    imgCanvas: null,       // offscreen canvas with the drawn source image
    imgReady: false,
  };

  /* ---------------- DOM refs ---------------- */
  const $ = (id) => document.getElementById(id);
  const screens = {
    start: $("screen-start"),
    game: $("screen-game"),
    final: $("screen-final"),
  };

  const el = {
    darkToggle: $("darkModeToggle"),
    modeGroup: $("modeGroup"),
    difficultyGroup: $("difficultyGroup"),
    timerPreview: $("timerPreview"),
    bestStreakPreview: $("bestStreakPreview"),
    startBtn: $("startBtn"),
    dailyBtn: $("dailyBtn"),
    dailyStatus: $("dailyStatus"),

    hudRound: $("hudRound"),
    hudScore: $("hudScore"),
    hudStreak: $("hudStreak"),
    hudMode: $("hudMode"),
    timerBar: $("timerBar"),
    canvas: $("revealCanvas"),
    stamp: $("stamp"),
    revealPercentLabel: $("revealPercentLabel"),
    revealPointsLabel: $("revealPointsLabel"),
    answerForm: $("answerForm"),
    answerInput: $("answerInput"),
    feedbackLine: $("feedbackLine"),
    nextRow: $("nextRow"),
    revealedAnswer: $("revealedAnswer"),
    nextBtn: $("nextBtn"),

    finalHeadline: $("finalHeadline"),
    finalScore: $("finalScore"),
    finalStreak: $("finalStreak"),
    finalSolved: $("finalSolved"),
    finalAvgReveal: $("finalAvgReveal"),
    shareGrid: $("shareGrid"),
    shareBtn: $("shareBtn"),
    playAgainBtn: $("playAgainBtn"),
    copyToast: $("copyToast"),
  };

  const ctx = el.canvas.getContext("2d");

  /* ---------------- Utilities ---------------- */
  function normalize(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isAnswerCorrect(question, guess) {
    const g = normalize(guess);
    if (!g) return false;
    const candidates = [question.answer, ...(question.aliases || [])].map(normalize);
    return candidates.includes(g);
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    const random = rng || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Deterministic RNG (mulberry32) for the daily challenge seed.
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedFromString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  /* ---------------- Dark mode ---------------- */
  function initDarkMode() {
    const saved = localStorage.getItem(STORAGE_KEYS.dark);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const on = saved !== null ? saved === "1" : prefersDark;
    document.body.classList.toggle("dark", on);
    el.darkToggle.querySelector(".iconbtn__glyph").textContent = on ? "☀" : "☾";
  }
  el.darkToggle.addEventListener("click", () => {
    const on = document.body.classList.toggle("dark");
    localStorage.setItem(STORAGE_KEYS.dark, on ? "1" : "0");
    el.darkToggle.querySelector(".iconbtn__glyph").textContent = on ? "☀" : "☾";
    if (state.imgReady) redrawCanvas(); // repaint tile color for new theme
  });

  /* ---------------- Data loading ---------------- */
  async function loadData() {
    const res = await fetch("questions.json");
    if (!res.ok) throw new Error("Failed to load questions.json");
    return res.json();
  }

  /* ---------------- Start screen interactions ---------------- */
  function wireChipGroup(group, attr, onPick) {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      [...group.children].forEach((c) => c.classList.remove("is-active"));
      btn.classList.add("is-active");
      onPick(btn.dataset[attr]);
    });
  }

  wireChipGroup(el.modeGroup, "mode", (mode) => { state.mode = mode; });
  wireChipGroup(el.difficultyGroup, "difficulty", (diff) => {
    state.difficulty = diff;
    el.timerPreview.textContent = `${DIFFICULTY_TIMER[diff]}s`;
  });

  function refreshStartScreenStats() {
    const best = parseInt(localStorage.getItem(STORAGE_KEYS.bestStreak) || "0", 10);
    el.bestStreakPreview.textContent = String(best);
    const key = STORAGE_KEYS.dailyPrefix + todayKey();
    const played = localStorage.getItem(key);
    if (played) {
      const info = JSON.parse(played);
      el.dailyStatus.textContent = `✓ ${info.score} pts today`;
    } else {
      el.dailyStatus.textContent = "";
    }
  }

  el.startBtn.addEventListener("click", () => startGame({ daily: false }));
  el.dailyBtn.addEventListener("click", () => startGame({ daily: true }));

  /* ---------------- Building the question pool ---------------- */
  function buildPool(mode, difficulty) {
    const items = state.data.categories[mode].items;
    if (difficulty === "all") return items;
    const filtered = items.filter((q) => q.difficulty === difficulty);
    if (filtered.length >= QUESTIONS_PER_GAME) return filtered;
    // Not enough at this difficulty — top up with the rest of the category.
    const rest = items.filter((q) => q.difficulty !== difficulty);
    return filtered.concat(rest);
  }

  function buildDailyPool() {
    const all = [];
    Object.values(state.data.categories).forEach((cat) => all.push(...cat.items));
    return all;
  }

  function pickQuestions({ daily }) {
    if (daily) {
      const rng = mulberry32(seedFromString("spotguess-" + todayKey()));
      const pool = buildDailyPool();
      return shuffle(pool, rng).slice(0, QUESTIONS_PER_GAME);
    }
    const pool = buildPool(state.mode, state.difficulty);
    return shuffle(pool).slice(0, QUESTIONS_PER_GAME);
  }

  /* ---------------- Game lifecycle ---------------- */
  function startGame({ daily }) {
    state.isDaily = daily;
    state.questions = pickQuestions({ daily });
    state.round = 0;
    state.score = 0;
    state.streak = 0;
    state.bestStreakThisGame = 0;
    state.results = [];
    state.timerLimit = daily ? 15 : DIFFICULTY_TIMER[state.difficulty];

    showScreen("game");
    el.hudMode.textContent = daily ? "Daily mix" : state.data.categories[state.mode].label;
    loadRound();
  }

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add("screen--hidden"));
    screens[name].classList.remove("screen--hidden");
  }

  function currentQuestion() {
    return state.questions[state.round];
  }

  function loadRound() {
    state.stageIndex = 0;
    state.answered = false;
    state.imgReady = false;
    el.answerInput.value = "";
    el.answerInput.disabled = false;
    el.feedbackLine.textContent = "";
    el.feedbackLine.className = "answerbar__feedback";
    el.nextRow.classList.remove("is-visible");
    el.stamp.className = "stamp";
    el.stamp.textContent = "";
    el.answerForm.querySelector("button[type=submit]").disabled = false;

    el.hudRound.textContent = `${state.round + 1} / ${state.questions.length}`;
    el.hudScore.textContent = String(state.score);
    el.hudStreak.textContent = `${state.streak}🔥`;

    const q = currentQuestion();
    const catLabel = state.isDaily
      ? (state.data.categories[q.id.split("-")[0] === "flags" ? "flags" : findCategoryOf(q)].label)
      : state.data.categories[state.mode].label;
    el.hudMode.textContent = state.isDaily ? `Daily · ${catLabel}` : catLabel;

    // build a fresh shuffled reveal order for the grid
    const totalCells = GRID * GRID;
    const order = [];
    for (let i = 0; i < totalCells; i++) order.push(i);
    state.revealOrder = shuffle(order);

    setStage(0);
    prepareImage(q.image);
    startTimer();
  }

  function findCategoryOf(question) {
    const entries = Object.entries(state.data.categories);
    for (const [key, cat] of entries) {
      if (cat.items.some((it) => it.id === question.id)) return key;
    }
    return "flags";
  }

  /* ---------------- Image drawing / reveal ---------------- */
  function prepareImage(src) {
    const img = new Image();
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = el.canvas.width;
      off.height = el.canvas.height;
      const octx = off.getContext("2d");
      const cw = off.width, ch = off.height;
      const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      octx.drawImage(img, dx, dy, dw, dh);
      state.imgCanvas = off;
      state.imgReady = true;
      redrawCanvas();
    };
    img.onerror = () => {
      // Fallback: draw a placeholder pattern so the game never hard-fails.
      const off = document.createElement("canvas");
      off.width = el.canvas.width; off.height = el.canvas.height;
      const octx = off.getContext("2d");
      octx.fillStyle = "#555";
      octx.fillRect(0, 0, off.width, off.height);
      octx.fillStyle = "#fff";
      octx.font = "20px monospace";
      octx.textAlign = "center";
      octx.fillText("image missing", off.width / 2, off.height / 2);
      state.imgCanvas = off;
      state.imgReady = true;
      redrawCanvas();
    };
    img.src = src;
  }

  function cellCountForPercent(pct) {
    return Math.round((pct / 100) * GRID * GRID);
  }

  function redrawCanvas() {
    const w = el.canvas.width, h = el.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!state.imgReady) return;

    ctx.drawImage(state.imgCanvas, 0, 0);

    const revealedSet = new Set(state.revealOrder.slice(0, state.revealedCount));
    const cw = w / GRID, ch = h / GRID;
    const tileColor = cssVar(TILE_COLOR_VAR) || "#222";
    const tickColor = cssVar(TICK_COLOR_VAR) || "rgba(255,255,255,0.15)";

    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const idx = row * GRID + col;
        if (revealedSet.has(idx)) continue;
        const x = col * cw, y = row * ch;
        ctx.fillStyle = tileColor;
        ctx.fillRect(x, y, cw, ch);
        // subtle redaction ticks
        ctx.strokeStyle = tickColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 4, y + ch - 4);
        ctx.lineTo(x + cw - 4, y + 4);
        ctx.stroke();
      }
    }
  }

  function setStage(index) {
    state.stageIndex = index;
    const stage = STAGES[index];
    state.revealedCount = cellCountForPercent(stage.percent);
    el.revealPercentLabel.textContent = `${stage.percent}% VISIBLE`;
    el.revealPointsLabel.textContent = `${stage.points} PTS`;
    if (state.imgReady) redrawCanvas();
  }

  function revealFull() {
    state.revealedCount = GRID * GRID;
    el.revealPercentLabel.textContent = `100% VISIBLE`;
    if (state.imgReady) redrawCanvas();
  }

  /* ---------------- Timer ---------------- */
  function startTimer() {
    clearInterval(state.timerHandle);
    state.timeLeft = state.timerLimit;
    updateTimerBar();
    state.timerHandle = setInterval(() => {
      state.timeLeft -= 1;
      updateTimerBar();
      if (state.timeLeft <= 0) {
        clearInterval(state.timerHandle);
        handleTimeout();
      }
    }, 1000);
  }

  function updateTimerBar() {
    const pct = Math.max(0, (state.timeLeft / state.timerLimit) * 100);
    el.timerBar.style.width = pct + "%";
    el.timerBar.classList.toggle("is-urgent", state.timeLeft <= Math.ceil(state.timerLimit * 0.3));
  }

  function stopTimer() {
    clearInterval(state.timerHandle);
  }

  /* ---------------- Answer handling ---------------- */
  el.answerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.answered) return;
    submitGuess(el.answerInput.value);
  });

  function submitGuess(guess) {
    const q = currentQuestion();
    if (isAnswerCorrect(q, guess)) {
      handleCorrect();
    } else {
      handleWrong();
    }
  }

  function handleTimeout() {
    if (state.answered) return;
    flashFeedback("⏱ Time's up.", "is-wrong");
    handleWrong();
  }

  function flashFeedback(text, cls) {
    el.feedbackLine.textContent = text;
    el.feedbackLine.className = "answerbar__feedback " + (cls || "");
  }

  function showStamp(text, cls) {
    el.stamp.textContent = text;
    el.stamp.className = "stamp is-visible " + cls;
  }

  function handleCorrect() {
    stopTimer();
    state.answered = true;
    const stage = STAGES[state.stageIndex];
    state.score += stage.points;
    state.streak += 1;
    state.bestStreakThisGame = Math.max(state.bestStreakThisGame, state.streak);
    state.results.push({ points: stage.points, correct: true, stagePercent: stage.percent });

    revealFull();
    showStamp("CONFIRMED", "is-correct");
    flashFeedback(`Correct! +${stage.points} points`, "is-correct");
    finishRoundUI(true);
  }

  function handleWrong() {
    const q = currentQuestion();
    if (state.stageIndex < STAGES.length - 1) {
      // reveal more, try again
      state.stageIndex += 1;
      setStage(state.stageIndex);
      el.answerInput.value = "";
      el.answerInput.focus();
      flashFeedback(`Not quite. Revealing ${STAGES[state.stageIndex].percent}%…`, "is-wrong");
      startTimer();
      return;
    }
    // final stage failed
    stopTimer();
    state.answered = true;
    state.streak = 0;
    state.results.push({ points: 0, correct: false, stagePercent: 100 });
    revealFull();
    showStamp("REDACTED", "is-wrong");
    flashFeedback(`Out of guesses. It was: ${q.answer}`, "is-wrong");
    finishRoundUI(false);
  }

  function finishRoundUI(correct) {
    el.answerInput.disabled = true;
    el.answerForm.querySelector("button[type=submit]").disabled = true;
    el.hudScore.textContent = String(state.score);
    el.hudStreak.textContent = `${state.streak}🔥`;
    const q = currentQuestion();
    el.revealedAnswer.innerHTML = correct
      ? `Locked in: <strong>${escapeHtml(q.answer)}</strong>`
      : `Correct answer: <strong>${escapeHtml(q.answer)}</strong>`;
    el.nextRow.classList.add("is-visible");
    if (state.round === state.questions.length - 1) {
      el.nextBtn.textContent = "See final results →";
    } else {
      el.nextBtn.textContent = "Next round →";
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  el.nextBtn.addEventListener("click", () => {
    state.round += 1;
    if (state.round >= state.questions.length) {
      endGame();
    } else {
      loadRound();
    }
  });

  /* ---------------- End of game ---------------- */
  function endGame() {
    stopTimer();
    const best = parseInt(localStorage.getItem(STORAGE_KEYS.bestStreak) || "0", 10);
    const newBest = Math.max(best, state.bestStreakThisGame);
    localStorage.setItem(STORAGE_KEYS.bestStreak, String(newBest));

    if (state.isDaily) {
      localStorage.setItem(
        STORAGE_KEYS.dailyPrefix + todayKey(),
        JSON.stringify({ score: state.score, ts: Date.now() })
      );
    }

    const solved = state.results.filter((r) => r.correct).length;
    const avgRevealSolved = solved
      ? Math.round(
          state.results.filter((r) => r.correct).reduce((s, r) => s + r.stagePercent, 0) / solved
        )
      : null;

    el.finalHeadline.textContent =
      solved === state.questions.length ? "Full clearance." :
      solved === 0 ? "File remains open." : "File closed.";
    el.finalScore.textContent = String(state.score);
    el.finalStreak.textContent = String(state.bestStreakThisGame);
    el.finalSolved.textContent = `${solved} / ${state.questions.length}`;
    el.finalAvgReveal.textContent = avgRevealSolved ? `${avgRevealSolved}%` : "–";

    el.shareGrid.textContent = buildShareEmojiRow(state.results);
    el.copyToast.classList.remove("is-visible");

    showScreen("final");
    refreshStartScreenStats();
  }

  function tierEmoji(result) {
    if (!result.correct) return "⬛";
    if (result.stagePercent === 10) return "🟩";
    if (result.stagePercent === 25) return "🟨";
    if (result.stagePercent === 50) return "🟧";
    return "🟥"; // 75%
  }

  function buildShareEmojiRow(results) {
    return results.map(tierEmoji).join(" ");
  }

  function buildShareText() {
    const title = state.isDaily ? `SpotGuess Daily ${todayKey()}` : `SpotGuess — ${state.data.categories[state.mode].label}`;
    const grid = buildShareEmojiRow(state.results);
    const solved = state.results.filter((r) => r.correct).length;
    return `${title}\n${grid}\nScore: ${state.score} · Solved ${solved}/${state.questions.length} · Best streak ${state.bestStreakThisGame}`;
  }

  el.shareBtn.addEventListener("click", async () => {
    const text = buildShareText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Fallback for browsers without clipboard API access
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* no-op */ }
      document.body.removeChild(ta);
    }
    el.copyToast.classList.add("is-visible");
    setTimeout(() => el.copyToast.classList.remove("is-visible"), 2200);
  });

  el.playAgainBtn.addEventListener("click", () => {
    showScreen("start");
    refreshStartScreenStats();
  });

  /* ---------------- Boot ---------------- */
  async function boot() {
    initDarkMode();
    el.timerPreview.textContent = `${DIFFICULTY_TIMER[state.difficulty]}s`;
    try {
      state.data = await loadData();
    } catch (err) {
      document.querySelector(".dossier__lede").textContent =
        "Could not load questions.json. If you opened this file directly, serve the folder with a local web server (e.g. `python3 -m http.server`) and reload.";
      el.startBtn.disabled = true;
      el.dailyBtn.disabled = true;
      console.error(err);
      return;
    }
    refreshStartScreenStats();
  }

  boot();
})();
