import {
  createEntry,
  deleteEntry,
  getActive,
  getEntry,
  listEntries,
  listEntriesRange,
  startSleep,
  stopSleep,
  updateEntry,
  type Entry,
} from "./db";
import indexHtml from "../public/index.html" with { type: "file" };
import styleCss from "../public/style.css" with { type: "file" };
import appJs from "../public/app.js" with { type: "file" };

const PORT = Number(process.env.PORT ?? 3000);

// Статика: работает и из исходников, и из скомпилированного бинаря
// (в рантайме это пути к файлам, при компиляции — встроенные ресурсы)
const STATIC_FILES: Record<string, string> = {
  "/": indexHtml as unknown as string,
  "/index.html": indexHtml as unknown as string,
  "/style.css": styleCss as unknown as string,
  "/app.js": appJs as unknown as string,
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// По умолчанию слушает все интерфейсы (0.0.0.0); переопределяется через HOST
const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // ---------- API ----------
    if (pathname.startsWith("/api/")) {
      const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => ({})) : {};

      if (pathname === "/api/active" && req.method === "GET") {
        return json(getActive() ?? null);
      }

      if (pathname === "/api/entries" && req.method === "GET") {
        return json(listEntries());
      }

      if (pathname === "/api/entries" && req.method === "POST") {
        // Ручное добавление записи: { started_at, ended_at?, note? }
        if (!body.started_at) return json({ error: "started_at is required" }, 400);
        return json(createEntry(body.started_at, body.ended_at ?? null, body.note ?? ""), 201);
      }

      if (pathname === "/api/export" && req.method === "GET") {
        const from = url.searchParams.get("from"); // YYYY-MM-DD
        const to = url.searchParams.get("to"); // YYYY-MM-DD
        const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

        // Границы по местному времени сервера (даты в журнале локальные)
        const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : "0000-01-01T00:00:00.000Z";
        const toIso = to ? new Date(`${to}T23:59:59.999`).toISOString() : "9999-12-31T23:59:59.999Z";

        const rows = listEntriesRange(fromIso, toIso);
        const suffix = from || to ? `-${from ?? "start"}_${to ?? "end"}` : "-all";

        if (format === "json") {
          return new Response(JSON.stringify(rows, null, 2), {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="sleep${suffix}.json"`,
            },
          });
        }

        const csv = toCsv(rows);
        return new Response(`\uFEFF${csv}`, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="sleep${suffix}.csv"`,
          },
        });
      }

      if (pathname === "/api/timer/start" && req.method === "POST") {
        if (getActive()) return json({ error: "Сон уже активен" }, 409);
        return json(startSleep(new Date().toISOString(), body.note ?? ""), 201);
      }

      if (pathname === "/api/timer/stop" && req.method === "POST") {
        const active = getActive();
        if (!active) return json({ error: "Нет активного сна" }, 409);
        return json(stopSleep(active.id, new Date().toISOString()));
      }

      let id: number;
      const m = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        id = Number(m[1]);
        if (!getEntry(id)) return json({ error: "Запись не найдена" }, 404);

        if (req.method === "DELETE") return json({ ok: deleteEntry(id) });

        // PATCH: { started_at, ended_at|null, note }
        if (!body.started_at) return json({ error: "started_at is required" }, 400);
        return json(updateEntry(id, body.started_at, body.ended_at ?? null, body.note ?? ""));
      }

      return json({ error: "Not found" }, 404);
    }

    // ---------- Статика ----------
    const asset = STATIC_FILES[pathname];
    if (asset) return new Response(Bun.file(asset));

    return new Response("Not found", { status: 404 });
  },
});

// ---------- CSV ----------
const pad = (n: number) => String(n).padStart(2, "0");

const localDateTime = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const durationMinutes = (e: Entry) => {
  const end = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
  return Math.round((end - new Date(e.started_at).getTime()) / 60000);
};

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (rows: Entry[]) => {
  const head = ["id", "date", "start", "end", "duration_min", "note"];
  const lines = rows.map((e) => {
    const d = new Date(e.started_at);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return [
      e.id,
      date,
      localDateTime(e.started_at).slice(11),
      e.ended_at ? localDateTime(e.ended_at).slice(11) : "",
      durationMinutes(e),
      e.note,
    ]
      .map(csvCell)
      .join(";");
  });
  return [head.join(";"), ...lines].join("\n");
};

console.log(`👶 Baby sleep tracker → http://localhost:${server.port}`);
