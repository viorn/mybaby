// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // status нужен для тихой обработки конфликтов (409) между клиентами
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
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
const lastEndedAt = () => entries.find((e) => e.ended_at)?.ended_at;

const renderTimer = () => {
  const pairs = [
    { status: $("timer-status"), elapsed: $("timer-elapsed"), btn: $("timer-btn") },
    { status: $("home-status"), elapsed: $("home-elapsed"), btn: $("home-sleep-btn") },
  ];

  for (const { status, elapsed, btn } of pairs) {
    if (active) {
      const started = new Date(active.started_at);
      status.textContent = `😴 Спит с ${started.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
      status.classList.add("active");
      status.title = "Нажмите, чтобы изменить время старта";
      elapsed.classList.remove("hidden", "awake");
      elapsed.textContent = fmtClock(Date.now() - started);
      btn.textContent = "Разбудить";
      btn.classList.add("stop");
    } else {
      status.textContent = "🙂 Не спит";
      status.classList.remove("active");
      status.removeAttribute("title");
      btn.textContent = "Начать сон";
      btn.classList.remove("stop");
      const lastEnded = lastEndedAt();
      if (lastEnded) {
        elapsed.classList.remove("hidden");
        elapsed.classList.add("awake");
        elapsed.textContent = fmtClock(Date.now() - new Date(lastEnded).getTime());
      } else {
        elapsed.classList.add("hidden");
      }
    }
  }

  for (const id of ["timer-note-wrap", "home-note-wrap"]) {
    $(id).classList.toggle("hidden", !!active);
  }
};

const tick = () => {
  refreshOpenFormTimes();
  const now = Date.now();
  if (active) {
    const ms = fmtClock(now - new Date(active.started_at));
    $("timer-elapsed").textContent = ms;
    $("home-elapsed").textContent = ms;
  } else {
    const lastEnded = lastEndedAt();
    if (lastEnded) {
      const ms = fmtClock(now - new Date(lastEnded).getTime());
      for (const id of ["timer-elapsed", "home-elapsed"]) {
        const el = $(id);
        el.textContent = ms;
        el.classList.add("awake");
      }
    }
  }
  renderLastSleep();
};

// Абсолютное время окончания последнего сна
const renderLastSleep = () => {
  let text = null;
  const lastEnded = lastEndedAt();
  if (!active && lastEnded) {
    const ended = new Date(lastEnded);
    const now = new Date();
    const timeStr = ended.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    text =
      ended.toDateString() === now.toDateString()
        ? `Последний сон закончился в ${timeStr}`
        : `Последний сон закончился ${timeStr} ${ended.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
  }
  for (const id of ["last-sleep", "home-last"]) {
    const el = $(id);
    el.classList.toggle("hidden", !text);
    if (text) el.textContent = text;
  }
};

let sleepBusy = false;

const toggleSleep = async () => {
  if (sleepBusy) return; // защита от двойного клика и гонки между устройствами
  sleepBusy = true;
  for (const id of ["timer-btn", "home-sleep-btn"]) $(id).disabled = true;
  try {
    if (active) {
      await api("/api/timer/stop", { method: "POST" });
    } else {
      const note = $("home-note").value.trim() || $("timer-note").value.trim();
      await api("/api/timer/start", { method: "POST", body: JSON.stringify({ note }) });
      $("home-note").value = "";
      $("timer-note").value = "";
    }
    await refresh();
  } catch (e) {
    // 409: другой клиент уже переключил состояние — просто синхронизируемся
    if (e.status === 409) await refresh();
    else alert(e.message);
  } finally {
    sleepBusy = false;
    for (const id of ["timer-btn", "home-sleep-btn"]) $(id).disabled = false;
  }
};

$("timer-btn").addEventListener("click", toggleSleep);
$("home-sleep-btn").addEventListener("click", toggleSleep);

// Клик по статусу активного сна — правка времени старта (диалог редактирования)
for (const id of ["timer-status", "home-status"]) {
  $(id).addEventListener("click", () => {
    if (active) openEdit(active);
  });
}

// Сон по календарным суткам: пересечение интервалов сна с каждым днём.
// Ночной сон через полночь делится между сутками; активный сон считается до «сейчас».
const sleepMsByDay = (fromTs = -Infinity, toTs = Infinity) => {
  const totals = new Map();
  for (const e of entries) {
    let s = Math.max(new Date(e.started_at).getTime(), fromTs);
    const en = Math.min(e.ended_at ? new Date(e.ended_at).getTime() : Date.now(), toTs);
    if (s >= en) continue;
    while (s < en) {
      const d = new Date(s);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const seg = Math.min(en, dayEnd) - s;
      const key = d.toDateString();
      totals.set(key, (totals.get(key) || 0) + seg);
      s = dayEnd;
    }
  }
  return totals;
};

// ---------- journal ----------
const renderJournal = () => {
  const list = $("journal");
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = '<li class="empty">Пока нет записей</li>';
    return;
  }

  // Итог сна за каждый день (ночной сон через полночь делится между днями)
  const dayTotals = sleepMsByDay();

  let lastDay = null;
  for (const e of entries) {
    const start = new Date(e.started_at);
    const dayKey = start.toDateString();

    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const li = document.createElement("li");
      li.className = "day-label";
      li.innerHTML =
        `${escapeHtml(dayName(start))} ` +
        `<span class="feeding-day-total">(${fmtDuration(dayTotals.get(dayKey) || 0)})</span>`;
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
const TAB_KEY = "mybaby:tab";
const TABS = ["home", "sleep", "feeding", "week"];

const showTab = (name) => {
  if (!TABS.includes(name)) name = "home";
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  for (const tab of TABS) {
    $(`tab-${tab}`).classList.toggle("hidden", tab !== name);
  }
  localStorage.setItem(TAB_KEY, name);
};

document.querySelectorAll(".tab-btn").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab))
);

