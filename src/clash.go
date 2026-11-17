package main

// Клиент Clash API mihomo (external-controller). Секрет остаётся на демоне:
// браузер общается только с xrock.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type clash struct {
	mu     sync.RWMutex // base/secret меняются, если config.yaml переписали
	base   string
	secret string
	hc     *http.Client // обычные запросы, с таймаутом
	hcFast *http.Client // то, что ждёт UI (state) — без долгих зависаний
	stream *http.Client // стримы (/traffic, /logs) — без общего таймаута
}

func (c *clash) baseURL() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.base
}

func (c *clash) authSecret() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.secret
}

// setAuth переключает клиент на новый адрес/секрет Clash API. true — если что-то
// изменилось (тогда кеши прокси надо сбросить).
func (c *clash) setAuth(api, secret string) bool {
	if !strings.HasPrefix(api, "http") {
		api = "http://" + api
	}
	api = strings.TrimRight(api, "/")
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.base == api && c.secret == secret {
		return false
	}
	c.base = api
	c.secret = secret
	return true
}

func newClash(api, secret string) *clash {
	if !strings.HasPrefix(api, "http") {
		api = "http://" + api
	}
	api = strings.TrimRight(api, "/")
	tr := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		MaxIdleConns:        8,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	return &clash{
		base:   api,
		secret: secret,
		hc:     &http.Client{Transport: tr, Timeout: 12 * time.Second},
		hcFast: &http.Client{Transport: tr, Timeout: 5 * time.Second},
		stream: &http.Client{Transport: tr},
	}
}

func (c *clash) do(method, path string, body []byte) ([]byte, error) {
	return c.doWith(c.hc, method, path, body)
}

// doFast — тот же запрос, но с коротким таймаутом: UI не должен ждать 12 секунд.
func (c *clash) doFast(method, path string, body []byte) ([]byte, error) {
	return c.doWith(c.hcFast, method, path, body)
}

func (c *clash) doWith(client *http.Client, method, path string, body []byte) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.baseURL()+path, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if secret := c.authSecret(); secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := strings.TrimSpace(string(b))
		var j struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &j) == nil && j.Message != "" {
			msg = j.Message
		}
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, msg)
	}
	return b, nil
}

