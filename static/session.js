// ── Load data from sessionStorage ─────────────────────────────────────────────
const block       = JSON.parse(sessionStorage.getItem("activeBlock")  || "null");
const currentPlan = JSON.parse(sessionStorage.getItem("currentPlan") || "null");

// ── App state ──────────────────────────────────────────────────────────────────
let appState      = "idle";  // idle | listening | processing | speaking
let conversation  = [];
let selectedEnergy = 3;
let selectedLoad   = 3;

const ENERGY_LABELS = { 1: "Drained",  2: "Low",      3: "Neutral",  4: "Good",  5: "Energized" };
const LOAD_LABELS   = { 1: "Very easy", 2: "Light",    3: "Moderate", 4: "Heavy", 5: "Exhausting" };

// ── Timer state ────────────────────────────────────────────────────────────────
let timerTotal              = 0;
let timerRemaining          = 0;
let timerRunning            = false;
let timerExpired            = false;
let timerInterval           = null;
let timerAutoStarted        = false;
let timerStartedAt          = null;   // wall-clock Date.now() when timer last started
let sessionTimeSpentMinutes = null;
let awaitingSessionEndReply = false;  // true after timer ends, coach asked "what did you do?"
let hadTimerEndConvo        = false;  // true after user replied to the session-end question

// ── Speech recognition ─────────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const hasSpeech = !!SpeechRecognition;
let recognition = null;

if (hasSpeech) {
  recognition = new SpeechRecognition();
  recognition.continuous     = false;
  recognition.interimResults = false;
  recognition.lang           = "en-US";

  recognition.onresult = (e) => {
    const t = e.results[0][0].transcript.trim();
    if (t) sendUserMessage(t);
  };

  recognition.onerror = (e) => {
    if (e.error !== "no-speech") setStateLabel("Mic error: " + e.error, "");
    setState("idle");
  };

  recognition.onend = () => {
    if (appState === "listening") setState("idle");
  };
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setState(s) {
  appState = s;
  // Mic is always enabled except while processing (API call in flight)
  $("mic-btn").disabled      = s === "processing";
  $("text-input").disabled   = s === "processing" || s === "speaking";
  $("send-btn").disabled     = s === "processing" || s === "speaking";
  $("complete-btn").disabled = s === "processing" || s === "speaking";

  const bar = $("state-bar");
  bar.className = "state-bar " + (s === "listening" ? "listening" : s === "speaking" ? "speaking" : "");

  const waveform = $("waveform");
  const label    = $("state-label");

  if (s === "listening") {
    $("mic-btn").classList.add("listening");
    $("mic-btn").textContent = "■";
    waveform.classList.remove("active");
    label.textContent = "Listening…";
  } else {
    $("mic-btn").classList.remove("listening");
    $("mic-btn").textContent = "🎙️";
    if (s === "speaking") {
      waveform.classList.add("active");
      label.textContent = "";
    } else {
      waveform.classList.remove("active");
      label.textContent = s === "processing" ? "Thinking…" : "";
    }
  }
}

function setStateLabel(text, cls) {
  $("state-bar").className = "state-bar " + (cls || "");
  $("waveform").classList.remove("active");
  $("state-label").textContent = text;
}

// ── Transcript ─────────────────────────────────────────────────────────────────
let typingEl = null;

function addMessage(role, text) {
  removeTyping();
  const wrap  = document.createElement("div");
  wrap.className = "msg " + (role === "assistant" ? "msg-ai" : "msg-user");

  const label = document.createElement("div");
  label.className   = "msg-label";
  label.textContent = role === "assistant" ? "Coach" : "You";

  const body = document.createElement("div");
  body.textContent = text;

  wrap.appendChild(label);
  wrap.appendChild(body);
  $("transcript").appendChild(wrap);
  scrollBottom();
  saveState();
}

function showTyping() {
  removeTyping();
  typingEl = document.createElement("div");
  typingEl.className = "typing-indicator";
  typingEl.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  $("transcript").appendChild(typingEl);
  scrollBottom();
}

function removeTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function scrollBottom() {
  const t = $("transcript");
  t.scrollTop = t.scrollHeight;
}

function restoreTranscript() {
  const el = $("transcript");
  el.innerHTML = "";
  conversation.forEach(msg => {
    const wrap  = document.createElement("div");
    wrap.className = "msg " + (msg.role === "assistant" ? "msg-ai" : "msg-user");

    const label = document.createElement("div");
    label.className   = "msg-label";
    label.textContent = msg.role === "assistant" ? "Coach" : "You";

    const body = document.createElement("div");
    body.textContent = msg.content;

    wrap.appendChild(label);
    wrap.appendChild(body);
    el.appendChild(wrap);
  });
  scrollBottom();
}

// ── Audio ──────────────────────────────────────────────────────────────────────
let currentAudio        = null;
let currentAudioResolve = null;

function playAudio(base64) {
  if (!base64) return Promise.resolve();
  return new Promise((resolve) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob  = new Blob([bytes], { type: "audio/mpeg" });
    const url   = URL.createObjectURL(blob);
    currentAudio        = new Audio(url);
    currentAudioResolve = resolve;
    currentAudio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null; currentAudioResolve = null;
      resolve();
    };
    currentAudio.onerror = () => {
      currentAudio = null; currentAudioResolve = null;
      resolve();
    };
    currentAudio.play().catch(() => {
      currentAudio = null; currentAudioResolve = null;
      resolve();
    });
  });
}

