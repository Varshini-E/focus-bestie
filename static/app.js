// ── State ──────────────────────────────────────────────────────────────────────
let currentPlan        = null;
let completedBlocks    = [];
let notificationTimers = [];
let salvageMode        = false;
let preSalvagePlan     = null;

// ── Helpers ────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
  );
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.style.color = isError ? "#f87171" : "#777";
}

// ── Time utilities ─────────────────────────────────────────────────────────────
function timeToMins(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minsToTime(mins) {
  const clamped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

function addMins(t, delta) {
  return minsToTime(timeToMins(t) + delta);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function roundedNowHHMM() {
  const d = new Date();
  const totalMins = d.getHours() * 60 + d.getMinutes();
  const rounded   = Math.ceil(totalMins / 15) * 15;  // round UP to next 15-min slot
  return minsToTime(rounded);
}

// ── Effective start/end from form inputs ───────────────────────────────────────
function getEffectiveStart() {
  return $("startTime").value;
}

function getEffectiveEnd() {
  const mode = document.querySelector('input[name="endMode"]:checked').value;
  if (mode === "duration") {
    const hours = parseFloat($("durationHrs").value);
    if (!hours || hours <= 0) return null;
    const start = getEffectiveStart();
    return addMins(start, Math.round(hours * 60));
  }
  return $("endTime").value;
}

// ── Date / mode UI wiring ──────────────────────────────────────────────────────
function onDateChange() {
  const isToday = $("planDate").value === todayISO();
  $("now-hint").classList.toggle("visible", isToday);
  $("startTime").classList.remove("today-locked");
  if (isToday) $("startTime").value = roundedNowHHMM();
}

function onEndModeChange() {
  const isDur = $("mode-dur").checked;
  $("endTime").style.display     = isDur ? "none"  : "";
  $("durationHrs").style.display = isDur ? ""      : "none";
}

// ── Plan generation ────────────────────────────────────────────────────────────
async function generatePlan() {
  const tasksRaw = $("tasks").value.trim();
  if (!tasksRaw) return setStatus("Add at least one task.", true);

  const startTime = getEffectiveStart();
  const endTime   = getEffectiveEnd();

  if (!startTime || !endTime)          return setStatus("Select start and end time (or allocate hours).", true);
  if (endTime <= startTime)            return setStatus("End time must be after start time.", true);

  const tasks = tasksRaw.split("\n").map(t => t.trim()).filter(Boolean);

  const btn = $("planBtn");
  btn.disabled = true;
  setStatus("Planning…");

  try {
    const res = await fetch("/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks, day_start: startTime, day_end: endTime, salvage: salvageMode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Request failed");

    if (!salvageMode) {
      completedBlocks = [];
    }
    renderPlan(data);
    setStatus("Done.");
  } catch (e) {
    setStatus("Error: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Replan from now ────────────────────────────────────────────────────────────
// Pure client-side shift — no AI call. Snaps remaining blocks to start from now
// (rounded to next 15-min mark) and removes any that no longer fit before day_end.
function replanNow() {
  if (!currentPlan || !currentPlan.blocks?.length) {
    return setStatus("No remaining blocks to shift.", true);
  }

  const nowMins   = timeToMins(nowHHMM());
  // Round up to next 15-min slot
  const snapMins  = Math.ceil(nowMins / 15) * 15;
  const firstMins = timeToMins(currentPlan.blocks[0].start);
  const delta     = snapMins - firstMins;

  if (delta === 0) return setStatus("Schedule is already current.", true);

  const dayEndMins = timeToMins(currentPlan.day_end);

  const shifted = currentPlan.blocks
    .map(b => ({ ...b, start: addMins(b.start, delta), end: addMins(b.end, delta) }))
    .filter(b => timeToMins(b.start) < dayEndMins)
    .map((b, i, arr) => {
      // Trim the last block's end if it overflows
      if (i === arr.length - 1 && timeToMins(b.end) > dayEndMins) {
        return { ...b, end: currentPlan.day_end };
      }
      return b;
    });

  if (shifted.length === 0) {
    return setStatus("No blocks fit within the remaining day window.", true);
  }

  renderPlan({ ...currentPlan, blocks: shifted });
  setStatus(delta > 0 ? "Shifted schedule forward." : "Shifted schedule back.");
}

// ── Day summary modal ──────────────────────────────────────────────────────────
async function showSummary() {
  const btn = $("summary-btn");
  if (btn) btn.disabled = true;
  setStatus("Summarizing your day…");

  try {
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed_blocks: completedBlocks }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Request failed");

    const modal = $("summary-modal");
    const body  = $("summary-body");
    if (body)  body.textContent  = data.summary || "";
    if (modal) modal.style.display = "flex";
    setStatus("");
  } catch (e) {
    setStatus("Error: " + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function closeSummary() {
  const modal = $("summary-modal");
  if (modal) modal.style.display = "none";
}

// ── Salvage mode toggle ────────────────────────────────────────────────────────
function onSalvageToggle(enabled) {
  salvageMode = !!enabled;

  const label = document.getElementById("salvage-label");
  if (label) {
    label.textContent = salvageMode
      ? "Minimum salvage mode is ON — focusing on one starter task."
      : "Minimum salvage mode — pick one tiny task to get going.";
  }

  if (salvageMode) {
    // Save current plan so we can restore it later
    if (currentPlan) {
      preSalvagePlan = JSON.parse(JSON.stringify(currentPlan));
    }
    // Immediately generate a minimal salvage plan if tasks are present
    if ($("tasks").value.trim()) {
      generatePlan();
    }
  } else {
    // Restore previous full plan and snap to current time
    if (preSalvagePlan) {
      renderPlan(preSalvagePlan);
      preSalvagePlan = null;
      replanNow();
    }
  }
}

// ── Block time editing ─────────────────────────────────────────────────────────
function onBlockEndEdit(blockId, newEnd) {
  const idx = currentPlan.blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return;

  const oldEnd  = currentPlan.blocks[idx].end;
  const delta   = timeToMins(newEnd) - timeToMins(oldEnd);
  if (delta === 0) return;

  currentPlan.blocks[idx].end = newEnd;

  // Shift all subsequent blocks by the same delta
  for (let i = idx + 1; i < currentPlan.blocks.length; i++) {
    currentPlan.blocks[i].start = addMins(currentPlan.blocks[i].start, delta);
    currentPlan.blocks[i].end   = addMins(currentPlan.blocks[i].end,   delta);
  }

  // Re-render without losing focus awkwardly — just re-draw
  renderPlan(currentPlan);
}

function onBlockStartEdit(blockId, newStart) {
  const idx = currentPlan.blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return;

  const oldStart = currentPlan.blocks[idx].start;
  const delta    = timeToMins(newStart) - timeToMins(oldStart);
  if (delta === 0) return;

  // Keep duration of this block, shift its end too
  currentPlan.blocks[idx].start = newStart;
  currentPlan.blocks[idx].end   = addMins(currentPlan.blocks[idx].end, delta);

  // Shift all subsequent blocks
  for (let i = idx + 1; i < currentPlan.blocks.length; i++) {
    currentPlan.blocks[i].start = addMins(currentPlan.blocks[i].start, delta);
    currentPlan.blocks[i].end   = addMins(currentPlan.blocks[i].end,   delta);
  }

  renderPlan(currentPlan);
}

// ── Add block ──────────────────────────────────────────────────────────────────
function toggleAddBlock() {
  const form = $("add-block-form");
  const visible = form.classList.toggle("visible");
  if (visible) {
    // Pre-fill start time from last block end, or current time
    const lastBlock = currentPlan?.blocks?.slice(-1)[0];
    $("new-block-start").value = lastBlock ? lastBlock.end : nowHHMM();
    $("new-block-title").focus();
  }
}

function submitAddBlock() {
  const title   = $("new-block-title").value.trim();
  const start   = $("new-block-start").value;
  const durMins = parseInt($("new-block-dur").value, 10) || 25;

  if (!title || !start) return;

  const end = addMins(start, durMins);
  const newBlock = {
    id:    `manual-${Date.now()}`,
    type:  "task",
    start,
    end,
    title,
    load:  null,
  };

  if (!currentPlan) {
    currentPlan = { day_start: start, day_end: end, blocks: [], notes: [] };
    $("schedule-card").style.display = "block";
  }

  currentPlan.blocks.push(newBlock);
  currentPlan.blocks.sort((a, b) => timeToMins(a.start) - timeToMins(b.start));

  // Clear form
  $("new-block-title").value = "";
  $("add-block-form").classList.remove("visible");

  renderPlan(currentPlan);
}

// ── Render plan ────────────────────────────────────────────────────────────────
function renderPlan(plan) {
  currentPlan = plan;

  const el = $("schedule");
  $("schedule-card").style.display = "block";

  let html = `<div style="font-size:0.82rem;color:#6b7280;margin-bottom:0.25rem;">
    ${escapeHtml(plan.day_start)} → ${escapeHtml(plan.day_end)}
  </div>`;

  // Completed blocks — greyed out
  if (completedBlocks.length > 0) {
    html += completedBlocks.map(b => `
      <div class="block block-done">
        <div class="block-meta">
          ${escapeHtml(b.start)}–${escapeHtml(b.end)}
          <span class="pill">${escapeHtml(b.type)}</span>
        </div>
        <div class="block-title">${escapeHtml(b.title)}</div>
      </div>
    `).join("");
    html += `<div class="now-divider">▾ now</div>`;
  }

  // Upcoming blocks — break/meal get "Mark done", tasks get clickable session
  const isBreak = b => b.type === "break" || b.type === "meal";
  html += plan.blocks.map(b => `
    <div class="block ${isBreak(b) ? "break-block" : "clickable"}" data-block-id="${escapeHtml(b.id)}">
      <div class="block-meta">
        <input class="block-time-input"
               type="time"
               value="${escapeHtml(b.start)}"
               data-block-id="${escapeHtml(b.id)}"
               data-field="start"
               title="Edit start time"
               onclick="event.stopPropagation()" />
        –
        <input class="block-time-input"
               type="time"
               value="${escapeHtml(b.end)}"
               data-block-id="${escapeHtml(b.id)}"
               data-field="end"
               title="Edit end time"
               onclick="event.stopPropagation()" />
        <span class="pill">${escapeHtml(b.type)}</span>
        ${typeof b.load === "number" ? `<span class="pill">load ${b.load}</span>` : ""}
      </div>
      <div class="block-title">${escapeHtml(b.title)}</div>
      <div class="block-actions">
        ${isBreak(b)
          ? `<button class="mark-done-btn btn-sm btn-ghost" data-block-id="${escapeHtml(b.id)}" onclick="event.stopPropagation()">✓ Mark done</button>`
          : `<div class="block-cta">▶ start session</div>`
        }
        <button class="delete-block-btn" data-block-id="${escapeHtml(b.id)}" onclick="event.stopPropagation()" title="Delete block">×</button>
      </div>
    </div>
  `).join("");

  if (plan.notes?.length) {
    html += `<div class="plan-notes">Notes: ${escapeHtml(plan.notes.join(" · "))}</div>`;
  }

  el.innerHTML = html;

  // ── Attach events ──────────────────────────────────────────────────────────

  // Time input: change → shift blocks
  el.querySelectorAll(".block-time-input").forEach(input => {
    input.addEventListener("change", (e) => {
      const id    = e.target.dataset.blockId;
      const field = e.target.dataset.field;
      if (field === "end")   onBlockEndEdit(id, e.target.value);
      if (field === "start") onBlockStartEdit(id, e.target.value);
    });
  });

  // Task block click → navigate to session.
  // Always adjust block.start to now so the timer reflects actual remaining time.
  // Three cases:
  //   Early  (now < scheduled start) → start=now, end=now+duration (full time, no block shifting)
  //   Late   (now inside window)     → start=now, end=original end (less time), shift later blocks
  //   Past   (now >= block end)      → start=now, end=now+duration (fresh session, no shifting)
  el.querySelectorAll(".block.clickable").forEach(blockEl => {
    blockEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("block-time-input")) return;
      const foundBlock = currentPlan.blocks.find(b => b.id === blockEl.dataset.blockId);
      if (!foundBlock) return;

      const now            = nowHHMM();
      const nowMins        = timeToMins(now);
      const blockStartMins = timeToMins(foundBlock.start);
      const blockEndMins   = timeToMins(foundBlock.end);
      const durationMins   = blockEndMins - blockStartMins;

      const isLate = nowMins > blockStartMins && nowMins < blockEndMins;

      // Late → keep original end (timer = remaining window in the scheduled slot)
      // Early or past → add full original duration from now
      const newEnd      = isLate ? foundBlock.end : addMins(now, durationMins);
      const activeBlock = { ...foundBlock, start: now, end: newEnd };

      // Only shift subsequent blocks when running late
      let planToStore;
      if (isLate) {
        const delta = nowMins - blockStartMins;
        planToStore = {
          ...currentPlan,
          blocks: currentPlan.blocks.map(b => {
            if (b.id === foundBlock.id) return activeBlock;
            if (timeToMins(b.start) > blockStartMins) {
              return { ...b, start: addMins(b.start, delta), end: addMins(b.end, delta) };
            }
            return b;
          }),
        };
      } else {
        planToStore = {
          ...currentPlan,
          blocks: currentPlan.blocks.map(b => b.id === foundBlock.id ? activeBlock : b),
        };
      }

      sessionStorage.setItem("activeBlock",     JSON.stringify(activeBlock));
      sessionStorage.setItem("currentPlan",     JSON.stringify(planToStore));
      sessionStorage.setItem("completedBlocks", JSON.stringify(completedBlocks));
      window.location.href = "/session";
    });
  });

  // Break/meal block: Mark done (no session required)
  el.querySelectorAll(".mark-done-btn").forEach(btn => {
    btn.addEventListener("click", () => markBlockDone(btn.dataset.blockId));
  });

  // Delete block button
  el.querySelectorAll(".delete-block-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteBlock(btn.dataset.blockId));
  });

  // Schedule 1-minute-before notifications for upcoming blocks
  scheduleBlockNotifications(plan.blocks);
}

// ── Delete block ───────────────────────────────────────────────────────────────
function deleteBlock(id) {
  const idx = currentPlan.blocks.findIndex(b => b.id === id);
  if (idx === -1) return;
  currentPlan.blocks.splice(idx, 1);
  renderPlan(currentPlan);
}

// ── Mark break/meal block done ─────────────────────────────────────────────────
function markBlockDone(id) {
  const idx = currentPlan.blocks.findIndex(b => b.id === id);
  if (idx === -1) return;
  const [done] = currentPlan.blocks.splice(idx, 1);
  completedBlocks.push(done);
  renderPlan(currentPlan);
}

// ── Block notifications ────────────────────────────────────────────────────────
function scheduleBlockNotifications(blocks) {
  notificationTimers.forEach(t => clearTimeout(t));
  notificationTimers = [];

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }

  const now = Date.now();
  blocks.forEach(block => {
    const [h, m] = block.start.split(":").map(Number);
    const blockDate = new Date();
    blockDate.setHours(h, m, 0, 0);
    const msUntil = blockDate.getTime() - 60_000 - now;  // 1 min before
    if (msUntil > 0) {
      notificationTimers.push(
        setTimeout(() => fireBlockNotification(block), msUntil)
      );
    }
  });
}

function fireBlockNotification(block) {
  const msg = `"${block.title}" starts in 1 minute (${block.start})`;

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Next block starting soon", { body: msg });
  }

  showToast(`⏰ ${msg}`);
  playNotificationSound();
}

function showToast(msg) {
  const toast = document.createElement("div");
  toast.className = "notification-toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 350);
  }, 5000);
}

