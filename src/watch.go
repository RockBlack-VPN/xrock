package main

// Сторож: каждые N секунд проверяет АКТИВНЫЙ сервер через Clash API — задержку
// через прокси до сервисов (YouTube/Telegram/Instagram). Если сервер не отвечает
// FailsToSwitch кругов подряд — мгновенно переключает группу на лучший живой
// узел (без перезапуска mihomo, без разрыва остальных соединений).

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type targetResult struct {
	Target string `json:"target"`
	OK     bool   `json:"ok"`
	MS     int    `json:"ms"`
	Err    string `json:"err,omitempty"`
}

type checkResult struct {
	Name    string         `json:"name"`
	T       int64          `json:"t"`
	Results []targetResult `json:"results"`
}

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

func (a *app) watchLoop() {
	for {
		a.mu.Lock()
		s := a.st.Watch
		a.mu.Unlock()
		if !s.Enabled {
			a.mu.Lock()
			a.running = false
			a.mu.Unlock()
			select {
			case <-a.kick:
				continue
			case <-time.After(15 * time.Second):
				continue
			}
		}
		a.mu.Lock()
		a.running = true
		a.mu.Unlock()
		a.round(s)
		select {
		case <-time.After(time.Duration(s.IntervalSec) * time.Second):
		case <-a.kick:
		}
	}
}

// round — один круг проверки активного сервера.
func (a *app) round(s watchSettings) {
	proxies, err := a.cl.allProxies()
	if err != nil {
		a.setAPIErr(err)
		return
	}
	a.setAPIErr(nil)
	gname := watchGroup(proxies, s.Group)
	if gname == "" {
		a.addEvent("warn", s.Group, "сторож: не нашёл группу для наблюдения (нет ни одной Selector-группы)")
		time.Sleep(5 * time.Second)
		return
	}
	leaf := resolveLeaf(proxies, gname)
	a.mu.Lock()
	a.curGroup = gname
	a.curName = leaf
	a.mu.Unlock()

	res := a.checkTargets(proxies, leaf, s.Targets, 4000)
	fails := 0
	for _, r := range res {
		if !r.OK {
			fails++
		}
	}
	ok := fails <= len(res)/2 // не больше половины целей упало
	a.addStat(leaf, res, ok)

	a.mu.Lock()
	a.lastRound = time.Now().Unix()
	lc := checkResult{Name: leaf, T: a.lastRound, Results: res}
	a.lastCheck = &lc
	// Событие пишем ПОСЛЕ разблокировки: addEvent сам берёт a.mu, а мьютекс
	// не рекурсивный. Раньше вызов внутри лока навсегда вешал панель ровно в
	// тот момент, когда сервер восстанавливался после сбоя.
	recovered := ok && !a.curOK && a.consecFail > 0
	if ok {
		a.curOK = true
		a.consecFail = 0
		a.mu.Unlock()
		if recovered {
			a.addEvent("ok", gname, fmt.Sprintf("%s снова отвечает (%d мс)", leaf, avgMS(res)))
		}
		a.clearDead(leaf)
		return
	}
	a.curOK = false
	a.consecFail++
	cf := a.consecFail
	a.mu.Unlock()

	if cf < s.FailsToSwitch {
		return
	}
	// Пользователь выбрал узел вручную — не перебиваем его выбор 10 минут.
	if grace, left := a.manualGrace(gname); grace {
		a.addEvent("warn", gname, fmt.Sprintf("сторож: %s не отвечает, но узел выбран вручную — не переключаю ещё %d мин", leaf, left/60+1))
		a.mu.Lock()
		a.consecFail = 0
		a.mu.Unlock()
		return
	}
	a.failover(proxies, gname, leaf, res, s)
}