// Stop ongoing audio and resolve the pending promise so callers continue
function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (currentAudioResolve) { currentAudioResolve(); currentAudioResolve = null; }
}

// ── API calls ──────────────────────────────────────────────────────────────────
async function fetchGreeting() {
  const res = await fetch("/api/voice/greet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ block }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Greet failed");
  return res.json();
}

async function fetchRespond(userText, isSessionEndReply = false) {
  // Goals message = first user message, before timer has auto-started
  const isGoalsMessage = !timerAutoStarted && !isSessionEndReply;
  // Mid-session = timer running, not the first message, not end-reply
  const isMidSession   = timerAutoStarted && timerRunning && !isSessionEndReply;
  const res = await fetch("/api/voice/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation,
      user_text: userText,
      block,
      is_session_end_reply: isSessionEndReply,
      is_goals_message: isGoalsMessage,
      is_mid_session: isMidSession,
    }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Respond failed");
  return res.json();
}

async function fetchSummarize() {
  const res = await fetch("/api/voice/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, block }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Summarize failed");
  return res.json();
}

async function fetchSessionEnd(timeSpentMins) {
  const res = await fetch("/api/voice/session_end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, block, time_spent_minutes: timeSpentMins }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Session end failed");
  return res.json();
}

async function fetchInitiation() {
  const res = await fetch("/api/voice/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ block }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Initiation failed");
  return res.json();
}

async function fetchInitiationEnd() {
  const res = await fetch("/api/voice/initiate_end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, block }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Initiation end failed");
  return res.json();
}

async function fetchReplan(summary) {
  // Include previous sessions' history (current session is passed explicitly below)
  const dayLog = JSON.parse(sessionStorage.getItem("dayLog") || "[]");
  const res = await fetch("/replan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_plan:       currentPlan,
      completed_block_id: block.id,
      goals_done:         summary.goals_done   || [],
      goals_missed:       summary.goals_missed || [],
      energy:             selectedEnergy,
      cognitive_load:     selectedLoad,
      notes:              summary.notes        || "",
      current_time:       nowHHMM(),
      day_log:            dayLog,
    }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Replan failed");
  return res.json();
}