func (c *clash) get(path string, v any) error {
	b, err := c.do("GET", path, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func (c *clash) getFast(path string, v any) error {
	b, err := c.doFast("GET", path, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

type proxyItem struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	UDP      bool    `json:"udp"`
	Alive    bool    `json:"alive"`
	Now      string  `json:"now"`
	All      []string `json:"all"`
	Provider string  `json:"provider-name"`
	Icon     string  `json:"icon"`
	Hidden   bool    `json:"hidden"`
	TestURL  string  `json:"testUrl"`
	History  []struct {
		Time  string `json:"time"`
		Delay int    `json:"delay"`
	} `json:"history"`
}

// isGroup — это группа (Selector/Fallback/URLTest/…), а не реальный узел.
func (p *proxyItem) isGroup() bool {
	switch strings.ToLower(p.Type) {
	case "selector", "fallback", "urltest", "loadbalance", "relay", "compatible":
		return true
	}
	return false
}

// isService — служебные псевдо-прокси, их нельзя ставить в группу.
func (p *proxyItem) isService() bool {
	switch strings.ToLower(p.Type) {
	case "direct", "reject", "rejectdrop", "pass", "passrule", "dns":
		return true
	}
	return false
}

type subInfo struct {
	Upload   int64 `json:"Upload"`
	Download int64 `json:"Download"`
	Total    int64 `json:"Total"`
	Expire   int64 `json:"Expire"`
}

type providerItem struct {
	Name             string       `json:"name"`
	Type             string       `json:"type"`
	VehicleType      string       `json:"vehicleType"`
	UpdatedAt        string       `json:"updatedAt"`
	TestURL          string       `json:"testUrl"`
	Interval         int          `json:"interval"`
	SubscriptionInfo *subInfo     `json:"subscriptionInfo"`
	Proxies          []*proxyItem `json:"proxies"`
}

type connMeta struct {
	Network         string `json:"network"`
	Type            string `json:"type"`
	SourceIP        string `json:"sourceIP"`
	DestinationIP   string `json:"destinationIP"`
	DestinationPort string `json:"destinationPort"`
	Host            string `json:"host"`
	InboundName     string `json:"inboundName"`
	SniffHost       string `json:"sniffHost"`
	Process         string `json:"process"`
	ProcessPath     string `json:"processPath"`
}

type connItem struct {
	ID       string   `json:"id"`
	Metadata connMeta `json:"metadata"`
	Upload   int64    `json:"upload"`
	Download int64    `json:"download"`
	Start    string   `json:"start"`
	Chains   []string `json:"chains"`
	Rule     string   `json:"rule"`
	RulePayload string `json:"rulePayload"`
}

type connsResp struct {
	DownloadTotal int64      `json:"downloadTotal"`
	UploadTotal   int64      `json:"uploadTotal"`
	Connections   []connItem `json:"connections"`
}

type ruleItem struct {
	Index   int    `json:"index"`
	Type    string `json:"type"`
	Payload string `json:"payload"`
	Proxy   string `json:"proxy"`
	Size    int64  `json:"size"`
}

type trafficItem struct {
	Up        int64 `json:"up"`
	Down      int64 `json:"down"`
	UpTotal   int64 `json:"upTotal"`
	DownTotal int64 `json:"downTotal"`
}

type logItem struct {
	Type    string `json:"type"`
	Payload string `json:"payload"`
}

func (c *clash) version() (string, error) {
	var v struct {
		Meta    bool   `json:"meta"`
		Version string `json:"version"`
	}
	if err := c.get("/version", &v); err != nil {
		return "", err
	}
	return v.Version, nil
}

// versionFast — проверка связи с коротким таймаутом (для фоновых проверок).
func (c *clash) versionFast() (string, error) {
	var v struct {
		Meta    bool   `json:"meta"`
		Version string `json:"version"`
	}
	if err := c.getFast("/version", &v); err != nil {
		return "", err
	}
	return v.Version, nil
}

func (c *clash) proxies() (map[string]*proxyItem, error) {
	var r struct {
		Proxies map[string]*proxyItem `json:"proxies"`
	}
	if err := c.getFast("/proxies", &r); err != nil {
		return nil, err
	}
	return r.Proxies, nil
}

func (c *clash) providers() (map[string]*providerItem, error) {
	var r struct {
		Providers map[string]*providerItem `json:"providers"`
	}
	if err := c.getFast("/providers/proxies", &r); err != nil {
		return nil, err
	}
	return r.Providers, nil
}

// allProxies — группы/служебные из /proxies + узлы из провайдеров подписки.
// mihomo НЕ отдаёт узлы провайдеров в /proxies, только в /providers/proxies,
// поэтому без этого списка панель видела «0 серверов».
//
// /providers/proxies — тяжёлый ответ (сотни КБ), а UI опрашивает state каждые
// 2–3 секунды, поэтому держим короткий кеш (2 с). После обновления подписки
// кеш сбрасывается через invalidateProxies.
var proxiesCache struct {
	sync.Mutex
	m map[string]*proxyItem
	t int64
}

func invalidateProxies() {
	proxiesCache.Lock()
	proxiesCache.m = nil
	proxiesCache.Unlock()
}

func (c *clash) allProxies() (map[string]*proxyItem, error) {
	proxiesCache.Lock()
	if proxiesCache.m != nil && time.Now().Unix()-proxiesCache.t < 2 {
		m := proxiesCache.m
		proxiesCache.Unlock()
		return m, nil
	}
	proxiesCache.Unlock()

	m, err := c.proxies()
	if err != nil {
		return nil, err
	}
	provs, err := c.providers()
	if err == nil {
		for pname, p := range provs {
			if strings.EqualFold(p.VehicleType, "compatible") {
				continue // зеркала групп, не подписка
			}
			for _, item := range p.Proxies {
				if item == nil || item.Name == "" {
					continue
				}
				if item.Provider == "" {
					item.Provider = pname
				}
				m[item.Name] = item
			}
		}
	}
	proxiesCache.Lock()
	proxiesCache.m, proxiesCache.t = m, time.Now().Unix()
	proxiesCache.Unlock()
	return m, nil
}

// delay — задержка ЧЕРЕЗ ПРОКСИ (mihomo сам делает запрос через узел).
func (c *clash) delay(name, targetURL string, timeoutMS int) (int, error) {
	if targetURL == "" {
		targetURL = "https://www.youtube.com/generate_204"
	}
	p := "/proxies/" + url.PathEscape(name) + "/delay?timeout=" + itoa(timeoutMS) + "&url=" + url.QueryEscape(targetURL)
	var r struct {
		Delay int `json:"delay"`
	}
	if err := c.get(p, &r); err != nil {
		return 0, err
	}
	if r.Delay <= 0 {
		return 0, errors.New("нет ответа")
	}
	return r.Delay, nil
}

// providerNodeDelay — проксированный замер конкретного узла подписки:
// GET /providers/proxies/{provider}/{node}/healthcheck. Именно этот путь отдаёт
// задержку для узлов провайдера (в /proxies их нет).
func (c *clash) providerNodeDelay(provider, node, targetURL string, timeoutMS int) (int, error) {
	if targetURL == "" {
		targetURL = "https://www.youtube.com/generate_204"
	}
	p := "/providers/proxies/" + url.PathEscape(provider) + "/" + url.PathEscape(node) +
		"/healthcheck?timeout=" + itoa(timeoutMS) + "&url=" + url.QueryEscape(targetURL)
	var r struct {
		Delay int `json:"delay"`
	}
	if err := c.get(p, &r); err != nil {
		return 0, err
	}
	if r.Delay <= 0 {
		return 0, errors.New("нет ответа")
	}
	return r.Delay, nil
}

// groupDelay — один запрос, в ответе задержки ВСЕХ участников группы
// (включая вложенные группы). mihomo делает каждый замер через сам узел.
func (c *clash) groupDelay(group, targetURL string, timeoutMS int) (map[string]int, error) {
	if targetURL == "" {
		targetURL = "https://www.youtube.com/generate_204"
	}
	p := "/group/" + url.PathEscape(group) + "/delay?timeout=" + itoa(timeoutMS) + "&url=" + url.QueryEscape(targetURL)
	var r map[string]int
	if err := c.get(p, &r); err != nil {
		return nil, err
	}
	return r, nil
}

func (c *clash) selectProxy(group, name string) error {
	b, _ := json.Marshal(map[string]string{"name": name})
	_, err := c.do("PUT", "/proxies/"+url.PathEscape(group), b)
	return err
}

func (c *clash) updateProvider(name string) error {
	_, err := c.do("PUT", "/providers/proxies/"+url.PathEscape(name), nil)
	return err
}

func (c *clash) connections() (*connsResp, error) {
	var r connsResp
	if err := c.get("/connections", &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (c *clash) closeConn(id string) error {
	_, err := c.do("DELETE", "/connections/"+url.PathEscape(id), nil)
	return err
}

func (c *clash) closeAll() error {
	_, err := c.do("DELETE", "/connections", nil)
	return err
}

func (c *clash) rules() ([]ruleItem, error) {
	var r struct {
		Rules []ruleItem `json:"rules"`
	}
	if err := c.get("/rules", &r); err != nil {
		return nil, err
	}
	return r.Rules, nil
}

// putConfig просит mihomo перечитать конфиг из файла (после правки правил).
func (c *clash) putConfig(path string) error {
	body, err := json.Marshal(map[string]any{"path": path, "force": true})
	if err != nil {
		return err
	}
	_, err = c.do("PUT", "/configs?force=true", body)
	return err
}

// streamGet — GET на стрим mihomo; тело читает вызывающий, отмена по ctx.
func (c *clash) streamGet(ctx context.Context, path string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL()+path, nil)
	if err != nil {
		return nil, err
	}
	if secret := c.authSecret(); secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
