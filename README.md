# 🌙 mybaby — трекер сна ребёнка

Минималистичное веб-приложение для личного использования: учёт сна малыша без авторизации, разворачивается на локальном сервере.

## Возможности

- **Таймер сна** — кнопка «Начать сон» / «Разбудить» с живым счётчиком времени
- **Журнал** — записи, сгруппированные по дням: время начала/конца, длительность, заметка
- **Редактирование** — клик по записи открывает диалог: изменение времени, заметки, удаление
- **Ручное добавление** — если забыли включить таймер
- **Экспорт** — CSV и JSON за выбранный диапазон дат или за всё время
- Один бинарь без зависимостей (Bun `--compile`)

## Стек

- [Bun](https://bun.sh) + TypeScript (сервер на `Bun.serve`)
- SQLite через встроенный `bun:sqlite` (файл `sleep.db`, режим WAL)
- Ванильные HTML/CSS/JS без сборки фронтенда

## Структура

```
src/server.ts   — HTTP-сервер: REST API + статика (встраивается в бинарь)
src/db.ts       — SQLite: таблица entries (started_at, ended_at, note)
public/         — фронтенд (index.html, style.css, app.js)
```

## Запуск

### Из исходников (нужен Bun)

```bash
bun install        # только @types/bun для IDE
bun run dev        # → http://localhost:3000
```

### Готовый бинарь

```bash
bun run build      # собирает ./mybaby (~79 МБ, статика встроена)
./mybaby           # → http://localhost:3000
```

Бинарь автономен: можно скопировать на сервер без Bun/Node. База `sleep.db` создаётся в **текущей рабочей директории** запуска.

### Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт прослушивания |
| `HOST` | `0.0.0.0` | Интерфейс (`127.0.0.1` — только localhost) |

```bash
PORT=8080 ./mybaby
```

## API

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/timer/start` | Начать сон (тело: `{"note": "..."}`) |
| `POST` | `/api/timer/stop` | Разбудить — завершает активный сон |
| `GET` | `/api/active` | Активная запись или `null` |
| `GET` | `/api/entries` | Последние 200 записей |
| `POST` | `/api/entries` | Добавить запись `{"started_at", "ended_at?", "note?"}` |
| `PATCH` | `/api/entries/:id` | Изменить запись |
| `DELETE` | `/api/entries/:id` | Удалить запись |
| `GET` | `/api/export?format=csv\|json&from=YYYY-MM-DD&to=YYYY-MM-DD` | Экспорт (`from`/`to` необязательны) |

Время в API — ISO UTC; в UI и CSV — локальное время сервера.

CSV: разделитель `;`, BOM, колонки `id;date;start;end;duration_min;note` — открывается в Excel без настроек.

## Развёртывание

Пример юнита systemd:

```ini
[Unit]
Description=Baby sleep tracker
After=network.target

[Service]
WorkingDirectory=/opt/mybaby
ExecStart=/opt/mybaby/mybaby
Environment=PORT=3000
Restart=on-failure
User=youruser

[Install]
WantedBy=multi-user.target
```

> **Безопасность:** авторизации нет — любой с доступом к порту может менять данные. Для доступа извне используйте файрвол или обратный прокси (nginx/caddy) с basic-auth и HTTPS.
