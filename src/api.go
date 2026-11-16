package main

// HTTP: панель (UI) и JSON API для неё. Наружу не отдаём ни секрет Clash API,
// ни конфиг mihomo — только то, что нужно интерфейсу.

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type proxyResp struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	UDP      bool   `json:"udp"`
	Alive    bool   `json:"alive"`
	Provider string `json:"provider"`
}

type groupResp struct {
	Name string   `json:"name"`
	Type string   `json:"type"`
	Now  string   `json:"now"`
	All  []string `json:"all"`
	Icon string   `json:"icon"`
}

// apiSubInfo — подписка в том виде, как её ждёт UI (ключи в нижнем регистре).
type apiSubInfo struct {
	Upload   int64 `json:"upload"`
	Download int64 `json:"download"`
	Total    int64 `json:"total"`
	Expire   int64 `json:"expire"`
}

type providerResp struct {
	Name             string      `json:"name"`
	Type             string      `json:"type"`
	VehicleType      string      `json:"vehicleType"`
	UpdatedAt        string      `json:"updatedAt"`
	TestURL          string      `json:"testUrl"`
	Interval         int         `json:"interval"`
	ProxyCount       int         `json:"proxyCount"`
	SubscriptionInfo *apiSubInfo `json:"subscriptionInfo"`
}

type watchdogResp struct {
	Enabled       bool          `json:"enabled"`
	Group         string        `json:"group"`
	IntervalSec   int           `json:"intervalSec"`
	FailsToSwitch int           `json:"failsToSwitch"`
	Current       string        `json:"current"`
	CurrentOK     bool          `json:"currentOK"`
	Dead          []string      `json:"dead"`
	LastRound     int64         `json:"lastRound"`
	Running       bool          `json:"running"`
	Targets       []target      `json:"targets"`
	LastCheck     *checkResult  `json:"lastCheck"`
	ConsecFail    int           `json:"consecFail"`
}

type trafficResp struct {
	Up        int64 `json:"up"`        // скорость сейчас, байт/с
	Down      int64 `json:"down"`      // скорость сейчас, байт/с
	UpTotal   int64 `json:"upTotal"`   // всего отдано
	DownTotal int64 `json:"downTotal"` // всего скачано
	Conns     int64 `json:"conns"`
}

type stateResp struct {
	OK        bool              `json:"ok"`
	Version   string            `json:"version"`
	Now       int64             `json:"now"`
	Mihomo    map[string]any    `json:"mihomo"`
	Groups    []groupResp       `json:"groups"`
	Proxies   []proxyResp       `json:"proxies"`
	Providers []providerResp    `json:"providers"`
	Watchdog  watchdogResp      `json:"watchdog"`
	Stats     map[string]*proxyStat `json:"stats"`
	Events    []event           `json:"events"`
	Traffic   trafficResp       `json:"traffic"`
	Started   int64             `json:"started"`
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	writeJSON(w, map[string]string{"error": msg})
}