function saveToDayLog(summary) {
  const entry = {
    block_title:  block.title,
    block_start:  block.start,
    block_end:    block.end,
    time_spent:   sessionTimeSpentMinutes,
    energy:       selectedEnergy,
    load:         selectedLoad,
    goals_done:   summary?.goals_done   || [],
    goals_missed: summary?.goals_missed || [],
    notes:        summary?.notes        || "",
  };
  const dayLog = JSON.parse(sessionStorage.getItem("dayLog") || "[]");
  dayLog.push(entry);
  sessionStorage.setItem("dayLog", JSON.stringify(dayLog));
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

// ── Time helpers ───────────────────────────────────────────────────────────────
function timeToMins(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minsToTime(mins) {
  const clamped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(clamped / 60)).padStart(2,"0")}:${String(clamped % 60).padStart(2,"0")}`;
}

function addMinsToTime(t, delta) {
  return minsToTime(timeToMins(t) + delta);
}

// ── Timer ──────────────────────────────────────────────────────────────────────
function initTimer() {
  const [sh, sm] = block.start.split(":").map(Number);
  const [eh, em] = block.end.split(":").map(Number);
  timerTotal     = Math.max((eh * 60 + em) - (sh * 60 + sm), 0) * 60;
  timerRemaining = timerTotal;
  renderTimerDisplay();
  updateTimerBtns();
}

function startTimer() {
  if (timerRunning || timerRemaining <= 0) return;
  timerRunning   = true;
  timerStartedAt = Date.now();
  updateTimerBtns();
  $("timer-display").classList.add("running");
  $("timer-display").classList.remove("done");

  timerInterval = setInterval(() => {
    timerRemaining = Math.max(timerRemaining - 1, 0);
    renderTimerDisplay();
    saveState();
    if (timerRemaining <= 0) {
      clearInterval(timerInterval);
      timerRunning = false;
      timerExpired = true;
      updateTimerBtns();
      $("timer-display").classList.remove("running");
      $("timer-display").classList.add("done");
      onTimerEnd();
    }
  }, 1000);
}

function endTimer() {
  // User manually clicked "End" — compute exact time spent from wall clock
  if (!timerRunning) return;
  const timeSpentMins = timerStartedAt
    ? Math.max(Math.round((Date.now() - timerStartedAt) / 60000), 0)
    : Math.max(Math.round((timerTotal - timerRemaining) / 60), 0);
  clearInterval(timerInterval);
  timerRunning = false;
  timerExpired = true;
  $("timer-display").classList.remove("running");
  $("timer-display").classList.add("done");
  updateTimerBtns();
  saveState();
  onTimerEnd(timeSpentMins);
}

function resetTimer() {
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
    $("timer-display").classList.remove("running");
  }
  timerRemaining   = timerTotal;
  timerExpired     = false;
  timerAutoStarted = false;
  timerStartedAt   = null;
  $("timer-display").classList.remove("done", "running");
  renderTimerDisplay();
  updateTimerBtns();
  saveState();
}

function renderTimerDisplay() {
  const m = Math.floor(timerRemaining / 60);
  const s = timerRemaining % 60;
  $("timer-display").textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function updateTimerBtns() {
  $("start-timer-btn").disabled = timerRunning || timerExpired;
  $("stop-timer-btn").disabled  = !timerRunning;
}

// Called when timer reaches zero (naturally) or endTimer() fires
async function onTimerEnd(timeSpentMins) {
  // Use passed value, or wall-clock elapsed, or fall back to scheduled duration
  const spent = timeSpentMins ?? (
    timerStartedAt
      ? Math.max(Math.round((Date.now() - timerStartedAt) / 60000), 0)
      : Math.round(timerTotal / 60)
  );
  sessionTimeSpentMinutes = spent;
  saveState();

  if (spent === 0) return;  // No time spent at all — skip voice check-in

  setState("processing");
  showTyping();
  try {
    const { text, audio } = await fetchSessionEnd(spent);
    addMessage("assistant", text);
    conversation.push({ role: "assistant", content: text });
    setState("speaking");
    await playAudio(audio);
    if (appState !== "listening") setState("idle");
    awaitingSessionEndReply = true;
  } catch (e) {
    removeTyping();
    const fallback = `Time's up for "${block.title}"! What did you get done?`;
    addMessage("assistant", fallback);
    conversation.push({ role: "assistant", content: fallback });
    setState("idle");
    awaitingSessionEndReply = true;
  }
}

