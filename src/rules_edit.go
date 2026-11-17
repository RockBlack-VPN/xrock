package main

// Правка правил прямо из панели: включить/выключить существующее правило и
// добавить своё. mihomo не умеет менять правила по API, поэтому панель
// редактирует блок rules: в config.yaml построчно (не трогая остальной файл),
// проверяет результат `mihomo -t` и просит mihomo перечитать конфиг.
//
// Выключенное правило остаётся в файле строкой «#off - TYPE,payload,target» —
// так его видно в панели и можно вернуть одним нажатием.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const ruleOffMark = "#off "

// cfgRule — правило из config.yaml в том виде, в каком его показывает панель.
type cfgRule struct {
	ID       int    `json:"id"`
	Type     string `json:"type"`
	Payload  string `json:"payload"`
	Proxy    string `json:"proxy"`
	Disabled bool   `json:"disabled"`
	Raw      string `json:"raw,omitempty"`
}

func readLines(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return nil, nil
	}
	return strings.Split(s, "\n"), nil
}

// ruleBody — содержимое правила в строке файла (после «- »), выключено ли оно
// нашим маркером и похоже ли строка вообще на правило.
func ruleBody(line string) (body string, disabled bool, ok bool) {
	t := strings.TrimLeft(line, " \t")
	if strings.HasPrefix(t, ruleOffMark) {
		t = t[len(ruleOffMark):]
		disabled = true
	}
	if !strings.HasPrefix(t, "- ") {
		return "", false, false
	}
	return strings.TrimSpace(t[2:]), disabled, true
}

func stripInlineComment(s string) string {
	if i := strings.Index(s, " #"); i >= 0 {
		return s[:i]
	}
	if i := strings.Index(s, "\t#"); i >= 0 {
		return s[:i]
	}
	return s
}

// splitRule — «TYPE,payload,target», где payload может содержать запятые
// (например OR,((RULE-SET,a),(RULE-SET,b)),DIRECT). Поэтому цель — после
// последней запятой, тип — до первой.
func splitRule(s string) (typ, payload, target string) {
	s = strings.TrimSpace(stripInlineComment(s))
	i := strings.Index(s, ",")
	if i < 0 {
		return s, "", ""
	}
	typ = strings.TrimSpace(s[:i])
	rest := s[i+1:]
	j := strings.LastIndex(rest, ",")
	if j < 0 {
		// MATCH,PROXY — у правила без содержимого после типа сразу цель
		if typ == "MATCH" || typ == "FINAL" {
			return typ, "", strings.TrimSpace(rest)
		}
		return typ, strings.TrimSpace(rest), ""
	}
	return typ, strings.TrimSpace(rest[:j]), strings.TrimSpace(rest[j+1:])
}

// parseRulesDoc находит блок rules: и разбирает его строки.
func parseRulesDoc(lines []string) (start, end int, rules []cfgRule, ok bool) {
	start = -1
	for i, ln := range lines {
		if strings.TrimSpace(ln) == "rules:" && len(ln) == len(strings.TrimLeft(ln, " \t")) {
			start = i
			break
		}
	}
	if start < 0 {
		return 0, 0, nil, false
	}
	end = len(lines)
	for i := start + 1; i < len(lines); i++ {
		ln := lines[i]
		if strings.TrimSpace(ln) == "" || ln[0] == ' ' || ln[0] == '\t' || strings.HasPrefix(ln, "#") {
			continue
		}
		end = i
		break
	}
	id := 0
	for i := start + 1; i < end; i++ {
		body, disabled, isRule := ruleBody(lines[i])
		if !isRule {
			continue
		}
		t, p, x := splitRule(body)
		rules = append(rules, cfgRule{ID: id, Type: t, Payload: p, Proxy: x, Disabled: disabled, Raw: strings.TrimSpace(lines[i])})
		id++
	}
	return start, end, rules, true
}

func cfgPath() string { return filepath.Join(*flagConfDir, "config.yaml") }