func (a *app) handleState(w http.ResponseWriter, r *http.Request) {
	proxies, err := a.cl.allProxies()
	if err != nil {
		a.setAPIErr(err)
		fail(w, 502, "mihomo API: "+err.Error())
		return
	}
	a.setAPIErr(nil)
	resp := stateResp{OK: true, Version: version, Now: time.Now().Unix(), Started: a.started.Unix(),
		Groups: []groupResp{}, Proxies: []proxyResp{}, Providers: []providerResp{}, Events: []event{}}

	a.mu.Lock()
	resp.Mihomo = map[string]any{"version": a.mihomoVer, "api": a.cl.base, "secret": a.cl.secret != ""}
	resp.Stats = a.st.Stats
	resp.Events = append([]event{}, a.st.Events...)
	if len(resp.Events) > 80 {
		resp.Events = resp.Events[len(resp.Events)-80:]
	}
	a.mu.Unlock()

	// группы
	for name, p := range proxies {
		if !p.isGroup() || strings.EqualFold(p.Type, "compatible") {
			continue
		}
		g := groupResp{Name: name, Type: p.Type, Now: p.Now, Icon: p.Icon, All: p.All}
		if g.All == nil {
			g.All = []string{}
		}
		resp.Groups = append(resp.Groups, g)
	}
	sort.Slice(resp.Groups, func(i, j int) bool { return resp.Groups[i].Name < resp.Groups[j].Name })

	// узлы
	for name, p := range proxies {
		if p.isGroup() || p.isService() {
			continue
		}
		resp.Proxies = append(resp.Proxies, proxyResp{Name: name, Type: p.Type, UDP: p.UDP, Alive: p.Alive, Provider: p.Provider})
	}
	sort.Slice(resp.Proxies, func(i, j int) bool { return resp.Proxies[i].Name < resp.Proxies[j].Name })

	// провайдеры (подписка): Compatible — это зеркала групп, их не показываем
	if provs, err := a.cl.providers(); err == nil {
		for name, p := range provs {
			if strings.EqualFold(p.VehicleType, "compatible") {
				continue
			}
			var si *apiSubInfo
			if p.SubscriptionInfo != nil {
				si = &apiSubInfo{
					Upload:   p.SubscriptionInfo.Upload,
					Download: p.SubscriptionInfo.Download,
					Total:    p.SubscriptionInfo.Total,
					Expire:   p.SubscriptionInfo.Expire,
				}
			}
			resp.Providers = append(resp.Providers, providerResp{
				Name: name, Type: p.Type, VehicleType: p.VehicleType, UpdatedAt: p.UpdatedAt,
				TestURL: p.TestURL, Interval: p.Interval, ProxyCount: len(p.Proxies),
				SubscriptionInfo: si,
			})
		}
		sort.Slice(resp.Providers, func(i, j int) bool { return resp.Providers[i].Name < resp.Providers[j].Name })
	}

	a.mu.Lock()
	s := a.st.Watch
	effGroup := a.curGroup
	if effGroup == "" {
		effGroup = s.Group
	}
	resp.Watchdog = watchdogResp{
		Enabled: s.Enabled, Group: effGroup, IntervalSec: s.IntervalSec, FailsToSwitch: s.FailsToSwitch,
		Current: a.curName, CurrentOK: a.curOK, LastRound: a.lastRound, Running: a.running,
		Targets: s.Targets, LastCheck: a.lastCheck, ConsecFail: a.consecFail,
	}
	resp.Traffic = trafficResp{Up: a.traffic.Up, Down: a.traffic.Down, UpTotal: a.traffic.UpTotal, DownTotal: a.traffic.DownTotal, Conns: a.traffic.Conns}
	a.mu.Unlock()
	resp.Watchdog.Dead = a.deadList()
	if resp.Watchdog.Dead == nil {
		resp.Watchdog.Dead = []string{}
	}
	writeJSON(w, resp)
}

func (a *app) handleWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeJSON(w, map[string]any{"ok": true})
		return
	}
	var req struct {
		Enabled       *bool    `json:"enabled"`
		Group         *string  `json:"group"`
		IntervalSec   *int     `json:"intervalSec"`
		FailsToSwitch *int     `json:"failsToSwitch"`
		Targets       *[]target `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad request")
		return
	}
	a.mu.Lock()
	if req.Enabled != nil {
		a.st.Watch.Enabled = *req.Enabled
	}
	if req.Group != nil {
		a.st.Watch.Group = strings.TrimSpace(*req.Group)
	}
	if req.IntervalSec != nil {
		a.st.Watch.IntervalSec = *req.IntervalSec
	}
	if req.FailsToSwitch != nil {
		a.st.Watch.FailsToSwitch = *req.FailsToSwitch
	}
	if req.Targets != nil {
		a.st.Watch.Targets = *req.Targets
	}
	a.st.Watch.normalize()
	en := a.st.Watch.Enabled
	a.mu.Unlock()
	a.save()
	a.addEvent("info", "", eventText(en))
	select {
	case a.kick <- struct{}{}:
	default:
	}
	writeJSON(w, map[string]any{"ok": true})
}

func eventText(enabled bool) string {
	if enabled {
		return "сторож включён"
	}
	return "сторож выключен"
}

func (a *app) handleSelect(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Group string `json:"group"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Group == "" || req.Name == "" {
		fail(w, 400, "нужны group и name")
		return
	}
	if err := a.cl.selectProxy(req.Group, req.Name); err != nil {
		fail(w, 502, err.Error())
		return
	}
	a.mu.Lock()
	a.curGroup = req.Group
	a.curName = req.Name
	a.curOK = true
	a.consecFail = 0
	if a.st.Selected == nil {
		a.st.Selected = map[string]string{}
	}
	a.st.Selected[req.Group] = req.Name
	a.mu.Unlock()
	a.save()
	a.clearDead(req.Name)
	a.addEvent("info", req.Group, "вручную выбран "+req.Name)
	writeJSON(w, map[string]any{"ok": true})
}