function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || /** @type {any} */(window).webkitAudioContext;
    const ctx  = new AudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880,  ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch (_) { /* AudioContext unavailable */ }
}

// ── Init ───────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Set default date to today
  $("planDate").value = todayISO();
  onDateChange();

  // Restore saved task list
  const savedTasks = localStorage.getItem("anchor_tasks");
  if (savedTasks) $("tasks").value = savedTasks;
  $("tasks").addEventListener("input", () => {
    localStorage.setItem("anchor_tasks", $("tasks").value);
  });

  // Wire up events
  $("planBtn").addEventListener("click", generatePlan);
  $("planDate").addEventListener("change", onDateChange);
  document.querySelectorAll('input[name="endMode"]').forEach(r =>
    r.addEventListener("change", onEndModeChange)
  );

  const salvageToggle = $("salvageToggle");
  if (salvageToggle) {
    salvageToggle.addEventListener("change", (e) => onSalvageToggle(e.target.checked));
  }
  const replanBtn = $("replan-btn");
  if (replanBtn) {
    replanBtn.addEventListener("click", replanNow);
  }
  const summaryBtn = $("summary-btn");
  if (summaryBtn) {
    summaryBtn.addEventListener("click", showSummary);
  }

  // Replanned plan returned from session complete
  const newPlanRaw = sessionStorage.getItem("newPlan");
  if (newPlanRaw) {
    sessionStorage.removeItem("newPlan");
    const savedCompleted = sessionStorage.getItem("completedBlocks");
    if (savedCompleted) {
      completedBlocks = JSON.parse(savedCompleted);
      sessionStorage.removeItem("completedBlocks");
    }
    renderPlan(JSON.parse(newPlanRaw));
    setStatus("Day replanned after your session.");
    return;
  }

  // Returned via back button from session page
  const returnedPlanRaw = sessionStorage.getItem("returnedPlan");
  if (returnedPlanRaw) {
    sessionStorage.removeItem("returnedPlan");
    const savedCompleted = sessionStorage.getItem("completedBlocks");
    if (savedCompleted) {
      completedBlocks = JSON.parse(savedCompleted);
    }
    renderPlan(JSON.parse(returnedPlanRaw));
  }
});
