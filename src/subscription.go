package main

// Ссылка подписки живёт в config.yaml mihomo (proxy-providers → url:), а не в
// Clash API, поэтому демон читает и правит файл сам, затем просит mihomo
// перечитать конфиг (PUT /configs) — без перезапуска VPN.
//
// Правка точечная: меняется только строка url: у нужного провайдера, остальной
// файл остаётся байт в байт (комментарии, порядок, отступы). Перед записью
// делается резервная копия config.yaml.xrock-bak-<дата>.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type subProvider struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	URL      string `json:"url"`
	File     string `json:"file"`
	Interval int    `json:"interval"`
	Line     int    `json:"line"` // номер строки url: (1-based), 0 — строки не было
}

type subResp struct {
	OK         bool          `json:"ok"`
	ConfigPath string        `json:"configPath"`
	Found      bool          `json:"found"`
	Providers  []subProvider `json:"providers"`
	Err        string        `json:"err,omitempty"`
}

// provBlock — найденный в тексте конфига блок провайдера.
type provBlock struct {
	Name        string
	StartLine   int // индекс строки с именем (0-based)
	NameIndent  int
	FieldIndent int // отступ полей провайдера (type:, url:, ...)
	URLLine     int // индекс строки url: провайдера или -1
}

func mihomoConfigFile() (string, bool) {
	dir := *flagConfDir
	if dir == "" {
		dir = "."
	}
	for _, name := range []string{"config.yaml", "config.yml"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	return filepath.Join(dir, "config.yaml"), false
}

func indentOf(line string) int {
	n := 0
	for _, ch := range line {
		switch ch {
		case ' ':
			n++
		case '\t':
			n += 2
		default:
			return n
		}
	}
	return n
}

func isCommentOrEmpty(t string) bool {
	return t == "" || strings.HasPrefix(t, "#")
}

// scanProviders ищет блоки внутри proxy-providers: по отступам, без YAML-парсера
// (в конфиге роутера сотни строк, а нам нужны только имена и url).
func scanProviders(lines []string) []provBlock {
	var out []provBlock
	secIndent := -1
	nameIndent := -1
	cur := -1
	for i, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		t := strings.TrimSpace(line)
		if isCommentOrEmpty(t) {
			continue
		}
		ind := indentOf(line)
		if secIndent < 0 {
			if t == "proxy-providers:" || strings.HasPrefix(t, "proxy-providers: ") || strings.HasPrefix(t, "proxy-providers:{}") {
				secIndent = ind
			}
			continue
		}
		if ind <= secIndent {
			break // секция закончилась
		}
		if nameIndent < 0 {
			nameIndent = ind
		}
		if ind == nameIndent && strings.HasSuffix(t, ":") && !strings.HasPrefix(t, "-") {
			name := strings.Trim(strings.TrimSuffix(t, ":"), `"'`)
			out = append(out, provBlock{Name: name, StartLine: i, NameIndent: ind, FieldIndent: -1, URLLine: -1})
			cur = len(out) - 1
			continue
		}
		if cur >= 0 && ind > nameIndent {
			// уровень полей провайдера — первый ключ внутри блока; вложенные
			// (health-check → url:) не должны подменять url подписки
			if out[cur].FieldIndent < 0 {
				out[cur].FieldIndent = ind
			}
			if ind == out[cur].FieldIndent && out[cur].URLLine < 0 && strings.HasPrefix(t, "url:") {
				out[cur].URLLine = i
			}
		}
	}
	return out
}

func yamlScalar(v string) string {
	// Всё, что может сломать YAML (пробел + #, кавычки, двоеточие с пробелом),
	// безопаснее завернуть в двойные кавычки — URL это не портит.
	return `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
}

func unquoteYAML(v string) string {
	v = strings.TrimSpace(v)
	if i := strings.Index(v, " #"); i > 0 {
		v = strings.TrimSpace(v[:i])
	}
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
	}
	return v
}

func parseProxyProviders(text string) []subProvider {
	lines := strings.Split(text, "\n")
	blocks := scanProviders(lines)
	out := make([]subProvider, 0, len(blocks))
	for _, b := range blocks {
		p := subProvider{Name: b.Name, Line: 0}
		for i := b.StartLine + 1; i < len(lines); i++ {
			raw := strings.TrimRight(lines[i], "\r")
			t := strings.TrimSpace(raw)
			if isCommentOrEmpty(t) {
				continue
			}
			ind := indentOf(raw)
			if ind <= b.NameIndent {
				break
			}
			if b.FieldIndent >= 0 && ind != b.FieldIndent {
				continue // вложенные блоки (health-check и т.п.)
			}
			switch {
			case strings.HasPrefix(t, "url:"):
				p.URL = unquoteYAML(strings.TrimPrefix(t, "url:"))
				p.Line = i + 1
			case strings.HasPrefix(t, "type:"):
				p.Type = unquoteYAML(strings.TrimPrefix(t, "type:"))
			case strings.HasPrefix(t, "path:"):
				p.File = unquoteYAML(strings.TrimPrefix(t, "path:"))
			case strings.HasPrefix(t, "interval:"):
				v := unquoteYAML(strings.TrimPrefix(t, "interval:"))
				if n, err := parseIntSafe(v); err == nil {
					p.Interval = n
				}
			}
		}
		out = append(out, p)
	}
	return out
}

func parseIntSafe(s string) (int, error) {
	n := 0
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("пусто")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("не число")
		}
		n = n*10 + int(s[i]-'0')
		if n > 1<<30 {
			return 0, fmt.Errorf("слишком большое")
		}
	}
	return n, nil
}

// setProviderURL меняет url: у провайдера name. Возвращает новый текст и ok.
func setProviderURL(text, name, newURL string) (string, bool) {
	lines := strings.Split(text, "\n")
	blocks := scanProviders(lines)
	var blk *provBlock
	for i := range blocks {
		if blocks[i].Name == name {
			blk = &blocks[i]
			break
		}
	}
	if blk == nil {
		return text, false
	}
	crlf := strings.Contains(text, "\r\n")
	cr := ""
	if crlf {
		cr = "\r"
	}
	if blk.URLLine >= 0 {
		old := lines[blk.URLLine]
		ind := strings.Repeat(" ", indentOf(old))
		lines[blk.URLLine] = ind + "url: " + yamlScalar(newURL) + cr
	} else {
		indent := blk.FieldIndent
		if indent <= blk.NameIndent {
			indent = blk.NameIndent + 2
		}
		line := strings.Repeat(" ", indent) + "url: " + yamlScalar(newURL) + cr
		out := make([]string, 0, len(lines)+1)
		out = append(out, lines[:blk.StartLine+1]...)
		out = append(out, line)
		out = append(out, lines[blk.StartLine+1:]...)
		lines = out
	}
	return strings.Join(lines, "\n"), true
}

func validateSubURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("ссылка пустая")
	}
	if len(raw) > 4096 {
		return fmt.Errorf("ссылка слишком длинная")
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("в ссылке есть служебные символы")
		}
	}
	if strings.ContainsAny(raw, `"'\<>`) {
		return fmt.Errorf(`в ссылке не должно быть кавычек, обратных слэшей и угловых скобок`)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("некорректная ссылка: %v", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("ссылка должна начинаться с http:// или https://")
	}
	if u.Host == "" {
		return fmt.Errorf("в ссылке нет хоста")
	}
	return nil
}

