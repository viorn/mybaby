// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
};

const pad = (n) => String(n).padStart(2, "0");

// ISO UTC -> значение для datetime-local
const toLocalInput = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// значение datetime-local -> ISO UTC
const fromLocalInput = (value) => new Date(value).toISOString();

const fmtDuration = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} ч ${pad(min % 60)} мин` : `${min} мин`;
};

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

const dayName = (date) =>
  date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });

// ---------- state ----------
let entries = [];
let active = null;
let editingId = null;
let tickTimer = null;

// ---------- timer ----------
const renderTimer = () => {
  const statusEl = $("timer-status");
  const elapsedEl = $("timer-elapsed");
  const btn = $("timer-btn");
  const noteWrap = $("timer-note-wrap");

  if (active) {
    const started = new Date(active.started_at);
    statusEl.textContent = `Спит с ${started.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
    statusEl.classList.add("active");
    elapsedEl.classList.remove("hidden");
    noteWrap.classList.add("hidden");
    btn.textContent = "Разбудить";
    btn.classList.add("stop");
  } else {
    statusEl.textContent = "Не спит";
    statusEl.classList.remove("active");
    elapsedEl.classList.add("hidden");
    noteWrap.classList.remove("hidden");
    btn.textContent = "Начать сон";
    btn.classList.remove("stop");
  }
};

const tick = () => {
  if (!active) return;
  $("timer-elapsed").textContent = fmtClock(Date.now() - new Date(active.started_at));
};

$("timer-btn").addEventListener("click", async () => {
  try {
    if (active) {
      await api("/api/timer/stop", { method: "POST" });
    } else {
      const note = $("timer-note").value.trim();
      await api("/api/timer/start", { method: "POST", body: JSON.stringify({ note }) });
      $("timer-note").value = "";
    }
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

// ---------- journal ----------
const renderJournal = () => {
  const list = $("journal");
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = '<li class="empty">Пока нет записей</li>';
    return;
  }

  let lastDay = null;
  for (const e of entries) {
    const start = new Date(e.started_at);
    const dayKey = start.toDateString();

    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const li = document.createElement("li");
      li.className = "day-label";
      li.textContent = dayName(start);
      list.appendChild(li);
    }

    const li = document.createElement("li");
    li.className = "entry" + (e.ended_at ? "" : " active");
    li.innerHTML = `
      <div class="entry-main">
        <div class="entry-time">
          ${start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
          ${e.ended_at ? " – " + new Date(e.ended_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : " – …"}
        </div>
        ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ""}
      </div>
      <div class="entry-duration">${fmtDuration((e.ended_at ? new Date(e.ended_at) : Date.now()) - start)}</div>
    `;
    li.addEventListener("click", () => openEdit(e));
    list.appendChild(li);
  }
};

const HTML_ESCAPES = {
  "\u0026": "\u0026amp;",
  "\u003C": "\u0026lt;",
  "\u003E": "\u0026gt;",
  '"': "\u0026quot;",
  "'": "\u0026#39;",
};

const escapeHtml = (s) => s.replace(/[\u0026<>"']/g, (c) => HTML_ESCAPES[c]);

// ---------- add form ----------
$("add-btn").addEventListener("click", () => {
  $("add-form").classList.toggle("hidden");
  $("add-start").value = toLocalInput(new Date().toISOString());
  $("add-end").value = "";
});

$("add-cancel").addEventListener("click", () => $("add-form").classList.add("hidden"));

$("add-save").addEventListener("click", async () => {
  if (!$("add-start").value) return alert("Укажите время начала");
  try {
    await api("/api/entries", {
      method: "POST",
      body: JSON.stringify({
        started_at: fromLocalInput($("add-start").value),
        ended_at: $("add-end").value ? fromLocalInput($("add-end").value) : null,
        note: $("add-note").value.trim(),
      }),
    });
    $("add-form").classList.add("hidden");
    $("add-note").value = "";
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

// ---------- export ----------
const exportData = (format) => {
  const params = new URLSearchParams({ format });
  const from = $("export-from").value;
  const to = $("export-to").value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  window.location.href = `/api/export?${params}`;
};

$("export-csv").addEventListener("click", () => exportData("csv"));
$("export-json").addEventListener("click", () => exportData("json"));

// ---------- edit dialog ----------
const dialog = $("edit-dialog");

const openEdit = (e) => {
  editingId = e.id;
  $("edit-start").value = toLocalInput(e.started_at);
  $("edit-end").value = e.ended_at ? toLocalInput(e.ended_at) : "";
  $("edit-note").value = e.note;
  dialog.showModal();
};

$("edit-cancel").addEventListener("click", () => dialog.close());

$("edit-save").addEventListener("click", async (ev) => {
  ev.preventDefault();
  if (!$("edit-start").value) return alert("Укажите время начала");
  try {
    await api(`/api/entries/${editingId}`, {
      method: "PATCH",
      body: JSON.stringify({
        started_at: fromLocalInput($("edit-start").value),
        ended_at: $("edit-end").value ? fromLocalInput($("edit-end").value) : null,
        note: $("edit-note").value.trim(),
      }),
    });
    dialog.close();
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

$("edit-delete").addEventListener("click", async () => {
  if (!confirm("Удалить запись?")) return;
  try {
    await api(`/api/entries/${editingId}`, { method: "DELETE" });
    dialog.close();
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

// ---------- boot ----------
const refresh = async () => {
  [entries, active] = await Promise.all([api("/api/entries"), api("/api/active")]);
  renderTimer();
  tick();
  renderJournal();
};

refresh();
setInterval(() => {
  tick();
  if (entries.some((e) => !e.ended_at)) renderJournal(); // обновляем длительность активных
}, 1000);
