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
let timerTotal       = 0;
let timerRemaining   = 0;
let timerRunning     = false;
let timerExpired     = false;
let timerInterval    = null;
let timerAutoStarted = false;  // true after first user message triggers auto-start
let sessionTimeSpentMinutes = null; // how long user actually spent in this block

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
  const busy = s === "processing" || s === "speaking";
  $("mic-btn").disabled      = busy;
  $("text-input").disabled   = busy;
  $("send-btn").disabled     = busy;
  $("complete-btn").disabled = busy;
  const endBtn = $("end-session-btn");
  if (endBtn) endBtn.disabled = busy;

  const bar = $("state-bar");
  bar.className = "state-bar " + (s === "listening" ? "listening" : s === "speaking" ? "speaking" : "");

  if (s === "listening") {
    $("mic-btn").classList.add("listening");
    $("mic-btn").textContent = "■";
    bar.textContent = "Listening…";
  } else {
    $("mic-btn").classList.remove("listening");
    $("mic-btn").textContent = "🎙️";
    bar.textContent = s === "speaking" ? "Speaking…" : s === "processing" ? "Thinking…" : "";
  }
}

function setStateLabel(text, cls) {
  const el = $("state-bar");
  el.textContent = text;
  el.className   = "state-bar " + (cls || "");
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
function playAudio(base64) {
  if (!base64) return Promise.resolve();
  return new Promise((resolve) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob  = new Blob([bytes], { type: "audio/mpeg" });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
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

async function fetchRespond(userText) {
  const res = await fetch("/api/voice/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, user_text: userText, block }),
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

async function fetchWrapup(timeSpentMins) {
  const res = await fetch("/api/voice/wrapup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, block, time_spent_minutes: timeSpentMins }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Wrapup failed");
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

async function fetchReplan(summary, timeSpentMins) {
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
      time_spent_minutes: timeSpentMins ?? null,
      current_time:       nowHHMM(),
    }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Replan failed");
  return res.json();
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
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
  timerRunning = true;
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
  // Manually end the session early (same effect as timer expiring)
  if (!timerRunning) return;
  const timeSpentMins = Math.round((timerTotal - timerRemaining) / 60);
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

async function onTimerEnd(timeSpentMins) {
  // If timer expired naturally, full duration was spent
  const spent = timeSpentMins ?? Math.round(timerTotal / 60);
  sessionTimeSpentMinutes = spent;
  saveState();

  // If they bailed within the first minute, skip voice check-in
  if (spent <= 1) {
    return;
  }
  setState("processing");
  showTyping();
  try {
    const { text, audio } = await fetchSessionEnd(spent);
    addMessage("assistant", text);
    conversation.push({ role: "assistant", content: text });
    setState("speaking");
    await playAudio(audio);
    setState("idle");
  } catch (e) {
    removeTyping();
    const fallback = `Time's up for "${block.title}"! Great work — how did it go? Tell me what you accomplished.`;
    addMessage("assistant", fallback);
    conversation.push({ role: "assistant", content: fallback });
    setState("idle");
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
  const isFirstUserMessage = !timerAutoStarted;

  setState("processing");
  addMessage("user", text);
  conversation.push({ role: "user", content: text });

  showTyping();
  try {
    const { text: replyText, audio } = await fetchRespond(text);
    addMessage("assistant", replyText);
    conversation.push({ role: "assistant", content: replyText });
    setState("speaking");
    await playAudio(audio);
    setState("idle");

    // Auto-start timer after first user message (goals stated)
    if (isFirstUserMessage && !timerRunning && !timerExpired) {
      timerAutoStarted = true;
      startTimer();
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
  } else if (appState === "idle") {
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

// ── Complete session ───────────────────────────────────────────────────────────
async function completeSession() {
  setState("processing");
  setStateLabel("Wrapping up…", "");

  try {
    const summary = await fetchSummarize();
    setStateLabel("Replanning your day…", "");
    const newPlan = await fetchReplan(summary);

    const completedSoFar = JSON.parse(sessionStorage.getItem("completedBlocks") || "[]");
    completedSoFar.push(block);
    sessionStorage.setItem("completedBlocks", JSON.stringify(completedSoFar));
    sessionStorage.setItem("newPlan", JSON.stringify(newPlan));

    // Clear saved session state for this block
    if (block) sessionStorage.removeItem(`sess_${block.id}`);

    window.location.href = "/";
  } catch (e) {
    setStateLabel("Error: " + e.message, "");
    setState("idle");
  }
}

// ── State persistence ──────────────────────────────────────────────────────────
function saveState() {
  if (!block) return;
  sessionStorage.setItem(`sess_${block.id}`, JSON.stringify({
    conversation,
    timerRemaining,
    timerExpired,
    selectedEnergy,
    selectedLoad,
    timerAutoStarted,
    sessionTimeSpentMinutes,
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
  if (storedPlan) {
    sessionStorage.setItem("returnedPlan", storedPlan);
    // completedBlocks already stored; leave it in place for home page
  }
  window.location.href = "/";
}

// ── Task initiation overlay ────────────────────────────────────────────────────
let savedTimerRemaining  = 0;
let initiationInterval   = null;
let initiationRemaining  = 120;

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

  // Reset overlay state
  initiationRemaining = 120;
  renderInitTimer();
  const headingEl   = $("initiation-heading");
  const endBtn      = $("initiation-end-btn");
  const continueBtn = $("initiation-continue-btn");
  if (headingEl) headingEl.textContent = "Just 2 minutes ✦";
  if (endBtn) endBtn.style.display = "block";
  if (continueBtn) continueBtn.style.display = "none";
  $("initiation-text").textContent      = "Loading…";
  $("initiation-breakdown").innerHTML   = "";
  $("initiation-overlay").style.display = "flex";

  // Fetch spoken text + breakdown
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
  // Timer finished: keep overlay open and show "Nice job!" + Go back button
  const headingEl   = $("initiation-heading");
  const endBtn      = $("initiation-end-btn");
  const continueBtn = $("initiation-continue-btn");
  if (headingEl) headingEl.textContent = "Nice job!";
  if (endBtn) endBtn.style.display = "none";
  if (continueBtn) continueBtn.style.display = "block";
}

function closeInitiation() {
  clearInterval(initiationInterval);
  $("initiation-overlay").style.display = "none";
}

function closeInitiationEarly() {
  clearInterval(initiationInterval);
  $("initiation-overlay").style.display = "none";
  // Return to the main session — resume timer from where it was
  timerRemaining = savedTimerRemaining;
  renderTimerDisplay();
  if (!timerExpired && timerRemaining > 0) {
    startTimer();
  }
}

async function continueAfterInitiation() {
  $("initiation-overlay").style.display = "none";

  // Deduct the 2 minutes from the main timer
  timerRemaining = Math.max(savedTimerRemaining - 120, 0);
  renderTimerDisplay();
  saveState();

  // Immediately continue the main timer
  if (!timerExpired && timerRemaining > 0) {
    startTimer();
  }
}

function resumeAfterInitiation() {
  $("resume-timer-btn").style.display = "none";
  if (timerRemaining > 0 && !timerExpired) {
    startTimer();
  }
}

// ── Wrap-up flow ───────────────────────────────────────────────────────────────
async function initiateWrapUp() {
  // Stop timer without triggering the normal timer-end voice
  let spentMins = sessionTimeSpentMinutes;
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
    const elapsed = timerTotal - timerRemaining;
    spentMins = Math.max(Math.round(elapsed / 60), 0);
    timerExpired = true;
    $("timer-display").classList.remove("running");
    $("timer-display").classList.add("done");
    updateTimerBtns();
    saveState();
  }

  if (spentMins != null) {
    sessionTimeSpentMinutes = spentMins;
    saveState();
  }

  setState("processing");
  setStateLabel("Checking in on your session…", "");
  showTyping();
  try {
    const { text, audio } = await fetchWrapup(spentMins);
    addMessage("assistant", text);
    conversation.push({ role: "assistant", content: text });
    setState("speaking");
    await playAudio(audio);
    setState("idle");
  } catch (e) {
    removeTyping();
    const fallback = "Let's wrap up this block. Tell me what you got done, then hit End Session when you're ready to replan.";
    addMessage("assistant", fallback);
    conversation.push({ role: "assistant", content: fallback });
    setState("idle");
  }

  // Swap buttons: hide \"Complete & Replan\" and show \"End Session & Replan\"
  const completeBtn = $("complete-btn");
  const endBtn = $("end-session-btn");
  if (completeBtn) completeBtn.style.display = "none";
  if (endBtn)      endBtn.style.display = "block";
}

async function endSessionReplan() {
  setState("processing");
  setStateLabel("Wrapping up…", "");

  try {
    const summary = await fetchSummarize();
    setStateLabel("Replanning your day…", "");
    const newPlan = await fetchReplan(summary, sessionTimeSpentMinutes);

    const completedSoFar = JSON.parse(sessionStorage.getItem("completedBlocks") || "[]");
    completedSoFar.push(block);
    sessionStorage.setItem("completedBlocks", JSON.stringify(completedSoFar));
    sessionStorage.setItem("newPlan", JSON.stringify(newPlan));

    // Clear saved session state for this block
    if (block) sessionStorage.removeItem(`sess_${block.id}`);

    window.location.href = "/";
  } catch (e) {
    setStateLabel("Error: " + e.message, "");
    setState("idle");
  }
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

  // Init timer (sets timerTotal from block duration)
  initTimer();

  // Restore saved session if available
  const saved = loadState();
  if (saved && saved.conversation?.length > 0) {
    conversation     = saved.conversation;
    timerRemaining   = saved.timerRemaining  ?? timerTotal;
    timerExpired     = saved.timerExpired    ?? false;
    selectedEnergy   = saved.selectedEnergy  ?? 3;
    selectedLoad     = saved.selectedLoad    ?? 3;
    timerAutoStarted = saved.timerAutoStarted ?? false;
    sessionTimeSpentMinutes = saved.sessionTimeSpentMinutes ?? null;

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

  // Fresh session — greet immediately without prompting
  setState("processing");
  showTyping();
  try {
    const { text, audio } = await fetchGreeting();
    addMessage("assistant", text);
    conversation.push({ role: "assistant", content: text });
    setState("speaking");
    await playAudio(audio);
    setState("idle");
  } catch (e) {
    removeTyping();
    setStateLabel("Could not load greeting: " + e.message, "");
    setState("idle");
  }
}

init();
