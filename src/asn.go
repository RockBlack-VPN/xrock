package main

// ASN / страна / провайдер по IP для карточки соединения и журнала.
// Источник — бесплатный ip-api.com (лимит 45 запросов/мин), поэтому кеш 24 часа
// и жёсткий таймаут. Роутер до него дотягивается напрямую.

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type asnInfo struct {
	IP          string `json:"ip"`
	Status      string `json:"status"`
	Country     string `json:"country"`
	CountryCode string `json:"countryCode"`
	AS          string `json:"as"`
	ASN         int    `json:"asn"`
	ASName      string `json:"asname"`
	ISP         string `json:"isp"`
	Org         string `json:"org"`
	Cached      bool   `json:"cached,omitempty"`
	Err         string `json:"err,omitempty"`
}

type asnEntry struct {
	info asnInfo
	t    int64
}

var asnCache = struct {
	sync.Mutex
	m map[string]asnEntry
}{m: map[string]asnEntry{}}

var asnClient = &http.Client{Timeout: 7 * time.Second}

func parseASN(as string) int {
	as = strings.TrimSpace(as)
	if strings.HasPrefix(strings.ToUpper(as), "AS") {
		as = as[2:]
	}
	fields := strings.Fields(as)
	if len(fields) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(fields[0])
	return n
}

// lookupASN — вернуть ASN/страну/провайдера, из кеша или из ip-api.com.
func lookupASN(ip string) asnInfo {
	now := time.Now().Unix()
	asnCache.Lock()
	if e, ok := asnCache.m[ip]; ok && now-e.t < 86400 {
		asnCache.Unlock()
		e.info.Cached = true
		return e.info
	}
	asnCache.Unlock()

	out := asnInfo{IP: ip, Status: "fail"}
	req, _ := http.NewRequest("GET", "http://ip-api.com/json/"+url.PathEscape(ip)+
		"?fields=status,country,countryCode,as,asname,isp,org", nil)
	req.Header.Set("User-Agent", "xrock/"+version)
	resp, err := asnClient.Do(req)
	if err != nil {
		out.Err = "нет связи с ip-api.com"
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		out.Err = "ip-api.com: HTTP " + strconv.Itoa(resp.StatusCode)
		return out
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		out.Err = "ответ ip-api.com не разобрался"
		return out
	}
	out.ASN = parseASN(out.AS)
	out.IP = ip
	asnCache.Lock()
	asnCache.m[ip] = asnEntry{info: out, t: now}
	// не даём кешу расти бесконечно
	if len(asnCache.m) > 4000 {
		for k, v := range asnCache.m {
			if now-v.t > 86400 {
				delete(asnCache.m, k)
			}
		}
	}
	asnCache.Unlock()
	return out
}

// handleASN — GET /api/asn?ip=1.2.3.4 (или ?ips=1.1.1.1,2.2.2.2 — до 10 адресов).
func (a *app) handleASN(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if ips := q.Get("ips"); ips != "" {
		var list []string
		for _, s := range strings.Split(ips, ",") {
			s = strings.TrimSpace(s)
			if net.ParseIP(s) == nil {
				continue
			}
			list = append(list, s)
			if len(list) >= 10 {
				break
			}
		}
		out := make(map[string]asnInfo, len(list))
		for _, ip := range list {
			out[ip] = lookupASN(ip)
		}
		writeJSON(w, map[string]any{"results": out})
		return
	}
	ip := strings.TrimSpace(q.Get("ip"))
	if net.ParseIP(ip) == nil {
		fail(w, 400, "нужен корректный ip")
		return
	}
	writeJSON(w, lookupASN(ip))
}
