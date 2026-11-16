package main

// Состояние панели: настройки сторожа, мёртвые серверы, история проверок,
// журнал событий. Хранится одним JSON-файлом рядом с настройками mihomo.

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type target struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type watchSettings struct {
	Enabled       bool     `json:"enabled"`
	Group         string   `json:"group"`
	IntervalSec   int      `json:"intervalSec"`
	FailsToSwitch int      `json:"failsToSwitch"`
	Targets       []target `json:"targets"`
}

func defTargets() []target {
	return []target{
		{"YouTube", "https://www.youtube.com/generate_204"},
		{"Telegram", "https://web.telegram.org/"},
		{"Instagram", "https://www.instagram.com/"},
	}
}

func defaultWatch() watchSettings {
	return watchSettings{Enabled: true, IntervalSec: 10, FailsToSwitch: 2, Targets: defTargets()}
}

func (w *watchSettings) normalize() {
	if w.IntervalSec < 5 {
		w.IntervalSec = 10
	}
	if w.IntervalSec > 300 {
		w.IntervalSec = 300
	}
	if w.FailsToSwitch < 1 {
		w.FailsToSwitch = 2
	}
	if w.FailsToSwitch > 10 {
		w.FailsToSwitch = 10
	}
	var ts []target
	for _, t := range w.Targets {
		t.Name = strings.TrimSpace(t.Name)
		t.URL = strings.TrimSpace(t.URL)
		if t.URL == "" || !strings.HasPrefix(t.URL, "http") {
			continue
		}
		if t.Name == "" {
			t.Name = t.URL
		}
		ts = append(ts, t)
	}
	if len(ts) == 0 {
		ts = defTargets()
	}
	w.Targets = ts
}

type histPoint struct {
	T    int64 `json:"t"`
	MS   int   `json:"ms"`
	Fail bool  `json:"fail"`
}

type proxyStat struct {
	Delay   int         `json:"delay"`
	OK      bool        `json:"ok"`
	Fails   int         `json:"fails"`
	LastT   int64       `json:"lastT"`
	OkSince int64       `json:"okSince"`
	History []histPoint `json:"history"`
}

type event struct {
	T     int64  `json:"t"`
	Kind  string `json:"kind"` // info | ok | warn | bad
	Group string `json:"group,omitempty"`
	Text  string `json:"text"`
}

type state struct {
	Watch     watchSettings         `json:"watch"`
	Dead      map[string]int64      `json:"dead"`
	Events    []event               `json:"events"`
	Stats     map[string]*proxyStat `json:"stats"`
	Selected  map[string]string     `json:"selected"`
	SelectedT map[string]int64      `json:"selectedT"` // когда узел выбран вручную
}

const (
	eventsMax   = 200
	statHistMax = 60
	deadCooldown = 300 // секунд: сколько не пробуем сервер после падения
	// manualGraceSec — сколько секунд после ручного выбора сторож не переключает
	// группу сам: пользователь уже решил, какой сервер ему нужен.
	manualGraceSec = 600
)

// manualGrace — идёт ли «тишина» после ручного выбора и сколько секунд осталось.
func (a *app) manualGrace(group string) (bool, int64) {
	if group == "" {
		return false, 0
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	t := a.st.SelectedT[group]
	if t == 0 {
		return false, 0
	}
	left := t + manualGraceSec - time.Now().Unix()
	if left <= 0 {
		return false, 0
	}
	return true, left
}

func loadState(path string) *state {
	st := &state{}
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, st); err != nil {
			// файл битый — начинаем с чистого, но не теряем сам файл
			os.Rename(path, path+".bad")
			st = &state{}
		}
	}
	if st.Dead == nil {
		st.Dead = map[string]int64{}
	}
	if st.Stats == nil {
		st.Stats = map[string]*proxyStat{}
	}
	if st.Selected == nil {
		st.Selected = map[string]string{}
	}
	if st.SelectedT == nil {
		st.SelectedT = map[string]int64{}
	}
	if len(st.Watch.Targets) == 0 && st.Watch.IntervalSec == 0 && st.Watch.FailsToSwitch == 0 {
		st.Watch = defaultWatch()
	}
	st.Watch.normalize()
	return st
}

