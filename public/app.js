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
  const pairs = [
    { status: $("timer-status"), elapsed: $("timer-elapsed"), btn: $("timer-btn") },
    { status: $("home-status"), elapsed: $("home-elapsed"), btn: $("home-sleep-btn") },
  ];

  for (const { status, elapsed, btn } of pairs) {
    if (active) {
      const started = new Date(active.started_at);
      status.textContent = `Спит с ${started.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
      status.classList.add("active");
      elapsed.classList.remove("hidden");
      elapsed.textContent = fmtClock(Date.now() - started);
      btn.textContent = "Разбудить";
      btn.classList.add("stop");
    } else {
      status.textContent = "Не спит";
      status.classList.remove("active");
      elapsed.classList.add("hidden");
      btn.textContent = "Начать сон";
      btn.classList.remove("stop");
    }
  }

  const noteWrap = $("timer-note-wrap");
  noteWrap.classList.toggle("hidden", !!active);
};

const tick = () => {
  if (active) {
    const ms = Date.now() - new Date(active.started_at);
    $("timer-elapsed").textContent = fmtClock(ms);
    $("home-elapsed").textContent = fmtClock(ms);
  }
  renderLastSleep();
};

// Прошло с окончания последнего сна (если меньше 24 ч)
const renderLastSleep = () => {
  let text = null;
  const last = entries.find((e) => e.ended_at);
  if (!active && last) {
    const since = Date.now() - new Date(last.ended_at).getTime();
    if (since < 24 * 60 * 60 * 1000) {
      text = `Последний сон закончился ${fmtDuration(since)} назад`;
    }
  }
  for (const id of ["last-sleep", "home-last"]) {
    const el = $(id);
    el.classList.toggle("hidden", !text);
    if (text) el.textContent = text;
  }
};

const toggleSleep = async () => {
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
};

$("timer-btn").addEventListener("click", toggleSleep);
$("home-sleep-btn").addEventListener("click", toggleSleep);

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

// ---------- вкладки ----------
const showTab = (name) => {
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  for (const tab of ["home", "sleep", "feeding"]) {
    $(`tab-${tab}`).classList.toggle("hidden", tab !== name);
  }
};

document.querySelectorAll(".tab-btn").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab))
);

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
  const from = $("home-export-from").value;
  const to = $("home-export-to").value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  window.location.href = `/api/export?${params}`;
};

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

// ---------- питание ----------
let feedings = [];
let editingFeedingId = null;
const AMOUNT_KEY = "mybaby:lastAmount";

const renderFeedingJournal = () => {
  const list = $("feeding-journal");
  list.innerHTML = "";

  if (feedings.length === 0) {
    list.innerHTML = '<li class="empty">Пока нет записей</li>';
    return;
  }

  let lastDay = null;
  let dayTotal = 0;
  for (const f of feedings) {
    const at = new Date(f.at);
    const dayKey = at.toDateString();

    if (dayKey !== lastDay) {
      if (lastDay !== null) {
        const total = document.createElement("li");
        total.className = "day-label";
        total.innerHTML = `Итого за день: <span class="feeding-day-total">${dayTotal} мл</span>`;
        list.appendChild(total);
      }
      lastDay = dayKey;
      dayTotal = 0;
      const li = document.createElement("li");
      li.className = "day-label";
      li.textContent = dayName(at);
      list.appendChild(li);
    }
    dayTotal += f.amount_ml;

    const li = document.createElement("li");
    li.className = "entry";
    li.innerHTML = `
      <div class="entry-main">
        <div class="entry-time">${at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</div>
      </div>
      <div class="entry-amount">${f.amount_ml} мл</div>
    `;
    li.addEventListener("click", () => openFeedingEdit(f));
    list.appendChild(li);
  }

  const total = document.createElement("li");
  total.className = "day-label";
  total.innerHTML = `Итого за день: <span class="feeding-day-total">${dayTotal} мл</span>`;
  list.appendChild(total);
};

const FEEDING_FORMS = [
  ["feeding-at", "feeding-amount"],
  ["home-feeding-at", "home-feeding-amount"],
];

const prefillFeedingForm = () => {
  const saved = Number(localStorage.getItem(AMOUNT_KEY));
  const lastServer = feedings[0]?.amount_ml;
  const amount = saved || lastServer || 60;
  for (const [atId, amountId] of FEEDING_FORMS) {
    $(atId).value = toLocalInput(new Date().toISOString());
    $(amountId).value = amount;
  }
};

const saveFeeding = async (atId, amountId) => {
  const amount = Math.max(0, Math.round(Number($(amountId).value) || 0));
  try {
    await api("/api/feedings", {
      method: "POST",
      body: JSON.stringify({ at: fromLocalInput($(atId).value), amount_ml: amount }),
    });
    localStorage.setItem(AMOUNT_KEY, String(amount));
    await refresh();
    $(atId).value = toLocalInput(new Date().toISOString());
  } catch (e) {
    alert(e.message);
  }
};

$("feeding-save").addEventListener("click", () => saveFeeding("feeding-at", "feeding-amount"));
$("home-feeding-save").addEventListener("click", () =>
  saveFeeding("home-feeding-at", "home-feeding-amount")
);

// ---------- диалог кормления ----------
const feedingDialog = $("feeding-dialog");

const openFeedingEdit = (f) => {
  editingFeedingId = f.id;
  $("feeding-edit-at").value = toLocalInput(f.at);
  $("feeding-edit-amount").value = f.amount_ml;
  feedingDialog.showModal();
};

$("feeding-edit-cancel").addEventListener("click", () => feedingDialog.close());

$("feeding-edit-save").addEventListener("click", async (ev) => {
  ev.preventDefault();
  try {
    await api(`/api/feedings/${editingFeedingId}`, {
      method: "PATCH",
      body: JSON.stringify({
        at: fromLocalInput($("feeding-edit-at").value),
        amount_ml: Math.max(0, Math.round(Number($("feeding-edit-amount").value) || 0)),
      }),
    });
    feedingDialog.close();
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

$("feeding-edit-delete").addEventListener("click", async () => {
  if (!confirm("Удалить запись?")) return;
  try {
    await api(`/api/feedings/${editingFeedingId}`, { method: "DELETE" });
    feedingDialog.close();
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

// ---------- визуализация дня ----------
const DAY_MS = 24 * 60 * 60 * 1000;

const renderDay = () => {
  if (!$("home-day-date").value) {
    $("home-day-date").value = toLocalInput(new Date().toISOString()).slice(0, 10);
  }
  const d = $("home-day-date").value;
  if (!d) return;

  const dayStart = new Date(`${d}T00:00:00`).getTime();
  const dayEnd = dayStart + DAY_MS;
  const now = Date.now();
  const timeline = $("home-timeline");
  timeline.innerHTML = "";

  // Часы 0..24
  $("home-hours").innerHTML = Array.from({ length: 25 }, (_, h) => `<span>${h}</span>`).join("");

  // Сегменты сна (обрезаем по границам дня, включая сон с прошлых суток)
  let sleepMs = 0;
  for (const e of entries) {
    const s = new Date(e.started_at).getTime();
    const en = e.ended_at ? new Date(e.ended_at).getTime() : now;
    const segStart = Math.max(s, dayStart);
    const segEnd = Math.min(en, dayEnd, now);
    if (segStart >= segEnd) continue;
    sleepMs += segEnd - segStart;

    const div = document.createElement("div");
    div.className = "tl-sleep";
    div.style.left = `${((segStart - dayStart) / DAY_MS) * 100}%`;
    div.style.width = `${((segEnd - segStart) / DAY_MS) * 100}%`;
    const f = (t) => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    div.title = `Сон: ${f(segStart)} – ${en > now ? "…" : f(segEnd)}`;
    timeline.appendChild(div);
  }

  // Метки кормлений
  let dayMl = 0;
  for (const fd of feedings) {
    const t = new Date(fd.at).getTime();
    if (t < dayStart || t >= dayEnd) continue;
    dayMl += fd.amount_ml;

    const div = document.createElement("div");
    div.className = "tl-feed";
    div.style.left = `${((t - dayStart) / DAY_MS) * 100}%`;
    div.title = `${new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} — ${fd.amount_ml} мл`;
    timeline.appendChild(div);
  }

  $("home-stats").innerHTML = `
    <span>😴 Сон: <b>${fmtDuration(sleepMs)}</b></span>
    <span>🍼 Еда: <b>${dayMl} мл</b></span>
  `;
};

$("home-day-date").addEventListener("change", renderDay);

// ---------- главная: действия ----------
$("home-export-csv").addEventListener("click", () => exportData("csv"));
$("home-export-json").addEventListener("click", () => exportData("json"));

const importJson = async (file) => {
  const data = JSON.parse(await file.text());

  // Полный экспорт: { entries: [...], feedings: [...] }
  if (!Array.isArray(data) && (Array.isArray(data?.entries) || Array.isArray(data?.feedings))) {
    const total = (data.entries?.length || 0) + (data.feedings?.length || 0);
    if (total === 0) throw new Error("файл не содержит записей");
    if (
      !confirm(
        `В файле: сон — ${data.entries?.length || 0}, кормлений — ${data.feedings?.length || 0}. Импортировать?`
      )
    )
      return;
    const res = await api("/api/import", { method: "POST", body: JSON.stringify(data) });
    alert(`Импортировано: сон — ${res.importedEntries}, кормлений — ${res.importedFeedings}`);
  } else {
    // Массив одного типа
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("файл не содержит записей");
    }
    const isFeeding = items.every((it) => it?.at !== undefined || it?.amount_ml !== undefined);
    const type = isFeeding ? "feedings" : "entries";
    const label = type === "feedings" ? "кормления" : "сон";
    if (!confirm(`Записей в файле: ${items.length}. Импортировать как «${label}»?`)) return;

    const res = await api(`/api/import?type=${type}`, {
      method: "POST",
      body: JSON.stringify(items),
    });
    alert(`Импортировано записей: ${res.importedEntries + res.importedFeedings}`);
  }
  await refresh();
};

$("home-import-btn").addEventListener("click", () => $("home-import-file").click());
$("home-import-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    await importJson(file);
  } catch (e) {
    alert(`Ошибка импорта: ${e.message}`);
  }
  ev.target.value = "";
});

// ---------- boot ----------
const refresh = async () => {
  [entries, active, feedings] = await Promise.all([
    api("/api/entries"),
    api("/api/active"),
    api("/api/feedings"),
  ]);
  renderTimer();
  tick();
  renderJournal();
  prefillFeedingForm();
  renderFeedingJournal();
  renderDay();
};

refresh();
setInterval(() => {
  tick();
  if (entries.some((e) => !e.ended_at)) renderJournal(); // обновляем длительность активных
}, 1000);