// открываем вкладку, которая была активна в прошлый раз
showTab(localStorage.getItem(TAB_KEY) || "home");

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
    for (const id of ["add-start", "add-end", "add-note"]) delete $(id).dataset.dirty;
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

  // Итоги по дням считаем заранее
  const totals = new Map();
  for (const f of feedings) {
    const key = new Date(f.at).toDateString();
    totals.set(key, (totals.get(key) || 0) + f.amount_ml);
  }

  let lastDay = null;
  for (const f of feedings) {
    const at = new Date(f.at);
    const dayKey = at.toDateString();

    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const li = document.createElement("li");
      li.className = "day-label";
      li.innerHTML =
        `${escapeHtml(dayName(at))} ` +
        `<span class="feeding-day-total">(${totals.get(dayKey)} мл)</span>`;
      list.appendChild(li);
    }

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
};

const FEEDING_AMOUNT_IDS = ["home-feeding-amount", "tab-feeding-amount"];
const FEEDING_LAST_IDS = ["home-feeding-last", "tab-feeding-last"];

// Поля, которые пользователь редактирует, не перезаписываются при refresh
const isDirty = (el) => el.dataset.dirty === "1";
for (const id of [
  ...FEEDING_AMOUNT_IDS,
  "feeding-add-amount",
  "feeding-add-at",
  "add-start",
  "add-end",
  "add-note",
]) {
  $(id).addEventListener("input", (e) => {
    e.target.dataset.dirty = "1";
  });
}

// Актуализируем время в открытых формах, если пользователь его не менял
const refreshOpenFormTimes = () => {
  const now = toLocalInput(new Date().toISOString());
  if (!$("feeding-add-form").classList.contains("hidden") && !isDirty($("feeding-add-at"))) {
    $("feeding-add-at").value = now;
  }
  if (!$("add-form").classList.contains("hidden") && !isDirty($("add-start"))) {
    $("add-start").value = now;
  }
};

const prefillFeedingForm = () => {
  const saved = Number(localStorage.getItem(AMOUNT_KEY));
  const lastServer = feedings[0]?.amount_ml;
  const amount = saved || lastServer || 60;
  for (const id of [...FEEDING_AMOUNT_IDS, "feeding-add-amount"]) {
    const el = $(id);
    if (!isDirty(el)) el.value = amount;
  }
};

