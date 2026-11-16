# xrock — HTTP API демона

UI (статика, отдаётся mihomo по `/ui`) обращается к демону `xrock` на `http://<router>:9091`.
Демон сам ходит в Clash API mihomo (secret остаётся на сервере) и наружу отдаёт только эти
эндпоинты. CORS: `Access-Control-Allow-Origin: *` для `/api/*`.

## Состояние

`GET /api/state`

```json
{
  "ok": true,
  "version": "0.1.0",
  "now": 1794736345,
  "mihomo": { "version": "v1.19.34", "api": "127.0.0.1:9090", "secret": true },
  "groups": [
    { "name": "PROXY", "type": "Selector", "now": "Fallback",
      "all": ["Fallback", "Fastest", "🇩🇪 Germany-31s(xHTTP)", "..."],
      "icon": "" }
  ],
  "proxies": [
    { "name": "🇩🇪 Germany-31s(xHTTP)", "type": "Vless", "udp": true,
      "provider": "subscription", "alive": true }
  ],
  "providers": [
    { "name": "subscription", "type": "Proxy", "vehicleType": "HTTP",
      "updatedAt": "2026-11-16T12:00:00Z", "proxyCount": 62,
      "subscriptionInfo": { "upload": 0, "download": 908322977802,
                            "total": 0, "expire": 1888617600 },
      "testUrl": "http://www.gstatic.com/generate_204", "interval": 300 }
  ],
  "watchdog": {
    "enabled": true, "group": "PROXY", "intervalSec": 10, "failsToSwitch": 2,
    "current": "🇩🇪 Germany-31s(xHTTP)", "currentOK": true,
    "dead": ["🇹🇷 Türkiye-2s(xHTTP)"],
    "lastRound": 1794736343, "running": true,
    "targets": [ { "name": "YouTube", "url": "https://www.youtube.com/generate_204" } ],
    "lastCheck": { "name": "🇩🇪 Germany-31s(xHTTP)", "t": 1794736343,
                   "results": [ { "target": "YouTube", "ok": true, "ms": 111 },
                                { "target": "Telegram", "ok": false, "ms": 0, "err": "timeout" } ] }
  },
  "stats": {
    "🇩🇪 Germany-31s(xHTTP)": { "delay": 111, "ok": true, "fails": 0,
      "lastT": 1794736343, "okSince": 1794736200,
      "history": [ { "t": 1794736343, "ms": 111, "fail": false } ] }
  },
  "events": [ { "t": 1794736343, "kind": "warn", "group": "PROXY", "text": "..." } ],
  "traffic": { "up": 1234567, "down": 7654321, "conns": 42 }
}
```

`kind` события: `info` | `warn` | `bad` | `ok`.

## Действия

| Метод и путь | Тело | Что делает |
|---|---|---|
| `POST /api/watch` | `{ "enabled": true, "group": "PROXY", "intervalSec": 10, "failsToSwitch": 2, "targets": [{"name":"YouTube","url":"..."}] }` | меняет настройки сторожа (любое поле опционально) |
| `POST /api/select` | `{ "group": "PROXY", "name": "🇩🇪 Germany-31s(xHTTP)" }` | переключает группу через Clash API |
| `POST /api/test` | `{ "names": ["..."], "url": "https://www.youtube.com/generate_204" }` | **проксированный** замер задержки (Clash API `/proxies/{name}/delay`); если `names` пусто — все узлы групп. Ответ: `{ "results": { "имя": { "delay": 111, "err": "" } } }` |
| `POST /api/speedtest` | `{ "name": "..." }` | (0.2) скорость через прокси, пока не реализовано — 501 |
| `POST /api/providers/update` | `{ "name": "subscription" }` | обновить подписку (`PUT /providers/proxies/{name}`) |
| `POST /api/switch/test` | `{ "group": "PROXY", "name": "..." }` | проверить сервер и, если живой, выбрать (для кнопки «проверить и переключить») |

## Потоки (SSE)

| Путь | События |
|---|---|
| `GET /api/stream/traffic` | `data: {"up":123,"down":456}` каждую секунду |
| `GET /api/stream/logs?level=info` | `data: {"type":"info","payload":"..."}` из Clash API `/logs` |

## Соединения / правила / провайдеры

| Путь | Ответ |
|---|---|
| `GET /api/connections` | как `/connections` Clash API + поля `up`/`down`/`conns` |
| `DELETE /api/connections?id=<id>` | закрыть соединение |
| `DELETE /api/connections` | закрыть все |
| `GET /api/rules` | `{ "rules": [ { "type": "...", "payload": "...", "proxy": "..." } ] }` |

## Проверка живости

`GET /api/ping` → `{"ok":true,"version":"0.1.0"}` (без обращения к mihomo).
