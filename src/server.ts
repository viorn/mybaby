import type { ServerWebSocket } from "bun";
import {
  createEntry,
  createFeeding,
  deleteEntry,
  deleteFeeding,
  getActive,
  getEntry,
  getFeeding,
  listEntries,
  listEntriesRange,
  listFeedings,
  listFeedingsRange,
  startSleep,
  stopSleep,
  updateEntry,
  updateFeeding,
  type Entry,
  type Feeding,
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
// Открытые WebSocket-соединения + рассылка уведомлений об изменениях
const sockets = new Set<ServerWebSocket<unknown>>();

const broadcast = (msg: object) => {
  const data = JSON.stringify(msg);
  for (const ws of sockets) ws.send(data);
};

const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "0.0.0.0",
  // ---------- WebSocket: уведомления клиентов об изменениях ----------
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    close(ws) {
      sockets.delete(ws);
    },
    message() {},
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 400 });
    }

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
        const created = createEntry(body.started_at, body.ended_at ?? null, body.note ?? "");
        broadcast({ type: "changed" });
        return json(created, 201);
      }

      if (pathname === "/api/export" && req.method === "GET") {
        const from = url.searchParams.get("from"); // YYYY-MM-DD
        const to = url.searchParams.get("to"); // YYYY-MM-DD
        const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

        // Границы по местному времени сервера (даты в журнале локальные)
        const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : "0000-01-01T00:00:00.000Z";
        const toIso = to ? new Date(`${to}T23:59:59.999`).toISOString() : "9999-12-31T23:59:59.999Z";

        const sleepRows = listEntriesRange(fromIso, toIso);
        const feedingRows = listFeedingsRange(fromIso, toIso);
        const suffix = from || to ? `-${from ?? "start"}_${to ?? "end"}` : "-all";

        if (format === "json") {
          const payload = { entries: sleepRows, feedings: feedingRows };
          return new Response(JSON.stringify(payload, null, 2), {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="mybaby${suffix}.json"`,
            },
          });
        }

        const csv = `${toCsv(sleepRows)}\n\n${toFeedingsCsv(feedingRows)}`;
        return new Response(`\uFEFF${csv}`, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="mybaby${suffix}.csv"`,
          },
        });
      }

      // ---------- Импорт ----------
      if (pathname === "/api/import" && req.method === "POST") {
        // Форматы: массив записей (+type=entries|feedings) или объект {entries, feedings}
        const type = url.searchParams.get("type") === "feedings" ? "feedings" : "entries";
        let entriesItems: any[] = [];
        let feedingsItems: any[] = [];

        if (Array.isArray(body)) {
          if (type === "entries") entriesItems = body;
          else feedingsItems = body;
        } else if (Array.isArray(body?.items)) {
          if (type === "entries") entriesItems = body.items;
          else feedingsItems = body.items;
        } else if (Array.isArray(body?.entries) || Array.isArray(body?.feedings)) {
          entriesItems = Array.isArray(body.entries) ? body.entries : [];
          feedingsItems = Array.isArray(body.feedings) ? body.feedings : [];
        } else {
          return json({ error: "Ожидается массив записей или объект {entries, feedings}" }, 400);
        }

        let importedEntries = 0;
        let importedFeedings = 0;
        for (const it of entriesItems) {
          if (!it?.started_at) continue;
          createEntry(String(it.started_at), it.ended_at ? String(it.ended_at) : null, String(it.note ?? ""));
          importedEntries++;
        }
        for (const it of feedingsItems) {
          if (!it?.at) continue;
          createFeeding(String(it.at), Math.max(0, Math.round(Number(it.amount_ml) || 0)));
          importedFeedings++;
        }
        broadcast({ type: "changed" });
        return json({ ok: true, importedEntries, importedFeedings });
      }

      // ---------- Питание ----------
      if (pathname === "/api/feedings" && req.method === "GET") {
        return json(listFeedings());
      }

      if (pathname === "/api/feedings" && req.method === "POST") {
        if (!body.at) return json({ error: "at is required" }, 400);
        const amount = Math.max(0, Math.round(Number(body.amount_ml) || 0));
        const created = createFeeding(body.at, amount);
        broadcast({ type: "changed" });
        return json(created, 201);
      }

      const fm = pathname.match(/^\/api\/feedings\/(\d+)$/);
      if (fm && (req.method === "PATCH" || req.method === "DELETE")) {
        const fid = Number(fm[1]);
        if (!getFeeding(fid)) return json({ error: "Запись не найдена" }, 404);

        if (req.method === "DELETE") {
          const res = { ok: deleteFeeding(fid) };
          broadcast({ type: "changed" });
          return json(res);
        }

        if (!body.at) return json({ error: "at is required" }, 400);
        const amount = Math.max(0, Math.round(Number(body.amount_ml) || 0));
        const updated = updateFeeding(fid, body.at, amount);
        broadcast({ type: "changed" });
        return json(updated);
      }

      if (pathname === "/api/timer/start" && req.method === "POST") {
        if (getActive()) return json({ error: "Сон уже активен" }, 409);
        const created = startSleep(new Date().toISOString(), body.note ?? "");
        broadcast({ type: "changed" });
        return json(created, 201);
      }

      if (pathname === "/api/timer/stop" && req.method === "POST") {
        const active = getActive();
        if (!active) return json({ error: "Нет активного сна" }, 409);
        const updated = stopSleep(active.id, new Date().toISOString());
        broadcast({ type: "changed" });
        return json(updated);
      }

      let id: number;
      const m = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        id = Number(m[1]);
        if (!getEntry(id)) return json({ error: "Запись не найдена" }, 404);

        if (req.method === "DELETE") {
          const res = { ok: deleteEntry(id) };
          broadcast({ type: "changed" });
          return json(res);
        }

        // PATCH: { started_at, ended_at|null, note }
        if (!body.started_at) return json({ error: "started_at is required" }, 400);
        const updated = updateEntry(id, body.started_at, body.ended_at ?? null, body.note ?? "");
        broadcast({ type: "changed" });
        return json(updated);
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

const toFeedingsCsv = (rows: Feeding[]) => {
  const head = ["id", "date", "time", "amount_ml"];
  const lines = rows.map((f) => {
    const d = new Date(f.at);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return [
      f.id,
      date,
      localDateTime(f.at).slice(11),
      f.amount_ml,
    ]
      .map(csvCell)
      .join(";");
  });
  return ["КОРМЛЕНИЕ", head.join(";"), ...lines].join("\n");
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
  return ["СОН", head.join(";"), ...lines].join("\n");
};

console.log(`👶 Baby sleep tracker → http://localhost:${server.port}`);