// Последнее кормление — статус в виджетах
const renderLastFeeding = () => {
  const last = feedings[0];
  let text = null;
  if (last) {
    const at = new Date(last.at);
    const dayStr =
      at.toDateString() === new Date().toDateString()
        ? ""
        : at.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + " ";
    text = `Последнее кормление: ${dayStr}${at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · ${last.amount_ml} мл`;
  }
  for (const id of FEEDING_LAST_IDS) {
    const el = $(id);
    el.classList.toggle("hidden", !text);
    if (text) el.textContent = text;
  }
};

// Запись «сейчас» (кнопки на главной и на вкладке питания)
const saveFeedingNow = async (amountId) => {
  const amount = Math.max(0, Math.round(Number($(amountId).value) || 0));
  try {
    await api("/api/feedings", {
      method: "POST",
      body: JSON.stringify({ at: new Date().toISOString(), amount_ml: amount }),
    });
    localStorage.setItem(AMOUNT_KEY, String(amount));
    delete $(amountId).dataset.dirty;
    await refresh();
  } catch (e) {
    alert(e.message);
  }
};

$("home-feeding-save").addEventListener("click", () => saveFeedingNow("home-feeding-amount"));
$("tab-feeding-save").addEventListener("click", () => saveFeedingNow("tab-feeding-amount"));

// ---------- добавление кормления вручную ----------
$("feeding-add-btn").addEventListener("click", () => {
  $("feeding-add-form").classList.toggle("hidden");
  $("feeding-add-at").value = toLocalInput(new Date().toISOString());
});

$("feeding-add-cancel").addEventListener("click", () => $("feeding-add-form").classList.add("hidden"));

$("feeding-add-save").addEventListener("click", async () => {
  if (!$("feeding-add-at").value) return alert("Укажите время");
  const amount = Math.max(0, Math.round(Number($("feeding-add-amount").value) || 0));
  try {
    await api("/api/feedings", {
      method: "POST",
      body: JSON.stringify({ at: fromLocalInput($("feeding-add-at").value), amount_ml: amount }),
    });
    localStorage.setItem(AMOUNT_KEY, String(amount));
    $("feeding-add-form").classList.add("hidden");
    delete $("feeding-add-amount").dataset.dirty;
    delete $("feeding-add-at").dataset.dirty;
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});

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

  // Часы 0..24: на узких экранах подписываем каждую 2-ю часовую отметку,
  // иначе цифры сливаются
  const step = timeline.clientWidth < 380 ? 2 : 1;
  $("home-hours").innerHTML = Array.from(
    { length: Math.floor(24 / step) + 1 },
    (_, i) => `<span>${i * step}</span>`
  ).join("");

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

// Пересчитываем шаг подписей часов при изменении ширины экрана
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderDay, 200);
});

// ---------- обзор недели ----------
let weekOffset = 0; // 0 = текущая неделя
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

// Полночь понедельника выбранной недели (неделя начинается с понедельника)
const startOfWeek = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
};

// Компактный формат часов для подписи над столбцом: «8,5 ч» / «11 ч»
const fmtHoursShort = (ms) => {
  const h = ms / 3600000;
  return `${(h >= 10 ? Math.round(h) : Math.round(h * 10) / 10).toLocaleString("ru-RU")} ч`;
};

