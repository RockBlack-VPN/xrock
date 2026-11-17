package main

// Ресурсы роутера для панели: загрузка CPU, память, температура, uptime.
// Всё читается из /proc и /sys, без внешних утилит.

import (
	"bufio"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type tempSensor struct {
	Name string  `json:"name"`
	C    float64 `json:"c"`
}

type sysInfo struct {
	OK         bool         `json:"ok"`
	CPUPct     int          `json:"cpuPct"`
	Load1      float64      `json:"load1"`
	MemTotal   int64        `json:"memTotal"` // кБ
	MemAvail   int64        `json:"memAvail"` // кБ
	MemUsedPct int          `json:"memUsedPct"`
	TempMax    float64      `json:"tempMax"`
	Temps      []tempSensor `json:"temps"`
	UptimeSec  int64        `json:"uptimeSec"`
	Arch       string       `json:"arch"`
	Model      string       `json:"model"`
	Cores      int          `json:"cores"`
	Goroutines int          `json:"goroutines"`
	// сколько памяти занимают сами процессы (кБ) — чтобы «62%» не путали с панелью
	SelfRssKb   int64 `json:"selfRssKb"`
	MihomoRssKb int64 `json:"mihomoRssKb"`
}

var (
	cpuMu     sync.Mutex
	cpuPrevIdle, cpuPrevTotal uint64
)

// cpuTimes — суммарные тики простоя и всех тиков из /proc/stat.
func cpuTimes() (idle, total uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0, 0
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 {
		return 0, 0
	}
	for i, x := range fields[1:] {
		v, _ := strconv.ParseUint(x, 10, 64)
		total += v
		if i == 3 || i == 4 { // idle + iowait
			idle += v
		}
	}
	return idle, total
}

func readMem() (total, avail int64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			total = memKb(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			avail = memKb(line)
		}
		if total > 0 && avail > 0 {
			break
		}
	}
	return
}

func memKb(line string) int64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	v, _ := strconv.ParseInt(fields[1], 10, 64)
	return v
}

func readLoad1() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

func readUptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return int64(v)
}

// readTemps — все датчики из /sys/class/thermal (и hwmon как запасной вариант).
func readTemps() []tempSensor {
	var out []tempSensor
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*")
	for _, z := range zones {
		name := strings.TrimSpace(readFileStr(filepath.Join(z, "type")))
		if name == "" {
			name = filepath.Base(z)
		}
		raw := strings.TrimSpace(readFileStr(filepath.Join(z, "temp")))
		if raw == "" {
			continue
		}
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil || v <= 0 {
			continue
		}
		out = append(out, tempSensor{Name: name, C: round1(v / 1000)})
	}
	if len(out) == 0 {
		hw, _ := filepath.Glob("/sys/class/hwmon/hwmon*/temp1_input")
		for _, h := range hw {
			name := strings.TrimSpace(readFileStr(filepath.Join(filepath.Dir(h), "name")))
			if name == "" {
				name = filepath.Base(filepath.Dir(h))
			}
			raw := strings.TrimSpace(readFileStr(h))
			v, err := strconv.ParseFloat(raw, 64)
			if err != nil || v <= 0 {
				continue
			}
			out = append(out, tempSensor{Name: name, C: round1(v / 1000)})
		}
	}
	return out
}

func readFileStr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func round1(v float64) float64 {
	return float64(int64(v*10+0.5)) / 10
}

func deviceModel() string {
	for _, p := range []string{"/proc/device-tree/model", "/sys/firmware/devicetree/base/model"} {
		if s := strings.TrimRight(readFileStr(p), "\x00\n "); s != "" {
			return s
		}
	}
	return ""
}

// handleSys — GET /api/sys.
func (a *app) handleSys(w http.ResponseWriter, r *http.Request) {
	info := sysInfo{OK: true, Arch: runtime.GOARCH, Cores: runtime.NumCPU()}
	info.Goroutines = runtime.NumGoroutine()
	info.Load1 = readLoad1()
	info.UptimeSec = readUptime()
	info.Model = deviceModel()

	// CPU: разница тиков с прошлого запроса
	idle, total := cpuTimes()
	cpuMu.Lock()
	if cpuPrevTotal > 0 && total > cpuPrevTotal {
		dTotal := total - cpuPrevTotal
		dIdle := idle - cpuPrevIdle
		busy := float64(dTotal-dIdle) / float64(dTotal) * 100
		info.CPUPct = int(busy + 0.5)
	}
	cpuPrevIdle, cpuPrevTotal = idle, total
	cpuMu.Unlock()

	info.SelfRssKb = procRssKb("xrock")
	info.MihomoRssKb = procRssKb("mihomo")

	totalKb, availKb := readMem()
	info.MemTotal = totalKb
	info.MemAvail = availKb
	if totalKb > 0 {
		info.MemUsedPct = int(float64(totalKb-availKb)/float64(totalKb)*100 + 0.5)
	}

	info.Temps = readTemps()
	if info.Temps == nil {
		info.Temps = []tempSensor{}
	}
	for _, t := range info.Temps {
		if t.C > info.TempMax {
			info.TempMax = t.C
		}
	}
	writeJSON(w, info)
}

// procRssKb — RSS процесса по имени (comm) из /proc/<pid>/status.
func procRssKb(name string) int64 {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		pid := e.Name()
		if pid == "" || pid[0] < '0' || pid[0] > '9' {
			continue
		}
		comm, err := os.ReadFile("/proc/" + pid + "/comm")
		match := err == nil && strings.TrimSpace(string(comm)) == name
		if !match {
			// обёртки (sh/скрипты xkeen) — смотрим ещё и командную строку
			if cl, err := os.ReadFile("/proc/" + pid + "/cmdline"); err == nil {
				args := strings.Split(string(cl), "\x00")
				for _, a := range args {
					if strings.Contains(a, name) {
						match = true
						break
					}
				}
			}
		}
		if !match {
			continue
		}
		b, err := os.ReadFile("/proc/" + pid + "/status")
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if !strings.HasPrefix(line, "VmRSS:") {
				continue
			}
			f := strings.Fields(line)
			if len(f) >= 2 {
				v, _ := strconv.ParseInt(f[1], 10, 64)
				return v
			}
		}
	}
	return 0
}

// sysLoop — раз в 5 секунд снимает CPU-тики, чтобы первый ответ /api/sys уже
// содержал осмысленную загрузку (иначе первый вызов отдаёт 0 %).
func (a *app) sysLoop() {
	cpuTimes() // прогрев: запоминаем тики
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	var lastWarn int64
	for range t.C {
		idle, total := cpuTimes()
		cpuMu.Lock()
		cpuPrevIdle, cpuPrevTotal = idle, total
		cpuMu.Unlock()

		// Диагностика утечек: много горутин — обычно висящие SSE-потоки.
		// Пишем в журнал не чаще раза в 5 минут, чтобы не засорять лог.
		if n := runtime.NumGoroutine(); n > 200 && time.Now().Unix()-lastWarn > 300 {
			lastWarn = time.Now().Unix()
			log.Printf("много горутин: %d (проверьте висящие потоки /api/stream/*)", n)
		}
	}
}