// reloadMihomoConfig просит mihomo перечитать конфиг с диска.
func (a *app) reloadMihomoConfig(path string) error {
	body, _ := json.Marshal(map[string]any{"path": path, "force": true})
	if _, err := a.cl.do("PUT", "/configs", body); err != nil {
		return err
	}
	invalidateProxies()
	return nil
}

// handleSubscriptionAPI — один путь на чтение и запись: GET отдаёт провайдеров
// с текущими url, POST меняет ссылку и перечитывает конфиг.
func (a *app) handleSubscriptionAPI(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		a.handleSubscription(w, r)
	case http.MethodPost, http.MethodPut:
		a.handleSubscriptionSave(w, r)
	default:
		fail(w, http.StatusMethodNotAllowed, "GET или POST")
	}
}

// handleSubscription — GET /api/subscription: провайдеры и их url из config.yaml.
func (a *app) handleSubscription(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		fail(w, http.StatusMethodNotAllowed, "только GET")
		return
	}
	cfgPath, found := mihomoConfigFile()
	if !found {
		writeJSON(w, subResp{OK: false, Found: false, ConfigPath: cfgPath,
			Err: "config.yaml не найден в " + *flagConfDir})
		return
	}
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		writeJSON(w, subResp{OK: false, Found: true, ConfigPath: cfgPath, Err: "прочитать конфиг: " + err.Error()})
		return
	}
	provs := parseProxyProviders(string(b))
	writeJSON(w, subResp{OK: true, Found: true, ConfigPath: cfgPath, Providers: provs})
}

// handleSubscriptionSave — POST /api/subscription {name, url}: заменить ссылку и
// перечитать конфиг. Возвращает, удалось ли перечитывание.
func (a *app) handleSubscriptionSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "только POST")
		return
	}
	var req struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "некорректный JSON: "+err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	newURL := strings.TrimSpace(req.URL)
	if name == "" {
		fail(w, http.StatusBadRequest, "не указан провайдер подписки")
		return
	}
	if err := validateSubURL(newURL); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	cfgPath, found := mihomoConfigFile()
	if !found {
		fail(w, http.StatusBadGateway, "config.yaml не найден в "+*flagConfDir)
		return
	}
	old, err := os.ReadFile(cfgPath)
	if err != nil {
		fail(w, http.StatusBadGateway, "прочитать конфиг: "+err.Error())
		return
	}

	provs := parseProxyProviders(string(old))
	var target *subProvider
	for i := range provs {
		if provs[i].Name == name {
			target = &provs[i]
			break
		}
	}
	if target == nil {
		fail(w, http.StatusNotFound, "провайдер «"+name+"» не найден в config.yaml")
		return
	}
	if target.URL == newURL {
		writeJSON(w, map[string]any{"ok": true, "name": name, "url": newURL,
			"configPath": cfgPath, "changed": false, "reloaded": false})
		return
	}

	next, ok := setProviderURL(string(old), name, newURL)
	if !ok {
		fail(w, http.StatusInternalServerError, "не удалось найти строку url: у провайдера «"+name+"»")
		return
	}

	backup := cfgPath + ".xrock-bak-" + time.Now().Format("20060102-150405")
	if err := os.WriteFile(backup, old, 0o644); err != nil {
		fail(w, http.StatusInternalServerError, "резервная копия: "+err.Error())
		return
	}
	info, err := os.Stat(cfgPath)
	mode := os.FileMode(0o644)
	if err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(cfgPath, []byte(next), mode); err != nil {
		fail(w, http.StatusInternalServerError, "записать конфиг: "+err.Error())
		return
	}

	resp := map[string]any{
		"ok": true, "name": name, "url": newURL, "configPath": cfgPath,
		"backup": filepath.Base(backup), "changed": true, "reloaded": true,
	}
	if err := a.reloadMihomoConfig(cfgPath); err != nil {
		resp["reloaded"] = false
		resp["reloadErr"] = err.Error()
	}
	writeJSON(w, resp)
}