const renderWeek = () => {
  const ws = startOfWeek(weekOffset);
  const we = new Date(ws);
  we.setDate(we.getDate() + 7);
  const wsT = ws.getTime();
  const weT = we.getTime();
  const now = Date.now();
  const fmtShort = (d) => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

  $("week-label").textContent = `${fmtShort(ws)} — ${fmtShort(new Date(weT - 1))}`;
  $("week-next").disabled = weekOffset >= 0;

  // --- агрегация по дням недели ---
  const sleepByDay = sleepMsByDay(wsT, weT);
  const feedByDay = new Map(); // toDateString -> { count, ml }
  for (const f of feedings) {
    const t = new Date(f.at).getTime();
    if (t < wsT || t >= weT) continue;
    const key = new Date(t).toDateString();
    const cur = feedByDay.get(key) || { count: 0, ml: 0 };
    cur.count += 1;
    cur.ml += f.amount_ml;
    feedByDay.set(key, cur);
  }

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(ws);
    d.setDate(d.getDate() + i);
    return d;
  });
  const todayKey = new Date().toDateString();

  // --- график: 7 столбцов, высота ∝ часам сна ---
  const maxMs = Math.max(...days.map((d) => sleepByDay.get(d.toDateString()) || 0), 3600000);
  const chart = $("week-chart");
  chart.innerHTML = "";
  for (const d of days) {
    const key = d.toDateString();
    const ms = sleepByDay.get(key) || 0;
    const isFuture = d.getTime() > now;
    const h = ms > 0 ? Math.max(6, Math.round((ms / maxMs) * 100)) : 0;
    const col = document.createElement("div");
    col.className = "wc-col" + (key === todayKey ? " today" : "") + (isFuture ? " future" : "");
    col.innerHTML = `
      <span class="wc-val">${ms ? fmtHoursShort(ms) : ""}</span>
      <div class="wc-bar" style="height:${h}%"></div>
      <span class="wc-day">${WEEKDAYS[(d.getDay() + 6) % 7]}</span>
    `;
    chart.appendChild(col);
  }

  // --- таблица по дням; клик — «Обзор дня» за эту дату ---
  const table = $("week-table");
  table.innerHTML =
    "<thead><tr><th>День</th><th>😴 Сон</th><th>🍼 Кол-во</th><th>Объём</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const d of days) {
    const key = d.toDateString();
    const ms = sleepByDay.get(key) || 0;
    const fd = feedByDay.get(key);
    const isFuture = d.getTime() > now;
    const tr = document.createElement("tr");
    tr.className = (key === todayKey ? "today-row" : "") + (isFuture ? " future" : "");
    tr.innerHTML = `
      <td>${fmtShort(d)}</td>
      <td>${ms ? fmtDuration(ms) : "—"}</td>
      <td>${fd ? fd.count : "—"}</td>
      <td>${fd ? fd.ml + " мл" : "—"}</td>
    `;
    tr.addEventListener("click", () => {
      $("home-day-date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      renderDay();
      showTab("home");
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // --- сводка ---
  const totalSleep = [...sleepByDay.values()].reduce((a, b) => a + b, 0);
  const totalFeed = [...feedByDay.values()].reduce(
    (a, b) => ({ count: a.count + b.count, ml: a.ml + b.ml }),
    { count: 0, ml: 0 }
  );
  // Средние считаем только по прошедшим дням недели
  const countedDays = Math.max(1, days.filter((d) => d.getTime() <= now).length);
  const avgFeedMl = totalFeed.count ? Math.round(totalFeed.ml / totalFeed.count) : 0;
  $("week-summary").innerHTML = `
    <span>😴 Сон: <b>${fmtDuration(totalSleep)}</b> · ${fmtDuration(totalSleep / countedDays)}/сут</span>
    <span>🍼 Кормлений: <b>${totalFeed.count}</b> · ${(totalFeed.count / countedDays).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}/сут</span>
    <span>🥛 Объём: <b>${totalFeed.ml} мл</b> · среднее ${avgFeedMl} мл</span>
  `;
};

$("week-prev").addEventListener("click", () => {
  weekOffset -= 1;
  renderWeek();
});
$("week-next").addEventListener("click", () => {
  weekOffset += 1;
  renderWeek();
});

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
  renderLastFeeding();
  renderDay();
  renderWeek();
  refreshOpenFormTimes();
};

refresh();

// ---------- WebSocket: сервер сообщает об изменениях ----------
const connectWs = () => {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      if (JSON.parse(ev.data).type === "changed") refresh();
    } catch {
      /* игнорируем некорректные сообщения */
    }
  };
  ws.onclose = () => setTimeout(connectWs, 3000); // авто-переподключение
  ws.onerror = () => ws.close();
};

connectWs();

setInterval(() => {
  tick();
  if (entries.some((e) => !e.ended_at)) renderJournal(); // обновляем длительность активных
}, 1000);
