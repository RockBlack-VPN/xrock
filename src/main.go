package main

// xrock — панель для mihomo (Keenetic + Entware + XKeen).
// Один бинарник: UI (отдаётся и сам, и через external-ui mihomo) + сторож,
// который быстро переключает группу, если активный сервер перестал открывать
// сервисы. Подробности — README.md и docs/api.md.

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"
)

//go:embed web
var embeddedUI embed.FS

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "-v", "--version", "version":
			fmt.Println("xrock", version)
			return
		}
	}
	flag.Parse()

	if *flagLog != "" {
		f, err := os.OpenFile(*flagLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err == nil {
			log.SetOutput(f)
			log.SetFlags(log.LstdFlags)
		}
	}

	mc := readMihomoConf(*flagConfDir)
	api := *flagAPI
	if api == "" {
		api = localAPI(mc.API)
	}
	secret := *flagSecret
	if secret == "" {
		secret = mc.Secret
	}
	cl := newClash(api, secret)
	a := newApp(cl, *flagState, *flagUI, *flagLog)

	if v, err := cl.version(); err != nil {
		a.setAPIErr(err)
		log.Printf("mihomo API (%s) пока не отвечает: %v", api, err)
	} else {
		a.mu.Lock()
		a.mihomoVer = v
		a.mu.Unlock()
		log.Printf("mihomo %s, API %s", v, api)
	}

	uiFS, err := fs.Sub(embeddedUI, "web")
	if err != nil {
		log.Fatalf("встроенный UI: %v", err)
	}
	if *flagUI != "" {
		log.Printf("UI из папки %s", *flagUI)
	}

	go a.saveLoop()
	go a.confLoop()
	go a.connsPoll()
	go a.sysLoop()

	srv := &http.Server{
		Addr:              *flagListen,
		Handler:           a.routes(uiFS),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("xrock %s: панель http://%s", version, *flagListen)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("панель: %v", err)
	}
}