// ── Cognitive load selector ────────────────────────────────────────────────────
function selectLoad(val) {
  selectedLoad = val;
  $("load-btns").querySelectorAll(".energy-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.val) === val);
  });
  $("load-desc").textContent = LOAD_LABELS[val] || "";
  saveState();
}

// ── Energy selector ────────────────────────────────────────────────────────────
function selectEnergy(val) {
  selectedEnergy = val;
  $("energy-btns").querySelectorAll(".energy-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.val) === val);
  });
  $("energy-desc").textContent = ENERGY_LABELS[val] || "";
  saveState();
}

// ── Conversation flow ──────────────────────────────────────────────────────────
async function sendUserMessage(text) {
  const isFirstUserMessage    = !timerAutoStarted;
  const wasAwaitingSessionEnd = awaitingSessionEndReply;

  setState("processing");
  addMessage("user", text);
  conversation.push({ role: "user", content: text });

  showTyping();
  try {
    const { text: replyText, audio } = await fetchRespond(text, wasAwaitingSessionEnd);
    addMessage("assistant", replyText);
    conversation.push({ role: "assistant", content: replyText });
    setState("speaking");
    await playAudio(audio);
    if (appState !== "listening") setState("idle");

    // Auto-start timer after first user message (goals stated)
    if (isFirstUserMessage && !timerRunning && !timerExpired) {
      timerAutoStarted = true;
      startTimer();
    }

    // Mark that the post-timer conversation has happened
    if (wasAwaitingSessionEnd) {
      awaitingSessionEndReply = false;
      hadTimerEndConvo        = true;
      saveState();
    }
  } catch (e) {
    removeTyping();
    setStateLabel("Error: " + e.message, "");
    setState("idle");
  }
}

function toggleMic() {
  if (!hasSpeech) return;
  if (appState === "listening") {
    recognition.stop();
    setState("idle");
  } else if (appState === "idle" || appState === "speaking") {
    stopAudio();           // interrupt agent if speaking
    setState("listening");
    recognition.start();
  }
}

function sendText() {
  const input = $("text-input");
  const text  = input.value.trim();
  if (!text || appState !== "idle") return;
  input.value = "";
  sendUserMessage(text);
}

// ── Complete & Replan ──────────────────────────────────────────────────────────
// Two paths:
//   hadTimerEndConvo = true  → AI summarise + replan → redirect home
//   hadTimerEndConvo = false → shift remaining block timings client-side → redirect home
async function completeAndReplan() {
  // Stop the timer if it's still running
  if (timerRunning) {
    const elapsed = timerTotal - timerRemaining;
    sessionTimeSpentMinutes = Math.max(Math.round(elapsed / 60), 0);
    clearInterval(timerInterval);
    timerRunning = false;
    timerExpired = true;
    $("timer-display").classList.remove("running");
    $("timer-display").classList.add("done");
    updateTimerBtns();
    saveState();
  }

  if (hadTimerEndConvo) {
    // Full AI replan
    setState("processing");
    setStateLabel("Wrapping up…", "");
    try {
      const summary = await fetchSummarize();
      setStateLabel("Replanning your day…", "");
      // Fetch replan first (dayLog holds previous sessions only)
      const newPlan = await fetchReplan(summary);
      // Then save this session to the day log so subsequent replans have the full history
      saveToDayLog(summary);

      const completedSoFar = JSON.parse(sessionStorage.getItem("completedBlocks") || "[]");
      completedSoFar.push(block);
      sessionStorage.setItem("completedBlocks", JSON.stringify(completedSoFar));
      sessionStorage.setItem("newPlan", JSON.stringify(newPlan));
      if (block) sessionStorage.removeItem(`sess_${block.id}`);
      window.location.href = "/";
    } catch (e) {
      setStateLabel("Error: " + e.message, "");
      setState("idle");
    }
  } else {
    // No post-timer chat — shift remaining blocks client-side and log the session
    const adjustedPlan = shiftRemainingBlocks();
    saveToDayLog(null);  // no summary available, log with empty goals

    const completedSoFar = JSON.parse(sessionStorage.getItem("completedBlocks") || "[]");
    completedSoFar.push(block);
    sessionStorage.setItem("completedBlocks", JSON.stringify(completedSoFar));
    sessionStorage.setItem("newPlan", JSON.stringify(adjustedPlan));
    if (block) sessionStorage.removeItem(`sess_${block.id}`);
    window.location.href = "/";
  }
}

