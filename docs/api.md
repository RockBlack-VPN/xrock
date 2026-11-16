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

## Ресурсы роутера

`GET /api/sys` — CPU, память, температура (обновляется опросом раз в 3–5 с):

```json
{
  "ok": true,
  "cpuPct": 7,
  "load1": 0.12,
  "memTotal": 1014996,
  "memAvail": 496372,
  "memUsedPct": 51,
  "tempMax": 56.4,
  "temps": [ { "name": "soc_thermal", "c": 56.4 }, { "name": "eth2p5g_thermal0", "c": 54.6 } ],
  "uptimeSec": 85583,
  "arch": "aarch64",
  "model": "Keenetic"
}
```

`tempMax` — максимум по всем термодатчикам `/sys/class/thermal/thermal_zone*` (целые градусы,
как отдаёт ядро). Если датчиков нет — `tempMax: 0`.

## Версии и обновления

`GET /api/versions` — текущие и последние доступные версии (последние запрашиваются у GitHub
и кешируются на 10 минут):

```json
{
  "xrock":  { "current": "0.1.0", "latest": "0.2.0", "updateAvailable": true },
  "mihomo": { "current": "v1.19.34", "latest": "v1.19.34", "updateAvailable": false },
  "checkedAt": 1794736345
}
```

`POST /api/upgrade/core` — обновить ядро mihomo через XKeen (`xkeen -um auto`) и перезапустить
Xray/mihomo. Синхронный, может занять до 2–3 минут; ответ:

```json
{ "ok": true, "before": "v1.19.34", "after": "v1.19.36",
  "log": ["Обновляю Mihomo…", "…"] }
```
При ошибке — `{"ok":false,"error":"…","log":[…]}` и код 502; старый бинарник продолжает работать.

`POST /api/upgrade/panel` — обновить сам xrock: демон скачивает `xrock-latest.tar.gz` из
последнего релиза GitHub, подменяет бинарник и UI, затем перезапускает сервис (ответ
отдаётся до перезапуска):

```json
{ "ok": true, "before": "0.1.0", "after": "0.2.0", "restarting": true }
```

## ASN и страна по IP

Нужно для «куда ушёл трафик» в деталях соединения/журнала.

`GET /api/asn?ip=1.2.3.4`:

```json
{
  "ip": "151.101.192.176", "status": "success",
  "country": "Canada", "countryCode": "CA",
  "as": "AS54113 Fastly, Inc.", "asn": 54113, "asname": "FASTLY",
  "isp": "Fastly, Inc.", "org": "",
  "cached": true
}
```

`GET /api/asn?ips=1.1.1.1,2.2.2.2` (до 10 адресов) → `{"results":{"1.1.1.1":{…},…}}`.

Источник — бесплатный `ip-api.com` (лимит 45 запросов/мин), поэтому демон кеширует ответы
на 24 часа. Если сети нет — `{"status":"fail","err":"нет связи с ip-api.com"}`.

