package main

import "testing"

const testCfg = `mixed-port: 7890
proxy-groups:
  - name: PROXY
    type: select
    include-all: true
    proxies: [Fallback, Fastest]

rules:
  - RULE-SET,torrent@inline,DIRECT # Торренты напрямую (должно быть первым)
  - RULE-SET,torrent-trackers@domain,DIRECT
  - DOMAIN,eri2.nca.by,DIRECT
#  - RULE-SET,adlist@domain,REJECT # Блокировка рекламы
  - RULE-SET,quic@inline,REJECT # Блокировка QUIC
  - OR,((RULE-SET,category-ru@domain),(RULE-SET,category-ru@ipcidr)),DIRECT
  - OR,((RULE-SET,telegram@domain),(RULE-SET,telegram@ipcidr)),Telegram
  - MATCH,PROXY
`

func TestParseRulesDoc(t *testing.T) {
	lines := splitTestLines(testCfg)
	start, end, rules, ok := parseRulesDoc(lines)
	if !ok {
		t.Fatal("блок rules: не найден")
	}
	if start != 7 || end != len(lines) {
		t.Fatalf("границы блока: start=%d end=%d", start, end)
	}
	// закомментированное правило (#  - …) в список не попадает
	if len(rules) != 7 {
		t.Fatalf("ожидалось 8 правил, получено %d: %+v", len(rules), rules)
	}
	if r := rules[0]; r.Type != "RULE-SET" || r.Payload != "torrent@inline" || r.Proxy != "DIRECT" || r.Disabled {
		t.Fatalf("первое правило разобрано неверно: %+v", r)
	}
	if r := rules[4]; r.Type != "OR" || r.Proxy != "DIRECT" ||
		r.Payload != "((RULE-SET,category-ru@domain),(RULE-SET,category-ru@ipcidr))" {
		t.Fatalf("OR-правило разобрано неверно: %+v", r)
	}
	if r := rules[6]; r.Type != "MATCH" || r.Proxy != "PROXY" || r.Payload != "" {
		t.Fatalf("MATCH разобран неверно: %+v", r)
	}
}

func TestRuleOffMarker(t *testing.T) {
	// так выглядит выключенное правило в файле
	body, disabled, ok := ruleBody("  #off - DOMAIN,av.by,DIRECT")
	if !ok || !disabled || body != "DOMAIN,av.by,DIRECT" {
		t.Fatalf("маркер #off не распознан: body=%q disabled=%v ok=%v", body, disabled, ok)
	}
	// обычное правило и не-правило
	if _, d, ok := ruleBody("  - DOMAIN,av.by,DIRECT"); !ok || d {
		t.Fatal("обычное правило распознано неверно")
	}
	if _, _, ok := ruleBody("  # просто комментарий"); ok {
		t.Fatal("комментарий принят за правило")
	}
}

func TestSplitRule(t *testing.T) {
	cases := []struct{ in, typ, payload, target string }{
		{"DOMAIN,eri2.nca.by,DIRECT", "DOMAIN", "eri2.nca.by", "DIRECT"},
		{"RULE-SET,torrent@inline,DIRECT # Торренты", "RULE-SET", "torrent@inline", "DIRECT"},
		{"OR,((A,B),(C,D)),PROXY", "OR", "((A,B),(C,D))", "PROXY"},
		{"MATCH,PROXY", "MATCH", "", "PROXY"},
	}
	for _, c := range cases {
		typ, payload, target := splitRule(c.in)
		if typ != c.typ || payload != c.payload || target != c.target {
			t.Fatalf("%q → (%q, %q, %q), ожидалось (%q, %q, %q)", c.in, typ, payload, target, c.typ, c.payload, c.target)
		}
	}
}

func splitTestLines(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '\n' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
