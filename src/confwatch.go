package main

// Конфиг mihomo могут переписать (обновление XKeen, переустановка, «удалил
// config.yaml и поднял заново»). Демон не должен умирать до перезапуска:
// раз в 15 секунд перечитываем config.yaml, а если Clash API перестал отвечать
// по LAN-адресу — пробуем loopback (на роутере mihomo обычно слушает только его).

import (
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

const confPollInterval = 15 * time.Second

// Последнее, что прочитали из файла. Сравниваем с файлом, а не с текущим
// клиентом: иначе автопереход на loopback откатывался бы на каждом тике.
var confState struct {
	mu     sync.Mutex
	api    string
	secret string
	read   bool
}

// reloadConf перечитывает config.yaml и, если там появился новый адрес или
// секрет, переключает клиент. Флаги -api/-secret имеют приоритет.
func (a *app) reloadConf() bool {
	if *flagAPI != "" && *flagSecret != "" {
		return false
	}
	mc := readMihomoConf(*flagConfDir)
	if !mc.Found {
		return false
	}
	api := *flagAPI
	if api == "" {
		api = localAPI(mc.API)
	}
	secret := *flagSecret
	if secret == "" {
		secret = mc.Secret
	}
	if api == "" {
		return false
	}

	confState.mu.Lock()
	same := confState.read && confState.api == api && confState.secret == secret
	if !same {
		confState.api = api
		confState.secret = secret
		confState.read = true
	}
	confState.mu.Unlock()
	if same {
		return false
	}

	if !a.cl.setAuth(api, secret) {
		return false
	}
	invalidateProxies()
	log.Printf("config.yaml перечитан: Clash API %s", a.cl.baseURL())
	a.addEvent("info", "", "mihomo: перечитан config.yaml (Clash API "+a.cl.baseURL()+")")
	if _, err := a.cl.versionFast(); err != nil {
		// новый адрес может быть недоступен (внешний IP на роутере) — пробуем loopback
		a.probeLoopback()
	}
	return true
}

// probeLoopback: текущий адрес не localhost и API молчит — проверяем тот же порт
// на 127.0.0.1. На роутере внешний адрес может заворачиваться в прокси, и тогда
// соединение к нему висит до таймаута.
func (a *app) probeLoopback() bool {
	base := a.cl.baseURL()
	host, port, err := net.SplitHostPort(strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://"))
	if err != nil || port == "" || host == "" {
		return false
	}
	if host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]" {
		return false
	}
	prevSecret := a.cl.authSecret()
	loop := "127.0.0.1:" + port
	a.cl.setAuth(loop, prevSecret)
	if _, err := a.cl.versionFast(); err != nil {
		a.cl.setAuth(base, prevSecret)
		return false
	}
	invalidateProxies()
	log.Printf("Clash API переключён на %s (адрес %s не отвечал)", loop, base)
	a.addEvent("info", "", "mihomo: Clash API переключён на "+loop)
	return true
}

func (a *app) confLoop() {
	t := time.NewTicker(confPollInterval)
	defer t.Stop()
	for range t.C {
		a.reloadConf()
		if _, err := a.cl.versionFast(); err == nil {
			continue
		}
		a.probeLoopback()
	}
}