func mihomoBin() string {
	for _, p := range []string{"/opt/sbin/mihomo", "/opt/bin/mihomo"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath("mihomo"); err == nil {
		return p
	}
	return ""
}

func lastLines(s string, n int) string {
	out := ""
	for _, l := range tailLines(s, n) {
		out += l + " · "
	}
	return strings.TrimSuffix(out, " · ")
}

// writeConfigValidated — бэкап, проверка `mihomo -t`, запись и перечитывание.
// Если mihomo не принял конфиг — файл остаётся прежним.
func (a *app) writeConfigValidated(path string, lines []string) error {
	orig, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := strings.Join(lines, "\n")
	if content != "" {
		content += "\n"
	}
	bak := path + ".bak-rules-" + time.Now().Format("20060102-150405")
	if err := os.WriteFile(bak, orig, 0644); err != nil {
		return fmt.Errorf("не смог сделать бэкап: %v", err)
	}
	tmp := path + ".tmp-rules"
	if err := os.WriteFile(tmp, []byte(content), 0644); err != nil {
		return err
	}
	if bin := mihomoBin(); bin != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, "-t", "-d", *flagConfDir, "-f", tmp)
		out, err := cmd.CombinedOutput()
		if err != nil {
			os.Remove(tmp)
			msg := lastLines(string(out), 2)
			if msg == "" {
				msg = err.Error()
			}
			return errors.New("mihomo не принял конфиг: " + msg)
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := a.cl.putConfig(path); err != nil {
		// возвращаем как было, чтобы mihomo и файл не разъехались
		os.WriteFile(path, orig, 0644)
		a.cl.putConfig(path)
		return fmt.Errorf("mihomo не перечитал конфиг: %v", err)
	}
	return nil
}

// setRuleEnabled — включить/выключить правило по его id в блоке rules:.
func (a *app) setRuleEnabled(id int, enabled bool) ([]cfgRule, error) {
	path := cfgPath()
	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	start, end, rules, ok := parseRulesDoc(lines)
	if !ok {
		return nil, errors.New("в config.yaml не найден блок rules:")
	}
	if id < 0 || id >= len(rules) {
		return nil, errors.New("правило не найдено — обновите список")
	}
	idx := -1
	n := 0
	for i := start + 1; i < end; i++ {
		if _, _, is := ruleBody(lines[i]); !is {
			continue
		}
		if n == id {
			idx = i
			break
		}
		n++
	}
	if idx < 0 {
		return nil, errors.New("правило не найдено в файле")
	}
	indent := lines[idx][:len(lines[idx])-len(strings.TrimLeft(lines[idx], " \t"))]
	body := strings.TrimLeft(lines[idx], " \t")
	if enabled {
		lines[idx] = indent + strings.TrimPrefix(body, ruleOffMark)
	} else {
		if strings.HasPrefix(body, ruleOffMark) {
			return rules, nil // уже выключено
		}
		lines[idx] = indent + ruleOffMark + body
	}
	if err := a.writeConfigValidated(path, lines); err != nil {
		return nil, err
	}
	_, _, rules2, _ := parseRulesDoc(lines)
	if rules2 == nil {
		rules2 = rules
	}
	return rules2, nil
}

// addRule — добавить правило перед MATCH (или в конец блока rules:).
func (a *app) addRule(rtype, payload, target string) ([]cfgRule, error) {
	rtype = strings.ToUpper(strings.TrimSpace(rtype))
	payload = strings.TrimSpace(payload)
	target = strings.TrimSpace(target)
	if rtype == "" || target == "" {
		return nil, errors.New("нужны тип, содержимое и цель")
	}
	if rtype == "MATCH" {
		return nil, errors.New("MATCH уже есть в конце — его не добавляем")
	}
	for _, s := range []string{rtype, payload, target} {
		if strings.ContainsAny(s, "\n\r") || strings.Contains(s, ",") && s == rtype {
			return nil, errors.New("недопустимые символы в правиле")
		}
	}
	path := cfgPath()
	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	start, end, rules, ok := parseRulesDoc(lines)
	if !ok {
		return nil, errors.New("в config.yaml не найден блок rules:")
	}
	indent := "  "
	for i := start + 1; i < end; i++ {
		if _, _, is := ruleBody(lines[i]); is {
			indent = lines[i][:len(lines[i])-len(strings.TrimLeft(lines[i], " \t"))]
			break
		}
	}
	pos := end
	for i := start + 1; i < end; i++ {
		if b, _, is := ruleBody(lines[i]); is && strings.HasPrefix(strings.ToUpper(b), "MATCH") {
			pos = i
			break
		}
	}
	newLine := indent + "- " + rtype + "," + payload + "," + target
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:pos]...)
	out = append(out, newLine)
	out = append(out, lines[pos:]...)
	if err := a.writeConfigValidated(path, out); err != nil {
		return nil, err
	}
	_, _, rules2, _ := parseRulesDoc(out)
	if rules2 == nil {
		rules2 = rules
	}
	return rules2, nil
}

func (a *app) configRules() ([]cfgRule, bool) {
	lines, err := readLines(cfgPath())
	if err != nil {
		return nil, false
	}
	_, _, rules, ok := parseRulesDoc(lines)
	if !ok || len(rules) == 0 {
		return nil, false
	}
	return rules, true
}

// handleRules — GET: список (из config.yaml, иначе из mihomo), POST: вкл/выкл,
// PUT: добавить своё правило.
func (a *app) handleRules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "POST":
		var req struct {
			ID      int  `json:"id"`
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, "нужен JSON {id, enabled}")
			return
		}
		rules, err := a.setRuleEnabled(req.ID, req.Enabled)
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		if req.Enabled {
			a.addEvent("info", "", "правило включено")
		} else {
			a.addEvent("info", "", "правило отключено")
		}
		writeJSON(w, map[string]any{"ok": true, "rules": rules, "src": "file"})
	case "PUT":
		var req struct {
			Type    string `json:"type"`
			Payload string `json:"payload"`
			Proxy   string `json:"proxy"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, "нужен JSON {type, payload, proxy}")
			return
		}
		rules, err := a.addRule(req.Type, req.Payload, req.Proxy)
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		a.addEvent("info", "", "добавлено правило "+strings.ToUpper(req.Type)+","+req.Payload+","+req.Proxy)
		writeJSON(w, map[string]any{"ok": true, "rules": rules, "src": "file"})
	default:
		if rules, ok := a.configRules(); ok {
			writeJSON(w, map[string]any{"rules": rules, "src": "file"})
			return
		}
		rules, err := a.cl.rules()
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		writeJSON(w, map[string]any{"rules": rules, "src": "mihomo"})
	}
}
