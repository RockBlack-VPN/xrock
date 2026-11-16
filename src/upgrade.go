package main

// Версии и обновления: ядро mihomo (через XKeen: xkeen -um auto) и сама панель
// (скачиваем xrock-latest.tar.gz из последнего релиза GitHub).

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	flagXkeen   = flag.String("xkeen", "/opt/sbin/xkeen", "путь к xkeen (обновление ядра)")
	flagBinPath = flag.String("bin", "/opt/sbin/xrock", "путь к своему бинарнику (самообновление)")
	flagInit    = flag.String("init", "/opt/etc/init.d/S99xrock", "init-скрипт панели")
	flagNoUpd   = flag.Bool("no-update", false, "запретить обновления ядра/панели из панели")
)

const (
	repoMihomo = "MetaCubeX/mihomo"
	repoXrock  = "RockBlack-VPN/xrock"
)


var ghClient = &http.Client{Timeout: 20 * time.Second}

type verCache struct {
	mu        sync.Mutex
	latest    map[string]string // repo → версия без v
	fetchedAt int64
}

var versions = &verCache{latest: map[string]string{}}

// ghLatestTag — последний тег релиза GitHub (без сети отдаёт кеш).
func ghLatestTag(repo string) (string, error) {
	versions.mu.Lock()
	if v, ok := versions.latest[repo]; ok && time.Now().Unix()-versions.fetchedAt < 600 {
		versions.mu.Unlock()
		return v, nil
	}
	versions.mu.Unlock()

	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/latest", nil)
	req.Header.Set("User-Agent", "xrock/"+version)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := ghClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GitHub API: HTTP %d", resp.StatusCode)
	}
	var r struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", err
	}
	v := strings.TrimPrefix(r.TagName, "v")
	versions.mu.Lock()
	versions.latest[repo] = v
	versions.fetchedAt = time.Now().Unix()
	versions.mu.Unlock()
	return v, nil
}

type verState struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
}

type versionsResp struct {
	Xrock     verState `json:"xrock"`
	Mihomo    verState `json:"mihomo"`
	CheckedAt int64    `json:"checkedAt"`
	Updating  string   `json:"updating,omitempty"` // "" | core | panel
}

func normVer(s string) string {
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "v"))
	return s
}

// newerVersion — true, если latest > current (числовое сравнение по частям).
func newerVersion(current, latest string) bool {
	c, l := normVer(current), normVer(latest)
	if l == "" || c == "" || c == l {
		return false
	}
	cs := strings.Split(c, ".")
	ls := strings.Split(l, ".")
	for i := 0; i < len(cs) || i < len(ls); i++ {
		var a, b int
		if i < len(cs) {
			a, _ = strconv.Atoi(strings.TrimFunc(cs[i], func(r rune) bool { return r < '0' || r > '9' }))
		}
		if i < len(ls) {
			b, _ = strconv.Atoi(strings.TrimFunc(ls[i], func(r rune) bool { return r < '0' || r > '9' }))
		}
		if b > a {
			return true
		}
		if b < a {
			return false
		}
	}
	return false
}

func (a *app) handleVersions(w http.ResponseWriter, r *http.Request) {
	resp := versionsResp{CheckedAt: time.Now().Unix()}
	resp.Xrock.Current = version
	resp.Mihomo.Current = a.currentMihomoVersion()
	if v, err := ghLatestTag(repoXrock); err == nil {
		resp.Xrock.Latest = v
		resp.Xrock.UpdateAvailable = newerVersion(resp.Xrock.Current, v)
	}
	if v, err := ghLatestTag(repoMihomo); err == nil {
		resp.Mihomo.Latest = v
		resp.Mihomo.UpdateAvailable = newerVersion(resp.Mihomo.Current, v)
	}
	if a.upgrading != "" {
		resp.Updating = a.upgrading
	}
	writeJSON(w, resp)
}