// Shift blocks that come after this block based on how much earlier/later we're finishing.
// Snaps to the next 15-min boundary to keep the schedule aligned and avoid fractional overlap.
function shiftRemainingBlocks() {
  const nowMins      = timeToMins(nowHHMM());
  const snapNowMins  = Math.ceil(nowMins / 15) * 15;  // next 15-min boundary
  const blockEndMins = timeToMins(block.end);
  const delta        = snapNowMins - blockEndMins;  // positive = late, negative = early

  const updatedBlocks = (currentPlan?.blocks || [])
    .filter(b => b.id !== block.id)
    .map(b => {
      if (delta !== 0 && timeToMins(b.start) >= blockEndMins) {
        return { ...b, start: addMinsToTime(b.start, delta), end: addMinsToTime(b.end, delta) };
      }
      return b;
    });

  return { ...currentPlan, blocks: updatedBlocks };
}

// ── State persistence ──────────────────────────────────────────────────────────
function saveState() {
  if (!block) return;
  sessionStorage.setItem(`sess_${block.id}`, JSON.stringify({
    conversation, timerRemaining, timerExpired, selectedEnergy, selectedLoad,
    timerAutoStarted, timerStartedAt, sessionTimeSpentMinutes, hadTimerEndConvo,
  }));
}

function loadState() {
  if (!block) return null;
  const raw = sessionStorage.getItem(`sess_${block.id}`);
  return raw ? JSON.parse(raw) : null;
}

// ── Back navigation ────────────────────────────────────────────────────────────
function goBack() {
  const storedPlan = sessionStorage.getItem("currentPlan");
  if (storedPlan) sessionStorage.setItem("returnedPlan", storedPlan);
  window.location.href = "/";
}

// ── Task initiation overlay ────────────────────────────────────────────────────
let savedTimerRemaining = 0;
let initiationInterval  = null;
let initiationRemaining = 120;