// trafficState — текущие скорости (с /traffic) и итоги (с /connections).
type trafficState struct {
	Up        int64
	Down      int64
	UpTotal   int64
	DownTotal int64
	Conns     int64
}

// app — всё состояние демона.
type app struct {
	cl        *clash
	statePath string
	uiDir     string // "" → встроенный UI
	logPath   string
	started   time.Time

	mu    sync.Mutex
	st    *state
	dirty bool
	saveC chan struct{}

	// рабочее (тоже под mu)
	running    bool
	curGroup   string
	curName    string // конечный узел, через который реально идёт трафик
	curOK      bool
	lastRound  int64
	lastCheck  *checkResult
	consecFail int
	mihomoVer  string
	apiErr     string
	traffic    trafficState

	// обновления (ядро/панель)
	updMu     sync.Mutex
	upgrading string // "" | core | panel

	kick chan struct{} // перечитать настройки сторожа
}

func newApp(cl *clash, statePath, uiDir, logPath string) *app {
	a := &app{
		cl:        cl,
		statePath: statePath,
		uiDir:     uiDir,
		logPath:   logPath,
		started:   time.Now(),
		saveC:     make(chan struct{}, 1),
		kick:      make(chan struct{}, 1),
	}
	a.st = loadState(statePath)
	return a
}

// save — отметить изменения и попросить фоновую запись (не блокирует обработчики).
func (a *app) save() {
	a.mu.Lock()
	a.dirty = true
	a.mu.Unlock()
	select {
	case a.saveC <- struct{}{}:
	default:
	}
}

func (a *app) saveLoop() {
	for range a.saveC {
		time.Sleep(400 * time.Millisecond) // склеиваем серию изменений
		a.mu.Lock()
		if !a.dirty {
			a.mu.Unlock()
			continue
		}
		b, err := json.MarshalIndent(a.st, "", " ")
		a.dirty = false
		a.mu.Unlock()
		if err != nil {
			continue
		}
		tmp := a.statePath + ".tmp"
		if err := os.WriteFile(tmp, b, 0644); err != nil {
			continue
		}
		os.Rename(tmp, a.statePath)
	}
}

func (a *app) addEvent(kind, group, text string) {
	a.mu.Lock()
	a.st.Events = append(a.st.Events, event{T: time.Now().Unix(), Kind: kind, Group: group, Text: text})
	if len(a.st.Events) > eventsMax {
		a.st.Events = a.st.Events[len(a.st.Events)-eventsMax:]
	}
	a.mu.Unlock()
	a.save()
}

// addStat — обновить статистику узла по результату проверки.
func (a *app) addStat(name string, res []targetResult, ok bool) {
	if name == "" {
		return
	}
	now := time.Now().Unix()
	ms := 0
	n := 0
	for _, r := range res {
		if r.OK && r.MS > 0 {
			ms += r.MS
			n++
		}
	}
	if n > 0 {
		ms /= n
	}
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

// deadList — имена серверов, которые сейчас в «карантине».
func (a *app) deadList() []string {
	now := time.Now().Unix()
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for name, until := range a.st.Dead {
		if until > now {
			out = append(out, name)
		} else {
			delete(a.st.Dead, name)
		}
	}
	sort.Strings(out)
	return out
}

func (a *app) isDead(name string) bool {
	now := time.Now().Unix()
	a.mu.Lock()
	defer a.mu.Unlock()
	until, ok := a.st.Dead[name]
	return ok && until > now
}

func (a *app) markDead(name string) {
	if name == "" {
		return
	}
	a.mu.Lock()
	a.st.Dead[name] = time.Now().Unix() + deadCooldown
	a.mu.Unlock()
	a.save()
}

func (a *app) clearDead(name string) {
	a.mu.Lock()
	delete(a.st.Dead, name)
	a.mu.Unlock()
}