// handleTest — проксированный замер задержки (mihomo делает запрос через узел),
// никакого TCP-пинга. Если список пуст — одним запросом /group/{g}/delay меряем
// сразу всех участников группы (4–6 секунд на 60+ серверов).
func (a *app) handleTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Names []string `json:"names"`
		URL   string   `json:"url"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	target := req.URL
	if target == "" {
		target = "https://www.youtube.com/generate_204"
	}
	type res struct {
		Delay int    `json:"delay"`
		Err   string `json:"err"`
	}
	out := map[string]res{}
	proxies, err := a.cl.allProxies()
	if err != nil {
		fail(w, 502, err.Error())
		return
	}

	if len(req.Names) == 0 {
		a.mu.Lock()
		want := a.st.Watch.Group
		a.mu.Unlock()
		gname := watchGroup(proxies, want)
		if gname != "" {
			if m, err := a.cl.groupDelay(gname, target, 4000); err == nil {
				for name, p := range proxies {
					if p.isGroup() || p.isService() {
						continue
					}
					if ms, ok := m[name]; ok && ms > 0 {
						out[name] = res{Delay: ms}
						a.addStatQuick(name, ms, true)
					} else {
						out[name] = res{Err: "нет ответа"}
						a.addStatQuick(name, 0, false)
					}
				}
				writeJSON(w, map[string]any{"results": out, "via": "group " + gname})
				return
			}
		}
		for name, p := range proxies {
			if !p.isGroup() && !p.isService() {
				req.Names = append(req.Names, name)
			}
		}
		sort.Strings(req.Names)
	}

	var mu sync.Mutex
	sem := make(chan struct{}, 10)
	var wg sync.WaitGroup
	for _, name := range req.Names {
		wg.Add(1)
		sem <- struct{}{}
		go func(name string) {
			defer wg.Done()
			defer func() { <-sem }()
			ms, err := a.nodeDelay(proxies, name, target, 4000)
			mu.Lock()
			if err != nil {
				out[name] = res{Err: shortErr(err)}
			} else {
				out[name] = res{Delay: ms}
			}
			mu.Unlock()
			a.addStatQuick(name, ms, err == nil)
		}(name)
	}
	wg.Wait()
	writeJSON(w, map[string]any{"results": out, "via": "по одному"})
}

// addStatQuick — обновление статистики после одиночного замера.
func (a *app) addStatQuick(name string, ms int, ok bool) {
	now := time.Now().Unix()
	a.mu.Lock()
	st := a.st.Stats[name]
	if st == nil {
		st = &proxyStat{}
		a.st.Stats[name] = st
	}
	st.Delay = ms
	st.OK = ok
	st.LastT = now
	if ok {
		st.Fails = 0
		if st.OkSince == 0 {
			st.OkSince = now
		}
	} else {
		st.Fails++
		st.OkSince = 0
	}
	st.History = append(st.History, histPoint{T: now, MS: ms, Fail: !ok})
	if len(st.History) > statHistMax {
		st.History = st.History[len(st.History)-statHistMax:]
	}
	a.mu.Unlock()
	a.save()
}

func (a *app) handleProviderUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Name == "" {
		fail(w, 400, "нужно имя провайдера")
		return
	}
	if err := a.cl.updateProvider(req.Name); err != nil {
		fail(w, 502, err.Error())
		return
	}
	invalidateProxies()
	a.addEvent("ok", "", "обновляю подписку «"+req.Name+"»")
	writeJSON(w, map[string]any{"ok": true})
}

func (a *app) handleConnections(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "DELETE":
		if id := r.URL.Query().Get("id"); id != "" {
			if err := a.cl.closeConn(id); err != nil {
				fail(w, 502, err.Error())
				return
			}
			writeJSON(w, map[string]any{"ok": true})
			return
		}
		if err := a.cl.closeAll(); err != nil {
			fail(w, 502, err.Error())
			return
		}
		a.addEvent("info", "", "закрыл все соединения")
		writeJSON(w, map[string]any{"ok": true})
	default:
		c, err := a.cl.connections()
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		a.mu.Lock()
		a.traffic.UpTotal = c.UploadTotal
		a.traffic.DownTotal = c.DownloadTotal
		n := int64(len(c.Connections))
		a.traffic.Conns = n
		a.mu.Unlock()
		writeJSON(w, map[string]any{
			"up": c.UploadTotal, "down": c.DownloadTotal, "conns": n,
			"connections": c.Connections,
		})
	}
}

func (a *app) handleRules(w http.ResponseWriter, r *http.Request) {
	rules, err := a.cl.rules()
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	writeJSON(w, map[string]any{"rules": rules})
}

func (a *app) handlePing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"ok": true, "version": version})
}

// SSE-поток трафика: пересылаем построчно то, что отдаёт mihomo /traffic.
func (a *app) handleStreamTraffic(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "нет flusher")
		return
	}
	ctx := r.Context()
	body, err := a.cl.streamGet(ctx, "/traffic")
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)
	fl.Flush()

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var t trafficItem
		if json.Unmarshal(line, &t) == nil {
			a.mu.Lock()
			a.traffic.Up = t.Up
			a.traffic.Down = t.Down
			if t.UpTotal > 0 {
				a.traffic.UpTotal = t.UpTotal
			}
			if t.DownTotal > 0 {
				a.traffic.DownTotal = t.DownTotal
			}
			a.mu.Unlock()
		}
		w.Write([]byte("data: "))
		w.Write(line)
		w.Write([]byte("\n\n"))
		fl.Flush()
	}
}

// SSE-поток логов mihomo.
func (a *app) handleStreamLogs(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "нет flusher")
		return
	}
	level := r.URL.Query().Get("level")
	switch level {
	case "debug", "info", "warning", "error":
	default:
		level = "info"
	}
	ctx := r.Context()
	body, err := a.cl.streamGet(ctx, "/logs?level="+level)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)
	fl.Flush()

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		w.Write([]byte("data: "))
		w.Write(line)
		w.Write([]byte("\n\n"))
		fl.Flush()
	}
}

// uiHandler — статика интерфейса: встроенная (embed) или из -ui.
func (a *app) uiHandler(embedded fs.FS) http.Handler {
	var root fs.FS = embedded
	if a.uiDir != "" {
		root = os.DirFS(a.uiDir)
	}
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(root, p); err != nil {
			// неизвестный путь → index.html (SPA)
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			w.Header().Set("Cache-Control", "no-cache")
			fileServer.ServeHTTP(w, r2)
			return
		}
		// HTML/JS/CSS не кешируем: после обновления панели браузер должен взять
		// свежие файлы, иначе остаётся старый интерфейс. Картинки/шрифты — можно.
		switch {
		case p == "index.html" || strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css"):
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		case strings.HasSuffix(p, ".svg") || strings.HasSuffix(p, ".png") || strings.HasSuffix(p, ".woff2"):
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func (a *app) routes(embedded fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", a.handlePing)
	mux.HandleFunc("/api/state", a.handleState)
	mux.HandleFunc("/api/watch", a.handleWatch)
	mux.HandleFunc("/api/select", a.handleSelect)
	mux.HandleFunc("/api/test", a.handleTest)
	mux.HandleFunc("/api/providers/update", a.handleProviderUpdate)
	mux.HandleFunc("/api/subscription", a.handleSubscriptionAPI)
	mux.HandleFunc("/api/sys", a.handleSys)
	mux.HandleFunc("/api/asn", a.handleASN)
	mux.HandleFunc("/api/versions", a.handleVersions)
	mux.HandleFunc("/api/upgrade/core", a.handleUpgradeCore)
	mux.HandleFunc("/api/upgrade/panel", a.handleUpgradePanel)
	mux.HandleFunc("/api/connections", a.handleConnections)
	mux.HandleFunc("/api/rules", a.handleRules)
	mux.HandleFunc("/api/stream/traffic", a.handleStreamTraffic)
	mux.HandleFunc("/api/stream/logs", a.handleStreamLogs)
	mux.Handle("/", a.uiHandler(embedded))
	return cors(mux)
}

// cors — UI открывается с другого origin (http://роутер:9090/ui), поэтому API
// доступен панели с любого адреса в локальной сети.
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == "OPTIONS" {
				w.WriteHeader(204)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

// connsPoll — раз в 5 секунд обновляет счётчик соединений и итоги трафика
// (нужен для «Обзора», когда SSE-поток не открыт).
func (a *app) connsPoll() {
	for {
		time.Sleep(5 * time.Second)
		c, err := a.cl.connections()
		if err != nil {
			continue
		}
		a.mu.Lock()
		a.traffic.UpTotal = c.UploadTotal
		a.traffic.DownTotal = c.DownloadTotal
		a.traffic.Conns = int64(len(c.Connections))
		a.mu.Unlock()
	}
}
