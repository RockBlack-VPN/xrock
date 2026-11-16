package main

// Состояние демона: журнал событий и выбранные вручную узлы. Хранится одним
// JSON-файлом рядом с настройками mihomo.

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

type event struct {
	T     int64  `json:"t"`
	Kind  string `json:"kind"` // info | ok | warn | bad
	Group string `json:"group,omitempty"`
	Text  string `json:"text"`
}

type state struct {
	Events   []event           `json:"events"`
	Selected map[string]string `json:"selected"`
}

const eventsMax = 200

func loadState(path string) *state {
	st := &state{}
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, st); err != nil {
			// файл битый — начинаем с чистого, но не теряем сам файл
			os.Rename(path, path+".bad")
			st = &state{}
		}
	}
	if st.Selected == nil {
		st.Selected = map[string]string{}
	}
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
	mihomoVer string
	apiErr    string
	traffic   trafficState

	// обновления (ядро/панель)
	updMu     sync.Mutex
	upgrading string // "" | core | panel
}

func newApp(cl *clash, statePath, uiDir, logPath string) *app {
	a := &app{
		cl:        cl,
		statePath: statePath,
		uiDir:     uiDir,
		logPath:   logPath,
		started:   time.Now(),
		saveC:     make(chan struct{}, 1),
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

// setAPIErr запоминает состояние связи с mihomo и пишет событие при изменении.
func (a *app) setAPIErr(err error) {
	a.mu.Lock()
	before := a.apiErr
	if err == nil {
		a.apiErr = ""
	} else {
		a.apiErr = err.Error()
	}
	changed := (before == "") != (a.apiErr == "")
	a.mu.Unlock()
	if changed && err != nil {
		a.addEvent("bad", "", "mihomo API недоступен: "+err.Error())
	} else if changed {
		a.addEvent("ok", "", "mihomo API снова доступен")
	}
}