// failover — сервер мёртв: выбираем лучший живой узел и переключаем группу.
func (a *app) failover(proxies map[string]*proxyItem, gname, cur string, res []targetResult, s watchSettings) {
	g := proxies[gname]
	if g == nil || !strings.EqualFold(g.Type, "selector") {
		a.addEvent("bad", gname, "не могу переключить: группа не Selector (выберите группу типа Selector в настройках сторожа)")
		a.mu.Lock()
		a.consecFail = 0
		a.mu.Unlock()
		return
	}
	a.markDead(cur)
	a.addEvent("warn", gname, fmt.Sprintf("%s → Offline на %d мин (%s) — ищу замену", cur, deadCooldown/60, summar(res)))

	cands := a.candidates(proxies, g)
	if len(cands) == 0 {
		a.addEvent("bad", gname, "в группе нет узлов для переключения")
		a.mu.Lock()
		a.consecFail = 0
		a.mu.Unlock()
		return
	}
	url := "https://www.youtube.com/generate_204"
	if len(s.Targets) > 0 {
		url = s.Targets[0].URL
	}
	best, ms := a.probeBest(proxies, cands, url, 2500, 8, 20)
	if best == "" {
		// второй проход: пробуем глубже и дольше, вдруг сеть просто подвисла
		best, ms = a.probeBest(proxies, cands, url, 3500, 4, 0)
	}
	if best == "" {
		a.addEvent("bad", gname, "все серверы не отвечают — оставляю текущий и пробую позже")
		a.mu.Lock()
		a.consecFail = 0
		a.mu.Unlock()
		return
	}
	if err := a.cl.selectProxy(gname, best); err != nil {
		a.addEvent("bad", gname, "не смог переключить группу: "+err.Error())
		a.mu.Lock()
		a.consecFail = 0
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.curName = best
	a.curOK = true
	a.consecFail = 0
	a.st.Selected[gname] = best
	a.mu.Unlock()
	a.save()
	a.addEvent("ok", gname, fmt.Sprintf("переключил на %s (%d мс)", best, ms))

	// подтверждаем через 2 секунды, что через новый сервер реально ходит трафик
	time.AfterFunc(2*time.Second, func() {
		if _, err := a.nodeDelay(proxies, best, url, 4000); err != nil {
			a.addEvent("bad", gname, fmt.Sprintf("%s не подтвердился после переключения: %v", best, err))
			return
		}
		a.clearDead(best)
	})
}

// nodeDelay — проксированный замер узла: для узлов подписки идём в
// /providers/proxies/{provider}/{node}/healthcheck (в /proxies их нет),
// для групп/служебных — обычный /proxies/{name}/delay.
func (a *app) nodeDelay(proxies map[string]*proxyItem, name, url string, timeoutMS int) (int, error) {
	if p := proxies[name]; p != nil && p.Provider != "" && !p.isGroup() {
		return a.cl.providerNodeDelay(p.Provider, name, url, timeoutMS)
	}
	return a.cl.delay(name, url, timeoutMS)
}

// checkTargets — проверка сервисов через конкретный узел (Clash API delay).
func (a *app) checkTargets(proxies map[string]*proxyItem, name string, targets []target, timeoutMS int) []targetResult {
	res := make([]targetResult, len(targets))
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, t target) {
			defer wg.Done()
			defer func() { <-sem }()
			ms, err := a.nodeDelay(proxies, name, t.URL, timeoutMS)
			if err != nil {
				res[i] = targetResult{Target: t.Name, OK: false, Err: shortErr(err)}
				return
			}
			res[i] = targetResult{Target: t.Name, OK: true, MS: ms}
		}(i, t)
	}
	wg.Wait()
	return res
}

// probeBest — параллельно проверяет кандидатов и возвращает лучший по задержке.
func (a *app) probeBest(proxies map[string]*proxyItem, names []string, url string, timeoutMS, parallel, limit int) (string, int) {
	if limit > 0 && len(names) > limit {
		names = names[:limit]
	}
	type r struct {
		name string
		ms   int
		ok   bool
	}
	out := make(chan r, len(names))
	sem := make(chan struct{}, maxInt(1, parallel))
	var wg sync.WaitGroup
	for _, n := range names {
		wg.Add(1)
		sem <- struct{}{}
		go func(n string) {
			defer wg.Done()
			defer func() { <-sem }()
			ms, err := a.nodeDelay(proxies, n, url, timeoutMS)
			out <- r{n, ms, err == nil}
		}(n)
	}
	wg.Wait()
	close(out)
	best, bestMS := "", 0
	for x := range out {
		if !x.ok {
			continue
		}
		if best == "" || x.ms < bestMS {
			best, bestMS = x.name, x.ms
		}
	}
	return best, bestMS
}

// candidates — реальные узлы группы (без вложенных групп и служебных),
// отсортированы: сначала с хорошей историей, потом остальные.
func (a *app) candidates(proxies map[string]*proxyItem, g *proxyItem) []string {
	var good, rest []string
	for _, name := range g.All {
		p := proxies[name]
		if p == nil || p.isGroup() || p.isService() {
			continue
		}
		if a.isDead(name) {
			continue
		}
		if a.hasGoodStat(name) {
			good = append(good, name)
		} else {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	return append(good, rest...)
}

func watchGroup(proxies map[string]*proxyItem, want string) string {
	if want != "" {
		if p := proxies[want]; p != nil {
			return want
		}
	}
	if p := proxies["PROXY"]; p != nil && p.isGroup() {
		return "PROXY"
	}
	var names []string
	for n, p := range proxies {
		if p.isGroup() && strings.EqualFold(p.Type, "selector") {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

// resolveLeaf — идём по цепочке групп до реального узла (PROXY → Fallback → узел).
func resolveLeaf(proxies map[string]*proxyItem, gname string) string {
	cur := gname
	for i := 0; i < 8; i++ {
		p := proxies[cur]
		if p == nil {
			return cur
		}
		if !p.isGroup() {
			return cur
		}
		if p.Now == "" || p.Now == cur {
			return cur
		}
		cur = p.Now
	}
	return cur
}

func (a *app) hasGoodStat(name string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := a.st.Stats[name]
	return st != nil && st.OK && time.Now().Unix()-st.LastT < 3600
}

func avgMS(res []targetResult) int {
	sum, n := 0, 0
	for _, r := range res {
		if r.OK && r.MS > 0 {
			sum += r.MS
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / n
}

func summar(res []targetResult) string {
	var bad, good []string
	for _, r := range res {
		if r.OK {
			good = append(good, fmt.Sprintf("%s %dмс", r.Target, r.MS))
		} else {
			bad = append(bad, r.Target)
		}
	}
	s := ""
	if len(bad) > 0 {
		s = "не открывается: " + strings.Join(bad, ", ")
	}
	if len(good) > 0 {
		if s != "" {
			s += "; "
		}
		s += "ок: " + strings.Join(good, ", ")
	}
	return s
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