func (a *app) currentMihomoVersion() string {
	a.mu.Lock()
	v := a.mihomoVer
	a.mu.Unlock()
	if v != "" {
		return strings.TrimPrefix(v, "v")
	}
	if v2, err := a.cl.version(); err == nil {
		a.mu.Lock()
		a.mihomoVer = v2
		a.mu.Unlock()
		return strings.TrimPrefix(v2, "v")
	}
	return ""
}

func runCmd(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var sb strings.Builder
	cmd.Stdout = &sb
	cmd.Stderr = &sb
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return sb.String(), err
	case <-time.After(300 * time.Second):
		cmd.Process.Kill()
		return sb.String(), errors.New("команда не завершилась за 5 минут")
	}
}

func tailLines(s string, n int) []string {
	s = strings.ReplaceAll(s, "\r", "")
	var out []string
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(l)
		if l != "" {
			out = append(out, l)
		}
	}
	if len(out) > n {
		out = out[len(out)-n:]
	}
	return out
}

// handleUpgradeCore — обновить ядро mihomo через XKeen и перезапустить прокси.
func (a *app) handleUpgradeCore(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		fail(w, 405, "только POST")
		return
	}
	if *flagNoUpd {
		fail(w, 403, "обновления из панели запрещены флагом -no-update")
		return
	}
	if !a.beginUpgrade("core") {
		fail(w, 409, "уже идёт обновление: "+a.upgrading)
		return
	}
	defer a.endUpgrade()

	before := a.currentMihomoVersion()
	if latest, err := ghLatestTag(repoMihomo); err == nil && !newerVersion(before, latest) {
		writeJSON(w, map[string]any{"ok": true, "before": before, "after": before,
			"log": []string{"Уже последняя версия ядра (" + before + ")"}})
		return
	}
	logs := []string{"Текущая версия mihomo: " + before, "Запускаю xkeen -um auto…"}
	out, err := runCmd(*flagXkeen, "-um", "auto")
	logs = append(logs, tailLines(out, 25)...)
	if err != nil {
		fail(w, 502, "не удалось обновить ядро: "+err.Error())
		return
	}
	logs = append(logs, "Перезапускаю прокси (mihomo)…")
	if out2, err := runCmd(*flagXkeen, "-restart"); err != nil {
		logs = append(logs, tailLines(out2, 10)...)
		fail(w, 502, "ядро обновлено, но перезапуск не удался: "+err.Error())
		return
	}
	// ждём, пока API ответит
	after := ""
	for i := 0; i < 60; i++ {
		time.Sleep(time.Second)
		if v, err := a.cl.version(); err == nil {
			after = strings.TrimPrefix(v, "v")
			a.mu.Lock()
			a.mihomoVer = v
			a.mu.Unlock()
			break
		}
	}
	if after == "" {
		logs = append(logs, "mihomo не ответил за 60 секунд")
		fail(w, 502, "ядро обновлено, но mihomo не запустился — проверьте xkeen -restart")
		return
	}
	logs = append(logs, "Готово: mihomo "+after)
	writeJSON(w, map[string]any{"ok": true, "before": before, "after": after, "log": logs})
}

// handleUpgradePanel — самообновление: тянем архив релиза и подменяем файлы.
func (a *app) handleUpgradePanel(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		fail(w, 405, "только POST")
		return
	}
	if *flagNoUpd {
		fail(w, 403, "обновления из панели запрещены флагом -no-update")
		return
	}
	if !a.beginUpgrade("panel") {
		fail(w, 409, "уже идёт обновление: "+a.upgrading)
		return
	}
	defer a.endUpgrade()

	logs := []string{"Текущая версия xrock: " + version}
	latest, err := ghLatestTag(repoXrock)
	if err != nil {
		fail(w, 502, "не смог узнать последнюю версию: "+err.Error())
		return
	}
	if !newerVersion(version, latest) {
		writeJSON(w, map[string]any{"ok": true, "before": version, "after": version, "log": []string{"Уже последняя версия (" + version + ")"}})
		return
	}
	logs = append(logs, "Новая версия: "+latest, "Скачиваю архив…")
	url := "https://github.com/" + repoXrock + "/releases/latest/download/xrock-latest.tar.gz"
	tmp := filepath.Join(os.TempDir(), "xrock-update.tgz")
	if err := downloadFile(url, tmp); err != nil {
		fail(w, 502, "не удалось скачать архив: "+err.Error())
		return
	}
	defer os.Remove(tmp)
	logs = append(logs, "Распаковываю…")
	if err := installFromTar(tmp); err != nil {
		fail(w, 502, "не удалось установить: "+err.Error())
		return
	}
	logs = append(logs, "Файлы обновлены, перезапускаю панель…")
	writeJSON(w, map[string]any{"ok": true, "before": version, "after": latest, "restarting": true, "log": logs})
	a.restartSelf()
}

