package main

// Конфигурация: адрес и секрет Clash API берём из config.yaml mihomo (если не заданы
// флагами), панель по умолчанию слушает 0.0.0.0:9091.

import (
	"flag"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const version = "0.5.6"

var (
	flagListen  = flag.String("listen", "0.0.0.0:9091", "адрес панели xrock")
	flagAPI     = flag.String("api", "", "адрес Clash API mihomo (по умолчанию из config.yaml)")
	flagSecret  = flag.String("secret", "", "секрет Clash API (по умолчанию из config.yaml)")
	flagConfDir = flag.String("confdir", "/opt/etc/mihomo", "папка конфигов mihomo")
	flagState   = flag.String("state", "/opt/etc/xrock.json", "файл настроек и истории")
	flagUI      = flag.String("ui", "", "папка с UI (по умолчанию встроенный)")
	flagLog     = flag.String("log", "", "файл журнала (по умолчанию stdout)")
)

// mihomoConf — что нам нужно из config.yaml.
type mihomoConf struct {
	API    string
	Secret string
	UIName string
	Found  bool
}

var (
	reExternalController = regexp.MustCompile(`(?m)^external-controller:\s*["']?([^\s"'#]+)`)
	reSecret             = regexp.MustCompile(`(?m)^secret:\s*["']?([^\s"'#]*)`)
	reExternalUI         = regexp.MustCompile(`(?m)^external-ui:\s*["']?([^\s"'#]+)`)
)

// readMihomoConf читает config.yaml построчно (полноценный YAML не нужен: три
// ключа верхнего уровня). Файла нет — вернёт Found=false, работать будет по флагам.
func readMihomoConf(dir string) mihomoConf {
	var c mihomoConf
	for _, name := range []string{"config.yaml", "config.yml"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		c.Found = true
		s := strings.TrimPrefix(string(b), "\ufeff") // файл могли сохранить с BOM (Windows)
		if m := reExternalController.FindStringSubmatch(s); m != nil {
			c.API = m[1]
		}
		if m := reSecret.FindStringSubmatch(s); m != nil {
			c.Secret = strings.TrimSpace(m[1])
		}
		if m := reExternalUI.FindStringSubmatch(s); m != nil {
			c.UIName = m[1]
		}
		break
	}
	return c
}

// localAPI превращает 0.0.0.0:9090 в 127.0.0.1:9090 — панель и mihomo на одном роутере.
func localAPI(addr string) string {
	if addr == "" {
		return "127.0.0.1:9090"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		if strings.HasPrefix(addr, ":") {
			return "127.0.0.1" + addr
		}
		return addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