function renderInitTimer() {
  const m = Math.floor(initiationRemaining / 60);
  const s = initiationRemaining % 60;
  $("init-timer-display").textContent =
    `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function startInitiationTimer() {
  clearInterval(initiationInterval);
  initiationInterval = setInterval(() => {
    initiationRemaining = Math.max(initiationRemaining - 1, 0);
    renderInitTimer();
    if (initiationRemaining <= 0) {
      clearInterval(initiationInterval);
      onInitiationTimerEnd();
    }
  }, 1000);
}

async function openInitiation() {
  // Pause main timer without marking it expired
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
    $("timer-display").classList.remove("running");
    updateTimerBtns();
  }
  savedTimerRemaining = timerRemaining;

  // Reset overlay to initial state
  initiationRemaining = 120;
  renderInitTimer();
  const headingEl   = $("initiation-heading");
  const endBtn      = $("initiation-end-btn");
  const continueBtn = $("initiation-continue-btn");
  if (headingEl)   headingEl.textContent     = "Just 2 minutes ✦";
  if (endBtn)      endBtn.style.display      = "block";
  if (continueBtn) continueBtn.style.display = "none";
  $("initiation-text").textContent      = "Loading…";
  $("initiation-breakdown").innerHTML   = "";
  $("initiation-overlay").style.display = "flex";

  try {
    const { text, audio, breakdown } = await fetchInitiation();
    $("initiation-text").textContent = text;
    if (breakdown?.length) {
      $("initiation-breakdown").innerHTML = breakdown.map(step => {
        const d = document.createElement("div");
        d.textContent = "→ " + step;
        return d.outerHTML;
      }).join("");
    }
    startInitiationTimer();
    await playAudio(audio);
  } catch (e) {
    $("initiation-text").textContent =
      "Just 2 minutes — open the task and do one tiny thing. That's all.";
    startInitiationTimer();
  }
}

async function onInitiationTimerEnd() {
  const headingEl = $("initiation-heading");
  if (headingEl) headingEl.textContent = "Nice job! ✓";
  // Hide the "go back" button while we play the voice response
  const endBtn = $("initiation-end-btn");
  if (endBtn) endBtn.style.display = "none";

  try {
    const { text, audio } = await fetchInitiationEnd();
    addMessage("assistant", text);
    conversation.push({ role: "assistant", content: text });
    setState("speaking");
    await playAudio(audio);
  } catch (_) { /* silent fallback — auto-proceed regardless */ }

  // Auto-close overlay and resume main timer (deduct 2 min already spent)
  $("initiation-overlay").style.display = "none";
  timerRemaining = Math.max(savedTimerRemaining - 120, 0);
  renderTimerDisplay();
  saveState();
  if (!timerExpired && timerRemaining > 0) startTimer();
  if (appState !== "listening") setState("idle");
}

// "Go back to session" — closes overlay, restores timer from before initiation
function closeInitiationEarly() {
  clearInterval(initiationInterval);
  $("initiation-overlay").style.display = "none";
  timerRemaining = savedTimerRemaining;
  renderTimerDisplay();
  if (!timerExpired && timerRemaining > 0) startTimer();
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  if (!block || !currentPlan) {
    $("transcript").innerHTML =
      `<div style="color:#6b7280;padding:1rem;font-size:0.9rem;">
        No session data found. <a href="/" style="color:#3b82f6;">← Go back to plan.</a>
       </div>`;
    return;
  }

  // Populate top bar and timer panel
  $("block-title").textContent      = block.title;
  $("block-chip-meta").textContent  = `${block.start} – ${block.end}`;
  $("timer-task").textContent       = block.title;
  $("timer-start").textContent      = block.start;
  $("timer-end").textContent        = block.end;

  if (!hasSpeech) $("mic-btn").classList.add("no-speech");

  initTimer();

  const saved = loadState();
  if (saved && saved.conversation?.length > 0) {
    conversation            = saved.conversation;
    timerRemaining          = saved.timerRemaining          ?? timerTotal;
    timerExpired            = saved.timerExpired            ?? false;
    selectedEnergy          = saved.selectedEnergy          ?? 3;
    selectedLoad            = saved.selectedLoad            ?? 3;
    timerAutoStarted        = saved.timerAutoStarted        ?? false;
    timerStartedAt          = null;  // timer is not running after reload; reset so elapsed is correct
    sessionTimeSpentMinutes = saved.sessionTimeSpentMinutes ?? null;
    hadTimerEndConvo        = saved.hadTimerEndConvo        ?? false;

    renderTimerDisplay();
    updateTimerBtns();
    selectEnergy(selectedEnergy);
    selectLoad(selectedLoad);

    if (timerExpired) {
      $("timer-display").classList.add("done");
      $("start-timer-btn").disabled = true;
    }

    restoreTranscript();
    setStateLabel("Welcome back!", "");
    return;
  }

  // Fresh session — greet immediately
  setState("processing");
  showTyping();
  try {
    const { text, audio } = await fetchGreeting();
    addMessage("assistant", text);
    conversation.push({ role: "assistant", content: text });
    setState("speaking");
    await playAudio(audio);
    if (appState !== "listening") setState("idle");
  } catch (e) {
    removeTyping();
    setStateLabel("Could not load greeting: " + e.message, "");
    setState("idle");
  }
}

init();