func downloadFile(url, dst string) error {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "xrock/"+version)
	cl := &http.Client{Timeout: 180 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(f, io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if n < 1<<20 {
		return errors.New("архив подозрительно маленький")
	}
	return nil
}

// installFromTar — из архива релиза ставим бинарник и UI.
func installFromTar(tgz string) error {
	f, err := os.Open(tgz)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	arch := map[string]string{"arm64": "xrock-arm64", "mips": "xrock-mips", "mipsle": "xrock-mipsel"}[runtime.GOARCH]
	if arch == "" {
		return errors.New("неизвестная архитектура: " + runtime.GOARCH)
	}
	uiDir := *flagUI
	if uiDir == "" {
		uiDir = filepath.Join(*flagConfDir, "xrock")
	}
	binTmp := filepath.Join(os.TempDir(), "xrock-new")
	gotBin := false
	gotUI := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		// путь внутри архива: xrock/<файл> или xrock/web/<файл>
		parts := strings.SplitN(name, "/", 2)
		if len(parts) < 2 || parts[0] != "xrock" {
			continue
		}
		rel := parts[1]
		switch {
		case rel == arch:
			if err := writeFromReader(tr, binTmp, 0755); err != nil {
				return err
			}
			gotBin = true
		case strings.HasPrefix(rel, "web/"):
			dst := filepath.Join(uiDir, strings.TrimPrefix(rel, "web/"))
			if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
				return err
			}
			if err := writeFromReader(tr, dst, 0644); err != nil {
				return err
			}
			gotUI++
		}
	}
	if !gotBin {
		return errors.New("в архиве нет бинарника для " + runtime.GOARCH)
	}
	if gotUI == 0 {
		return errors.New("в архиве нет файлов UI")
	}
	// подмена бинарника с резервной копией
	if st, err := os.Stat(binTmp); err != nil || st.Size() < 1<<20 {
		return errors.New("скачанный бинарник пустой")
	}
	backup := fmt.Sprintf("%s.bak-%d", *flagBinPath, time.Now().Unix())
	_ = copyFile(*flagBinPath, backup)
	// /tmp и /opt — разные файловые системы, rename не сработает: копируем рядом
	newPath := *flagBinPath + ".new"
	if err := copyFile(binTmp, newPath); err != nil {
		return err
	}
	os.Chmod(newPath, 0755)
	if err := os.Rename(newPath, *flagBinPath); err != nil {
		return err
	}
	return nil
}

func writeFromReader(r io.Reader, dst string, mode os.FileMode) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, io.LimitReader(r, 64<<20))
	return err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// restartSelf — перезапускает сервис через init-скрипт после ответа клиенту.
func (a *app) restartSelf() {
	cmd := exec.Command("/bin/sh", "-c", "sleep 2; "+*flagInit+" restart >/dev/null 2>&1")
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Start() // не ждём: наш процесс сейчас убьют
}

func (a *app) beginUpgrade(kind string) bool {
	a.updMu.Lock()
	defer a.updMu.Unlock()
	if a.upgrading != "" {
		return false
	}
	a.upgrading = kind
	return true
}

func (a *app) endUpgrade() {
	a.updMu.Lock()
	a.upgrading = ""
	a.updMu.Unlock()
}
