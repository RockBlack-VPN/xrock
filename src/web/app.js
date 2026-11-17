/* ==========================================================================
   xrock — панель управления mihomo (Keenetic)
   Чистый JS без зависимостей: fetch + EventSource + DOM.
   Никаких внешних запросов: только адрес демона (по умолчанию :9091).
   ========================================================================== */
(function () {
  'use strict';

  var API_KEY = 'xrock.api';
  var POLL_MS = 2500;          // опрос /api/state
  var CONN_MS = 2000;          // автообновление соединений
  var SYS_MS = 4000;           // опрос ресурсов роутера (/api/sys)
  var SYS_RETRY_MS = 30000;    // если демон не отдаёт /api/sys — не долбим его каждые 4 с
  var TEST_TIMEOUT = 120000;   // проксированный замер может быть долгим
  var UPGRADE_TIMEOUT = 180000; // обновление ядра mihomo: синхронно, до 2–3 минут
  var PANEL_WAIT_MS = 60000;   // ожидание перезапуска панели после обновления
  var LONG_PRESS_MS = 450;     // удержание карточки узла = тест
  var VIEWS = ['overview', 'servers', 'connections', 'rules', 'subscription', 'journal', 'settings'];

  /* ------------------------------ состояние ------------------------------ */

  var ui = {
    view: 'overview',
    api: '',
    state: null,
    seen: false,
    setupOpen: false,
    link: { ok: false, err: '', fails: 0, version: '', daemonOk: false, daemonVersion: '', probing: false, probedAt: 0 },
    traffic: { up: 0, down: 0, at: 0, histD: [], histU: [] },
    conns: { list: [], search: '', at: 0, lastTry: 0, up: 0, down: 0, total: 0, loading: false, closing: false, hover: false, err: '', device: '', sort: { key: 'time', dir: 'desc' } },
    rules: { list: [], search: '', at: 0, loading: false, err: '' },
    journal: { tab: 'events', filter: 'all', logLevel: 'info', logs: [], autoscroll: true, es: null, q: '', regex: false },
    servers: { autoTested: false, search: '', testing: false, group: '', sort: 'delay' },
    settings: { dirty: false, targetsDirty: false, inited: false },
    sys: { data: null, at: 0, triedAt: 0, loading: false, err: '' },
    sub: { at: 0, loading: false, err: '', data: null, edit: '' },
    ver: { data: null, at: 0, triedAt: 0, loading: false, err: '' },
    upd: { kind: '', running: false, startedAt: 0, timer: null },
    drawer: { open: false, kind: '', key: '', ip: '', conn: null, event: null, log: null, scroll: 0 },
    theme: { mode: 'dark', resolved: 'dark' },
    pendingSelect: Object.create(null)
  };

  var delay = {
    map: Object.create(null),       // имя -> {delay, err, t}
    testing: Object.create(null),   // имя -> true, пока идёт замер
    running: false,
    startedAt: 0,
    total: 0,
    lastAuto: 0
  };

  var timers = { poll: null, conns: null, sys: null };
  var streams = { traffic: null, logs: null, logLevel: '' };
  var pollPromise = null;
  var wdTargetsSig = '';
  var wdGroupsSig = '';
  var delayRev = 0;
  var serversSig = null;
  var rulesSig = '';
  var eventsSig = '';
  var asnCache = Object.create(null);   // ip -> {t, info, err}
  var asnLoading = Object.create(null); // ip -> true, пока идёт запрос
  var logHintTimer = null;

  /* ------------------------------- утилиты ------------------------------- */

  function $(id) { return document.getElementById(id); }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function appendKids(parent, kids) {
    if (kids === null || kids === undefined || kids === false) return;
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i++) appendKids(parent, kids[i]);
      return;
    }
    if (kids instanceof Node) { parent.appendChild(kids); return; }
    parent.appendChild(document.createTextNode(String(kids)));
  }

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { for (var d in v) { if (Object.prototype.hasOwnProperty.call(v, d)) node.dataset[d] = v[d]; } }
        else if (k.length > 2 && k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    appendKids(node, kids);
    return node;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
      }
    }
    return node;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function trim(s, n) {
    s = String(s === null || s === undefined ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Чтение поля без учёта регистра: демон может отдавать и camelCase, и PascalCase.
  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null) return v;
    }
    var lower = Object.create(null);
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) lower[k.toLowerCase()] = obj[k];
    }
    for (var j = 0; j < keys.length; j++) {
      var lv = lower[keys[j].toLowerCase()];
      if (lv !== undefined && lv !== null) return lv;
    }
    return undefined;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  var BYTES = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  function fmtBytes(n, forceDigits) {
    n = num(n);
    if (n <= 0) return '0 Б';
    var i = 0, v = n;
    while (v >= 1024 && i < BYTES.length - 1) { v /= 1024; i++; }
    var digits;
    if (forceDigits !== undefined) digits = i === 0 ? 0 : forceDigits;
    else digits = i === 0 ? 0 : (v < 10 ? 2 : v < 100 ? 1 : 0);
    return v.toFixed(digits).replace('.', ',') + ' ' + BYTES[i];
  }

  function fmtSpeed(n) { return fmtBytes(n) + '/с'; }

  function fmtTime(unix) {
    if (!unix) return '—';
    var d = new Date(num(unix) * 1000);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtClock(unix) {
    if (!unix) return '—';
    var d = new Date(num(unix) * 1000);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function agoText(seconds) {
    seconds = Math.max(0, Math.floor(num(seconds)));
    if (seconds < 5) return 'только что';
    if (seconds < 60) return seconds + ' с';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' мин';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' ч';
    return Math.floor(seconds / 86400) + ' дн';
  }

  function fmtAgo(unix) {
    if (!unix) return '—';
    var diff = Math.floor(Date.now() / 1000) - num(unix);
    if (diff < 5) return 'только что';
    return agoText(diff) + ' назад';
  }

  function fmtDur(seconds) {
    seconds = Math.max(0, Math.floor(num(seconds)));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  function plural(n, forms) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function fmtDelay(ms) { return Math.round(num(ms)) + ' мс'; }

  function delayClass(ms) {
    ms = num(ms);
    if (ms <= 0) return 'unknown';
    if (ms < 150) return 'good';
    if (ms < 400) return 'mid';
    return 'bad';
  }

  // не число (null/undefined/пусто) → null, чтобы в интерфейсе был прочерк, а не 0
  function toNumOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function fmtLoad(v) {
    var n = toNumOrNull(v);
    return n === null ? '—' : n.toFixed(2).replace('.', ',');
  }

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(num(sec)));
    if (!sec) return '—';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d) return d + ' ' + plural(d, ['день', 'дня', 'дней']) + (h ? ' ' + h + ' ч' : '');
    if (h) return h + ' ч ' + pad2(m) + ' мин';
    return m + ' мин';
  }

  function tempLevel(c) {
    var t = toNumOrNull(c);
    if (t === null || t <= 0) return 'dim';
    if (t < 60) return 'good';
    if (t < 75) return 'warn';
    return 'bad';
  }

  // Флаг страны из начала имени узла («🇩🇪 Germany-…») → эмодзи + двухбуквенный код.
  var FLAG_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}\uFE0F?\s*/u;
  function splitFlag(name) {
    var s = String(name === null || name === undefined ? '' : name).replace(/^\s+/, '');
    var m = s.match(FLAG_RE);
    if (m) {
      var flag = s.slice(0, m[0].length).replace(/\uFE0F/g, '').trim();
      var code = '';
      for (var i = 0; i < flag.length; i++) {
        var cp = flag.codePointAt(i);
        if (cp >= 0x1F1E6 && cp <= 0x1F1FF) code += String.fromCharCode(cp - 0x1F1E6 + 65);
        if (cp > 0xFFFF) i++;
      }
      return { flag: flag, code: code, rest: s.slice(m[0].length).trim() || s };
    }
    var latin = s.match(/[A-Za-zА-Яа-яЁё]{2}/);
    return { flag: '', code: latin ? latin[0].toUpperCase() : '', rest: s };
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* -------------------- страны, флаги, иконки сервисов -------------------- */

  var THEME_KEY = 'xrock.theme';

  // Столько флагов реально лежит в flags/ — остальные коды покажем бейджем.
  var FLAG_SET = Object.create(null);
  ('ae am ar at au az be bg br by ca ch cl cn cz de dk ee eg es fi fr gb ge gr hk hr hu ' +
   'id ie il in is it jp kg kr kz lt lu lv md mn mx my nl no nz ph pl pt ro rs ru sa se sg si sk th tj tm tr tw ua us uz vn za'
  ).split(' ').forEach(function (c) { FLAG_SET[c] = 1; });

  var COUNTRY_NAMES = {
    ae: 'ОАЭ', am: 'Армения', ar: 'Аргентина', at: 'Австрия', au: 'Австралия', az: 'Азербайджан',
    be: 'Бельгия', bg: 'Болгария', br: 'Бразилия', by: 'Беларусь', ca: 'Канада', ch: 'Швейцария',
    cl: 'Чили', cn: 'Китай', cz: 'Чехия', de: 'Германия', dk: 'Дания', ee: 'Эстония', eg: 'Египет',
    es: 'Испания', fi: 'Финляндия', fr: 'Франция', gb: 'Великобритания', ge: 'Грузия', gr: 'Греция',
    hk: 'Гонконг', hr: 'Хорватия', hu: 'Венгрия', id: 'Индонезия', ie: 'Ирландия', il: 'Израиль',
    in: 'Индия', is: 'Исландия', it: 'Италия', jp: 'Япония', kg: 'Киргизия', kr: 'Южная Корея',
    kz: 'Казахстан', lt: 'Литва', lu: 'Люксембург', lv: 'Латвия', md: 'Молдова', mn: 'Монголия',
    mx: 'Мексика', my: 'Малайзия', nl: 'Нидерланды', no: 'Норвегия', nz: 'Новая Зеландия',
    ph: 'Филиппины', pl: 'Польша', pt: 'Португалия', ro: 'Румыния', rs: 'Сербия', ru: 'Россия',
    sa: 'Саудовская Аравия', se: 'Швеция', sg: 'Сингапур', si: 'Словения', sk: 'Словакия',
    th: 'Таиланд', tj: 'Таджикистан', tm: 'Туркменистан', tr: 'Турция', tw: 'Тайвань',
    ua: 'Украина', us: 'США', uz: 'Узбекистан', vn: 'Вьетнам', za: 'ЮАР'
  };

  // Синонимы в нижнем регистре → код страны. Слова из 1–3 букв сравниваются
  // только целиком (иначе «us» нашлось бы внутри «Russia»), длинные — тоже
  // целым словом: имя режется по цифрам и знакам, поэтому «Germany44fb» = germany + 44fb.
  var COUNTRY_ALIASES = {
    germany: 'de', deutschland: 'de', ger: 'de', deu: 'de', 'германия': 'de', 'германии': 'de',
    finland: 'fi', suomi: 'fi', fin: 'fi', 'финляндия': 'fi',
    sweden: 'se', sverige: 'se', swe: 'se', 'швеция': 'se',
    netherlands: 'nl', holland: 'nl', nederland: 'nl', nld: 'nl', ned: 'nl',
    'нидерланды': 'nl', 'голландия': 'nl',
    france: 'fr', fra: 'fr', 'франция': 'fr',
    poland: 'pl', polska: 'pl', pol: 'pl', 'польша': 'pl',
    spain: 'es', espana: 'es', 'españa': 'es', esp: 'es', 'испания': 'es',
    latvia: 'lv', latvija: 'lv', lva: 'lv', 'латвия': 'lv',
    usa: 'us', 'united states': 'us', 'united states of america': 'us', america: 'us',
    'сша': 'us', 'америка': 'us', 'соединенные штаты': 'us', 'соединённые штаты': 'us',
    canada: 'ca', can: 'ca', 'канада': 'ca',
    russia: 'ru', 'russian federation': 'ru', rus: 'ru', 'россия': 'ru', 'рф': 'ru',
    'российская федерация': 'ru', moscow: 'ru', 'москва': 'ru',
    belarus: 'by', blr: 'by', 'беларусь': 'by', 'белоруссия': 'by',
    italy: 'it', italia: 'it', ita: 'it', 'италия': 'it',
    austria: 'at', osterreich: 'at', 'österreich': 'at', aut: 'at', 'австрия': 'at',
    'united kingdom': 'gb', 'great britain': 'gb', britain: 'gb', england: 'gb',
    scotland: 'gb', wales: 'gb', gbr: 'gb', eng: 'gb', 'великобритания': 'gb',
    'англия': 'gb', 'британия': 'gb',
    norway: 'no', norge: 'no', nor: 'no', 'норвегия': 'no',
    india: 'in', ind: 'in', 'индия': 'in',
    'south africa': 'za', zaf: 'za', 'юар': 'za', 'южная африка': 'za',
    turkey: 'tr', turkiye: 'tr', 'türkiye': 'tr', turkei: 'tr', tur: 'tr', 'турция': 'tr',
    switzerland: 'ch', schweiz: 'ch', suisse: 'ch', che: 'ch', 'швейцария': 'ch',
    japan: 'jp', jpn: 'jp', nippon: 'jp', 'япония': 'jp',
    'south korea': 'kr', korea: 'kr', kor: 'kr', 'корея': 'kr', 'южная корея': 'kr',
    singapore: 'sg', sgp: 'sg', 'сингапур': 'sg',
    'hong kong': 'hk', hongkong: 'hk', hkg: 'hk', 'гонконг': 'hk',
    taiwan: 'tw', twn: 'tw', 'тайвань': 'tw',
    ukraine: 'ua', ukr: 'ua', 'украина': 'ua',
    kazakhstan: 'kz', kaz: 'kz', 'казахстан': 'kz',
    georgia: 'ge', geo: 'ge', 'грузия': 'ge',
    armenia: 'am', arm: 'am', 'армения': 'am',
    moldova: 'md', mda: 'md', 'молдова': 'md', 'молдавия': 'md',
    romania: 'ro', rou: 'ro', 'românia': 'ro', 'румыния': 'ro',
    bulgaria: 'bg', bgr: 'bg', 'болгария': 'bg',
    czech: 'cz', czechia: 'cz', 'czech republic': 'cz', cze: 'cz', 'чехия': 'cz',
    slovakia: 'sk', slovensko: 'sk', svk: 'sk', 'словакия': 'sk',
    hungary: 'hu', magyarorszag: 'hu', hun: 'hu', 'венгрия': 'hu',
    lithuania: 'lt', lietuva: 'lt', ltu: 'lt', 'литва': 'lt',
    estonia: 'ee', eesti: 'ee', est: 'ee', 'эстония': 'ee',
    denmark: 'dk', danmark: 'dk', dnk: 'dk', 'дания': 'dk',
    belgium: 'be', belgique: 'be', bel: 'be', 'бельгия': 'be',
    ireland: 'ie', eire: 'ie', 'éire': 'ie', irl: 'ie', 'ирландия': 'ie',
    portugal: 'pt', prt: 'pt', 'португалия': 'pt',
    greece: 'gr', hellas: 'gr', grc: 'gr', 'греция': 'gr',
    serbia: 'rs', srbija: 'rs', srb: 'rs', 'сербия': 'rs',
    croatia: 'hr', hrvatska: 'hr', hrv: 'hr', 'хорватия': 'hr',
    slovenia: 'si', slovenija: 'si', svn: 'si', 'словения': 'si',
    luxembourg: 'lu', lux: 'lu', 'люксембург': 'lu',
    iceland: 'is', island: 'is', isl: 'is', 'исландия': 'is',
    australia: 'au', aus: 'au', 'австралия': 'au',
    'new zealand': 'nz', nzl: 'nz', 'новая зеландия': 'nz',
    brazil: 'br', brasil: 'br', bra: 'br', 'бразилия': 'br',
    argentina: 'ar', arg: 'ar', 'аргентина': 'ar',
    chile: 'cl', chl: 'cl', 'чили': 'cl',
    mexico: 'mx', 'méxico': 'mx', mex: 'mx', 'мексика': 'mx',
    uae: 'ae', emirates: 'ae', 'united arab emirates': 'ae', are: 'ae', 'оаэ': 'ae',
    'эмираты': 'ae',
    israel: 'il', isr: 'il', 'израиль': 'il',
    'saudi arabia': 'sa', saudi: 'sa', sau: 'sa', 'саудовская аравия': 'sa',
    egypt: 'eg', egy: 'eg', 'египет': 'eg',
    thailand: 'th', tha: 'th', 'таиланд': 'th',
    vietnam: 'vn', 'viet nam': 'vn', vnm: 'vn', 'вьетнам': 'vn',
    malaysia: 'my', mys: 'my', 'малайзия': 'my',
    indonesia: 'id', 'индонезия': 'id',
    philippines: 'ph', phl: 'ph', 'филиппины': 'ph',
    china: 'cn', chn: 'cn', 'китай': 'cn',
    mongolia: 'mn', mng: 'mn', 'монголия': 'mn',
    uzbekistan: 'uz', uzb: 'uz', 'узбекистан': 'uz',
    azerbaijan: 'az', aze: 'az', 'азербайджан': 'az',
    kyrgyzstan: 'kg', kirgizia: 'kg', kgz: 'kg', 'киргизия': 'kg', 'кыргызстан': 'kg',
    tajikistan: 'tj', tjk: 'tj', 'таджикистан': 'tj',
    turkmenistan: 'tm', tkm: 'tm', 'туркменистан': 'tm'
  };

  // словосочетания ищем подстрокой (в т.ч. через дефисы: «United-Kingdom-1»)
  var COUNTRY_PHRASES = Object.keys(COUNTRY_ALIASES).filter(function (k) {
    return k.indexOf(' ') >= 0;
  }).sort(function (a, b) { return b.length - a.length; });

  var ICON_SET = Object.create(null);
  ('proxy userlist fallback fastest global direct reject router server youtube telegram x discord ' +
   'steam twitch instagram whatsapp netflix spotify github').split(' ').forEach(function (n) {
    ICON_SET[n] = 1;
  });

  // ВАЖНО: имена групп в mihomo с заглавной буквы («Fallback», «PROXY»),
  // поэтому все правила регистронезависимые.
  var GROUP_ICON_RULES = [
    [/user[\s_-]*list/i, 'userlist'],
    [/fallback/i, 'fallback'],
    [/fastest|speed[\s_-]*test|auto[\s_-]*select|url[\s_-]*test/i, 'fastest'],
    [/global/i, 'global'],
    [/direct/i, 'direct'],
    [/reject|block|advert|adblock|\bads\b/i, 'reject'],
    [/youtube|\byt\b/i, 'youtube'],
    [/twitter|^x$|\bx[\s_-]?com/i, 'x'],
    [/discord/i, 'discord'],
    [/steam/i, 'steam'],
    [/twitch/i, 'twitch'],
    [/telegram|\btg\b/i, 'telegram'],
    [/instagram|\big\b/i, 'instagram'],
    [/netflix/i, 'netflix'],
    [/spotify/i, 'spotify'],
    [/github/i, 'github'],
    [/whatsapp/i, 'whatsapp'],
    [/proxy|select|manual|выбор/i, 'proxy'],
    [/router|keenetic|mihomo/i, 'router']
  ];

  function flagCodeFromEmoji(text) {
    var m = String(text || '').match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
    if (!m) return '';
    var cps = Array.from(m[0]);
    var code = '';
    for (var i = 0; i < cps.length; i++) {
      code += String.fromCharCode(cps[i].codePointAt(0) - 0x1F1E6 + 65);
    }
    code = code.toLowerCase();
    return FLAG_SET[code] ? code : '';
  }

  // Страна узла: сначала эмодзи-флаг, потом словарь названий в имени.
  function countryFromName(name) {
    var raw = String(name === null || name === undefined ? '' : name);
    if (!raw) return '';
    var emoji = flagCodeFromEmoji(raw);
    if (emoji) return emoji;
    var norm = ' ' + raw.toLowerCase().replace(/[^a-z\u0430-\u044f\u0451]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    for (var i = 0; i < COUNTRY_PHRASES.length; i++) {
      if (norm.indexOf(' ' + COUNTRY_PHRASES[i] + ' ') >= 0) return COUNTRY_ALIASES[COUNTRY_PHRASES[i]];
    }
    var parts = norm.trim().split(' ');
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (!p) continue;
      var hit = COUNTRY_ALIASES[p];
      if (hit) return hit;
      if (p.length === 2 && FLAG_SET[p]) return p;
    }
    return '';
  }

  function countryName(code) {
    var c = String(code || '').toLowerCase();
    return COUNTRY_NAMES[c] || (c ? c.toUpperCase() : '');
  }

  // <img class="flag"> для известной страны, иначе нейтральный бейдж с кодом.
  function flagEl(code, cls) {
    var c = String(code || '').toLowerCase();
    var extra = cls ? ' ' + cls : '';
    function neutral() {
      return el('span', {
        class: 'flag flag-none' + extra,
        title: c ? 'Страна: ' + countryName(c) : 'Страна не определена',
        text: c ? c.toUpperCase().slice(0, 2) : '•'
      });
    }
    if (FLAG_SET[c]) {
      var img = el('img', {
        class: 'flag' + extra,
        src: 'flags/' + c + '.svg',
        alt: c.toUpperCase(),
        title: countryName(c),
        loading: 'lazy',
        decoding: 'async',
        width: cls === 'sm' ? 20 : 24,
        height: cls === 'sm' ? 15 : 18
      });
      // если файла флага нет в сборке — тихо заменяем на нейтральный бейдж
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(neutral(), img);
      });
      return img;
    }
    return neutral();
  }

  function flagForNode(name, cls) {
    return flagEl(countryFromName(name), cls);
  }

  // Имя узла без эмодзи-флага: сам флаг теперь отдельной картинкой, а на Windows
  // региональные индикаторы рисуются как «DE»/«de» и дублировали бы флаг.
  function nodeLabel(name) {
    var s = String(name === null || name === undefined ? '' : name);
    if (!s) return '';
    var fl = splitFlag(s);
    return fl.flag ? (fl.rest || s) : s;
  }

  // Иконки icons/*.svg красятся через mask + currentColor (в <img> currentColor
  // не наследуется и иконка осталась бы чёрной в тёмной теме).
  function icoEl(name, cls) {
    var n = ICON_SET[name] ? name : 'server';
    var node = el('span', { class: 'ico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    node.style.setProperty('--ico', 'url(icons/' + n + '.svg)');
    return node;
  }

  function groupIconName(name) {
    var s = String(name || '');
    for (var i = 0; i < GROUP_ICON_RULES.length; i++) {
      if (GROUP_ICON_RULES[i][0].test(s)) return GROUP_ICON_RULES[i][1];
    }
    return 'server';
  }

  /* -------- иконки групп из config.yaml (поле icon: в proxy-groups) -------- */

  // Группа в состоянии демона приходит с icon из конфига mihomo — обычно это
  // ссылка на Qure/simple-icons. Названия служебных иконок (Available, Auto,
  // Reject…) ничего не говорят о группе, поэтому для них остаётся локальная
  // иконка по имени; сервисные иконки берём как есть — с CDN, а если он
  // недоступен (роутер без интернета), подставляем локальную.
  var GENERIC_ICON_RE = /^(reject|available|auto|direct|global|proxy|static|balance|roundrobin|url-?test|fallback|select|adblock|block|ads|final|match|cn|ru)$/i;

  var ICON_ALIASES = {
    youtube: 'youtube', youtubemusic: 'youtube', yt: 'youtube',
    telegram: 'telegram', tg: 'telegram',
    twitter: 'x', x: 'x',
    discord: 'discord', steam: 'steam', twitch: 'twitch',
    instagram: 'instagram', whatsapp: 'whatsapp',
    netflix: 'netflix', spotify: 'spotify', github: 'github'
  };

  function iconFileName(url) {
    var s = String(url || '').split(/[?#]/)[0];
    var i = s.lastIndexOf('/');
    return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
  }

  function serviceKeyFromIcon(url) {
    var name = iconFileName(url).replace(/\.(png|svg|jpe?g|webp|gif|ico)$/i, '').replace(/[^a-z0-9]/g, '');
    return ICON_ALIASES[name] || '';
  }

  function groupIconUrl(name) {
    var g = groupByName(name);
    var url = g && g.icon ? String(g.icon) : '';
    return url;
  }

  // Иконка группы: из config.yaml (icon:), иначе локальная по имени.
  function groupIconEl(name, cls) {
    var url = groupIconUrl(name);
    var sizeCls = cls === 'lg' ? ' lg' : (cls === 'sm' ? ' sm' : '');
    var isData = /^data:image\//i.test(url);
    var isHttp = /^https?:\/\//i.test(url);
    var fileName = iconFileName(url);
    var svc = serviceKeyFromIcon(url);
    var generic = GENERIC_ICON_RE.test(fileName.replace(/\.(png|svg|jpe?g|webp|gif|ico)$/i, ''));
    if (url && !generic && (isData || isHttp)) {
      var img = el('img', {
        class: 'ico-img' + sizeCls,
        src: url,
        alt: '',
        title: name,
        loading: 'lazy',
        decoding: 'async',
        referrerpolicy: 'no-referrer'
      });
      img.addEventListener('error', function () {
        var fallback = svc && ICON_SET[svc] ? svc : groupIconName(name);
        if (img.parentNode) img.parentNode.replaceChild(icoEl(fallback, cls), img);
      });
      return img;
    }
    return icoEl(svc && ICON_SET[svc] ? svc : groupIconName(name), cls);
  }

  // Встроенные «узлы» mihomo: у них нет страны, но есть подходящая иконка.
  var BUILTIN_ICONS = {
    direct: 'direct',
    'direct-1': 'direct',
    reject: 'reject',
    'reject-drop': 'reject',
    pass: 'direct',
    global: 'global',
    proxy: 'proxy'
  };

  // Иконка группы/встроенного узла либо флаг страны — то, что рисуем слева от имени.
  function nodeBadge(name, cls) {
    var key = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
    if (BUILTIN_ICONS[key]) return icoEl(BUILTIN_ICONS[key], cls === 'lg' ? 'lg' : 'sm');
    if (isGroupName(name)) return groupIconEl(name, cls === 'lg' ? 'lg' : 'sm');
    return flagForNode(name, cls);
  }

  function targetIconName(name) {
    return groupIconName(name);
  }

  // Иконки в статической разметке: элементы с data-ico="router" и т.п.
  function applyStaticIcons() {
    var nodes = document.querySelectorAll('[data-ico]');
    for (var i = 0; i < nodes.length; i++) {
      var host = nodes[i];
      var first = host.firstChild;
      if (first && first.nodeType === 1 && first.classList && first.classList.contains('ico')) continue;
      host.insertBefore(icoEl(host.getAttribute('data-ico')), first);
    }
  }

  function copyText(text, okLabel) {
    text = String(text === null || text === undefined ? '' : text);
    if (!text) { toast('Нечего копировать', 'warn', 2000); return; }
    function done(ok) {
      toast(ok ? (okLabel || 'Скопировано') : 'Не удалось скопировать — выделите вручную', ok ? 'ok' : 'bad', 2200);
    }
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(!!ok);
      } catch (e) { done(false); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
    } else {
      legacy();
    }
  }

  /* ------------------------- темы оформления ------------------------------ */

  var THEME_META_COLOR = {
    dark: '#0b0f14', light: '#eef2f7', midnight: '#050a15', nord: '#2e3440',
    ocean: '#06121a', emerald: '#06120e', gold: '#12100a', violet: '#0b0817', rose: '#140910'
  };

  var THEME_LIST = [
    {
      id: 'dark', name: 'Тёмная', desc: 'текущая, по умолчанию',
      prev: { bg: '#0b0f14', side: '#0e141b', card: '#151b24', accent: '#6ea8fe', line: '#243040', ok: '#3ddc97' }
    },
    {
      id: 'light', name: 'Светлая', desc: 'дневная, высокий контраст',
      prev: { bg: '#eef2f7', side: '#f8fafc', card: '#ffffff', accent: '#2563eb', line: '#d9e2ee', ok: '#0f8a5a' }
    },
    {
      id: 'midnight', name: 'Полночь', desc: 'глубокий синий',
      prev: { bg: '#050a15', side: '#060c18', card: '#0a1424', accent: '#5ea0ff', line: '#17273f', ok: '#34d399' }
    },
    {
      id: 'nord', name: 'Nord', desc: 'северная палитра',
      prev: { bg: '#2e3440', side: '#2b303b', card: '#3b4252', accent: '#88c0d0', line: '#4c566a', ok: '#a3be8c' }
    },
    {
      id: 'ocean', name: 'Океан', desc: 'бирюзовая, голубой акцент',
      prev: { bg: '#06121a', side: '#06131b', card: '#0a1a24', accent: '#22d3ee', line: '#143242', ok: '#34d399' }
    },
    {
      id: 'emerald', name: 'Изумруд', desc: 'зелёная',
      prev: { bg: '#06120e', side: '#06131a', card: '#0a1a15', accent: '#34d399', line: '#143226', ok: '#86efac' }
    },
    {
      id: 'gold', name: 'Золото', desc: 'тёплая, янтарная',
      prev: { bg: '#12100a', side: '#141109', card: '#1d1810', accent: '#e6b34a', line: '#3a3223', ok: '#6ee7a8' }
    },
    {
      id: 'violet', name: 'Аметист', desc: 'фиолетовая',
      prev: { bg: '#0b0817', side: '#0b0818', card: '#14101f', accent: '#a78bfa', line: '#2a2240', ok: '#34d399' }
    },
    {
      id: 'rose', name: 'Роза', desc: 'розово-красная',
      prev: { bg: '#140910', side: '#150a11', card: '#1e0f17', accent: '#fb7185', line: '#3a1d29', ok: '#34d399' }
    },
    {
      id: 'system', name: 'Как в системе', desc: 'следовать теме ОС',
      prev: { bg: '#141a24', side: '#0e141b', card: '#1c2431', accent: '#7ea9f7', line: '#2a3648', ok: '#3ddc97' },
      sys: true
    }
  ];

  function themeById(id) {
    for (var i = 0; i < THEME_LIST.length; i++) {
      if (THEME_LIST[i].id === id) return THEME_LIST[i];
    }
    return THEME_LIST[0];
  }

  function systemThemeMode() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  function readThemeMode() {
    var saved = '';
    try { saved = localStorage.getItem(THEME_KEY) || ''; } catch (e) { saved = ''; }
    if (saved === 'system') return 'system';
    if (saved && themeById(saved).id === saved) return saved;
    return 'dark';
  }

  function themePreviewSwatch(theme) {
    var sw = el('span', { class: 'sw', 'aria-hidden': 'true' });
    if (theme.sys) return sw;
    var p = theme.prev;
    [p.bg, p.card, p.accent].forEach(function (c) {
      var i = el('i');
      i.style.background = c;
      sw.appendChild(i);
    });
    return sw;
  }

  function applyTheme(mode, persist) {
    var m = mode === 'system' ? 'system' : (themeById(mode).id || 'dark');
    var resolved = m === 'system' ? systemThemeMode() : m;
    var root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-mode', m);
    try { root.style.colorScheme = resolved === 'light' ? 'light' : 'dark'; } catch (e) { /* ignore */ }
    ui.theme = { mode: m, resolved: resolved };
    var meta = $('meta-theme-color');
    if (meta) meta.setAttribute('content', THEME_META_COLOR[resolved] || THEME_META_COLOR.dark);
    if (persist) {
      try { localStorage.setItem(THEME_KEY, m); } catch (e) { /* приватный режим */ }
    }
    renderThemeMenu();
    renderThemeCards();
    renderThemeBadge();
  }

  function renderThemeBadge() {
    var badge = $('theme-badge');
    if (!badge) return;
    var mode = (ui.theme && ui.theme.mode) || 'dark';
    var t = themeById(mode);
    if (mode === 'system') {
      badge.textContent = 'как в системе · ' + (ui.theme.resolved === 'light' ? 'светлая' : 'тёмная');
    } else {
      badge.textContent = t.name.toLowerCase();
    }
    badge.className = 'badge muted';
  }

  function themeMenuOpen() {
    var menu = $('theme-menu');
    return !!(menu && !menu.hidden);
  }

  function setThemeMenu(open) {
    var menu = $('theme-menu');
    var btn = $('btn-theme');
    if (!menu || !btn) return;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderThemeMenu();
  }

  function renderThemeMenu() {
    var menu = $('theme-menu');
    if (!menu) return;
    clear(menu);
    menu.appendChild(el('div', { class: 'theme-menu-h', text: 'Тема оформления' }));
    var mode = (ui.theme && ui.theme.mode) || 'dark';
    THEME_LIST.forEach(function (t) {
      var active = t.id === mode;
      menu.appendChild(el('button', {
        type: 'button',
        class: 'theme-item' + (active ? ' active' : '') + (t.sys ? ' sys' : ''),
        role: 'menuitemradio',
        'aria-checked': active ? 'true' : 'false',
        dataset: { theme: t.id },
        title: t.name + ' — ' + t.desc,
        onclick: function () { applyTheme(t.id, true); setThemeMenu(false); toast('Тема: ' + t.name, 'ok', 1800); }
      }, [
        themePreviewSwatch(t),
        el('span', { text: t.name }),
        el('span', { class: 'tick', text: '✓' })
      ]));
    });
  }

  function renderThemeCards() {
    var box = $('theme-cards');
    if (!box) return;
    var mode = (ui.theme && ui.theme.mode) || 'dark';
    clear(box);
    THEME_LIST.forEach(function (t) {
      var active = t.id === mode;
      var prev = el('span', { class: 'theme-prev', 'aria-hidden': 'true' }, [
        el('span', { class: 'tp-card' }),
        el('span', { class: 'tp-dot' }),
        el('span', { class: 'tp-card two' }),
        el('span', { class: 'tp-pill' })
      ]);
      prev.style.setProperty('--p-bg', t.prev.bg);
      prev.style.setProperty('--p-side', t.prev.side);
      prev.style.setProperty('--p-card', t.prev.card);
      prev.style.setProperty('--p-accent', t.prev.accent);
      prev.style.setProperty('--p-line', t.prev.line);
      prev.style.setProperty('--p-ok', t.prev.ok);
      box.appendChild(el('button', {
        type: 'button',
        class: 'theme-card' + (active ? ' active' : ''),
        role: 'radio',
        'aria-checked': active ? 'true' : 'false',
        dataset: { theme: t.id },
        title: t.name + ' — ' + t.desc,
        onclick: function () { applyTheme(t.id, true); }
      }, [
        el('span', { class: 'tick', text: '✓' }),
        prev,
        el('span', { class: 'theme-name', text: t.name }),
        el('span', { class: 'theme-desc', text: t.desc })
      ]));
    });
  }

  function watchSystemTheme() {
    if (!window.matchMedia) return;
    var mq;
    try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch (e) { return; }
    var onChange = function () {
      if (ui.theme && ui.theme.mode === 'system') applyTheme('system', false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }


  function normBase(value) {
    var v = String(value || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v.replace(/\/+$/, '');
  }

  function defaultBase() {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      if (location.port === '9091') return location.protocol + '//' + location.host;
    }
    var host = location.hostname || '127.0.0.1';
    if (host.indexOf(':') >= 0 && host.charAt(0) !== '[') host = '[' + host + ']';
    return 'http://' + host + ':9091';
  }

  // Панель может отдавать сам демон — в том числе через опубликованный в
  // Keenetic https-порт (external-ui тут ни при чём: демон отдаёт UI сам).
  // Тогда API живёт на том же адресе, что и страница: подхватываем его, иначе
  // приходится вписывать адрес руками, а с https-страницы http-демон ещё и
  // блокируется браузером (mixed content).
  function probeOwnOrigin() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return Promise.resolve('');
    var origin = location.origin;
    if (!origin || origin === 'null') return Promise.resolve('');
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 2500) : null;
    return fetch(origin + '/api/ping', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      return data && data.ok ? origin : '';
    }).catch(function () {
      return '';
    }).then(function (v) {
      if (timer) clearTimeout(timer);
      return v;
    });
  }

  function readSavedApi() {
    try { return localStorage.getItem(API_KEY) || ''; } catch (e) { return ''; }
  }

  function saveApi(value) {
    try {
      if (value) localStorage.setItem(API_KEY, value);
      else localStorage.removeItem(API_KEY);
    } catch (e) { /* режим приватного просмотра — просто работаем без сохранения */ }
  }

  /* --------------------------------- API --------------------------------- */

  function ApiError(message, path, name) {
    this.name = name || 'ApiError';
    this.message = message;
    this.path = path || '';
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function friendlyError(e) {
    if (!e) return 'неизвестная ошибка';
    if (e.name === 'AbortError') return 'таймаут запроса';
    var m = String(e.message || e);
    if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(m)) {
      return 'нет связи (сеть или CORS)';
    }    return m;
  }

  async function apiJson(path, options, timeoutMs) {
    var ms = timeoutMs || 9000;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    var res, text;
    try {
      res = await fetch(ui.api + path, Object.assign({
        method: 'GET',
        signal: ctrl.signal,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Accept': 'application/json' }
      }, options || {}));
      text = await res.text();
    } catch (e) {
      var msg = (e && e.name === 'AbortError')
        ? 'таймаут запроса (' + Math.round(ms / 1000) + ' с)'
        : friendlyError(e);
      throw new ApiError(msg, path);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // тело ошибки демона — JSON {"error": "..."}; показываем только текст
      var errText = '';
      var body = parseJson(text);
      if (body && typeof body === 'object' && body.error) errText = String(body.error);
      else if (text) errText = trim(text, 180);
      throw new ApiError('HTTP ' + res.status + (errText ? ' — ' + trim(errText, 180) : ''), path, 'HttpError');
    }
    if (!text) return {};
    var data = parseJson(text);
    if (data === null) throw new ApiError('демон вернул некорректный JSON', path, 'ParseError');
    return data;
  }

  function postJson(path, body, timeoutMs) {
    return apiJson(path, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }, timeoutMs);
  }

  // Как apiJson, но не бросает на HTTP-ошибке: нужен для /api/upgrade/*, где тело
  // ответа (error + log) важно показать пользователю даже при коде 502.
  async function apiFull(path, options, timeoutMs) {
    var ms = timeoutMs || 9000;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    var res, text;
    try {
      res = await fetch(ui.api + path, Object.assign({
        method: 'GET',
        signal: ctrl.signal,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Accept': 'application/json' }
      }, options || {}));
      text = await res.text();
    } catch (e) {
      var msg = (e && e.name === 'AbortError')
        ? 'таймаут запроса (' + Math.round(ms / 1000) + ' с)'
        : friendlyError(e);
      throw new ApiError(msg, path);
    } finally {
      clearTimeout(timer);
    }
    var data = text ? parseJson(text) : null;
    return {
      ok: res.ok && !(data && typeof data === 'object' && data.ok === false),
      status: res.status,
      data: data,
      text: text || ''
    };
  }

  /* --------------------------- связь и индикаторы ------------------------ */

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent.trim();
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      if (label !== undefined && label !== null && !btn.querySelector('svg')) btn.textContent = label;
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (label !== undefined && label !== null && btn.dataset.idleLabel && !btn.querySelector('svg')) {
        btn.textContent = btn.dataset.idleLabel;
      }
    }
  }

  function renderTopbar() {
    var st = ui.state;
    var chipDaemon = $('chip-daemon');
    var chipMihomo = $('chip-mihomo');
    if (chipDaemon) {
      var daemonVer = st ? (st.version || '—') : (ui.link.daemonOk ? (ui.link.daemonVersion || '?') : '—');
      chipDaemon.textContent = (LANG === 'en' ? 'daemon ' : 'демон ') + daemonVer;
      chipDaemon.title = LANG === 'en' ? 'xrock daemon version' : 'Версия демона xrock';
    }
    if (chipMihomo) {
      clear(chipMihomo);
      if (st && st.mihomo) {
        chipMihomo.appendChild(document.createTextNode('mihomo ' + (st.mihomo.version || '—')));
        if (st.mihomo.api) {
          chipMihomo.appendChild(el('span', {
            class: 'mihomo-api',
            text: ' · ' + String(st.mihomo.api).replace(/^https?:\/\//, '')
          }));
        }
        if (st.mihomo.secret) chipMihomo.appendChild(el('span', { class: 'mihomo-secret', text: LANG === 'en' ? ' · secret' : ' · ключ' }));
        chipMihomo.title = 'Clash API: ' + (st.mihomo.api || '—') + (st.mihomo.secret ? ' (с secret)' : '');
      } else {
        chipMihomo.textContent = 'mihomo —';
        chipMihomo.title = '';
      }
    }
    var sideApi = $('side-api');
    if (sideApi) {
      sideApi.textContent = ui.api.replace(/^https?:\/\//, '');
      sideApi.title = ui.api;
    }
    var sideMihomo = $('side-mihomo');
    if (sideMihomo) sideMihomo.textContent = st && st.mihomo ? (st.mihomo.version || '—') : '—';
    var sideVer = $('side-version');
    if (sideVer) sideVer.textContent = 'xrock UI · ' + (st && st.version ? st.version : '—');

    var linkEl = $('link-state');
    if (!linkEl) return;
    if (ui.link.ok) {
      linkEl.className = 'link-state ok';
      $('link-text').textContent = 'демон на связи';
      linkEl.title = 'Демон ' + (ui.link.version || '') + ' · ' + ui.api;
    } else {
      linkEl.className = 'link-state bad';
      var errText = ui.link.err || 'нет ответа';
      $('link-text').textContent = ui.link.daemonOk ? 'mihomo не отвечает' : (/^нет/i.test(errText) ? errText : ('нет связи: ' + errText));
      linkEl.title = (ui.link.daemonOk ? 'демон xrock на связи, mihomo: ' : '') + (ui.link.err || 'демон недоступен') + '\n' + ui.api;
    }
  }

  function showBanner(title, detail) {
    var b = $('banner');
    if (!b) return;
    $('banner-title').textContent = title;
    $('banner-detail').textContent = detail;
    b.hidden = false;
  }

  // Демон может быть жив, а mihomo — нет: /api/ping не трогает Clash API,
  // поэтому по нему видно, кто именно не отвечает.
  async function probeDaemon() {
    if (ui.link.probing) return;
    if (Date.now() - (ui.link.probedAt || 0) < 8000) return;
    ui.link.probing = true;
    ui.link.probedAt = Date.now();
    try {
      var r = await apiJson('/api/ping', null, 4000);
      ui.link.daemonOk = true;
      ui.link.daemonVersion = r && r.version ? String(r.version) : '';
    } catch (e) {
      ui.link.daemonOk = false;
      ui.link.daemonVersion = '';
    } finally {
      ui.link.probing = false;
      renderTopbar();
      if (!ui.link.ok) renderBanner();
    }
  }

  function renderBanner() {
    var b = $('banner');
    if (!b) return;
    if (ui.link.ok) { b.hidden = true; return; }
    var extra = '';
    if (location.protocol === 'https:' && /^http:/i.test(ui.api)) {
      extra = ' Панель открыта по HTTPS, а демон отвечает по HTTP — браузер блокирует такие запросы (mixed content). Укажите https-адрес или откройте панель по http.';
    }
    if (ui.link.daemonOk) {
      showBanner(
        'mihomo не отвечает',
        'Демон xrock ' + (ui.link.daemonVersion || '') + ' на связи (' + ui.api + '), но состояние получить не удалось: ' +
        (ui.link.err || 'таймаут') + '. Проверьте Clash API в config.yaml (external-controller, secret) — панель переподключится сама.' + extra
      );
      return;
    }
    showBanner(
      'Демон недоступен',
      'Адрес: ' + ui.api + ' — ' + (ui.link.err || 'нет ответа') + '.' + extra +
      (ui.seen ? ' Показаны последние полученные данные.' : ' Данных ещё нет — проверьте адрес в настройках.')
    );
  }

  function hideBanner() {
    var b = $('banner');
    if (b) b.hidden = true;
  }

  /* --------------------------- экран подключения -------------------------- */

  var SETUP_SKIP_KEY = 'xrock.setupSkipped';

  function setupSkipped() {
    try { return sessionStorage.getItem(SETUP_SKIP_KEY) === '1'; } catch (e) { return false; }
  }

  function setSetupStatus(text, kind) {
    var s = $('setup-status');
    if (!s) return;
    s.className = 'setup-status' + (kind ? ' ' + kind : '');
    s.textContent = text || '';
  }

  function openSetup() {
    var box = $('setup');
    if (!box || !box.hidden) return;
    var input = $('setup-url');
    if (input) input.value = readSavedApi() || defaultBase();
    setSetupStatus('', '');
    box.hidden = false;
    ui.setupOpen = true;
    if (input) {
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 40);
    }
  }

  function closeSetup(skip) {
    var box = $('setup');
    if (box) box.hidden = true;
    ui.setupOpen = false;
    if (skip) {
      try { sessionStorage.setItem(SETUP_SKIP_KEY, '1'); } catch (e) {}
    }
  }

  async function connectFromSetup() {
    var input = $('setup-url');
    var url = normBase(input ? input.value : '');
    if (!url) { setSetupStatus('Укажите адрес демона', 'bad'); return; }
    var btn = $('btn-setup-connect');
    if (btn) btn.disabled = true;
    setSetupStatus('проверяю связь…', '');
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 7000);
    try {
      var res = await fetch(url + '/api/ping', {
        method: 'GET', cache: 'no-store', mode: 'cors', credentials: 'omit',
        headers: { 'Accept': 'application/json' }, signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      saveApi(url);
      ui.api = url;
      closeSetup(false);
      try { sessionStorage.removeItem(SETUP_SKIP_KEY); } catch (e) {}
      toast('Демон на связи' + (data && data.version ? ' · версия ' + data.version : ''), 'ok', 3200);
      resetForApiChange();
      pollState();
    } catch (e) {
      var msg = (e && e.name === 'AbortError') ? 'таймаут: демон не ответил за 7 с' : friendlyError(e);
      setSetupStatus('Не удалось подключиться: ' + msg, 'bad');
    } finally {
      clearTimeout(timer);
      if (btn) btn.disabled = false;
    }
  }

  function onLinkFail(e) {
    ui.link.fails++;
    ui.link.ok = false;
    ui.link.err = friendlyError(e);
    renderTopbar();
    probeDaemon();
    if (ui.link.fails >= 2 || !ui.seen) renderBanner();
    // первый вход: демон не отвечает и адрес ещё не сохранён — предлагаем подключиться
    if (!ui.setupOpen && !ui.seen && !readSavedApi() && !setupSkipped()) openSetup();
  }

  function onLinkOk(version) {
    if (ui.setupOpen) closeSetup(false);
    var wasBad = !ui.link.ok && ui.link.fails > 0;
    ui.link.ok = true;
    ui.link.err = '';
    ui.link.fails = 0;
    ui.link.daemonOk = true;
    if (version) ui.link.daemonVersion = String(version);
    if (version) ui.link.version = version;
    if (wasBad) {
      hideBanner();
      toast('Связь с демоном восстановлена', 'ok', 3000);
      if (!streams.traffic && !document.hidden) startTrafficStream();
    }
    renderTopbar();
  }

  /* ------------------------------- язык ---------------------------------- */

  var LANG_KEY = 'xrock.lang';
  var LANG = 'ru';
  try { LANG = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ru'; } catch (e) { LANG = 'ru'; }
  var RU_TEXT = typeof WeakMap === 'function' ? new WeakMap() : null;

  // Ключ — русский текст как он есть в разметке; значение — английский.
  var EN = {
    'Обзор': 'Overview',
    'Серверы': 'Servers',
    'Соединения': 'Connections',
    'Правила': 'Rules',
    'Подписка': 'Subscription',
    'Журнал': 'Journal',
    'Настройки': 'Settings',
    'Демон': 'Daemon',
    'демон —': 'daemon —',
    'демон на связи': 'daemon online',
    'mihomo не отвечает': 'mihomo offline',
    'подключение…': 'connecting…',
    'Демон недоступен': 'Daemon unavailable',
    'Повторить': 'Retry',
    'Меню': 'Menu',
    'Переключить на лучший': 'Switch to best',
    'Проверить все серверы': 'Test all servers',
    'Обновить подписку': 'Update subscription',
    'Текущий сервер': 'Current server',
    'Топ прокси': 'Top proxies',
    'Проверить': 'Test',
    'Сторож': 'Watchdog',
    'Выключить': 'Disable',
    'Включить': 'Enable',
    'Скорость': 'Speed',
    'Роутер': 'Router',
    'Проверить все': 'Test all',
    'Проверить задержку': 'Test delay',
    'Все серверы': 'All servers',
    'Выбрать': 'Select',
    'Открыть соединения': 'Open connections',
    'Открыть подписку': 'Open subscription',
    'Проверить группу': 'Test group',
    'тест… 0 с': 'testing… 0 s',
    'Нет данных о группах. Демон ещё не прислал состояние.': 'No group data yet — the daemon has not sent state.',
    'Поиск по имени в группе…': 'Search by group name…',
    'задержка через прокси': 'delay via proxy',
    'состояние': 'status',
    'цели проверки': 'probe targets',
    'стабилен': 'stable',
    'последний замер': 'last probe',
    'узлов в группе': 'nodes in group',
    'протокол': 'protocol',
    'скачивание': 'download',
    'отдача': 'upload',
    'активных': 'active',
    'скачано': 'downloaded',
    'отдано': 'uploaded',
    'температура': 'temperature',
    'uptime': 'uptime',
    'load average': 'load average',
    'Память': 'Memory',
    'панель xrock': 'xrock panel',
    'ядро mihomo': 'mihomo core',
    'Ядра и архитектура': 'Cores & arch',
    'Модель': 'Model',
    'Узлов': 'Nodes',
    'Трафик': 'Traffic',
    'Истекает': 'Expires',
    'Обновлён': 'Updated',
    'использовано': 'used',
    'Смена ссылки подписки': 'Subscription link',
    'Новая ссылка': 'New link',
    'Сохранить': 'Save',
    'Отмена': 'Cancel',
    'Закрыть всё': 'Close all',
    'Закрыть': 'Close',
    'Обновить': 'Update',
    'Обновить всё': 'Refresh all',
    'Очистить': 'Clear',
    'Применить': 'Apply',
    'Проверить связь': 'Check connection',
    'Сбросить': 'Reset',
    'Сортировка': 'Sorting',
    'Устройство': 'Device',
    'Все устройства': 'All devices',
    'Хост': 'Host',
    'Правило': 'Rule',
    'Цепочка': 'Chain',
    'Время': 'Time',
    'Тип': 'Type',
    'Содержимое': 'Content',
    'Куда идёт': 'Target',
    'Нет активных соединений': 'No active connections',
    'Правила не загружены': 'Rules not loaded',
    'Поиск по хосту или правилу…': 'Search host or rule…',
    'Поиск по правилу…': 'Search rule…',
    'Провайдеры подписок не найдены.': 'No subscription providers found.',
    'Мёртвые узлы': 'Offline',
    'по данным сторожа': 'per watchdog',
    'по последнему проксированному замеру': 'by last proxied probe',
    'События': 'Events',
    'Логи mihomo': 'mihomo logs',
    'Все': 'All',
    'Сбои': 'Failures',
    'Переключения': 'Switches',
    'Событий пока нет.': 'No events yet.',
    'Логи пока не получены.': 'No log lines yet.',
    'уровень': 'level',
    'Неверное регулярное выражение.': 'Invalid regular expression.',
    'автоскролл': 'autoscroll',
    'поток не подключён': 'stream not connected',
    'Оформление': 'Appearance',
    'тёмная': 'dark',
    'Подключение к демону': 'Daemon connection',
    'Адрес демона': 'Daemon address',
    'По умолчанию:': 'Default:',
    'Сторож выключен': 'Watchdog is off',
    'Сторож включён': 'Watchdog is on',
    'автопереключений нет — сервер выбирается вручную': 'no auto-switching — you pick the server',
    'Включить сторожа': 'Enable watchdog',
    'Выключить сторожа': 'Disable watchdog',
    'Интервал проверки, сек': 'Check interval, sec',
    'Сбоев до переключения': 'Failures before switch',
    'Группа': 'Group',
    'Цели проверки': 'Probe targets',
    '+ Добавить цель': '+ Add target',
    'Обновления': 'Updates',
    'Панель xrock': 'xrock panel',
    'Ядро mihomo': 'mihomo core',
    'Обновить ядро mihomo': 'Update mihomo core',
    'Обновить панель': 'Update panel',
    'Проверить версии': 'Check versions',
    'Соединение': 'Connection',
    'Событие': 'Event',
    'Подключить': 'Connect',
    'Позже': 'Later',
    'Укажите адрес демона xrock — обычно он на том же роутере, порт': 'Enter the xrock daemon address — usually on the same router, port',
    'Адрес запомнится в этом браузере.': 'The address will be remembered in this browser.',
    'сам. Если секрета там нет — панель тоже работает, вводить ничего не нужно.': 'itself. If there is no secret there, the panel works as well — nothing to enter.',
    'Укажите адрес демона': 'Enter the daemon address',
    'проверяю связь…': 'checking connection…',
    'Демон на связи': 'Daemon is online',
    'Не удалось подключиться': 'Could not connect',
    'загрузка': 'loading',
    'нет данных': 'no data',
    'Нет данных': 'No data',
    'ошибка': 'error',
    'включён': 'on',
    'выключен': 'off',
    'Включён': 'On',
    'Выключен': 'Off',
    'Интервал': 'Interval',
    'текущий:': 'current:',
    'Тёмная': 'Dark', 'текущая, по умолчанию': 'current, default',
    'Светлая': 'Light', 'дневная, высокий контраст': 'daylight, high contrast',
    'Полночь': 'Midnight', 'глубокий синий': 'deep blue',
    'северная палитра': 'northern palette',
    'Океан': 'Ocean', 'бирюзовая, голубой акцент': 'teal, cyan accent',
    'Изумруд': 'Emerald', 'зелёная': 'green',
    'Золото': 'Gold', 'тёплая, янтарная': 'warm, amber',
    'Аметист': 'Amethyst', 'фиолетовая': 'violet',
    'Роза': 'Rose', 'розово-красная': 'rose-red',
    'Как в системе': 'System', 'следовать теме ОС': 'follow the OS theme',
    'Обновить всё': 'Refresh all',
    'Осталось': 'Left', 'без срока': 'no expiry', 'истекла': 'expired',
    'Лимит не ограничен': 'Unlimited',
    'обновлено': 'updated', 'всего': 'total', 'правил:': 'rules:',
    'устройство': 'device', 'устройства': 'devices', 'устройств': 'devices',
    'день': 'day', 'дня': 'days', 'дней': 'days',
    'Активных': 'Active',
    'Проверить задержку всех узлов группы через прокси': 'Test every node in the group through the proxy',
    'Сортировка': 'Sorting',
    'по задержке': 'by delay', 'по имени': 'by name',
    'Стабилен': 'Stable',
    'Отдано ↑': 'Uploaded ↑', 'Скачано ↓': 'Downloaded ↓',
    'группа': 'group',
    'узлов': 'nodes',
    'узел': 'node',
    'Последняя проверка': 'Last check',
    'Поток': 'Loop',
    'Мёртвых узлов': 'Offline',
    'идёт проверка': 'checking now',
    'ожидание': 'waiting',
    'остановлен': 'stopped',
    'Последняя проверка была давно — возможно, сторож не работает.': 'Last check was long ago — the watchdog may be stuck.',
    'Сторож выключен: автопереключения не выполняются.': 'Watchdog is off: no auto-switching.',
    'Изменить ссылку': 'Change link',
    'Проверить ASN': 'Look up ASN',
    'Закрыть соединение': 'Close connection',
    'Страна': 'Country',
    'Провайдер': 'Provider',
    'Трафик по соединению': 'Connection traffic',
    'Правило и цепочка': 'Rule and chain',
    'Событие журнала': 'Journal event',
    'Живой лог mihomo': 'mihomo live log',
    'Строка лога mihomo': 'mihomo log line'
  };

  function t(ru) {
    return LANG === 'en' ? (EN[ru] || ru) : ru;
  }

  function applyLang(root) {
    var node = root || document.body;
    if (!node) return;
    if (typeof document.createTreeWalker !== 'function') return;
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var list = [];
    var n;
    while ((n = walker.nextNode())) list.push(n);
    for (var i = 0; i < list.length; i++) {
      var tn = list[i];
      var p = tn.parentNode;
      if (!p) continue;
      var tag = p.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE' || tag === 'TEXTAREA') continue;
      var raw = tn.nodeValue;
      if (!raw || !raw.trim()) continue;
      if (LANG === 'en') {
        var trimmed = raw.trim();
        var en = EN[trimmed];
        if (en === undefined) continue;
        if (RU_TEXT && !RU_TEXT.has(tn)) RU_TEXT.set(tn, raw);
        var lead = raw.match(/^\s*/)[0];
        var tail = raw.match(/\s*$/)[0];
        tn.nodeValue = lead + en + tail;
      } else if (RU_TEXT && RU_TEXT.has(tn)) {
        tn.nodeValue = RU_TEXT.get(tn);
        RU_TEXT.delete(tn);
      }
    }
  }

  function renderLangBtn() {
    var btn = $('btn-lang');
    if (!btn) return;
    btn.textContent = LANG === 'en' ? 'RU' : 'EN';
    btn.title = LANG === 'en' ? 'Русский язык' : 'English language';
    btn.setAttribute('aria-label', btn.title);
  }

  function setLang(lang) {
    LANG = lang === 'en' ? 'en' : 'ru';
    try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {}
    document.documentElement.lang = LANG;
    document.title = LANG === 'en' ? 'xrock — mihomo panel' : 'xrock — панель mihomo';
    renderLangBtn();
    renderTopbar();
    if (ui.view) renderActive();
    applyLang();
  }

  /* ------------------------------ toast/modal ---------------------------- */

  function toast(message, kind, ms) {
    var box = $('toasts');
    if (!box) return;
    var t = el('div', { class: 'toast ' + (kind || ''), role: 'status' }, message);
    box.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .2s, transform .2s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(5px)';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 230);
    }, ms || 4200);
  }

  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var root = $('modal-root');
      if (!root) { resolve(false); return; }
      var prevFocus = document.activeElement;
      clear(root);
      root.hidden = false;

      var okBtn = el('button', {
        type: 'button',
        class: 'btn ' + (opts.danger ? 'danger' : 'primary'),
        text: opts.okLabel || 'OK'
      });
      var cancelBtn = el('button', { type: 'button', class: 'btn ghost', text: opts.cancelLabel || 'Отмена' });

      root.appendChild(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h3', { text: opts.title || 'Подтверждение' }),
        el('p', { text: opts.text || '' }),
        el('div', { class: 'modal-actions' }, [cancelBtn, okBtn])
      ]));

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(true); }
      }
      function onRootClick(e) { if (e.target === root) done(false); }
      function done(value) {
        document.removeEventListener('keydown', onKey);
        root.removeEventListener('click', onRootClick);
        root.hidden = true;
        clear(root);
        resolve(value);
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (e) { /* ignore */ }
        }
      }
      okBtn.addEventListener('click', function () { done(true); });
      cancelBtn.addEventListener('click', function () { done(false); });
      document.addEventListener('keydown', onKey);
      root.addEventListener('click', onRootClick);
      setTimeout(function () { try { okBtn.focus(); } catch (e) { /* ignore */ } }, 0);
    });
  }

  /* ----------------------------- нормализация ---------------------------- */

  function normState(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    s.groups = Array.isArray(s.groups) ? s.groups : [];
    s.proxies = Array.isArray(s.proxies) ? s.proxies : [];
    s.providers = Array.isArray(s.providers) ? s.providers : [];
    s.events = Array.isArray(s.events) ? s.events : [];
    s.watchdog = s.watchdog && typeof s.watchdog === 'object' ? s.watchdog : {};
    s.watchdog.dead = Array.isArray(s.watchdog.dead) ? s.watchdog.dead : [];
    s.watchdog.targets = Array.isArray(s.watchdog.targets) ? s.watchdog.targets : [];
    s.stats = s.stats && typeof s.stats === 'object' ? s.stats : {};
    s.traffic = s.traffic && typeof s.traffic === 'object' ? s.traffic : {};
    if (s.watchdog.lastCheck && !Array.isArray(s.watchdog.lastCheck.results)) {
      s.watchdog.lastCheck.results = [];
    }
    return s;
  }

  function groupByName(name) {
    if (!ui.state) return null;
    for (var i = 0; i < ui.state.groups.length; i++) {
      if (ui.state.groups[i] && ui.state.groups[i].name === name) return ui.state.groups[i];
    }
    return null;
  }

  function proxyByName(name) {
    if (!ui.state) return null;
    for (var i = 0; i < ui.state.proxies.length; i++) {
      if (ui.state.proxies[i] && ui.state.proxies[i].name === name) return ui.state.proxies[i];
    }
    return null;
  }

  function isGroupName(name) { return !!groupByName(name); }

  // цепочка «группа → подгруппа → узел»
  function activeChain(name) {
    var out = [], seen = Object.create(null), cur = name;
    for (var guard = 0; guard < 10 && cur; guard++) {
      if (seen[cur]) break;
      seen[cur] = 1;
      var g = groupByName(cur);
      if (!g) { out.push({ kind: 'node', name: cur }); break; }
      out.push({ kind: 'group', name: g.name, type: g.type || '' });
      cur = g.now;
    }
    return out;
  }

  function finalNode(name) {
    if (!name) return '';
    var chain = activeChain(name);
    return chain.length ? chain[chain.length - 1].name : name;
  }

  function allNodeNames() {
    var st = ui.state;
    if (!st) return [];
    var out = [], seen = Object.create(null);
    for (var i = 0; i < st.groups.length; i++) {
      var all = (st.groups[i] && st.groups[i].all) || [];
      for (var j = 0; j < all.length; j++) {
        var n = all[j];
        if (!n || seen[n] || isGroupName(n)) continue;
        seen[n] = 1;
        out.push(n);
      }
    }
    if (!out.length) {
      for (var k = 0; k < st.proxies.length; k++) {
        var p = st.proxies[k];
        if (p && p.name && !isGroupName(p.name)) out.push(p.name);
      }
    }
    return out;
  }

  function groupNodes(group) {
    var out = [];
    if (!group || !Array.isArray(group.all)) return out;
    for (var i = 0; i < group.all.length; i++) {
      if (group.all[i] && !isGroupName(group.all[i])) out.push(group.all[i]);
    }
    return out;
  }

  function testUrl() {
    var st = ui.state;
    if (st && st.providers) {
      for (var i = 0; i < st.providers.length; i++) {
        if (st.providers[i] && st.providers[i].testUrl) return st.providers[i].testUrl;
      }
    }
    if (st && st.watchdog && st.watchdog.targets && st.watchdog.targets[0] && st.watchdog.targets[0].url) {
      return st.watchdog.targets[0].url;
    }
    return 'http://www.gstatic.com/generate_204';
  }

  /* --------------------------------- опрос ------------------------------- */

  async function pollState(manual) {
    if (pollPromise) return pollPromise;
    pollPromise = (async function () {
      try {
        var st = await apiJson('/api/state', null, 8000);
        onState(st);
      } catch (e) {
        onLinkFail(e);
        if (manual) toast('Не удалось обновить: ' + friendlyError(e), 'bad');
      } finally {
        pollPromise = null;
      }
    })();
    return pollPromise;
  }

  function onState(raw) {
    var st = normState(raw);
    ui.state = st;
    ui.seen = true;
    onLinkOk(st.version);

    renderTopbar();
    renderActive();
    maybeAutoTest();
    if (ui.view === 'overview') maybeTestTop();
    if (ui.view === 'settings') fillWatchdogForm();
    if (!streams.traffic && !document.hidden) startTrafficStream();
    if (ui.view === 'overview') maybeLoadConnCount();
  }

  // Демон может отдавать traffic.conns = 0 при живых соединениях — один раз уточняем счётчик.
  function maybeLoadConnCount() {
    var st = ui.state;
    if (!st) return;
    if (num(st.traffic && st.traffic.conns) > 0) return;
    if (ui.conns.loading) return;
    if (ui.conns.lastTry && Date.now() - ui.conns.lastTry < 20000) return;
    loadConnections();
  }

  function startPolling() {
    stopPolling();
    timers.poll = setInterval(function () {
      if (document.hidden) return;
      pollState();
    }, POLL_MS);
  }

  function stopPolling() {
    if (timers.poll) { clearInterval(timers.poll); timers.poll = null; }
  }

  /* -------------------------------- потоки ------------------------------- */

  function startTrafficStream() {
    stopTrafficStream();
    if (!ui.api) return;
    var es;
    try {
      es = new EventSource(ui.api + '/api/stream/traffic');
    } catch (e) {
      return;
    }
    streams.traffic = es;
    es.onmessage = function (ev) {
      var d = parseJson(ev.data);
      if (!d) return;
      onTraffic(d);
    };
    es.onerror = function () {
      // EventSource переподключается сам; показываем, что данные устарели
      ui.traffic.at = 0;
      renderSpeedCard();
    };
  }

  function stopTrafficStream() {
    if (streams.traffic) {
      try { streams.traffic.close(); } catch (e) { /* ignore */ }
      streams.traffic = null;
    }
  }

  function onTraffic(d) {
    // /api/stream/traffic отдаёт приращение за интервал (~1 с), т.е. байты/с
    ui.traffic.up = num(d.up);
    ui.traffic.down = num(d.down);
    ui.traffic.at = Date.now();
    ui.traffic.histD.push(ui.traffic.down);
    ui.traffic.histU.push(ui.traffic.up);
    if (ui.traffic.histD.length > 60) ui.traffic.histD.shift();
    if (ui.traffic.histU.length > 60) ui.traffic.histU.shift();
    if (document.hidden) return;
    renderSpeedCard();
    if (ui.view === 'connections') renderConnMeta();
  }

  function startLogStream() {
    if (!ui.api || document.hidden) return;
    var level = ui.journal.logLevel || 'info';
    // уже подключены к этому уровню — не пересоздаём поток на каждом опросе состояния
    if (streams.logs && streams.logLevel === level) { scheduleLogHint(); return; }
    stopLogStream();
    setLogStatus('подключение к потоку…');
    var es;
    try {
      es = new EventSource(ui.api + '/api/stream/logs?level=' + encodeURIComponent(level));
    } catch (e) {
      setLogStatus('не удалось открыть поток');
      scheduleLogHint();
      return;
    }
    streams.logs = es;
    streams.logLevel = level;
    es.onopen = function () {
      setLogStatus('поток активен · уровень ' + level);
      scheduleLogHint();
    };
    es.onmessage = function (ev) {
      var data = parseJson(ev.data);
      var entry;
      if (data && typeof data === 'object') {
        entry = { type: String(data.type || data.level || 'info'), text: String(data.payload != null ? data.payload : (data.message || '')) };
      } else {
        entry = { type: level, text: String(ev.data || '') };
      }
      pushLog(entry);
    };
    es.onerror = function () {
      setLogStatus('поток прерван · переподключение…');
      scheduleLogHint();
    };
  }

  function stopLogStream() {
    if (streams.logs) {
      try { streams.logs.close(); } catch (e) { /* ignore */ }
      streams.logs = null;
      streams.logLevel = '';
    }
    hideLogHint();
  }

  function setLogStatus(text) {
    var n = $('log-status');
    if (n) n.textContent = text;
  }

  function stripAnsi(s) {
    return String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u009b[0-9;?]*[A-Za-z]/g, '');
  }

  function pushLog(entry) {
    var text = stripAnsi(entry.text || '');
    if (!text) return;
    var item = { t: Date.now(), type: entry.type || 'info', text: text };
    ui.journal.logs.push(item);
    if (ui.journal.logs.length > 500) ui.journal.logs.shift();
    appendLogLine(item);
    hideLogHint();
    setLogStatus('поток активен · уровень ' + (ui.journal.logLevel || 'info') + ' · ' + ui.journal.logs.length + ' строк');
  }

  function logLevelClass(type) {
    var t = String(type || '').toLowerCase();
    if (t === 'warn' || t === 'warning') return 'warning';
    if (t === 'err' || t === 'error' || t === 'fatal') return 'error';
    if (t === 'debug') return 'debug';
    return 'info';
  }

  // Строка журнала: время, уровень-чип, сообщение — в одну линию, но с тем же
  // видом, что и события (клик открывает детали).
  function logLineEl(entry) {
    var lvl = logLevelClass(entry.type);
    var d = new Date(entry.t);
    var line = el('div', {
      class: 'log-line jrn-row ' + lvl,
      title: 'Нажмите, чтобы разобрать строку',
      dataset: { lvl: lvl }
    }, [
      el('span', { class: 'log-t', text: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) }),
      el('span', { class: 'log-lvl ' + lvl, text: lvl }),
      el('span', { class: 'log-msg', text: entry.text })
    ]);
    line.__log = entry;
    return line;
  }

  function appendLogLine(entry) {
    var list = $('log-list');
    if (!list) return;
    // убираем заглушку «логи пока не получены» / «ничего не найдено»
    var placeholder = list.querySelector('.jrn-empty');
    if (placeholder) list.removeChild(placeholder);
    var pat = jrnPattern();
    var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (pat && !pat.test(entry.text)) { setLogCount(); return; }
    list.appendChild(logLineEl(entry));
    while (list.childNodes.length > 500) list.removeChild(list.firstChild);
    if (ui.journal.autoscroll || nearBottom) list.scrollTop = list.scrollHeight;
    setLogCount();
  }

  /* ------------------------- проксированный замер ------------------------ */

  function testbarText() {
    var secs = delay.running ? Math.max(0, Math.round((Date.now() - delay.startedAt) / 1000)) : 0;
    var txt = 'тест… ' + secs + ' с';
    if (delay.total) {
      txt += ' · ' + delay.total + ' ' + plural(delay.total, ['узел', 'узла', 'узлов']);
    }
    return txt;
  }

  function renderTestBar() {
    var bar = $('srv-testbar');
    if (!bar) return;
    var running = delay.running;
    bar.hidden = !running;
    if (running) {
      var txt = $('srv-testbar-text');
      if (txt) txt.textContent = testbarText();
    }
    var b1 = $('btn-srv-test-all');
    var b2 = $('btn-test-all');
    if (b1) b1.disabled = running;
    if (b2) b2.disabled = running;
  }

  function markDelayPending(names) {
    delayRev++;
    for (var i = 0; i < names.length; i++) delay.testing[names[i]] = true;
  }

  function clearDelayPending(names) {
    delayRev++;
    for (var i = 0; i < names.length; i++) delete delay.testing[names[i]];
  }

  // имена узлов из ответа /api/test (демон может вернуть только results)
  function testResultNames(res) {
    var r = res && typeof res === 'object' ? (res.results !== undefined ? res.results : res.data) : null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return [];
    if (r.results && typeof r.results === 'object' && !Array.isArray(r.results)) r = r.results;
    return Object.keys(r);
  }

  function applyTestResults(res, names) {
    delayRev++;
    var results = res && (res.results || res.data || res);
    var byName = Object.create(null);
    if (Array.isArray(results)) {
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (r && (r.name || r.proxy)) byName[r.name || r.proxy] = r;
      }
    } else if (results && typeof results === 'object') {
      if (results.results && typeof results.results === 'object' && !Array.isArray(results.results)) {
        byName = results.results;
      } else {
        byName = results;
      }
    }
    var nowSec = Math.floor(Date.now() / 1000);
    for (var k = 0; k < names.length; k++) {
      var name = names[k];
      var item = byName[name];
      if (Array.isArray(item)) item = item[0] || {};
      var ms, err;
      if (typeof item === 'number') { ms = item; err = ''; }
      else if (item && typeof item === 'object') {
        ms = item.delay !== undefined && item.delay !== null ? num(item.delay) : num(item.ms);
        err = item.err || item.error || '';
      } else {
        ms = 0;
        err = 'нет результата';
      }
      if (!err && (!isFinite(ms) || ms <= 0)) err = 'нет ответа';
      delay.map[name] = err
        ? { delay: 0, err: String(err), t: nowSec }
        : { delay: Math.max(1, Math.round(ms)), err: '', t: nowSec };
    }
  }

  // names пусто/не массив → один POST /api/test без names: демон меряет все узлы
  // одним запросом /group/{g}/delay (быстро и без дублирования на каждый узел).
  async function runTest(names, opts) {
    opts = opts || {};
    if (delay.running) {
      if (!opts.silent) toast('Проверка задержки уже идёт', 'warn');
      return false;
    }
    var explicit = Array.isArray(names) && names.length > 0;
    var list = explicit ? names.slice() : allNodeNames();
    if (!list.length) {
      if (!opts.silent) toast('Нет узлов для проверки — демон ещё не прислал состояние', 'warn');
      return false;
    }
    delay.running = true;
    delay.startedAt = Date.now();
    delay.total = list.length;
    markDelayPending(list);
    renderTestBar();
    if (ui.view === 'servers') renderServers();
    if (ui.view === 'overview') renderOverview();

    var ticker = setInterval(function () {
      if (!delay.running) return;
      var txt = $('srv-testbar-text');
      if (txt) txt.textContent = testbarText();
    }, 1000);

    var ok = false;
    try {
      var body = explicit ? { names: list, url: opts.url || testUrl() } : { url: opts.url || testUrl() };
      var res = await postJson('/api/test', body, TEST_TIMEOUT);
      var got = explicit ? list : testResultNames(res);
      if (!got.length) throw new ApiError('демон не вернул результаты замера', '/api/test', 'EmptyTest');
      if (got.length > delay.total) delay.total = got.length;
      applyTestResults(res, got);
      clearDelayPending(got);
      ok = true;
      var alive = 0;
      for (var i = 0; i < got.length; i++) {
        var d = delay.map[got[i]];
        if (d && !d.err) alive++;
      }
      if (!opts.silent) {
        toast('Задержка измерена через прокси: ' + alive + ' из ' + got.length, alive ? 'ok' : 'warn', 3500);
      }
    } catch (e) {
      if (!opts.silent) toast('Не удалось измерить задержку: ' + friendlyError(e), 'bad');
    } finally {
      clearInterval(ticker);
      delay.running = false;
      clearDelayPending(list);
      renderTestBar();
      if (ui.view === 'servers') renderServers();
      if (ui.view === 'overview') renderOverview();
    }
    return ok;
  }

  function maybeAutoTest() {
    if (ui.view !== 'servers' || ui.servers.autoTested || delay.running) return;
    var names = allNodeNames();
    if (!names.length) return;
    ui.servers.autoTested = true;
    delay.lastAuto = Date.now();
    // без names — демон меряет все узлы одним запросом; результат кешируется на сессию
    runTest(null, { silent: true });
  }

  /* ------------------------------ навигация ------------------------------ */

  function openSidebar() {
    var sb = $('sidebar');
    if (!sb) return;
    sb.classList.add('open');
    $('scrim').hidden = false;
    $('burger').setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    var sb = $('sidebar');
    if (!sb || !sb.classList.contains('open')) return;
    sb.classList.remove('open');
    $('scrim').hidden = true;
    $('burger').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  function activate(view, initial) {
    if (VIEWS.indexOf(view) < 0) view = 'overview';
    var prev = ui.view;
    ui.view = view;
    if (ui.drawer.open) closeDrawer(false);
    setThemeMenu(false);

    VIEWS.forEach(function (name) {
      var sec = $('view-' + name);
      if (sec) sec.hidden = name !== view;
      var btn = document.querySelector('.nav-item[data-view="' + name + '"]');
      if (btn) {
        btn.classList.toggle('active', name === view);
        if (name === view) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      }
    });

    closeSidebar();
    if (!initial) {
      try { history.replaceState(null, '', '#' + view); } catch (e) { location.hash = view; }
    }

    if (view !== 'connections') stopConnRefresh();
    if (view !== 'overview') stopSysPoll();

    if (view === 'overview') {
      maybeTestCurrent();
      renderOverview();
      startSysPoll();
    } else if (view === 'servers') {
      renderServers();
      renderTestBar();
      maybeAutoTest();
    } else if (view === 'connections') {
      renderConnections();
      loadConnections();
      startConnRefresh();
    } else if (view === 'rules') {
      renderRules();
      loadRules();
    } else if (view === 'subscription') {
      renderSubscription(true);
      loadSubscription();
    } else if (view === 'journal') {
      renderJournal();
      if (ui.journal.tab === 'logs') startLogStream();
      else stopLogStream();
    } else if (view === 'settings') {
      initSettings();
      fillWatchdogForm();
      renderUpdates();
      loadVersions();
    }

    if (prev === 'journal' && view !== 'journal') stopLogStream();
  }

  function maybeTestCurrent() {
    if (!ui.state) return;
    var wd = ui.state.watchdog || {};
    var current = wd.current || (ui.state.groups[0] && ui.state.groups[0].now) || '';
    current = finalNode(current);
    if (!current) return;
    var tested = delay.map[current];
    if (tested && !tested.err) return;
    if (delay.testing[current]) return;
    if (Date.now() - delay.lastAuto < 20000) return;
    delay.lastAuto = Date.now();
    runTest([current], { silent: true });
  }

  /* ------------------------------- рендер -------------------------------- */

  function renderActive() {
    if (LANG === 'en') setTimeout(function () { applyLang(); }, 0);
    if (ui.view === 'overview') renderOverview();
    else if (ui.view === 'servers') renderServers();
    else if (ui.view === 'connections') renderConnections();
    else if (ui.view === 'rules') renderRules();
    else if (ui.view === 'subscription') renderSubscription();
    else if (ui.view === 'journal') renderJournal();
    else if (ui.view === 'settings') {
      fillWatchdogForm();
      renderSettingsStatus();
    }
  }

  function skeletonCard(body, lines) {
    if (!body) return;
    clear(body);
    for (var i = 0; i < (lines || 3); i++) {
      body.appendChild(el('div', { class: 'skel ' + (i === 0 ? 'tall w60' : 'w80') }));
    }
  }

  function delayBadge(name, opts) {
    opts = opts || {};
    var span = el('span', { class: 'delay unknown' });
    if (delay.testing[name]) {
      span.className = 'delay pending';
      span.appendChild(el('span', { class: 'spinner' }));
      span.appendChild(el('span', { text: 'тест' }));
      span.title = 'Идёт измерение задержки через прокси';
      return span;
    }
    var d = delay.map[name];
    if (d) {
      if (d.err) {
        span.className = 'delay bad';
        span.textContent = '✕';
        span.title = 'Ошибка замера: ' + d.err;
      } else {
        span.className = 'delay ' + delayClass(d.delay);
        span.textContent = fmtDelay(d.delay);
        span.title = 'Задержка через прокси: ' + fmtDelay(d.delay) + ' · ' + fmtAgo(d.t);
      }
      return span;
    }
    span.textContent = '—';
    if (opts.unknownTitle) span.title = opts.unknownTitle;
    else span.title = 'Задержка ещё не измерена — нажмите «Проверить все» или удерживайте узел';
    return span;
  }

  function metric(label, value, cls, title) {
    return el('div', { class: 'metric', title: title || '' }, [
      el('b', { class: cls || '', text: value }),
      el('span', { text: label })
    ]);
  }

  function kvRow(key, value, title) {
    var v = value instanceof Node ? value : el('span', { class: 'kv-v', text: value, title: title || String(value) });
    return el('div', { class: 'kv-row' }, [el('span', { class: 'kv-k', text: key }), v]);
  }

  function speedFresh() {
    return ui.traffic.at > 0 && (Date.now() - ui.traffic.at) < 5000;
  }

  /* ------------------------------- ОБЗОР -------------------------------- */

  function isDeadNode(name) {
    var wd = ui.state && ui.state.watchdog;
    return !!(wd && wd.dead && wd.dead.indexOf(name) >= 0);
  }

  function setBadge(node, cls, text) {
    if (!node) return;
    node.className = 'badge ' + (cls || '');
    node.textContent = text;
  }

  function renderOverview() {
    var st = ui.state;
    if (!st) {
      skeletonCard($('cur-body'), 4);
      skeletonCard($('top-body'), 3);
      skeletonCard($('wd-body'), 4);
      skeletonCard($('speed-body'), 3);
      skeletonCard($('router-body'), 3);
      skeletonCard($('sub-body'), 3);
      skeletonCard($('conn-card-body'), 2);
      setBadge($('cur-badge'), 'muted', 'загрузка');
      setBadge($('top-badge'), 'muted', '—');
      setBadge($('wd-badge-overview'), 'muted', '—');
      setBadge($('router-badge'), 'muted', 'загрузка');
      setBadge($('sub-badge'), 'muted', '—');
      setBadge($('conn-badge'), 'muted', '—');
      renderSpeedCard();
      return;
    }
    renderCurrentCard(st);
    renderTopCard();
    renderWatchdogCard(st);
    renderSpeedCard();
    renderRouterCard();
    renderSubCard(st);
    renderConnsCard(st);
  }

  // Группа, за которой следим в «Обзоре»: PROXY → первая Selector → первая.
  function currentGroup() {
    var st = ui.state;
    if (!st || !st.groups || !st.groups.length) return null;
    var g = groupByName('PROXY');
    if (g) return g;
    for (var i = 0; i < st.groups.length; i++) {
      var gi = st.groups[i];
      if (gi && gi.name && String(gi.type || '').toLowerCase() === 'selector') return gi;
    }
    return st.groups[0] || null;
  }

  function currentChainNode() {
    var g = currentGroup();
    if (!g) return '';
    var chain = activeChain(g.name);
    return chain.length ? chain[chain.length - 1].name : '';
  }

  /* ------------------------------ топ прокси ------------------------------ */

  // Лучшие узлы группы по последнему проксированному замеру.
  function topCandidates() {
    var g = currentGroup();
    var res = { group: g, alive: [], dead: [], tested: 0, total: 0 };
    if (!g) return res;
    var names = (g.all || []).filter(function (n) { return n && !isGroupName(n); });
    res.total = names.length;
    var alive = [], dead = [];
    names.forEach(function (n) {
      var d = delay.map[n];
      if (d) res.tested++;
      if (d && !d.err) alive.push({ name: n, d: d });
      else if (d && d.err) dead.push({ name: n, d: d });
    });
    alive.sort(function (a, b) { return a.d.delay - b.d.delay; });
    res.alive = alive;
    res.dead = dead;
    return res;
  }

  // Проверка произвольного адреса через конкретный узел: показывает,
  // открывается ли сайт прокси-путём (а не браузером/системой).
  async function checkUrlThrough() {
    var node = currentChainNode();
    if (!node) { toast('Демон не сообщил активный сервер', 'warn'); return; }
    var input = $('cur-url');
    var url = String(input ? input.value : '').trim();
    if (!/^https?:\/\/\S+/i.test(url)) { toast('Адрес должен начинаться с http:// или https://', 'warn'); return; }
    var st = $('cur-check-status');
    function say(text, kind) {
      if (!st) return;
      st.textContent = text;
      st.className = 'hint ' + (kind || '');
    }
    say('проверяю через ' + nodeLabel(node) + '…', '');
    try {
      var res = await postJson('/api/test', { names: [node], url: url }, 25000);
      var r = res && res.results ? res.results[node] : null;
      if (r && r.delay) {
        say('открывается через ' + nodeLabel(node) + ' за ' + fmtDelay(r.delay), 'ok');
        toast('Адрес открывается через ' + nodeLabel(node) + ' (' + fmtDelay(r.delay) + ')', 'ok', 5000);
      } else {
        var why = r && r.err ? ': ' + r.err : '';
        say('не открывается через ' + nodeLabel(node) + why, 'bad');
        toast('Адрес не открылся через ' + nodeLabel(node) + why, 'bad', 6000);
      }
    } catch (e) {
      say('ошибка проверки: ' + friendlyError(e), 'bad');
    }
  }

  function renderTopCard() {
    var body = $('top-body');
    if (!body) return;
    clear(body);
    var badge = $('top-badge');
    var tc = topCandidates();

    if (!tc.group) {
      body.appendChild(el('div', { class: 'empty', text: 'Нет данных о группах — демон ещё не прислал состояние.' }));
      setBadge(badge, 'muted', '—');
      return;
    }
    if (!tc.tested) {
      body.appendChild(el('div', { class: 'empty', text: 'Замеров пока нет: нажмите «Проверить» — панель измерит всю группу через прокси.' }));
      setBadge(badge, 'muted', 'нет замеров');
      return;
    }
    if (!tc.alive.length) {
      body.appendChild(el('div', { class: 'empty', text: 'Ни один узел группы не ответил на проксированный замер.' }));
      setBadge(badge, 'bad', '0 живых');
      return;
    }
    setBadge(badge, 'ok', tc.alive.length + ' online / ' + tc.total);

    var cur = currentChainNode();
    var selectable = isSelector(tc.group);
    var list = el('ol', { class: 'top-list' });
    tc.alive.slice(0, 8).forEach(function (x, i) {
      var isCur = x.name === cur;
      list.appendChild(el('li', {
        class: 'top-row' + (isCur ? ' current' : ''),
        title: x.name + ' · ' + nodeTypeText(x.name) + (x.d.t ? '\nзамер ' + fmtAgo(x.d.t) : '')
      }, [
        el('span', { class: 'top-rank', text: String(i + 1) }),
        flagForNode(x.name),
        el('span', { class: 'top-name', text: nodeLabel(x.name) }),
        el('span', { class: 'top-type', text: nodeTypeText(x.name) }),
        el('span', { class: 'delay ' + delayClass(x.d.delay), text: fmtDelay(x.d.delay) }),
        isCur ? el('span', { class: 'top-cur', text: '✓' })
          : (selectable ? el('button', {
            type: 'button', class: 'btn small ghost top-pick', text: 'Выбрать',
            onclick: function (e) { if (e) e.stopPropagation(); chooseNode(x.name, tc.group); }
          }) : null)
      ]));
    });
    body.appendChild(list);

    var tail = [];
    if (tc.alive.length > 8) tail.push(LANG === 'en'
      ? (tc.alive.length - 8) + ' more online — see the Servers tab'
      : 'ещё ' + (tc.alive.length - 8) + ' живых — на вкладке «Серверы»');
    if (tc.dead.length) tail.push((LANG === 'en' ? 'offline: ' : 'не отвечают: ') + tc.dead.length);
    if (tail.length) body.appendChild(el('div', { class: 'hint', text: tail.join(' · ') }));
  }

  // Автозамер группы при открытии «Обзора», если рейтинг ещё не из чего строить.
  function maybeTestTop() {
    if (ui.view !== 'overview') return;
    if (delay.running || Object.keys(delay.testing).length) return;
    var g = currentGroup();
    if (!g) { maybeTestCurrent(); return; }
    var tc = topCandidates();
    var need = Math.min(4, tc.total);
    if (tc.tested >= need) return;
    if (Date.now() - delay.lastAuto < 20000) return;
    delay.lastAuto = Date.now();
    runTest(null, { silent: true });
  }

  /* --------------------------- выключатель сторожа ------------------------- */

  function renderWdSwitch(on) {
    var title = $('wd-switch-title'), hint = $('wd-switch-hint');
    var btn = $('btn-wd-toggle'), dot = $('wd-switch-dot');
    if (title) title.textContent = on ? 'Сторож включён' : 'Сторож выключен';
    if (hint) hint.textContent = on
      ? 'проверяет активный сервер каждые ' + (num(ui.state && ui.state.watchdog && ui.state.watchdog.intervalSec) || 10) + ' с и переключает при сбоях'
      : 'автопереключений нет — сервер выбирается вручную';
    if (dot) dot.className = 'wd-switch-dot' + (on ? ' on' : '');
    if (btn) {
      btn.textContent = on ? 'Выключить сторожа' : 'Включить сторожа';
      btn.className = 'btn ' + (on ? 'danger' : 'primary');
      btn.dataset.on = on ? '1' : '0';
    }
    var quick = $('wd-quick-toggle');
    if (quick) {
      quick.textContent = on ? 'Выключить' : 'Включить';
      quick.className = 'btn small ' + (on ? 'ghost' : 'primary');
    }
  }

  async function setWatchdogEnabled(on) {
    var btn = $('btn-wd-toggle');
    var quick = $('wd-quick-toggle');
    if (btn) btn.disabled = true;
    if (quick) quick.disabled = true;
    try {
      await postJson('/api/watch', { enabled: !!on }, 15000);
      ui.settings.dirty = false;
      toast(on ? 'Сторож включён' : 'Сторож выключен — сервер больше не переключается сам', 'ok', 3600);
      await pollState();
      fillWatchdogForm(true);
    } catch (e) {
      toast('Не удалось переключить сторожа: ' + friendlyError(e), 'bad');
    } finally {
      if (btn) btn.disabled = false;
      if (quick) quick.disabled = false;
      renderWdSwitch(!!(ui.state && ui.state.watchdog && ui.state.watchdog.enabled));
    }
  }

  function renderCurrentCard(st) {
    var body = $('cur-body');
    if (!body) return;
    clear(body);

    var wd = st.watchdog || {};
    var groupName = wd.group || (st.groups[0] && st.groups[0].name) || '';
    var group = groupName ? groupByName(groupName) : null;
    var chain = groupName ? activeChain(groupName) : [];
    var chainFinal = chain.length ? chain[chain.length - 1].name : '';
    var wdNode = wd.current ? finalNode(wd.current) : '';
    // активная цепочка важнее: после ручного переключения именно она отражает реальность
    var cur = chainFinal || wdNode;

    if (!cur) {
      body.appendChild(el('div', { class: 'empty', text: 'Демон не сообщил активный сервер. Проверьте связь и настройки сторожа.' }));
      setBadge($('cur-badge'), 'muted', 'нет данных');
      return;
    }

    var stat = st.stats && st.stats[cur] ? st.stats[cur] : null;
    var tested = delay.map[cur];
    // Задержку показываем только после /api/test — никаких цифр из чужих источников.
    var ms = tested && !tested.err ? tested.delay : 0;

    var healthText, healthCls;
    if (stat) {
      if (stat.ok === true) { healthText = 'online'; healthCls = 'ok'; }
      else if (stat.ok === false) { healthText = 'offline' + (num(stat.fails) ? ' · ' + num(stat.fails) : ''); healthCls = 'bad'; }
      else { healthText = 'нет данных'; healthCls = 'muted'; }
    } else if (tested) {
      healthText = tested.err ? 'offline' : 'online';
      healthCls = tested.err ? 'bad' : 'ok';
    } else {
      healthText = 'нет данных';
      healthCls = 'muted';
    }
    setBadge($('cur-badge'), healthCls, healthText);

    var title = el('div', { class: 'cur-name' }, [
      nodeBadge(cur, 'lg'),
      el('span', { text: nodeLabel(cur) }),
      group ? el('span', { class: 'badge muted', text: group.type || 'группа' }) : null
    ]);
    body.appendChild(title);

    var chainText = chain.map(function (x) { return nodeLabel(x.name); }).join(' → ');
    if (groupName) {
      body.appendChild(el('div', { class: 'cur-group' }, [
        'Группа ',
        el('b', { text: groupName }),
        chainText && chainText !== groupName ? ' · ' + chainText : '',
        wdNode && wdNode !== cur ? ' · сторож считает активным: ' + nodeLabel(wdNode) : ''
      ]));
    } else {
      body.appendChild(el('div', { class: 'cur-group', text: 'Группа не определена — сторож ещё не запускался.' }));
    }

    var nowSec = Math.floor(Date.now() / 1000);
    var wdOff = wd.enabled === false;
    var lastCheck = wd.lastCheck;
    // Сторож выключен — цели не проверяются: не показываем старые цифры как живые.
    var targets = wdOff ? [] : ((lastCheck && lastCheck.results) || []);
    var okCount = targets.filter(function (r) { return r && r.ok; }).length;

    var metrics = el('div', { class: 'cur-metrics' }, [
      metric('задержка через прокси', ms > 0 ? fmtDelay(ms) : '—', ms > 0 ? delayClass(ms) : 'dim',
        'Проксированный замер Clash API, не TCP-пинг роутера'),
      metric('состояние', healthText, healthCls === 'ok' ? 'good' : healthCls === 'bad' ? 'bad' : 'dim'),
      metric('цели проверки', targets.length ? okCount + '/' + targets.length : '—',
        targets.length && okCount === targets.length ? 'good' : targets.length ? 'warn' : 'dim',
        wdOff ? 'Сторож выключен — цели не проверяются' : ''),
      metric('стабилен', !wdOff && stat && stat.okSince ? fmtDur(nowSec - num(stat.okSince)) : '—', 'dim')
    ]);
    body.appendChild(metrics);

    if (wdOff) {
      body.appendChild(el('div', { class: 'hint', text: 'Сторож выключен: YouTube / Telegram / Instagram не проверяются, переключений нет.' }));
    }
    if (targets.length) {
      if (lastCheck && lastCheck.name && lastCheck.name !== cur) {
        body.appendChild(el('div', { class: 'hint', text: 'Последняя проверка целей относится к узлу ' + nodeLabel(lastCheck.name) }));
      }
      var list = el('div', { class: 'cur-targets' });
      targets.forEach(function (r) {
        if (!r) return;
        var ok = !!r.ok;
        var val = ok ? (num(r.ms) > 0 ? fmtDelay(r.ms) : 'ok') : (r.err ? trim(r.err, 28) : 'сбой');
        list.appendChild(el('div', { class: 'tchk', title: (r.target || '') + (r.err ? ' — ' + r.err : '') }, [
          el('span', { class: ok ? 'dot-ok' : 'dot-bad' }),
          icoEl(targetIconName(r.target), 'sm'),
          el('span', { class: 'tname', text: r.target || 'цель' }),
          el('span', { class: 'tval ' + (ok ? 'good' : 'bad'), text: val })
        ]));
      });
      body.appendChild(list);
    }

    body.appendChild(el('div', { class: 'row' }, [
      el('button', {
        type: 'button', class: 'btn small ghost',
        onclick: function () { runTest([cur]); }
      }, 'Проверить задержку'),
      el('button', {
        type: 'button', class: 'btn small ghost',
        onclick: function () { activate('servers'); }
      }, 'Все серверы')
    ]));
  }

  function renderWatchdogCard(st) {
    var body = $('wd-body');
    if (!body) return;
    clear(body);
    var wd = st.watchdog || {};
    renderWdSwitch(!!wd.enabled);
    var badge = $('wd-badge-overview');
    if (!wd.enabled) setBadge(badge, 'muted', 'выключен');
    else if (wd.currentOK === false) setBadge(badge, 'bad', 'offline');
    else setBadge(badge, 'ok', 'online');

    var nowSec = Math.floor(Date.now() / 1000);
    var lastT = wd.lastCheck ? wd.lastCheck.t : wd.lastRound;
    var rows = el('div', { class: 'kv' }, [
      kvRow('Группа', wd.group || '—'),
      kvRow('Интервал', (wd.intervalSec ? wd.intervalSec + ' с' : '—')),
      kvRow('Сбоев до переключения', wd.failsToSwitch ? String(wd.failsToSwitch) : '—'),
      kvRow('Последняя проверка', lastT ? fmtAgo(lastT) : '—', lastT ? fmtTime(lastT) : ''),
      kvRow('Поток', wd.running ? 'идёт проверка' : (wd.enabled ? 'ожидание' : 'остановлен')),
      kvRow('Offline', String((wd.dead || []).length))
    ]);
    body.appendChild(rows);

    if (num(wd.manualLeft) > 0) {
      body.appendChild(el('div', { class: 'hint' }, LANG === 'en'
        ? 'You picked this server manually — the watchdog will not switch it for ' + Math.ceil(num(wd.manualLeft) / 60) + ' min.'
        : 'Вы выбрали сервер вручную — сторож не переключит его ещё ' + Math.ceil(num(wd.manualLeft) / 60) + ' мин.'));
    }
    if (lastT && (nowSec - num(lastT)) > Math.max(90, num(wd.intervalSec) * 6)) {
      body.appendChild(el('div', { class: 'hint' }, 'Последняя проверка была давно — возможно, сторож не работает.'));
    }
    if (!wd.enabled) {
      body.appendChild(el('div', { class: 'hint' }, 'Сторож выключен: автопереключения не выполняются.'));
    }
  }

  function renderSpeedCard() {
    var body = $('speed-body');
    if (!body) return;
    var fresh = speedFresh();
    var d = ui.traffic.histD;
    var u = ui.traffic.histU;

    var down = fresh ? ui.traffic.down : 0;
    var up = fresh ? ui.traffic.up : 0;

    clear(body);
    body.appendChild(el('div', { class: 'speed-row' }, [
      metric('скачивание', fresh ? fmtSpeed(down) : '—', fresh ? 'good' : 'dim'),
      metric('отдача', fresh ? fmtSpeed(up) : '—', fresh ? 'good' : 'dim')
    ]));

    var chart = el('div', { class: 'spark-wrap' });
    if (fresh && d.length > 1) chart.appendChild(sparkSvg(d));
    else if (!fresh) chart.appendChild(el('div', { class: 'hint', text: 'Поток /api/stream/traffic не подключён.' }));
    body.appendChild(chart);

    setBadge($('speed-badge'), fresh ? 'ok' : 'muted', fresh ? 'live' : 'нет данных');
  }

  function sparkSvg(hist) {
    var w = 100, h = 40;
    var max = 1;
    for (var i = 0; i < hist.length; i++) if (hist[i] > max) max = hist[i];
    var n = hist.length;
    var pts = [];
    for (var j = 0; j < n; j++) {
      var x = n === 1 ? w : (j / (n - 1)) * w;
      var y = (h - 3) - (num(hist[j]) / max) * (h - 8);
      pts.push(x.toFixed(2) + ',' + y.toFixed(2));
    }
    var s = svg('svg', { class: 'spark', viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    s.appendChild(svg('line', { class: 'axis', x1: 0, y1: h - 1, x2: w, y2: h - 1 }));
    s.appendChild(svg('polygon', { class: 'fill', points: '0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h }));
    s.appendChild(svg('polyline', { class: 'line', points: pts.join(' ') }));
    return s;
  }

  /* ------------------------------- РОУТЕР -------------------------------- */

  function looksLikeSys(d) {
    if (!d || typeof d !== 'object') return false;
    var keys = ['cpuPct', 'load1', 'memTotal', 'memAvail', 'memUsedPct', 'tempMax', 'uptimeSec', 'arch'];
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(d, keys[i])) return true;
    }
    return false;
  }

  function normalizeSys(raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    var temps = o.temps !== undefined ? o.temps : pick(o, ['temps', 'sensors']);
    return {
      cpuPct: toNumOrNull(pick(o, ['cpuPct', 'cpu'])),
      load1: toNumOrNull(pick(o, ['load1', 'load'])),
      memTotal: toNumOrNull(pick(o, ['memTotal'])),
      memAvail: toNumOrNull(pick(o, ['memAvail', 'memAvailable'])),
      memUsedPct: toNumOrNull(pick(o, ['memUsedPct'])),
      tempMax: toNumOrNull(pick(o, ['tempMax', 'temp'])),
      temps: Array.isArray(temps) ? temps.slice(0, 24) : [],
      uptimeSec: toNumOrNull(pick(o, ['uptimeSec', 'uptime'])),
      arch: String(pick(o, ['arch']) || ''),
      model: String(pick(o, ['model']) || ''),
      cores: toNumOrNull(pick(o, ['cores', 'numCpu'])),
      selfRssKb: toNumOrNull(pick(o, ['selfRssKb', 'selfRssKB', 'selfRss'])),
      mihomoRssKb: toNumOrNull(pick(o, ['mihomoRssKb', 'mihomoRssKB', 'mihomoRss']))
    };
  }

  function sysFresh() {
    return ui.sys.at > 0 && (Date.now() - ui.sys.at) < 12000;
  }

  async function loadSys(manual) {
    if (ui.sys.loading) return;
    ui.sys.loading = true;
    ui.sys.triedAt = Date.now();
    try {
      var raw = await apiJson('/api/sys', null, 6000);
      // Демон без /api/sys отдаёт index.html — это не ресурсы, показываем «нет данных».
      if (!looksLikeSys(raw)) throw new ApiError('демон не отдаёт /api/sys', '/api/sys', 'NoSys');
      ui.sys.data = normalizeSys(raw);
      ui.sys.err = '';
      ui.sys.at = Date.now();
    } catch (e) {
      ui.sys.err = friendlyError(e);
      if (manual) toast('Ресурсы роутера недоступны: ' + ui.sys.err, 'bad');
    } finally {
      ui.sys.loading = false;
      if (ui.view === 'overview') renderRouterCard();
    }
  }

  function startSysPoll() {
    stopSysPoll();
    if (ui.view !== 'overview') return;
    loadSys();
    timers.sys = setInterval(function () {
      if (document.hidden || ui.view !== 'overview') return;
      // если API нет — редкие повторы, чтобы не дёргать демон каждые 4 секунды
      if (!ui.sys.data && ui.sys.err && Date.now() - ui.sys.triedAt < SYS_RETRY_MS) return;
      loadSys();
    }, SYS_MS);
  }

  function stopSysPoll() {
    if (timers.sys) { clearInterval(timers.sys); timers.sys = null; }
  }

  function renderRouterCard() {
    var body = $('router-body');
    if (!body) return;
    clear(body);
    var badge = $('router-badge');
    var d = ui.sys.data;

    if (!d) {
      if (ui.sys.err) {
        body.appendChild(el('div', { class: 'empty', text: 'Нет данных о ресурсах роутера' }));
        body.appendChild(el('div', { class: 'hint', text: 'Демон не ответил на GET /api/sys (' + ui.sys.err + '). Нужен xrock с поддержкой ресурсов.' }));
        setBadge(badge, 'muted', 'нет данных');
      } else {
        skeletonCard(body, 3);
        setBadge(badge, 'muted', 'загрузка');
      }
      return;
    }

    var cpu = d.cpuPct;
    var cpuCls = cpu === null ? 'dim' : cpu >= 85 ? 'bad' : cpu >= 60 ? 'warn' : 'good';
    var gauge = el('div', {
      class: 'gauge ' + cpuCls,
      style: '--v:' + (cpu === null ? 0 : Math.max(0, Math.min(100, Math.round(cpu)))),
      title: cpu === null ? 'Загрузка CPU: нет данных' : 'Загрузка CPU: ' + Math.round(cpu) + '%'
    }, [
      el('span', null, [
        el('b', { text: cpu === null ? '—' : Math.round(cpu) + '%' }),
        el('small', { text: 'CPU' })
      ])
    ]);

    var temp = d.tempMax;
    var tempsTitle = (d.temps || []).map(function (t) {
      if (!t) return '';
      return (t.name || 'датчик') + ' ' + (toNumOrNull(t.c) === null ? '—' : t.c + ' °C');
    }).filter(Boolean).join('\n');
    var metrics = el('div', { class: 'cur-metrics router-metrics' }, [
      metric('температура', (temp === null || temp <= 0) ? '—' : Math.round(temp) + ' °C', tempLevel(temp),
        tempsTitle || 'Максимум по термодатчикам роутера'),
      metric('uptime', d.uptimeSec ? fmtUptime(d.uptimeSec) : '—', 'dim', d.uptimeSec ? fmtDur(d.uptimeSec) : ''),
      metric('load average', fmtLoad(d.load1), 'dim', 'Средняя нагрузка за 1 минуту')
    ]);

    body.appendChild(el('div', { class: 'router-top' }, [
      gauge,
      el('div', { class: 'router-main' }, metrics)
    ]));

    var memTotal = d.memTotal;
    var memAvail = d.memAvail;
    var memPct = d.memUsedPct;
    var usedKb = (memTotal !== null && memAvail !== null) ? Math.max(0, memTotal - memAvail) : null;
    if ((memPct === null || memPct === undefined) && usedKb !== null && memTotal) {
      memPct = Math.round((usedKb / memTotal) * 100);
    }
    var memText = '—';
    if (memTotal !== null && memTotal > 0) {
      memText = (usedKb !== null ? fmtBytes(usedKb * 1024) : '—') + ' / ' + fmtBytes(memTotal * 1024);
      if (memPct !== null) memText += ' · ' + Math.round(memPct) + '%';
    }
    var pct = memPct === null || memPct === undefined ? 0 : Math.max(0, Math.min(100, Math.round(memPct)));
    body.appendChild(el('div', { class: 'bar ' + (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '') }, [
      el('i', { style: 'width:' + pct + '%' })
    ]));

    var hw = [];
    if (d.cores !== null) hw.push(d.cores + ' ' + plural(d.cores, ['ядро', 'ядра', 'ядер']));
    if (d.arch) hw.push(d.arch);
    var selfRss = num(d.selfRssKb) > 0 ? fmtBytes(num(d.selfRssKb) * 1024) : '—';
    var coreRss = num(d.mihomoRssKb) > 0 ? fmtBytes(num(d.mihomoRssKb) * 1024) : '—';
    body.appendChild(el('div', { class: 'kv' }, [
      kvRow('Память', memText, 'Вся система: занято / всего (MemTotal − MemAvailable)'),
      kvRow('панель xrock', selfRss, 'Сколько памяти занимает сам демон xrock (VmRSS)'),
      kvRow('ядро mihomo', coreRss, 'Сколько памяти занимает процесс mihomo (VmRSS)'),
      kvRow('Ядра и архитектура', hw.length ? hw.join(' · ') : '—'),
      kvRow('Модель', d.model || '—')
    ]));

    setBadge(badge, sysFresh() ? 'ok' : 'muted', sysFresh() ? 'live' : 'устарело');
  }

  function providerStats(p) {
    var si = (p && (p.subscriptionInfo || p.subscription)) || {};
    var expireRaw = pick(si, ['expire', 'expireAt']);
    var expire = 0;
    if (typeof expireRaw === 'number') expire = expireRaw;
    else if (typeof expireRaw === 'string') {
      if (/^\d+$/.test(expireRaw.trim())) expire = num(expireRaw);
      else {
        var parsedExpire = Date.parse(expireRaw);
        if (!isNaN(parsedExpire)) expire = Math.floor(parsedExpire / 1000);
      }
    }
    var total = num(pick(si, ['total', 'trafficTotal']));
    var download = num(pick(si, ['download', 'down']));
    var upload = num(pick(si, ['upload', 'up']));
    var days = expire > 0 ? Math.ceil((expire * 1000 - Date.now()) / 86400000) : null;
    return {
      expire: expire,
      total: total,
      download: download,
      upload: upload,
      used: download + upload,
      days: days,
      unlimited: total <= 0
    };
  }

  function expireBadge(days) {
    if (days === null) return { cls: 'muted', text: 'без срока' };
    if (days < 0) return { cls: 'bad', text: 'истекла' };
    var daysTxt = LANG === 'en' ? days + ' ' + plural(days, ['day', 'days', 'days']) : days + ' ' + plural(days, ['день', 'дня', 'дней']);
    if (days <= 3) return { cls: 'bad', text: daysTxt };
    if (days <= 10) return { cls: 'warn', text: daysTxt };
    return { cls: 'muted', text: daysTxt };
  }

  function renderSubCard(st) {
    var body = $('sub-body');
    if (!body) return;
    clear(body);
    var providers = (st.providers || []).filter(function (p) { return p && p.name; });
    if (!providers.length) {
      body.appendChild(el('div', { class: 'empty', text: 'Провайдеры подписок не найдены.' }));
      setBadge($('sub-badge'), 'muted', '—');
      return;
    }

    var worstDays = null;
    var list = el('div', { class: 'sub-list' });
    providers.forEach(function (p) {
      var inf = providerStats(p);
      if (inf.days !== null && (worstDays === null || inf.days < worstDays)) worstDays = inf.days;
      var b = expireBadge(inf.days);
      var item = el('div', { class: 'sub-item' }, [
        el('div', { class: 'row', style: 'justify-content:space-between' }, [
          el('h3', { text: p.name }),
          el('span', { class: 'badge ' + b.cls, text: b.text })
        ]),
        el('div', { class: 'kv' }, [
          kvRow('Узлов', String(num(p.proxyCount))),
          kvRow('Трафик', inf.unlimited
            ? fmtBytes(inf.download) + ' из ∞'
            : fmtBytes(inf.download) + ' / ' + fmtBytes(inf.total),
          'download ' + inf.download + ' Б, total ' + inf.total + ' Б'),
          kvRow('Истекает', inf.expire ? fmtDateOnly(inf.expire) : '—', inf.expire ? fmtTime(inf.expire) : ''),
          kvRow('Обновлён', parseIsoSeconds(p.updatedAt) ? fmtAgo(parseIsoSeconds(p.updatedAt)) : '—', p.updatedAt || '')
        ])
      ]);
      if (!inf.unlimited && inf.total > 0) {
        var pct = Math.min(100, Math.round((inf.used / inf.total) * 100));
        item.appendChild(el('div', { class: 'bar ' + (pct > 90 ? 'bad' : pct > 70 ? 'warn' : '') }, [
          el('i', { style: 'width:' + pct + '%' })
        ]));
        item.appendChild(el('div', { class: 'hint', text: 'использовано ' + pct + '%' }));
      }
      list.appendChild(item);
    });
    body.appendChild(list);
    body.appendChild(el('div', { class: 'row' }, [
      el('button', {
        type: 'button', class: 'btn small ghost',
        onclick: function () { activate('subscription'); }
      }, 'Открыть подписку')
    ]));
    var b0 = expireBadge(worstDays);
    setBadge($('sub-badge'), b0.cls, worstDays === null ? providers.length + ' шт.' : b0.text);
  }

  function fmtDateOnly(unix) {
    var d = new Date(num(unix) * 1000);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function renderConnsCard(st) {
    var body = $('conn-card-body');
    if (!body) return;
    clear(body);
    var conns = st.traffic && st.traffic.conns !== undefined ? num(st.traffic.conns) : null;
    var totalUp = st.traffic ? num(st.traffic.up) : 0;
    var totalDown = st.traffic ? num(st.traffic.down) : 0;
    // Демон иногда отдаёт traffic.conns = 0 при живых соединениях — уточняем по /api/connections.
    if (!conns && ui.conns.at && (Date.now() - ui.conns.at) < 6000) conns = ui.conns.list.length;

    if (conns === null || !ui.state) {
      body.appendChild(el('div', { class: 'empty', text: 'Нет данных.' }));
      return;
    }
    setBadge($('conn-badge'), conns > 0 ? 'ok' : 'muted', String(conns));
    body.appendChild(el('div', { class: 'cur-metrics' }, [
      metric('активных', String(conns), conns > 0 ? 'good' : 'dim'),
      metric('скачано', fmtBytes(totalDown), 'dim'),
      metric('отдано', fmtBytes(totalUp), 'dim')
    ]));
    body.appendChild(el('button', {
      type: 'button', class: 'btn small ghost', onclick: function () { activate('connections'); }
    }, 'Открыть соединения'));
  }

  /* ------------------------------- СЕРВЕРЫ ------------------------------- */

  function nodeRank(name) {
    var d = delay.map[name];
    if (d && !d.err) return 0;
    if (isDeadNode(name)) return 2;
    if (d && d.err) return 2;
    return 1;
  }

  function nodeComparator(a, b) {
    var ra = nodeRank(a.name), rb = nodeRank(b.name);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      var da = num(delay.map[a.name].delay), db = num(delay.map[b.name].delay);
      if (da !== db) return da - db;
    }
    return a.idx - b.idx;
  }

  function isSelector(group) {
    return !!group && String(group.type || '').toLowerCase() === 'selector';
  }

  function groupNodeCount(g) {
    if (!g) return 0;
    var all = Array.isArray(g.all) ? g.all : [];
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && !isGroupName(all[i])) n++;
    }
    return n;
  }

  // Выбранная группа: запомненная → watchdog.group → первая Selector → первая.
  function serverGroup() {
    var st = ui.state;
    if (!st) return null;
    var groups = (st.groups || []).filter(function (g) { return g && g.name; });
    if (!groups.length) { ui.servers.group = ''; return null; }
    var saved = ui.servers.group ? groupByName(ui.servers.group) : null;
    if (saved) return saved;
    var wdName = (st.watchdog && st.watchdog.group) || '';
    var pick = wdName ? groupByName(wdName) : null;
    if (!pick) {
      for (var i = 0; i < groups.length; i++) {
        if (isSelector(groups[i])) { pick = groups[i]; break; }
      }
    }
    if (!pick) pick = groups[0];
    ui.servers.group = pick.name;
    return pick;
  }

  function isDeadOrErr(name) {
    if (isDeadNode(name)) return true;
    var d = delay.map[name];
    if (d && d.err) return true;
    if (isGroupName(name)) {
      var f = finalNode(name);
      if (f && f !== name && (isDeadNode(f) || (delay.map[f] && delay.map[f].err))) return true;
    }
    return false;
  }

  function serversSignature() {
    var st = ui.state;
    if (!st) return 'nostate';
    var g = serverGroup();
    var parts = ['g:' + (g ? g.name : ''), 'q:' + ui.servers.search, 's:' + ui.servers.sort, 'd:' + delayRev];
    for (var i = 0; i < st.groups.length; i++) {
      var gi = st.groups[i] || {};
      var all = gi.all || [];
      parts.push([gi.name || '', gi.now || '', all.length, all[0] || '', all[all.length - 1] || ''].join('|'));
    }
    var wd = st.watchdog || {};
    parts.push('dead:' + (wd.dead || []).join('\u0001'));
    for (var j = 0; j < st.providers.length; j++) parts.push('p:' + (st.providers[j].updatedAt || ''));
    return parts.join('\u0002');
  }

  function sortBtn(mode, label) {
    return el('button', {
      type: 'button',
      class: 'seg-btn' + (ui.servers.sort === mode ? ' active' : ''),
      'aria-pressed': ui.servers.sort === mode ? 'true' : 'false',
      onclick: function () {
        if (ui.servers.sort === mode) return;
        ui.servers.sort = mode;
        serversSig = null;
        renderServers();
      }
    }, label);
  }

  // Порядок вкладок: сначала основные группы, потом все остальные по алфавиту.
  var GROUP_ORDER = ['PROXY', 'FALLBACK', 'FASTEST', 'GLOBAL'];

  function groupPriority(name) {
    var i = GROUP_ORDER.indexOf(String(name || '').toUpperCase());
    return i < 0 ? GROUP_ORDER.length : i;
  }

  function sortGroups(list) {
    return (list || []).slice().sort(function (a, b) {
      var pa = groupPriority(a && a.name), pb = groupPriority(b && b.name);
      if (pa !== pb) return pa - pb;
      return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'ru');
    });
  }

  function renderGroupTabs(st) {
    var box = $('srv-tabs');
    if (!box) return;
    clear(box);
    if (!st) return;
    var activeName = ui.servers.group;
    var groups = sortGroups((st.groups || []).filter(function (g) { return g && g.name; }));
    groups.forEach(function (g) {
      var active = g.name === activeName;
      var nodes = groupNodeCount(g);
      var now = g.now || '—';
      var nowIsGroup = isGroupName(now);
      var nowCode = nowIsGroup ? '' : countryFromName(now);
      var nowIcon = nowIsGroup ? groupIconEl(now, 'sm') : (nowCode ? flagEl(nowCode, 'sm') : (BUILTIN_ICONS[String(now).toLowerCase()] ? icoEl(BUILTIN_ICONS[String(now).toLowerCase()], 'sm') : null));
      box.appendChild(el('button', {
        type: 'button',
        class: 'gtab' + (active ? ' active' : ''),
        role: 'tab',
        'aria-selected': active ? 'true' : 'false',
        title: g.name + ' · ' + (g.type || 'группа') + '\nтекущий: ' + now + '\n' + nodes + ' ' + plural(nodes, ['узел', 'узла', 'узлов']),
        dataset: { group: g.name }
      }, [
        el('span', { class: 'gtab-ico' }, [groupIconEl(g.name)]),
        el('span', { class: 'gtab-main' }, [
          el('span', { class: 'gtab-top' }, [
            el('span', { class: 'gtab-name', text: g.name }),
            el('span', { class: 'gtab-count', text: String(nodes) })
          ]),
          el('span', { class: 'gtab-sub' }, [
            el('span', { class: 'gtab-type', text: g.type || 'группа' }),
            el('span', { class: 'gtab-now' }, [nowIcon, el('span', { class: 'gtab-now-txt', text: nodeLabel(now), title: now })])
          ])
        ])
      ]));
    });
    // На телефоне вкладки остаются горизонтальными — активную подкручиваем в вид.
    var act = box.querySelector('.gtab.active');
    if (act && box.scrollWidth > box.clientWidth + 4) {
      var left = act.offsetLeft - box.offsetLeft;
      if (left < box.scrollLeft || left + act.offsetWidth > box.scrollLeft + box.clientWidth) {
        var target = Math.max(0, left - 8);
        try { box.scrollTo({ left: target, behavior: 'smooth' }); }
        catch (e) { box.scrollLeft = target; }
      }
    }
  }

  function renderServerPanelHead(group) {
    var box = $('srv-panel-head');
    if (!box) return;
    clear(box);
    if (!group) { box.hidden = true; return; }
    box.hidden = false;

    var selectable = isSelector(group);
    var nodes = groupNodeCount(group);
    var nowName = group.now || '';
    var nowIsGroup = isGroupName(nowName);
    var nowCode = nowIsGroup ? '' : countryFromName(nowName);
    var cur = el('span', { class: 'srv-cur', title: 'Текущий узел группы' }, [
      el('span', { class: 'muted', text: t('текущий:') }),
      nowIsGroup ? groupIconEl(nowName, 'sm') : (nowCode ? flagEl(nowCode, 'sm') : null),
      el('b', { text: nodeLabel(nowName) || '—' })
    ]);

    box.appendChild(el('div', { class: 'srv-panel-title' }, [
      el('h2', null, [groupIconEl(group.name), el('span', { text: group.name })]),
      el('span', { class: 'badge muted', text: group.type || t('группа') }),
      el('span', { class: 'badge muted', text: LANG === 'en' ? plural(nodes, ['node', 'nodes', 'nodes']) : nodes + ' ' + plural(nodes, ['узел', 'узла', 'узлов']) }),
      cur,
      selectable ? null : el('span', { class: 'badge warn', text: 'авто' })
    ]));

    box.appendChild(el('div', { class: 'srv-panel-tools' }, [
      el('span', { class: 'srv-note', text: LANG === 'en'
        ? (selectable
          ? 'click — make active · right click / hold — test · delay is a real request through the node'
          : 'group picks a node automatically · test — right click / hold · delay is a real request through the node')
        : (selectable
          ? 'клик — сделать активным · правый клик / удержание — тест · задержка — реальный запрос через узел'
          : 'группа выбирает узел автоматически · тест — правый клик / удержание · задержка — реальный запрос через узел') }),
      el('div', { class: 'seg small', role: 'group', 'aria-label': 'Сортировка' }, [
        sortBtn('delay', LANG === 'en' ? 'by delay' : 'по задержке'),
        sortBtn('name', LANG === 'en' ? 'by name' : 'по имени')
      ]),
      el('button', {
        type: 'button', class: 'btn small ghost',
        title: 'Проверить задержку всех узлов группы через прокси',
        onclick: function () { runTest(groupNodes(group)); }
      }, 'Проверить группу')
    ]));
  }

  function renderServers() {
    var grid = $('srv-grid');
    if (!grid) return;
    var emptyEl = $('srv-empty');
    var countEl = $('srv-count');
    var st = ui.state;
    var group = serverGroup();

    if (st) {
      var sig = serversSignature();
      if (sig === serversSig && grid.childNodes.length) {
        renderTestBar();
        return;
      }
      serversSig = sig;
    } else {
      serversSig = null;
    }

    renderGroupTabs(st);
    clear(grid);
    renderDeadCard();

    if (!st) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = 'Нет данных о группах. Демон ещё не прислал состояние.';
      }
      if (countEl) countEl.textContent = '';
      renderServerPanelHead(null);
      renderTestBar();
      return;
    }
    if (!group) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'Группы не найдены.'; }
      if (countEl) countEl.textContent = '';
      renderServerPanelHead(null);
      renderTestBar();
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    var q = (ui.servers.search || '').trim().toLowerCase();
    var all = Array.isArray(group.all) ? group.all : [];
    var subs = [], nodes = [];
    all.forEach(function (name, idx) {
      if (!name) return;
      if (isGroupName(name)) subs.push({ name: name, idx: idx });
      else nodes.push({ name: name, idx: idx });
    });

    var entries = subs.concat(nodes);
    if (q) {
      entries = entries.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; });
    }
    if (ui.servers.sort === 'name') {
      entries.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
    } else {
      entries.sort(nodeComparator);
    }

    var alive = [], dead = [];
    entries.forEach(function (r) {
      if (isDeadOrErr(r.name)) dead.push(r);
      else alive.push(r);
    });

    alive.forEach(function (r) { grid.appendChild(buildNodeCard(r.name, group)); });
    if (dead.length) {
      grid.appendChild(el('div', { class: 'node-grid-sep' }, [
        el('span', { class: 'badge bad', text: 'не отвечают' }),
        el('span', { class: 'hint', text: 'по данным сторожа или последнего замера' })
      ]));
      dead.forEach(function (r) { grid.appendChild(buildNodeCard(r.name, group)); });
    }
    if (!entries.length) {
      grid.appendChild(el('div', { class: 'empty srv-grid-empty', text: q
        ? 'В группе «' + group.name + '» ничего не найдено по запросу «' + ui.servers.search + '»'
        : 'В группе «' + group.name + '» нет узлов.' }));
    }

    renderServerPanelHead(group);

    if (countEl) {
      var total = allNodeNames().length;
      countEl.textContent = total
        ? total + ' ' + plural(total, ['узел', 'узла', 'узлов']) + ' · ' +
          st.groups.length + ' ' + plural(st.groups.length, ['группа', 'группы', 'групп']) +
          (q ? ' · найдено ' + entries.length : '')
        : '';
    }
    renderTestBar();
  }

  function nodeTypeText(name) {
    var proxy = proxyByName(name);
    if (proxy && proxy.type) return proxy.type;
    var g = groupByName(name);
    if (g && g.type) return g.type;
    if (name === 'DIRECT') return 'Direct';
    if (name === 'REJECT' || name === 'REJECT-DROP') return 'Reject';
    return 'узел';
  }

  function buildNodeCard(name, group) {
    var isSub = isGroupName(name);
    var proxy = isSub ? null : proxyByName(name);
    var selectable = isSelector(group);
    var current = !!group && group.now === name;
    var target = isSub ? finalNode(name) : name;
    var dead = isDeadOrErr(name);
    var fl = splitFlag(name);
    var shown = fl.flag ? fl.rest : name;
    var cc = isSub ? '' : countryFromName(name);
    var key = (group ? group.name : '') + '\u0000' + name;
    var pending = !!ui.pendingSelect[key];

    var card = el('button', {
      type: 'button',
      class: 'ncard' + (current ? ' current' : '') + (dead ? ' dead' : '') +
        (selectable ? '' : ' auto') + (pending ? ' pending' : ''),
      dataset: { name: name },
      title: name + '\n' + (isSub ? 'подгруппа · ' + nodeTypeText(name) : nodeTypeText(name)) +
        (cc ? '\nстрана: ' + countryName(cc) : '') +
        '\nклик — ' + (selectable ? 'сделать активным' : 'группа выбирает автоматически') +
        '\nправый клик / удержание — тест'
    });

    // флаг страны слева; у подгрупп — иконка группы
    card.appendChild(el('span', { class: 'ncard-flag' }, [nodeBadge(name)]));

    card.appendChild(el('span', { class: 'ncard-name', text: shown, title: name }));

    var badge = delayBadge(target, {
      unknownTitle: 'Задержка ещё не измерена — правый клик / удержание по карточке запустит тест'
    });
    if (isSub) {
      badge.title = (target && target !== name ? 'Задержка узла «' + target + '»: ' : 'Задержка: ') + (badge.title || '');
    }
    card.appendChild(el('span', { class: 'ncard-delay' }, [badge]));

    var meta = el('span', { class: 'ncard-meta' }, [
      el('span', { class: 'ncard-type', text: isSub ? 'группа · ' + nodeTypeText(name) : nodeTypeText(name) }),
      !isSub && proxy && proxy.udp ? el('span', { class: 'ncard-udp', text: 'UDP' }) : null,
      dead ? el('span', { class: 'badge bad', text: 'offline' }) : null
    ]);
    if (isSub && target && target !== name) {
      meta.appendChild(el('span', {
        class: 'ncard-via',
        text: '→ ' + trim(nodeLabel(target), 24),
        title: 'Активный узел подгруппы: ' + target
      }));
    }
    card.appendChild(meta);

    var acts = el('span', { class: 'ncard-acts' });
    if (pending) {
      acts.appendChild(el('span', { class: 'ncard-switch' }, [el('span', { class: 'spinner' }), el('span', { text: 'переключаю…' })]));
    } else {
      if (current) acts.appendChild(el('span', { class: 'ncard-act on', text: '✓ активен' }));
      else if (!selectable) acts.appendChild(el('span', { class: 'ncard-act auto', text: 'авто' }));
      else acts.appendChild(el('span', { class: 'ncard-act', text: isSub ? 'выбрать группу' : 'выбрать' }));
      acts.appendChild(el('span', {
        class: 'ncard-act test',
        text: 'тест',
        title: 'Замерить задержку через прокси',
        onclick: function (e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          testNode(name, group);
        }
      }));
    }
    card.appendChild(acts);

    bindNodeGestures(card, name, group);
    return card;
  }

  function bindNodeGestures(card, name, group) {
    var timer = null;
    var startX = 0, startY = 0, moved = false, suppress = false, lastFire = 0;
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    function fireTest(suppressClick) {
      var now = Date.now();
      // на некоторых браузерах долгое нажатие приходит и таймером, и contextmenu
      if (now - lastFire < 900) return;
      lastFire = now;
      cancel();
      if (suppressClick) suppress = true;
      card.classList.add('pressing');
      setTimeout(function () { card.classList.remove('pressing'); }, 320);
      testNode(name, group);
    }
    card.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      moved = false;
      suppress = false;
      startX = e.clientX;
      startY = e.clientY;
      cancel();
      timer = setTimeout(function () {
        timer = null;
        if (!moved) fireTest(true);
      }, LONG_PRESS_MS);
    });
    card.addEventListener('pointermove', function (e) {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) {
        moved = true;
        cancel();
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      card.addEventListener(ev, cancel);
    });
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      fireTest(false);
    });
    card.addEventListener('click', function (e) {
      e.preventDefault();
      if (suppress) { suppress = false; return; }
      chooseNode(name, group);
    });
    card.addEventListener('keydown', function (e) {
      if (e.key === 't' || e.key === 'T' || (e.shiftKey && e.key === 'Enter')) {
        e.preventDefault();
        fireTest(false);
      }
    });
  }

  function testNode(name, group) {
    if (delay.running) {
      toast('Тест уже идёт — дождитесь результата', 'warn');
      return;
    }
    var isSub = isGroupName(name);
    var target = isSub ? finalNode(name) : name;
    if (!target) return;
    if (isSub && target !== name) {
      toast('Тест подгруппы «' + name + '»: измеряю активный узел ' + nodeLabel(target), 'info', 2800);
    }
    runTest([target]);
  }

  async function chooseNode(name, group) {
    if (!group) return;
    if (!isSelector(group)) {
      toast('Группа «' + group.name + '» (' + (group.type || 'группа') + ') выбирает узел автоматически', 'warn', 3600);
      return;
    }
    if (group.now === name) return; // уже активен
    var key = group.name + '\u0000' + name;
    if (ui.pendingSelect[key]) return;
    ui.pendingSelect[key] = true;
    serversSig = null;
    renderServers();
    try {
      await postJson('/api/select', { group: group.name, name: name }, 15000);
      var g = groupByName(group.name);
      if (g) g.now = name;
      toast(isGroupName(name) ? 'Группа «' + group.name + '» → ' + nodeLabel(name) : 'Выбран ' + nodeLabel(name), 'ok', 3200);
      pollState();
    } catch (e) {
      toast('Не удалось переключить: ' + friendlyError(e), 'bad');
    } finally {
      delete ui.pendingSelect[key];
      serversSig = null;
      if (ui.view === 'servers') renderServers();
      else if (ui.view === 'overview') renderOverview();
    }
  }

  function renderDeadCard() {
    var wrap = $('srv-dead-wrap');
    var list = $('srv-dead');
    var cnt = $('srv-dead-count');
    if (!wrap || !list) return;
    var wd = ui.state && ui.state.watchdog;
    var dead = (wd && wd.dead) || [];
    if (!dead.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (cnt) { cnt.className = 'badge bad'; cnt.textContent = String(dead.length); }
    clear(list);
    dead.forEach(function (name) {
      list.appendChild(el('span', {
        class: 'dead-item',
        title: (LANG === 'en' ? 'Offline per watchdog: ' : 'Offline по данным сторожа: ') + name
      }, [flagForNode(name, 'sm'), el('span', { text: nodeLabel(name) })]));
    });
  }

  /* ------------------------------ СОЕДИНЕНИЯ ----------------------------- */

  function parseStart(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value > 1e12 ? value / 1000 : value;
    return parseIsoSeconds(value);
  }

  // ISO-дата с любым числом долей секунды (mihomo/Go отдают 7–9 знаков) → unix-секунды
  function parseIsoSeconds(value) {
    if (!value) return 0;
    var text = String(value);
    var normal = text.replace(/(\.\d{3})\d+/, '$1');
    var ms = Date.parse(normal);
    if (isNaN(ms)) ms = Date.parse(text);
    return isNaN(ms) ? 0 : Math.floor(ms / 1000);
  }

  function normConn(c) {
    c = c || {};
    var m = c.metadata || c.meta || {};
    var host = m.host || m.sni || m.destinationIP || m.destIP || m.remoteDestination || '';
    if (!host) host = '—';
    var dst = m.destinationIP || m.destIP || '';
    var dstPort = m.destinationPort || m.destPort || '';
    var src = m.sourceIP || '';
    var srcPort = m.sourcePort || '';
    var chains = Array.isArray(c.chains) ? c.chains.slice().reverse() : [];
    var dstText = dst ? dst + (dstPort ? ':' + dstPort : '') : (host && host !== '—' && dstPort ? host + ':' + dstPort : '');
    return {
      id: c.id !== undefined && c.id !== null ? String(c.id) : (host + '|' + (m.destinationPort || '') + '|' + (c.start || '')),
      host: String(host),
      rule: c.rule ? String(c.rule) : '',
      payload: c.rulePayload !== undefined && c.rulePayload !== null ? String(c.rulePayload) : '',
      chain: chains.length ? chains.map(nodeLabel).join(' → ') : (c.chain ? String(c.chain) : ''),
      chainList: chains,
      up: num(c.upload !== undefined ? c.upload : c.up),
      down: num(c.download !== undefined ? c.download : c.down),
      start: parseStart(c.start),
      network: m.network ? String(m.network) : '',
      type: m.type ? String(m.type) : '',
      src: src ? src + (srcPort ? ':' + srcPort : '') : '',
      srcIp: src ? String(src) : '',
      dst: dstText,
      ip: dst ? String(dst) : (isIpAddr(host) ? String(host) : ''),
      port: dstPort ? String(dstPort) : '',
      process: m.processPath ? String(m.processPath) : ''
    };
  }

  async function loadConnections(manual) {
    if (ui.conns.loading) return;
    ui.conns.loading = true;
    ui.conns.lastTry = Date.now();
    try {
      var res = await apiJson('/api/connections', null, 9000);
      var raw = Array.isArray(res) ? res : (res && Array.isArray(res.connections) ? res.connections : []);
      ui.conns.list = raw.map(normConn);
      ui.conns.total = raw.length;
      ui.conns.up = res && res.up !== undefined ? num(res.up) : ui.conns.list.reduce(function (a, c) { return a + c.up; }, 0);
      ui.conns.down = res && res.down !== undefined ? num(res.down) : ui.conns.list.reduce(function (a, c) { return a + c.down; }, 0);
      ui.conns.at = Date.now();
      ui.conns.err = '';
      syncConnDrawer();
      if (ui.view === 'connections') renderConnections();
      else if (ui.view === 'overview') renderOverview();
    } catch (e) {
      ui.conns.err = friendlyError(e);
      if (manual) toast('Не удалось получить соединения: ' + ui.conns.err, 'bad');
      if (ui.view === 'connections') renderConnMeta();
    } finally {
      ui.conns.loading = false;
    }
  }

  // Панель деталей не должна мешать автообновлению: выделение хранится по id,
  // а данные в открытой панели подтягиваются из свежего списка.
  function syncConnDrawer() {
    if (!ui.drawer.open || ui.drawer.kind !== 'conn') return;
    var found = null;
    for (var i = 0; i < ui.conns.list.length; i++) {
      if (ui.conns.list[i].id === ui.drawer.key) { found = ui.conns.list[i]; break; }
    }
    ui.drawer.conn = found;
    renderDrawer();
  }

  function connMatches(c, q) {
    if (!q) return true;
    return (c.host + ' ' + c.rule + ' ' + c.payload + ' ' + c.chain + ' ' + c.dst + ' ' + c.src).toLowerCase().indexOf(q) >= 0;
  }

  /* ------------------- устройства в локальной сети ---------------------- */

  var devSig = '';        // набор sourceIP в списке (пересборка <select>)
  var devCountsSig = '';  // счётчики для подписей опций

  // Куда реально уходит соединение — последний элемент цепочки (сам узел).
  function connExitNode(c) {
    var list = c && Array.isArray(c.chainList) ? c.chainList : [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i]) return list[i];
    }
    return '';
  }

  // Сводка по локальным адресам: сколько соединений, трафик и через что выходят.
  function connDeviceStats() {
    var map = Object.create(null);
    var order = [];
    var list = ui.conns.list;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var ip = c.srcIp || '';
      if (!ip) continue;
      var d = map[ip];
      if (!d) {
        d = map[ip] = { ip: ip, count: 0, up: 0, down: 0, exits: Object.create(null), exitOrder: [] };
        order.push(ip);
      }
      d.count++;
      d.up += c.up;
      d.down += c.down;
      var ex = connExitNode(c);
      if (!ex) continue;
      var e = d.exits[ex];
      if (!e) {
        e = d.exits[ex] = { node: ex, count: 0, bytes: 0, chain: (c.chainList || []).slice() };
        d.exitOrder.push(ex);
      }
      e.count++;
      e.bytes += c.up + c.down;
      if ((c.chainList || []).length > e.chain.length) e.chain = (c.chainList || []).slice();
    }
    var out = order.map(function (ip) { return map[ip]; });
    out.forEach(function (d) {
      d.exitList = d.exitOrder.map(function (n) { return d.exits[n]; }).sort(function (a, b) {
        return b.bytes - a.bytes || b.count - a.count;
      });
      d.top = d.exitList[0] || null;
    });
    out.sort(function (a, b) {
      try { return b.count - a.count || a.ip.localeCompare(b.ip, 'ru', { numeric: true }); }
      catch (e) { return b.count - a.count || (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0); }
    });
    return out;
  }

  function renderDeviceBar(devices) {
    var sel = $('conn-device');
    if (!sel) return;
    var sig = devices.map(function (d) { return d.ip; }).join('|');
    var counts = devices.map(function (d) { return d.ip + ':' + d.count; }).join('|');
    if (sig !== devSig) {
      devSig = sig;
      var keep = ui.conns.device;
      clear(sel);
      sel.appendChild(el('option', {
        value: '',
        text: devices.length ? 'Все устройства · ' + ui.conns.list.length : 'Все устройства'
      }));
      devices.forEach(function (d) {
        sel.appendChild(el('option', { value: d.ip, text: d.ip + ' · ' + d.count }));
      });
      var known = false;
      devices.forEach(function (d) { if (d.ip === keep) known = true; });
      if (keep && !known) sel.appendChild(el('option', { value: keep, text: keep + ' · 0' }));
      sel.value = keep || '';
    } else if (counts !== devCountsSig) {
      // обновляем только подписи, чтобы не сбрасывать открытый список
      var byIp = Object.create(null);
      devices.forEach(function (d) { byIp[d.ip] = d; });
      for (var j = 0; j < sel.options.length; j++) {
        var opt = sel.options[j];
        if (!opt.value) {
          opt.textContent = devices.length ? 'Все устройства · ' + ui.conns.list.length : 'Все устройства';
        } else if (byIp[opt.value]) {
          opt.textContent = byIp[opt.value].ip + ' · ' + byIp[opt.value].count;
        }
      }
    }
    devCountsSig = counts;
    renderDeviceExit(devices);
  }

  function renderDeviceExit(devices) {
    var box = $('conn-dev-exit');
    if (!box) return;
    var ip = ui.conns.device;
    if (!ip) {
      box.hidden = true;
      clear(box);
      return;
    }
    var dev = null;
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].ip === ip) { dev = devices[i]; break; }
    }
    box.hidden = false;
    clear(box);
    if (!dev) {
      box.appendChild(el('div', {
        class: 'dev-empty',
        text: 'У устройства ' + ip + ' сейчас нет активных соединений.'
      }));
      return;
    }
    var main = el('div', { class: 'dev-exit-main' });
    var top = dev.top;
    if (top) {
      main.appendChild(el('span', { class: 'dev-exit-lbl', text: 'выходит через' }));
      main.appendChild(nodeBadge(top.node, 'sm'));
      main.appendChild(el('b', { text: nodeLabel(top.node) || '—' }));
      var cc = countryFromName(top.node);
      if (cc) main.appendChild(el('span', { class: 'badge muted', text: countryName(cc) }));
      var chainText = Array.isArray(top.chain) ? top.chain.map(nodeLabel).join(' → ') : '';
      if (chainText) main.appendChild(el('span', { class: 'dev-exit-chain', text: chainText, title: chainText }));
    } else {
      main.appendChild(el('span', { class: 'dev-empty', text: 'маршрут пока не определён' }));
    }
    box.appendChild(el('div', { class: 'dev-exit-row' }, [
      main,
      el('div', {
        class: 'dev-exit-stats',
        text: dev.count + ' ' + plural(dev.count, ['соединение', 'соединения', 'соединений']) +
          ' · ↑ ' + fmtBytes(dev.up) + ' · ↓ ' + fmtBytes(dev.down)
      })
    ]));
    if (dev.exitList.length > 1) {
      var more = el('div', { class: 'dev-exit-more' }, [el('span', { text: 'ещё:' })]);
      dev.exitList.slice(1, 5).forEach(function (e) {
        more.appendChild(el('span', { class: 'chain-node' }, [
          nodeBadge(e.node, 'sm'),
          el('b', { text: nodeLabel(e.node) || '—' }),
          el('span', { class: 'muted', text: '· ' + e.count })
        ]));
      });
      if (dev.exitList.length > 5) more.appendChild(el('span', { text: '+ ещё ' + (dev.exitList.length - 5) }));
      box.appendChild(more);
    }
  }

  /* ------------------------- сортировка соединений ------------------------ */

  var CONN_SORT_DEFAULT_DIR = { time: 'desc', down: 'desc', up: 'desc', host: 'asc', rule: 'asc', chain: 'asc' };

  function connComparator(a, b) {
    var sort = (ui.conns.sort && ui.conns.sort.key) ? ui.conns.sort : { key: 'time', dir: 'desc' };
    var r = 0;
    if (sort.key === 'host') r = String(a.host || '').localeCompare(String(b.host || ''), 'ru');
    else if (sort.key === 'rule') r = String(a.rule || '').localeCompare(String(b.rule || ''), 'ru');
    else if (sort.key === 'chain') r = String(a.chain || '').localeCompare(String(b.chain || ''), 'ru');
    else if (sort.key === 'up') r = (a.up || 0) - (b.up || 0);
    else if (sort.key === 'down') r = (a.down || 0) - (b.down || 0);
    else r = (a.start || 0) - (b.start || 0);
    if (r === 0) r = (a.start || 0) - (b.start || 0);
    return sort.dir === 'asc' ? r : -r;
  }

  function setConnSort(key, dir) {
    if (!key) return;
    var cur = ui.conns.sort || { key: 'time', dir: 'desc' };
    var nextDir = dir || (cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : (CONN_SORT_DEFAULT_DIR[key] || 'desc'));
    ui.conns.sort = { key: key, dir: nextDir };
    renderConnections();
  }

  function renderConnSortUi() {
    var sort = (ui.conns.sort && ui.conns.sort.key) ? ui.conns.sort : { key: 'time', dir: 'desc' };
    var ths = document.querySelectorAll('#conn-table thead th[data-sort]');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var on = th.getAttribute('data-sort') === sort.key;
      th.classList.toggle('sorted', on);
      th.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      var ind = th.querySelector('.sort-ind');
      if (ind) ind.textContent = on ? (sort.dir === 'asc' ? '↑' : '↓') : '↕';
    }
    var sel = $('conn-sort');
    if (!sel) return;
    if (!sel.options.length) {
      [
        ['time:desc', 'Время · сначала новые'],
        ['down:desc', 'Скачано · больше сверху'],
        ['up:desc', 'Отдано · больше сверху'],
        ['host:asc', 'Хост · А–Я'],
        ['rule:asc', 'Правило · А–Я'],
        ['chain:asc', 'Цепочка · А–Я']
      ].forEach(function (o) {
        sel.appendChild(el('option', { value: o[0], text: o[1] }));
      });
    }
    var want = sort.key + ':' + sort.dir;
    var has = false;
    for (var k = 0; k < sel.options.length; k++) {
      if (sel.options[k].value === want) has = true;
    }
    if (!has) want = sort.key + ':' + (CONN_SORT_DEFAULT_DIR[sort.key] || 'desc');
    if (sel.value !== want) sel.value = want;
  }

  function renderConnections() {
    var body = $('conn-body');
    if (!body) return;
    var wrap = $('conn-table-wrap');
    var keepScroll = wrap ? wrap.scrollTop : 0;
    var q = (ui.conns.search || '').trim().toLowerCase();
    var dev = ui.conns.device || '';
    var all = ui.conns.list;
    var devTotal = dev ? all.filter(function (c) { return c.srcIp === dev; }).length : all.length;
    var list = all.slice();
    if (dev) list = list.filter(function (c) { return c.srcIp === dev; });
    if (q) list = list.filter(function (c) { return connMatches(c, q); });
    list.sort(connComparator);
    renderConnSortUi();

    renderDeviceBar(connDeviceStats());

    clear(body);
    var nowSec = Math.floor(Date.now() / 1000);
    var frag = document.createDocumentFragment();

    list.forEach(function (c) {
      var ruleText = c.rule || '—';
      // если хоста нет и в таблице уже стоит IP, не дублируем «IP:порт» второй строкой
      var dstNote = c.host && c.ip && c.host === c.ip ? '' : c.dst;
      var srcNote = !dev && c.srcIp ? 'из ' + c.srcIp : '';
      var selected = ui.drawer.open && ui.drawer.kind === 'conn' && ui.drawer.key === c.id;
      var closeBtn = el('button', {
        type: 'button', class: 'btn small ghost', title: 'Закрыть соединение',
        onclick: function (e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          closeConnection(c.id, closeBtn);
        }
      }, '✕');

      var tr = el('tr', {
        class: 'conn-row' + (selected ? ' selected' : ''),
        tabindex: '0',
        'aria-label': 'Подробности соединения ' + c.host,
        dataset: { id: c.id }
      }, [
        el('td', { 'data-label': 'Хост' }, [
          el('div', { class: 'cell-stack' }, [
            el('span', { class: 'cell-main', text: c.host, title: c.host }),
            el('span', {
              class: 'cell-sub',
              text: [c.network, c.type, dstNote, srcNote, c.process ? c.process : ''].filter(Boolean).join(' · ') || (c.src ? 'из ' + c.src : ''),
              title: [c.dst && 'назначение: ' + c.dst, c.src && 'источник: ' + c.src, c.process && 'процесс: ' + c.process].filter(Boolean).join('\n')
            })
          ])
        ]),
        el('td', { 'data-label': 'Правило' }, [
          el('div', { class: 'cell-stack' }, [
            el('span', { class: 'cell-main', text: ruleText }),
            c.payload ? el('span', { class: 'cell-sub', text: c.payload, title: c.payload }) : null
          ])
        ]),
        el('td', { 'data-label': 'Цепочка' }, [
          el('span', { class: 'cell-chain', text: c.chain || '—' })
        ]),
        el('td', { 'data-label': '↑', class: 'num', text: fmtBytes(c.up) }),
        el('td', { 'data-label': '↓', class: 'num', text: fmtBytes(c.down) }),
        el('td', { 'data-label': 'Время', class: 'num', text: fmtDur(nowSec - c.start) }),
        el('td', { class: 'act', 'data-label': '' }, [closeBtn])
      ]);
      tr.addEventListener('click', function () { openDrawer('conn', c.id, c); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openDrawer('conn', c.id, c);
        }
      });
      frag.appendChild(tr);
    });
    body.appendChild(frag);

    var table = $('conn-table');
    var emptyEl = $('conn-empty');
    if (emptyEl) {
      emptyEl.hidden = list.length > 0;
      if (dev && !devTotal) {
        emptyEl.textContent = 'У устройства ' + dev + ' сейчас нет активных соединений';
      } else if (q) {
        emptyEl.textContent = 'Ничего не найдено по запросу «' + ui.conns.search + '»' + (dev ? ' у устройства ' + dev : '');
      } else if (dev) {
        emptyEl.textContent = 'У устройства ' + dev + ' нет соединений с такими параметрами';
      } else {
        emptyEl.textContent = 'Нет активных соединений';
      }
    }
    if (table) table.hidden = list.length === 0;

    var countEl = $('conn-count');
    if (countEl) {
      if (!all.length) countEl.textContent = '';
      else if (q || dev) countEl.textContent = list.length + ' из ' + devTotal;
      else countEl.textContent = String(all.length);
    }
    renderConnMeta();
    if (wrap) wrap.scrollTop = keepScroll;
  }

  function renderConnMeta() {
    var meta = $('conn-meta');
    if (!meta) return;
    // чип паузы обновляем всегда: место под него занято постоянно, чтобы
    // тулбар не менял высоту и таблица не «прыгала»
    var paused = $('conn-paused');
    if (paused) paused.classList.toggle('is-off', !(ui.conns.hover && canHover()));
    if (ui.conns.err) {
      meta.textContent = 'ошибка: ' + ui.conns.err + (ui.conns.at ? ' · данные от ' + fmtClock(ui.conns.at / 1000) : '');
      meta.className = 'small';
      meta.style.color = 'var(--bad)';
      return;
    }
    meta.style.color = '';
    meta.className = 'muted small';
    var parts = [];
    if (ui.conns.at) parts.push((LANG === 'en' ? 'updated ' : 'обновлено ') + fmtClock(ui.conns.at / 1000));
    parts.push((LANG === 'en' ? 'total ' : 'всего ') + '↑ ' + fmtBytes(ui.conns.up) + ' · ↓ ' + fmtBytes(ui.conns.down));
    meta.textContent = parts.join(' · ');
  }

  function canHover() {
    try { return window.matchMedia('(hover: hover)').matches; } catch (e) { return false; }
  }

  function startConnRefresh() {
    stopConnRefresh();
    timers.conns = setInterval(function () {
      if (ui.view !== 'connections' || document.hidden) return;
      if (ui.conns.hover || ui.conns.closing) return;
      loadConnections();
    }, CONN_MS);
  }

  function stopConnRefresh() {
    if (timers.conns) { clearInterval(timers.conns); timers.conns = null; }
  }

  async function closeConnection(id, btn) {
    if (ui.conns.closing) return;
    ui.conns.closing = true;
    if (btn) btn.disabled = true;
    try {
      await apiJson('/api/connections?id=' + encodeURIComponent(id), { method: 'DELETE' }, 9000);
      ui.conns.list = ui.conns.list.filter(function (c) { return c.id !== id; });
      if (ui.drawer.open && ui.drawer.kind === 'conn' && ui.drawer.key === String(id)) {
        ui.drawer.conn = null;
        renderDrawer();
      }
      renderConnections();
      toast('Соединение закрыто', 'ok', 2000);
    } catch (e) {
      if (btn) btn.disabled = false;
      toast('Не удалось закрыть соединение: ' + friendlyError(e), 'bad');
    } finally {
      ui.conns.closing = false;
    }
  }

  async function closeAllConnections() {
    if (!ui.conns.list.length) { toast('Активных соединений нет', 'warn'); return; }
    var ok = await confirmDialog({
      title: 'Закрыть все соединения?',
      text: 'Будет отправлен DELETE /api/connections. Активные загрузки, обновления и звонки прервутся.',
      okLabel: 'Закрыть всё',
      danger: true
    });
    if (!ok) return;
    var btn = $('btn-conn-close-all');
    setBusy(btn, true, 'Закрываю…');
    try {
      await apiJson('/api/connections', { method: 'DELETE' }, 15000);
      ui.conns.list = [];
      if (ui.drawer.open && ui.drawer.kind === 'conn') {
        ui.drawer.conn = null;
        renderDrawer();
      }
      renderConnections();
      toast('Все соединения закрыты', 'ok');
      pollState();
    } catch (e) {
      toast('Не удалось закрыть соединения: ' + friendlyError(e), 'bad');
    } finally {
      setBusy(btn, false, 'Закрыть всё');
    }
  }

  /* ------------------------- панель деталей (drawer) ---------------------- */

  function drawerEls() {
    return {
      root: $('drawer-root'),
      panel: $('drawer'),
      body: $('drawer-body'),
      foot: $('drawer-foot'),
      title: $('drawer-title'),
      kind: $('drawer-kind')
    };
  }

  function openDrawer(kind, key, payload) {
    var els = drawerEls();
    if (!els.root || !els.body) return;
    var prevFocus = document.activeElement;
    if (kind === 'conn') { ui.drawer.conn = payload || null; ui.drawer.event = null; ui.drawer.log = null; }
    else if (kind === 'event') { ui.drawer.event = payload || null; ui.drawer.conn = null; ui.drawer.log = null; }
    else if (kind === 'log') { ui.drawer.log = payload || null; ui.drawer.conn = null; ui.drawer.event = null; }
    ui.drawer.open = true;
    ui.drawer.kind = kind;
    ui.drawer.key = String(key === undefined || key === null ? '' : key);
    els.root.hidden = false;
    ui.drawer.prevFocus = prevFocus || null;
    document.body.style.overflow = 'hidden';
    renderDrawer();
    if (els.panel) {
      try { els.panel.focus({ preventScroll: true }); } catch (e) { try { els.panel.focus(); } catch (e2) { /* ignore */ } }
    }
    if (ui.view === 'connections') renderConnections();
    if (ui.view === 'journal') renderEvents();
  }

  function closeDrawer(restoreFocus) {
    var els = drawerEls();
    if (!ui.drawer.open) return;
    ui.drawer.open = false;
    ui.drawer.kind = '';
    ui.drawer.key = '';
    ui.drawer.conn = null;
    ui.drawer.event = null;
    ui.drawer.log = null;
    if (els.root) els.root.hidden = true;
    if (els.body) clear(els.body);
    if (els.foot) clear(els.foot);
    document.body.style.overflow = '';
    if (ui.view === 'connections') renderConnections();
    if (ui.view === 'journal') renderEvents();
    var prev = ui.drawer.prevFocus;
    ui.drawer.prevFocus = null;
    if (restoreFocus !== false && prev && typeof prev.focus === 'function') {
      try { prev.focus({ preventScroll: true }); } catch (e) { try { prev.focus(); } catch (e2) { /* ignore */ } }
    }
  }

  function renderDrawer() {
    var els = drawerEls();
    if (!els.root || !els.body || !ui.drawer.open) return;
    var scroll = els.body.scrollTop;
    clear(els.body);
    clear(els.foot);
    if (ui.drawer.kind === 'conn') renderConnDrawer(ui.drawer.conn, els);
    else if (ui.drawer.kind === 'event') renderEventDrawer(ui.drawer.event, els);
    else if (ui.drawer.kind === 'log') renderLogDrawer(ui.drawer.log, els);
    els.body.scrollTop = scroll;
  }

  function dsec(title, iconName) {
    var head = el('h3', { class: 'dsec-h' }, iconName ? [icoEl(iconName, 'sm'), el('span', { text: title })] : title);
    return el('section', { class: 'dsec' }, [head]);
  }

  function drow(key, value, mono, title) {
    var v;
    if (value instanceof Node) v = value;
    else v = el('span', { text: value === '' || value === null || value === undefined ? '—' : String(value) });
    if (title) v.title = title;
    else if (!(value instanceof Node)) v.title = String(value === null || value === undefined ? '' : value);
    return el('div', { class: 'drow' }, [
      el('span', { class: 'drow-k', text: key }),
      mono ? el('span', { class: 'drow-v mono' }, [v]) : el('span', { class: 'drow-v' }, [v])
    ]);
  }

  function chainChips(list) {
    var arr = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!arr.length) return el('span', { class: 'drow-v', text: '—' });
    var box = el('span', { class: 'chain' });
    arr.forEach(function (name, i) {
      if (i) box.appendChild(el('span', { class: 'chain-arrow', text: '→' }));
      var isGroup = isGroupName(name);
      var item = el('span', {
        class: 'chain-node' + (isGroup ? ' group' : '') + (!isGroup && i === arr.length - 1 ? ' last' : ''),
        title: isGroup ? 'Группа ' + name : name
      }, [nodeBadge(name, 'sm'), el('b', { text: nodeLabel(name) })]);
      box.appendChild(item);
    });
    return box;
  }

  function isIpAddr(text) {
    var s = String(text || '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
    return s.indexOf(':') >= 0 && /^[0-9a-fA-F:.]+$/.test(s);
  }

  function asnBox(ip) {
    var box = el('div', { class: 'asn-box' });
    box.dataset.ip = ip ? String(ip) : '';
    paintAsn(box, ip);
    return box;
  }

  function asnEntryFor(ip) {
    var e = asnCache[ip];
    if (!e) return null;
    // ошибку держим недолго, успешный ответ — 6 часов (демон кеширует на 24 ч)
    if (Date.now() - e.t > (e.err ? 60000 : 6 * 3600 * 1000)) return null;
    return e;
  }

  function ensureAsn(ip) {
    if (!ip || asnLoading[ip]) return;
    asnLoading[ip] = true;
    apiJson('/api/asn?ip=' + encodeURIComponent(ip), null, 9000)
      .then(function (info) {
        asnCache[ip] = { t: Date.now(), info: info && typeof info === 'object' ? info : {}, err: '' };
      })
      .catch(function (e) {
        asnCache[ip] = { t: Date.now(), info: null, err: friendlyError(e) };
      })
      .then(function () {
        asnLoading[ip] = false;
        repaintAsn(ip);
      });
  }

  function repaintAsn(ip) {
    var boxes = document.querySelectorAll('.asn-box');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].dataset.ip === ip) paintAsn(boxes[i], ip);
    }
  }

  function paintAsn(box, ip) {
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    ip = ip ? String(ip) : '';
    if (!ip) {
      box.appendChild(el('div', { class: 'asn-empty', text: 'Нет IP — страну и ASN не определить (в метаданных только домен).' }));
      return;
    }
    if (asnLoading[ip] && !asnCache[ip]) {
      box.appendChild(el('div', { class: 'asn-loading' }, [
        el('span', { class: 'spinner' }),
        el('span', { text: 'запрашиваю страну и ASN…' })
      ]));
      return;
    }
    var e = asnEntryFor(ip);
    if (!e) {
      ensureAsn(ip);
      box.appendChild(el('div', { class: 'asn-loading' }, [
        el('span', { class: 'spinner' }),
        el('span', { text: 'запрашиваю страну и ASN…' })
      ]));
      return;
    }
    var retry = el('button', {
      type: 'button', class: 'btn small ghost', text: 'Повторить',
      onclick: function () {
        delete asnCache[ip];
        paintAsn(box, ip);
      }
    });
    if (e.err) {
      box.appendChild(el('div', { class: 'asn-err' }, [
        el('span', { text: 'нет данных: ' + e.err }),
        retry
      ]));
      box.appendChild(el('div', { class: 'asn-note', text: 'Гео и ASN отдаёт демон (GET /api/asn). Если эндпоинта нет — обновите xrock.' }));
      return;
    }
    var info = e.info || {};
    if (!info || info.status === 'fail' || (!info.country && !info.countryCode && !info.asn && !info.asname)) {
      box.appendChild(el('div', { class: 'asn-err' }, [
        el('span', { text: 'нет данных' + (info && info.err ? ': ' + info.err : '') }),
        retry
      ]));
      return;
    }
    var cc = String(info.countryCode || '').toLowerCase();
    box.appendChild(el('div', { class: 'asn-head' }, [
      flagEl(cc, 'sm'),
      el('span', { class: 'asn-country', text: info.country || countryName(cc) || 'страна неизвестна' }),
      el('span', { class: 'asn-ip', text: ip })
    ]));
    var asNum = num(info.asn) || 0;
    var asName = String(info.asname || '');
    var asLine = asNum ? ('AS' + asNum + (asName ? ' · ' + asName : '')) : String(info.as || '');
    if (asLine) box.appendChild(el('div', { class: 'asn-row' }, [el('b', { text: asLine })]));
    if (info.isp && info.isp !== asName) {
      box.appendChild(el('div', { class: 'asn-row' }, [el('span', { text: 'ISP' }), el('b', { text: info.isp })]));
    }
    if (info.org && info.org !== asName && info.org !== info.isp) {
      box.appendChild(el('div', { class: 'asn-row' }, [el('span', { text: 'организация' }), el('b', { text: info.org })]));
    }
    if (info.cached) box.appendChild(el('div', { class: 'asn-note', text: 'из кеша демона (24 ч)' }));
  }

  function renderConnDrawer(c, els) {
    els.kind.textContent = 'Соединение';
    if (!c) {
      els.title.textContent = 'Соединение закрыто';
      els.body.appendChild(el('div', { class: 'empty', text: 'Этого соединения больше нет: оно закрыто или завершилось.' }));
      els.body.appendChild(el('div', { class: 'dnote', text: 'Панель можно закрыть — таблица обновляется сама.' }));
      return;
    }
    els.title.textContent = c.host && c.host !== '—' ? c.host : (c.dst || 'Без хоста');
    var nowSec = Math.floor(Date.now() / 1000);

    var s1 = dsec('Соединение', 'fallback');
    s1.appendChild(drow('Хост', c.host || '—', false, c.host));
    s1.appendChild(drow('IP и порт', c.dst || '—', true));
    s1.appendChild(drow('Сеть', [c.network, c.type].filter(Boolean).join(' · ') || '—'));
    s1.appendChild(drow('Источник', c.src || '—', true));
    if (c.process) s1.appendChild(drow('Процесс', c.process, false, c.process));
    els.body.appendChild(s1);

    var s2 = dsec('Трафик и время', 'fastest');
    s2.appendChild(drow('Отдано ↑', fmtBytes(c.up), false, c.up + ' Б'));
    s2.appendChild(drow('Скачано ↓', fmtBytes(c.down), false, c.down + ' Б'));
    s2.appendChild(drow('Старт', c.start ? fmtTime(c.start) : '—', false, c.start ? fmtAgo(c.start) : ''));
    s2.appendChild(drow('Длительность', c.start ? fmtDur(nowSec - c.start) : '—'));
    els.body.appendChild(s2);

    var s3 = dsec('Маршрут', 'proxy');
    s3.appendChild(drow('Правило', c.rule || '—', false, c.payload || ''));
    if (c.payload) s3.appendChild(drow('Содержимое', c.payload, true));
    var chainList = Array.isArray(c.chainList) && c.chainList.length ? c.chainList :
      (c.chain ? String(c.chain).split(/\s*→\s*/) : []);
    s3.appendChild(drow('Цепочка', chainChips(chainList)));
    els.body.appendChild(s3);

    var s4 = dsec('Куда ушёл трафик', 'global');
    s4.appendChild(asnBox(c.ip));
    els.body.appendChild(s4);

    var ipBtn = el('button', { type: 'button', class: 'btn small', text: 'Копировать IP' });
    ipBtn.disabled = !c.ip;
    ipBtn.addEventListener('click', function () { copyText(c.ip, 'IP скопирован'); });
    var hostBtn = el('button', { type: 'button', class: 'btn small', text: 'Копировать хост' });
    hostBtn.addEventListener('click', function () { copyText(c.host && c.host !== '—' ? c.host : '', 'Хост скопирован'); });
    var closeBtn = el('button', {
      type: 'button', class: 'btn small danger', text: 'Закрыть соединение',
      onclick: function () { closeConnection(c.id, closeBtn); }
    });
    els.foot.appendChild(ipBtn);
    els.foot.appendChild(hostBtn);
    els.foot.appendChild(closeBtn);
  }

  function renderEventDrawer(ev, els) {
    els.kind.textContent = 'Событие';
    if (!ev) {
      els.title.textContent = 'Событие';
      els.body.appendChild(el('div', { class: 'empty', text: 'Событие больше не в списке.' }));
      return;
    }
    var kind = String(ev.kind || 'info').toLowerCase();
    if (['info', 'warn', 'bad', 'ok'].indexOf(kind) < 0) kind = 'info';
    els.title.textContent = trim(ev.text || 'Событие', 90);

    var s1 = dsec('Событие', 'proxy');
    s1.appendChild(drow('Время', fmtTime(ev.t) + (ev.t ? ' · ' + fmtAgo(ev.t) : '')));
    s1.appendChild(drow('Тип', el('span', { class: 'badge ' + kind, text: kind })));
    s1.appendChild(drow('Группа', ev.group || '—'));
    els.body.appendChild(s1);

    var s2 = dsec('Текст', 'server');
    s2.appendChild(el('code', { class: 'dcode', text: ev.text || '—' }));
    els.body.appendChild(s2);

    var copyBtn = el('button', { type: 'button', class: 'btn small', text: 'Копировать текст' });
    copyBtn.addEventListener('click', function () { copyText(ev.text || '', 'Событие скопировано'); });
    els.foot.appendChild(copyBtn);
    els.foot.appendChild(el('button', { type: 'button', class: 'btn small ghost', text: 'Закрыть', onclick: function () { closeDrawer(); } }));
  }

  function splitEndpoint(text) {
    var s = String(text === null || text === undefined ? '' : text).trim().replace(/[,;]$/, '');
    if (!s) return { host: '', port: '' };
    var v6 = s.match(/^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/);
    if (v6) return { host: v6[1], port: v6[2] || '' };
    var m = s.match(/^(.+):(\d{1,5})$/);
    if (m) return { host: m[1], port: m[2] };
    return { host: s, port: '' };
  }

  // Разбор строки лога mihomo:
  // [TCP] 1.2.3.4:5678 --> host.com:443 match RuleSet(...) using PROXY[Germany-44fb(ws)]
  function parseLogLine(text) {
    var raw = stripAnsi(String(text === null || text === undefined ? '' : text)).trim();
    var out = {
      raw: raw,
      net: '',
      src: { host: '', port: '' },
      dst: { host: '', port: '' },
      rule: '',
      group: '',
      node: '',
      ok: false
    };
    var rest = raw;
    var m = rest.match(/^\[([^\]]{1,14})\]\s*([\s\S]*)$/);
    if (m) { out.net = m[1].toLowerCase(); rest = m[2]; }
    var ai = rest.indexOf('-->');
    if (ai < 0) return out;
    out.ok = true;
    out.src = splitEndpoint(rest.slice(0, ai));
    var right = rest.slice(ai + 3).trim();
    var usingIdx = right.lastIndexOf(' using ');
    var main = usingIdx >= 0 ? right.slice(0, usingIdx).trim() : right;
    var using = usingIdx >= 0 ? right.slice(usingIdx + 7).trim() : '';
    var sp = main.search(/\s/);
    out.dst = splitEndpoint(sp >= 0 ? main.slice(0, sp) : main);
    var rule = sp >= 0 ? main.slice(sp).trim() : '';
    out.rule = rule.replace(/^match\s+/i, '').trim();
    if (using) {
      var br = using.match(/^([^\[]*)\[([\s\S]+)\]$/);
      if (br) {
        out.group = br[1].trim();
        out.node = br[2].trim();
      } else {
        out.group = using.trim();
      }
    }
    return out;
  }

  function logGeoIp(p) {
    if (p && p.dst && isIpAddr(p.dst.host)) return p.dst.host;
    if (p && p.src && isIpAddr(p.src.host)) return p.src.host;
    return '';
  }

  function renderLogDrawer(entry, els) {
    els.kind.textContent = 'Строка лога mihomo';
    if (!entry) {
      els.title.textContent = 'Строка лога';
      els.body.appendChild(el('div', { class: 'empty', text: 'Строка больше не в буфере.' }));
      return;
    }
    var p = parseLogLine(entry.text);
    els.title.textContent = p.ok
      ? ((p.dst.host || '—') + (p.dst.port ? ':' + p.dst.port : ''))
      : trim(entry.text || 'Строка лога', 80);

    var s0 = dsec('Запись', 'server');
    s0.appendChild(drow('Время', fmtClock(entry.t / 1000)));
    s0.appendChild(drow('Уровень', el('span', { class: 'badge ' + logLevelClass(entry.type), text: logLevelClass(entry.type) })));
    if (p.ok && p.net) s0.appendChild(drow('Сеть', p.net.toUpperCase()));
    els.body.appendChild(s0);

    if (p.ok) {
      var s1 = dsec('Соединение', 'fallback');
      s1.appendChild(drow('Источник', p.src.host ? (p.src.host + (p.src.port ? ':' + p.src.port : '')) : '—', true));
      s1.appendChild(drow('Назначение', p.dst.host ? (p.dst.host + (p.dst.port ? ':' + p.dst.port : '')) : '—', true));
      if (p.dst.port) s1.appendChild(drow('Порт', p.dst.port, true));
      els.body.appendChild(s1);

      var s2 = dsec('Маршрут', 'proxy');
      s2.appendChild(drow('Правило', p.rule || '—', false, p.rule));
      var chain = [];
      if (p.group) chain.push(p.group);
      if (p.node) chain.push(p.node);
      if (chain.length) s2.appendChild(drow('Цепочка', chainChips(chain)));
      els.body.appendChild(s2);

      var geo = logGeoIp(p);
      if (geo) {
        var s3 = dsec('Гео и провайдер', 'global');
        s3.appendChild(asnBox(geo));
        els.body.appendChild(s3);
      }
    } else {
      els.body.appendChild(el('div', { class: 'dnote', text: 'В строке нет разметки «откуда --> куда» — показываю её как есть.' }));
    }

    var s4 = dsec('Строка целиком', 'server');
    s4.appendChild(el('code', { class: 'dcode', text: entry.text || '' }));
    els.body.appendChild(s4);

    var copyBtn = el('button', { type: 'button', class: 'btn small', text: 'Копировать строку' });
    copyBtn.addEventListener('click', function () { copyText(entry.text || '', 'Строка скопирована'); });
    els.foot.appendChild(copyBtn);
    els.foot.appendChild(el('button', { type: 'button', class: 'btn small ghost', text: 'Закрыть', onclick: function () { closeDrawer(); } }));
  }

  /* ---------------------------- подсказка логов --------------------------- */

  function showLogHint() {
    var hint = $('log-hint');
    if (!hint) return;
    clear(hint);
    hint.appendChild(icoEl('proxy', 'lg'));
    hint.appendChild(el('div', {}, [
      el('b', { text: 'Строк нет. Возможно, в mihomo включён log-level: silent. ' }),
      'Поставьте ', el('code', { text: 'log-level: info' }), ' в ',
      el('code', { text: '/opt/etc/mihomo/config.yaml' }), ' и перезапустите ядро: ',
      el('code', { text: 'xkeen -restart' })
    ]));
    hint.hidden = false;
  }

  function hideLogHint() {
    var hint = $('log-hint');
    if (hint) hint.hidden = true;
    if (logHintTimer) { clearTimeout(logHintTimer); logHintTimer = null; }
  }

  function logHintShown() {
    var hint = $('log-hint');
    return !!(hint && !hint.hidden);
  }

  // EventSource при обрыве повторяет попытки каждые ~3 с, поэтому таймер не
  // перезапускаем — иначе подсказка не успевала бы показаться.
  function scheduleLogHint() {
    if (ui.journal.logs.length) return;
    if (logHintTimer || logHintShown()) return;
    logHintTimer = setTimeout(function () {
      logHintTimer = null;
      if (ui.view === 'journal' && ui.journal.tab === 'logs' && !ui.journal.logs.length) showLogHint();
    }, 6000);
  }

  /* -------------------------------- ПРАВИЛА ------------------------------ */

  async function loadRules(manual) {
    if (ui.rules.loading) return;
    ui.rules.loading = true;
    try {
      var res = await apiJson('/api/rules', null, 12000);
      var raw = res && Array.isArray(res.rules) ? res.rules : (Array.isArray(res) ? res : []);
      ui.rules.list = raw.map(function (r) {
        r = r || {};
        return {
          type: r.type ? String(r.type) : '—',
          payload: r.payload !== undefined && r.payload !== null ? String(r.payload) : '',
          proxy: r.proxy ? String(r.proxy) : (r.target ? String(r.target) : '')
        };
      });
      ui.rules.at = Date.now();
      ui.rules.err = '';
      if (ui.view === 'rules') renderRules();
    } catch (e) {
      ui.rules.err = friendlyError(e);
      if (manual) toast('Не удалось получить правила: ' + ui.rules.err, 'bad');
      if (ui.view === 'rules') renderRules();
    } finally {
      ui.rules.loading = false;
    }
  }

  function renderRules() {
    var body = $('rules-body');
    if (!body) return;
    var sig = (ui.rules.at || 0) + '|' + ui.rules.list.length + '|' + (ui.rules.err || '') + '|' + (ui.rules.search || '');
    if (sig === rulesSig && body.childNodes.length) return;
    rulesSig = sig;

    var keepScroll = 0;
    var wrap = body.closest ? body.closest('.table-wrap') : null;
    if (wrap) keepScroll = wrap.scrollTop;
    var q = (ui.rules.search || '').trim().toLowerCase();
    var list = ui.rules.list.filter(function (r) {
      if (!q) return true;
      return (r.type + ' ' + r.payload + ' ' + r.proxy).toLowerCase().indexOf(q) >= 0;
    });

    clear(body);
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      frag.appendChild(el('tr', null, [
        el('td', { 'data-label': 'Тип' }, [el('span', { class: 'cell-main', text: r.type })]),
        el('td', { 'data-label': 'Содержимое' }, [
          el('span', { class: 'cell-main', text: r.payload || '—', title: r.payload })
        ]),
        el('td', { 'data-label': 'Куда идёт' }, [el('span', { class: 'cell-chain', text: r.proxy || '—' })])
      ]));
    });
    body.appendChild(frag);

    var table = $('rules-table');
    var emptyEl = $('rules-empty');
    if (table) table.hidden = list.length === 0;
    if (emptyEl) {
      emptyEl.hidden = list.length > 0;
      if (ui.rules.err) emptyEl.textContent = 'Не удалось загрузить правила: ' + ui.rules.err;
      else if (q) emptyEl.textContent = 'Ничего не найдено по запросу «' + ui.rules.search + '»';
      else emptyEl.textContent = 'Правила не загружены — нажмите «Обновить» в верхней панели.';
    }

    var countEl = $('rules-count');
    if (countEl) countEl.textContent = ui.rules.list.length ? (q ? list.length + ' из ' + ui.rules.list.length : String(ui.rules.list.length)) : '';
    var meta = $('rules-meta');
    if (meta) {
      meta.textContent = ui.rules.err
        ? 'ошибка: ' + ui.rules.err
        : (ui.rules.at
          ? (LANG === 'en'
            ? 'rules: ' + ui.rules.list.length + ' · updated ' + fmtClock(ui.rules.at / 1000)
            : 'правил: ' + ui.rules.list.length + ' · обновлено ' + fmtClock(ui.rules.at / 1000))
          : (LANG === 'en' ? 'loading…' : 'загрузка…'));
      meta.style.color = ui.rules.err ? 'var(--bad)' : '';
    }
    if (wrap) wrap.scrollTop = keepScroll;
  }

  /* ------------------------------- ПОДПИСКА ------------------------------ */

  function providerCard(p) {
    var inf = providerStats(p);
    var b = expireBadge(inf.days);
    var card = el('article', { class: 'card' });

    card.appendChild(el('header', { class: 'card-h' }, [
      el('h2', { text: p.name }),
      el('span', { class: 'row' }, [
        p.vehicleType ? el('span', { class: 'badge muted', text: p.vehicleType }) : null,
        p.type ? el('span', { class: 'badge muted', text: p.type }) : null,
        el('span', { class: 'badge ' + b.cls, text: b.text })
      ])
    ]));

    var body = el('div', { class: 'card-b' });
    body.appendChild(el('div', { class: 'kv' }, [
      kvRow('Узлов', String(num(p.proxyCount))),
      kvRow('Истекает', inf.expire ? fmtTime(inf.expire) : '—', inf.expire ? 'unix ' + inf.expire : ''),
      kvRow(LANG === 'en' ? 'Left' : 'Осталось', inf.days === null
        ? (LANG === 'en' ? 'no expiry' : 'без срока')
        : (inf.days < 0
          ? (LANG === 'en' ? 'expired' : 'истекла')
          : inf.days + ' ' + (LANG === 'en' ? plural(inf.days, ['day', 'days', 'days']) : plural(inf.days, ['день', 'дня', 'дней'])))),
      kvRow(LANG === 'en' ? 'Downloaded' : 'Скачано', fmtBytes(inf.download), inf.download + ' Б'),
      kvRow(LANG === 'en' ? 'Uploaded' : 'Отдано', fmtBytes(inf.upload), inf.upload + ' Б'),
      kvRow(LANG === 'en' ? 'Limit' : 'Лимит', inf.unlimited
        ? (LANG === 'en' ? 'unlimited' : 'не ограничен')
        : fmtBytes(inf.total), inf.total + ' Б'),
      kvRow(LANG === 'en' ? 'Updated' : 'Обновлён', p.updatedAt ? fmtAgo(parseIsoSeconds(p.updatedAt)) : '—', p.updatedAt || ''),
      kvRow('Интервал', p.interval ? p.interval + ' с' : '—'),
      kvRow('URL проверки', p.testUrl || '—', p.testUrl || '')
    ]));

    if (!inf.unlimited && inf.total > 0) {
      var pct = Math.min(100, Math.round((inf.used / inf.total) * 100));
      body.appendChild(el('div', { class: 'bar ' + (pct > 90 ? 'bad' : pct > 70 ? 'warn' : '') }, [
        el('i', { style: 'width:' + pct + '%' })
      ]));
      body.appendChild(el('div', { class: 'hint', text: 'использовано ' + pct + '% · осталось ' + fmtBytes(Math.max(0, inf.total - inf.used)) }));
    } else if (inf.unlimited) {
      body.appendChild(el('div', { class: 'hint', text: 'Лимит трафика не задан провайдером.' }));
    }

    var btn = el('button', {
      type: 'button', class: 'btn small', text: 'Обновить',
      onclick: function () { updateProvider(p.name, btn); }
    });
    body.appendChild(buildSubUrlBlock(p));
    body.appendChild(el('div', { class: 'row' }, [btn]));
    card.appendChild(body);
    return card;
  }

  /* --------------------- ссылка подписки в config.yaml -------------------- */

  function validateSubUrl(v) {
    if (!v) return 'Ссылка пустая';
    if (!/^https?:\/\//i.test(v)) return 'Ссылка должна начинаться с http:// или https://';
    if (/[\s"'\\<>]/.test(v)) return 'В ссылке не должно быть пробелов, кавычек, обратных слэшей и < >';
    if (v.length > 4096) return 'Слишком длинная ссылка';
    return '';
  }

  function subProviderInfo(name) {
    var d = ui.sub.data;
    if (!d || !Array.isArray(d.providers)) return null;
    for (var i = 0; i < d.providers.length; i++) {
      if (String(d.providers[i].name).toLowerCase() === String(name).toLowerCase()) return d.providers[i];
    }
    return null;
  }

  async function loadSubscription(force) {
    if (ui.sub.loading) return;
    if (!force && ui.sub.at && Date.now() - ui.sub.at < 15000) return;
    ui.sub.loading = true;
    try {
      var res = await apiJson('/api/subscription', null, 8000);
      if (!res || typeof res !== 'object' || res.ok === false) {
        throw new ApiError((res && res.err) || 'демон не отдаёт /api/subscription', '/api/subscription', 'NoSub');
      }
      ui.sub.data = {
        configPath: res.configPath ? String(res.configPath) : '',
        providers: Array.isArray(res.providers) ? res.providers : []
      };
      ui.sub.err = '';
      ui.sub.at = Date.now();
    } catch (e) {
      ui.sub.err = friendlyError(e);
      ui.sub.data = null;
      ui.sub.at = 0;
    } finally {
      ui.sub.loading = false;
      if (ui.view === 'subscription') renderSubscription();
    }
  }

  function buildSubUrlBlock(p) {
    var info = subProviderInfo(p.name);
    var editing = ui.sub.edit === p.name;
    var box = el('div', { class: 'sub-url' + (editing ? ' editing' : '') });

    box.appendChild(el('div', { class: 'sub-url-top' }, [
      el('span', { class: 'sub-url-k', text: 'Ссылка подписки' }),
      el('span', {
        class: 'sub-url-src',
        text: info ? 'config.yaml' : (ui.sub.err ? 'недоступна' : '…'),
        title: ui.sub.err || (ui.sub.data && ui.sub.data.configPath) || ''
      })
    ]));

    if (editing) {
      var input = el('input', {
        class: 'input mono sub-url-input', type: 'url', value: info ? info.url : '',
        placeholder: 'https://…', spellcheck: 'false', autocomplete: 'off', inputmode: 'url'
      });
      var errEl = el('div', { class: 'sub-url-err', hidden: true });
      var saveBtn = el('button', { type: 'button', class: 'btn small primary', text: 'Сохранить' });
      var cancelBtn = el('button', { type: 'button', class: 'btn small ghost', text: 'Отмена' });
      var busy = false;

      function close() {
        ui.sub.edit = '';
        renderSubscription(true);
      }
      function showErr(text) {
        errEl.textContent = text;
        errEl.hidden = false;
      }
      function save() {
        if (busy) return;
        var v = input.value.trim();
        var bad = validateSubUrl(v);
        if (bad) { showErr(bad); try { input.focus(); } catch (e) { /* ignore */ } return; }
        busy = true;
        errEl.hidden = true;
        setBusy(saveBtn, true, 'Сохраняю…');
        cancelBtn.disabled = true;
        postJson('/api/subscription', { name: p.name, url: v }, 30000)
          .then(function (res) {
            if (!res || res.ok === false) {
              throw new ApiError((res && res.error) || 'демон не сохранил ссылку', '/api/subscription', 'SubSave');
            }
            ui.sub.edit = '';
            if (res.changed === false) {
              toast('Ссылка не изменилась', 'info', 2500);
            } else if (res.reloaded === false) {
              toast('Ссылка сохранена, но mihomo не перечитал конфиг: ' + (res.reloadErr || 'неизвестно') +
                '. Перезапустите ядро: xkeen -restart', 'warn', 12000);
            } else {
              toast('Ссылка подписки обновлена — mihomo перечитал config.yaml', 'ok', 6000);
              if (res.backup) {
                setTimeout(function () { toast('Копия старого конфига: ' + res.backup, 'info', 5000); }, 700);
              }
            }
            loadSubscription(true);
            setTimeout(function () { pollState(); }, 1500);
            renderSubscription(true);
          })
          .catch(function (e) {
            showErr('Не удалось сохранить: ' + friendlyError(e));
            setBusy(saveBtn, false, 'Сохранить');
            cancelBtn.disabled = false;
            busy = false;
          });
      }

      saveBtn.addEventListener('click', save);
      cancelBtn.addEventListener('click', close);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      box.appendChild(input);
      box.appendChild(errEl);
      box.appendChild(el('div', { class: 'sub-url-actions' }, [saveBtn, cancelBtn]));
      if (!info) {
        box.appendChild(el('div', { class: 'sub-url-note', text: ui.sub.err
          ? 'Демон не отдал текущую ссылку (' + ui.sub.err + '). Можно вписать новую.'
          : 'Текущая ссылка ещё не получена от демона.' }));
      }
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 0);
    } else {
      var val = info && info.url ? String(info.url) : '';
      box.appendChild(el('div', { class: 'sub-url-val mono', text: val || '—', title: val }));
      var editBtn = el('button', { type: 'button', class: 'btn small ghost', text: 'Изменить' });
      editBtn.addEventListener('click', function () {
        ui.sub.edit = p.name;
        renderSubscription(true);
      });
      box.appendChild(el('div', { class: 'sub-url-actions' }, [editBtn]));
      if (!info && ui.sub.err) {
        box.appendChild(el('div', { class: 'sub-url-note', text: 'Текущую ссылку демон не отдал: ' + ui.sub.err }));
      }
    }
    return box;
  }

  function renderSubscription(force) {
    var list = $('sub-list');
    if (!list) return;
    // под открытым редактором не перерисовываем: пользователь вводит ссылку
    if (ui.sub.edit && !force) return;
    clear(list);
    var emptyEl = $('sub-empty');
    var st = ui.state;
    if (!st) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'Загрузка данных подписки…'; }
      return;
    }
    var providers = (st.providers || []).filter(function (p) { return p && p.name; });
    if (!providers.length) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'Провайдеры подписок не найдены в состоянии демона.'; }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    providers.forEach(function (p) { list.appendChild(providerCard(p)); });
  }

  async function updateProvider(name, btn) {
    setBusy(btn, true, 'Обновляю…');
    try {
      await postJson('/api/providers/update', { name: name }, 60000);
      toast('Подписка «' + name + '» обновляется', 'ok', 3500);
      setTimeout(function () { pollState(); }, 1500);
    } catch (e) {
      toast('Не удалось обновить «' + name + '»: ' + friendlyError(e), 'bad');
    } finally {
      setBusy(btn, false, 'Обновить');
    }
  }

  async function refreshSubscriptions(btn) {
    var st = ui.state;
    var providers = (st && st.providers ? st.providers : []).filter(function (p) { return p && p.name; });
    if (!providers.length) { toast('Провайдеры подписок не найдены', 'warn'); return; }
    setBusy(btn, true);
    var ok = 0, errors = 0;
    for (var i = 0; i < providers.length; i++) {
      try {
        await postJson('/api/providers/update', { name: providers[i].name }, 60000);
        ok++;
      } catch (e) {
        errors++;
      }
    }
    setBusy(btn, false);
    if (ok) {
      toast('Обновление запущено: ' + ok + ' ' + plural(ok, ['провайдер', 'провайдера', 'провайдеров']), 'ok');
      setTimeout(function () { pollState(); }, 1500);
    }
    if (errors) toast('Не удалось обновить провайдеров: ' + errors, 'bad');
  }

  /* -------------------------------- ЖУРНАЛ -------------------------------- */

  // Поиск по журналу: обычная подстрока или регулярное выражение (кнопка «.*»).
  function jrnPattern() {
    var q = String(ui.journal.q || '');
    if (!q) return null;
    if (!ui.journal.regex) {
      var needle = q.toLowerCase();
      return { test: function (s) { return String(s).toLowerCase().indexOf(needle) >= 0; }, bad: false };
    }
    var rx;
    try {
      rx = new RegExp(q, 'i');
    } catch (e) {
      return { test: function () { return true; }, bad: true };
    }
    return { test: function (s) { return rx.test(String(s)); }, bad: false };
  }

  function jrnNotFound() {
    return LANG === 'en'
      ? 'Nothing matches “' + ui.journal.q + '”'
      : 'Ничего не найдено по запросу «' + ui.journal.q + '»';
  }

  function setJournalQuery(q) {
    ui.journal.q = String(q || '');
    var box = $('jrn-search-box');
    var pat = jrnPattern();
    if (box) box.classList.toggle('bad', !!(pat && pat.bad));
    var clearBtn = $('btn-jrn-q-clear');
    if (clearBtn) clearBtn.hidden = !ui.journal.q;
    if (ui.journal.tab === 'logs') renderLogsList();
    else renderEvents();
  }

  function updateJournalTabs() {
    var tabs = $('jrn-tabs');
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll('[data-tab]'), function (b) {
        b.classList.toggle('active', b.dataset.tab === ui.journal.tab);
        b.setAttribute('aria-selected', b.dataset.tab === ui.journal.tab ? 'true' : 'false');
      });
    }
    var evPane = $('jrn-events-pane');
    var lgPane = $('jrn-logs-pane');
    if (evPane) evPane.hidden = ui.journal.tab !== 'events';
    if (lgPane) lgPane.hidden = ui.journal.tab !== 'logs';
    var filters = $('ev-filters');
    if (filters) filters.hidden = ui.journal.tab !== 'events';
  }

  function renderJournal() {
    updateJournalTabs();
    if (ui.journal.tab === 'events') {
      renderEvents();
      stopLogStream();
    } else {
      var list = $('log-list');
      if (list && !list.querySelector('.log-line')) renderLogsList();
      if (ui.view === 'journal' && !document.hidden) startLogStream();
    }
  }

  function matchEvent(ev, filter) {
    var kind = String(ev.kind || '').toLowerCase();
    var text = String(ev.text || '');
    if (filter === 'fail') {
      return kind === 'bad' || kind === 'warn' || /сбо|ошиб|недоступ|не отвеч|dead|fail|timeout|таймаут/i.test(text);
    }    if (filter === 'switch') {
      return /переключ|выбран|выбира|select|switch|лучш|fallback/i.test(text + ' ' + kind);
    }
    return true;
  }

  function renderEvents() {
    var box = $('ev-list');
    if (!box) return;
    var st = ui.state;
    var allEvents = st && Array.isArray(st.events) ? st.events : [];
    var filter = ui.journal.filter;
    var pat = jrnPattern();
    var events = allEvents.slice().sort(function (a, b) { return num(b && b.t) - num(a && a.t); });
    var filtered = events.filter(function (ev) {
      if (!ev || !matchEvent(ev, filter)) return false;
      if (!pat) return true;
      return pat.test(String(ev.text || '') + ' ' + String(ev.kind || '') + ' ' + String(ev.group || ''));
    });

    var firstT = events.length ? num(events[0] && events[0].t) : 0;
    var lastT = events.length ? num(events[events.length - 1] && events[events.length - 1].t) : 0;
    var sig = allEvents.length + '|' + firstT + '|' + lastT + '|' + filter + '|' + (st ? 1 : 0) + '|' + LANG +
      '|' + ui.journal.q + '|' + (ui.journal.regex ? 1 : 0) +
      '|' + (ui.drawer.open && ui.drawer.kind === 'event' ? ui.drawer.key : '');
    if (sig === eventsSig && box.childNodes.length) return;
    eventsSig = sig;

    var keepScroll = box.scrollTop;
    clear(box);
    filtered.slice(0, 300).forEach(function (ev, i) {
      var kind = String(ev.kind || 'info').toLowerCase();
      if (['info', 'ok', 'warn', 'bad'].indexOf(kind) < 0) kind = 'info';
      var key = num(ev.t) + '|' + String(ev.text || '');
      var selected = ui.drawer.open && ui.drawer.kind === 'event' && ui.drawer.key === key;
      var sub = [
        el('span', { class: 'jrn-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'jrn-chip ' + kind, text: kind })
      ];
      if (ev.group) sub.push(el('span', { class: 'jrn-chip grp', text: ev.group }));
      sub.push(el('span', { class: 'jrn-t', text: fmtClock(ev.t), title: fmtTime(ev.t) }));
      sub.push(el('span', { class: 'jrn-dot-sep', 'aria-hidden': 'true', text: '·' }));
      sub.push(el('span', { class: 'jrn-ago', text: fmtAgo(ev.t) }));
      var row = el('div', {
        class: 'jrn-row ev ' + kind + (selected ? ' selected' : ''),
        role: 'button',
        tabindex: '0',
        'aria-label': 'Подробности события: ' + trim(ev.text || '', 60),
        title: 'Нажмите, чтобы открыть подробности',
        dataset: { key: key }
      }, [
        el('div', { class: 'jrn-main' }, [
          el('span', { class: 'jrn-i', text: String(i + 1) }),
          el('span', { class: 'jrn-k', text: t('Событие') }),
          el('span', { class: 'jrn-sep', text: ':' }),
          el('span', { class: 'jrn-v', text: ev.text || '' }),
          el('span', { class: 'jrn-go', text: '›', 'aria-hidden': 'true' })
        ]),
        el('div', { class: 'jrn-sub' }, sub)
      ]);
      row.addEventListener('click', function () { openDrawer('event', key, ev); });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openDrawer('event', key, ev);
        }
      });
      box.appendChild(row);
    });
    box.scrollTop = keepScroll;

    var cnt = $('ev-count');
    if (cnt) {
      var total = events.length;
      cnt.textContent = total ? (filtered.length === total ? String(total) : filtered.length + '/' + total) : '';
    }

    var emptyEl = $('ev-empty');
    if (emptyEl) {
      emptyEl.hidden = filtered.length > 0;
      if (!st) emptyEl.textContent = 'Нет данных: демон недоступен.';
      else if (!events.length) emptyEl.textContent = 'Событий пока нет.';
      else if (!filtered.length) emptyEl.textContent = pat && pat.bad ? 'Неверное регулярное выражение.' : jrnNotFound();
    }

    var filters = $('ev-filters');
    if (filters) {
      Array.prototype.forEach.call(filters.querySelectorAll('[data-filter]'), function (b) {
        b.classList.toggle('active', b.dataset.filter === filter);
      });
    }
  }

  function renderLogsList() {
    var list = $('log-list');
    if (!list) return;
    clear(list);
    var pat = jrnPattern();
    var items = ui.journal.logs.slice(-500);
    var shown = 0;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      if (pat && !pat.test(items[i].text)) continue;
      frag.appendChild(logLineEl(items[i]));
      shown++;
    }
    if (shown) list.appendChild(frag);
    else if (items.length) {
      list.appendChild(el('div', {
        class: 'jrn-empty',
        text: pat && pat.bad ? 'Неверное регулярное выражение.' : jrnNotFound()
      }));
    } else {
      list.appendChild(el('div', { class: 'jrn-empty', text: 'Логи пока не получены.' }));
    }
    list.scrollTop = list.scrollHeight;
    setLogCount();
  }

  function setLogCount() {
    var cnt = $('log-count');
    if (!cnt) return;
    var list = $('log-list');
    var shown = list ? list.querySelectorAll('.log-line').length : 0;
    var all = ui.journal.logs.length;
    cnt.textContent = all ? (shown === all ? String(all) : shown + '/' + all) : '';
  }

  function setJournalTab(tab) {
    ui.journal.tab = tab === 'logs' ? 'logs' : 'events';
    updateJournalTabs();
    if (ui.journal.tab === 'logs') {
      renderLogsList();
      if (ui.view === 'journal' && !document.hidden) startLogStream();
    } else {
      stopLogStream();
      renderEvents();
    }
  }

  /* ------------------------------ ОБНОВЛЕНИЯ ----------------------------- */

  function normVerPart(v) {
    var o = v && typeof v === 'object' ? v : {};
    var current = o.current !== undefined && o.current !== null ? String(o.current) : '';
    var latest = o.latest !== undefined && o.latest !== null ? String(o.latest) : '';
    var upd = o.updateAvailable;
    if (upd === undefined || upd === null) upd = !!(current && latest && current !== latest);
    return { current: current, latest: latest, updateAvailable: !!upd };
  }

  function setVerItem(kind, part) {
    var cur = $('upd-' + kind + '-cur');
    var lat = $('upd-' + kind + '-latest');
    var badge = $('upd-' + kind + '-badge');
    if (cur) {
      cur.textContent = part.current || '—';
      cur.title = part.current ? 'Текущая версия: ' + part.current : 'Текущая версия неизвестна';
    }
    if (lat) {
      lat.textContent = part.latest || (ui.ver.err ? 'неизвестно' : '—');
      lat.className = 'upd-latest' + (part.updateAvailable ? ' new' : '');
      if (part.latest) lat.title = 'Последняя доступная версия: ' + part.latest;
    }
    if (badge) {
      if (!part.current && !part.latest) setBadge(badge, 'muted', 'нет данных');
      else if (!part.latest) setBadge(badge, 'muted', 'последняя неизвестна');
      else if (part.updateAvailable) setBadge(badge, 'warn', 'обновление доступно');
      else setBadge(badge, 'ok', 'обновлений нет');
    }
  }

  function renderUpdates() {
    var data = ui.ver.data;
    var x = data && data.xrock ? data.xrock : { current: '', latest: '', updateAvailable: false };
    var m = data && data.mihomo ? data.mihomo : { current: '', latest: '', updateAvailable: false };
    setVerItem('xrock', x);
    setVerItem('mihomo', m);

    var badge = $('upd-badge');
    if (badge) {
      if (ui.ver.loading) setBadge(badge, 'muted', 'проверяю…');
      else if (ui.ver.err && !data) setBadge(badge, 'warn', 'нет данных');
      else if (x.updateAvailable || m.updateAvailable) setBadge(badge, 'warn', 'есть обновления');
      else if (!x.latest && !m.latest) setBadge(badge, 'muted', data ? 'обновления неизвестны' : 'нет данных');
      else setBadge(badge, 'ok', 'актуально');
    }

    var status = $('upd-status');
    if (status) {
      if (ui.ver.err) status.textContent = 'версии недоступны: ' + ui.ver.err;
      else if (data && !x.latest && !m.latest) {
        status.textContent = 'последние версии не получены' +
          (data.checkedAt ? ' · проверено ' + fmtAgo(data.checkedAt) : '') +
          ' — проверьте связь роутера с GitHub';
      } else if (data && data.checkedAt) status.textContent = 'проверено ' + fmtAgo(data.checkedAt);
      else status.textContent = '';
    }
    setUpdButtons();
  }

  async function loadVersions(force) {
    if (ui.ver.loading) return;
    if (!force && ui.ver.data && (Date.now() - ui.ver.at) < 60000) {
      renderUpdates();
      return;
    }
    ui.ver.loading = true;
    ui.ver.triedAt = Date.now();
    renderUpdates();
    try {
      var raw = await apiJson('/api/versions', null, 20000);
      if (!raw || typeof raw !== 'object' || (!raw.xrock && !raw.mihomo)) {
        throw new ApiError('демон не отдаёт /api/versions', '/api/versions', 'NoVersions');
      }
      ui.ver.data = {
        xrock: normVerPart(raw.xrock),
        mihomo: normVerPart(raw.mihomo),
        checkedAt: num(pick(raw, ['checkedAt'])) || 0
      };
      ui.ver.err = '';
      ui.ver.at = Date.now();
    } catch (e) {
      ui.ver.err = friendlyError(e);
      // Фолбэк: текущие версии есть в /api/state, последние — неизвестны.
      var st = ui.state;
      ui.ver.data = {
        xrock: { current: st && st.version ? String(st.version) : '', latest: '', updateAvailable: false },
        mihomo: { current: st && st.mihomo && st.mihomo.version ? String(st.mihomo.version) : '', latest: '', updateAvailable: false },
        checkedAt: 0
      };
      if (force) toast('Версии недоступны: ' + ui.ver.err, 'bad');
    } finally {
      ui.ver.loading = false;
      renderUpdates();
    }
  }

  function setUpdProgress(text) {
    var box = $('upd-progress');
    var txt = $('upd-progress-text');
    if (!box) return;
    if (text === null) {
      box.hidden = true;
      if (txt) txt.textContent = '…';
      return;
    }
    box.hidden = false;
    if (txt) txt.textContent = text;
  }

  function setUpdSpinning(on) {
    var box = $('upd-progress');
    var sp = box ? box.querySelector('.spinner') : null;
    if (sp) sp.hidden = !on;
  }

  function showUpdLog(lines, isError) {
    var pre = $('upd-log');
    if (!pre) return;
    var arr = Array.isArray(lines) ? lines : [];
    var text = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === null || arr[i] === undefined) continue;
      var s = stripAnsi(String(arr[i])).replace(/\s+$/, '');
      if (s) text.push(s);
    }
    pre.textContent = text.join('\n');
    pre.hidden = !text.length;
    pre.className = 'upd-log' + (isError ? ' error' : '');
    pre.scrollTop = pre.scrollHeight;
  }

  function startUpdTimer(prefix, note) {
    stopUpdTimer();
    setUpdSpinning(true);
    ui.upd.startedAt = Date.now();
    function tick() {
      var secs = Math.floor((Date.now() - ui.upd.startedAt) / 1000);
      setUpdProgress(prefix + ' ' + secs + ' с' + (note ? ' · ' + note : ''));
    }
    tick();
    ui.upd.timer = setInterval(tick, 1000);
  }

  function stopUpdTimer() {
    if (ui.upd.timer) { clearInterval(ui.upd.timer); ui.upd.timer = null; }
  }

  function setUpdButtons() {
    var running = ui.upd.running;
    ['btn-upd-core', 'btn-upd-panel', 'btn-upd-check'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = running;
    });
  }

  function upgradeError(r) {
    var d = r && r.data;
    if (d && typeof d === 'object' && d.error) return String(d.error);
    if (replyIsHtml(r)) return 'демон не поддерживает обновление — нужен xrock с /api/upgrade';
    if (r && r.text) return 'HTTP ' + r.status + ' — ' + trim(r.text, 200);
    return 'неизвестная ошибка';
  }

  function replyIsHtml(r) {
    return !!(r && !r.data && /^\s*<!doctype html/i.test(r.text || ''));
  }

  // Строки для лога обновления: HTML-фолбэк SPA показывать не нужно.
  function upgradeLogLines(r, d) {
    var lines = d && Array.isArray(d.log) ? d.log.slice() : [];
    var hasData = !!(d && typeof d === 'object' && Object.keys(d).length);
    if (replyIsHtml(r)) lines.push('демон вернул HTML вместо JSON — вероятно, это старая версия xrock без /api/upgrade');
    else if (!lines.length && r && r.text && !hasData) lines.push(r.text);
    if (d && d.error) lines.push('Ошибка: ' + d.error);
    return lines;
  }

  // Успех обновления — только валидный JSON с ok !== false. Старый демон отвечает
  // на неизвестный путь index.html (200), это не успех.
  function upgradeReplyOK(r) {
    return !!(r && r.ok && r.data && typeof r.data === 'object' && r.data.ok !== false);
  }

  async function waitDaemonUp() {
    var deadline = Date.now() + PANEL_WAIT_MS;
    // даём демону реально уйти на перезапуск, иначе первый ping ответит старым процессом
    await sleep(2500);
    while (Date.now() < deadline) {
      try {
        var r = await apiFull('/api/ping', null, 4000);
        if (r.ok && (!r.data || r.data.ok !== false)) return true;
      } catch (e) {
        // демон ещё перезапускается
      }
      await sleep(2000);
    }
    return false;
  }

  async function upgradeCore() {
    if (ui.upd.running) return;
    var ok = await confirmDialog({
      title: 'Обновить ядро mihomo?',
      text: 'Демон скачает актуальную версию mihomo и перезапустит ядро. VPN перезапустится на 10–20 секунд: активные соединения прервутся.',
      okLabel: 'Обновить ядро'
    });
    if (!ok) return;

    ui.upd.running = true;
    ui.upd.kind = 'core';
    setUpdButtons();
    showUpdLog([], false);
    startUpdTimer('обновляю ядро mihomo…', 'может занять до 3 минут');
    try {
      var r = await apiFull('/api/upgrade/core', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: '{}'
      }, UPGRADE_TIMEOUT);
      var d = r.data && typeof r.data === 'object' ? r.data : {};
      var lines = Array.isArray(d.log) ? d.log : [];
      if (!upgradeReplyOK(r)) {
        setUpdProgress('ошибка обновления ядра: ' + upgradeError(r));
        showUpdLog(upgradeLogLines(r, d), true);
        toast('Ядро не обновлено: ' + upgradeError(r), 'bad', 9000);
        return;
      }
      showUpdLog(lines, false);
      var msg = (d.before && d.after)
        ? (d.before !== d.after ? 'mihomo ' + d.before + ' → ' + d.after : 'mihomo уже ' + d.after)
        : 'ядро обновлено';
      toast(msg, 'ok', 6000);
      setUpdProgress('готово · ' + msg);
      await pollState();
      await loadVersions(true);
    } catch (e) {
      var err = friendlyError(e);
      showUpdLog([err], true);
      setUpdProgress('ошибка: ' + err);
      toast('Не удалось обновить ядро: ' + err, 'bad', 9000);
    } finally {
      stopUpdTimer();
      setUpdSpinning(false);
      ui.upd.running = false;
      ui.upd.kind = '';
      setUpdButtons();
      renderUpdates();
    }
  }

  async function upgradePanel() {
    if (ui.upd.running) return;
    var ok = await confirmDialog({
      title: 'Обновить панель xrock?',
      text: 'Демон скачает последний релиз, заменит бинарник и интерфейс и перезапустит сервис. Панель будет недоступна 5–20 секунд, затем страница обновится сама.',
      okLabel: 'Обновить панель'
    });
    if (!ok) return;

    ui.upd.running = true;
    ui.upd.kind = 'panel';
    setUpdButtons();
    showUpdLog([], false);
    startUpdTimer('обновляю панель xrock…', 'ждём ответа демона');
    try {
      var r = await apiFull('/api/upgrade/panel', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: '{}'
      }, 90000);
      var d = r.data && typeof r.data === 'object' ? r.data : {};
      if (!upgradeReplyOK(r)) {
        setUpdProgress('ошибка обновления панели: ' + upgradeError(r));
        showUpdLog(upgradeLogLines(r, d), true);
        toast('Панель не обновлена: ' + upgradeError(r), 'bad', 9000);
        return;
      }
      var msg = (d.before && d.after) ? 'xrock ' + d.before + ' → ' + d.after : 'панель обновлена';
      var noOp = !!(d.before && d.after && d.before === d.after) || d.restarting === false;
      if (noOp) {
        showUpdLog([msg, 'перезапуск не требуется — установлена последняя версия'], false);
        setUpdProgress('готово · ' + msg);
        toast('Панель уже актуальна: ' + (d.after || ''), 'ok', 6000);
        await loadVersions(false);
        return;
      }
      showUpdLog([msg, 'демон перезапускается, ждём /api/ping…'], false);
      startUpdTimer('панель перезапускается…', 'ждём до 60 с');
      var alive = await waitDaemonUp();
      if (!alive) {
        setUpdProgress('демон не ответил за 60 с — обновите страницу вручную');
        toast('Панель не ответила за 60 секунд. Обновите страницу вручную.', 'warn', 9000);
        return;
      }
      setUpdProgress('демон отвечает — перезагружаю страницу…');
      toast('Панель обновлена — перезагружаю страницу', 'ok', 3000);
      setTimeout(function () { location.reload(); }, 500);
    } catch (e) {
      var err2 = friendlyError(e);
      showUpdLog([err2], true);
      setUpdProgress('ошибка: ' + err2);
      toast('Не удалось обновить панель: ' + err2, 'bad', 9000);
    } finally {
      stopUpdTimer();
      setUpdSpinning(false);
      ui.upd.running = false;
      ui.upd.kind = '';
      setUpdButtons();
      renderUpdates();
    }
  }

  /* ------------------------------- НАСТРОЙКИ ----------------------------- */

  function initSettings() {
    var input = $('set-api');
    var def = $('set-api-default');
    var saved = readSavedApi();
    if (def) def.textContent = defaultBase();
    if (input && !ui.settings.inited) input.value = saved ? normBase(saved) : '';
    ui.settings.inited = true;
    renderThemeCards();
    renderThemeBadge();
    renderSettingsStatus();
    fillGroupSelect();
    fillWatchdogForm();
  }

  function renderSettingsStatus() {
    var status = $('set-api-status');
    if (status) {
      var saved = readSavedApi();
      status.textContent = 'Сейчас используется: ' + ui.api + (saved ? ' · сохранено в localStorage' : ' · по умолчанию');
    }
    var badge = $('wd-badge-settings');
    var wd = ui.state && ui.state.watchdog;
    if (badge) {
      if (!wd) setBadge(badge, 'muted', '—');
      else setBadge(badge, wd.enabled ? 'ok' : 'muted', wd.enabled ? 'включён' : 'выключен');
    }
    var wdStatus = $('wd-status');
    if (wdStatus && ui.settings.dirty) {
      wdStatus.textContent = 'есть несохранённые изменения';
      wdStatus.style.color = 'var(--warn)';
    }
  }

  function fillGroupSelect(selected) {
    var sel = $('wd-group');
    if (!sel) return;
    var st = ui.state;
    var names = st ? st.groups.map(function (g) { return g && g.name; }).filter(Boolean) : [];
    var sig = names.join('\u0000');
    var cur = selected || sel.value;
    if (sig === wdGroupsSig && sel.options.length) {
      if (cur && names.indexOf(cur) >= 0) sel.value = cur;
      return;
    }
    wdGroupsSig = sig;
    clear(sel);
    if (!names.length) {
      sel.appendChild(el('option', { value: '', text: '— нет групп —' }));
      return;
    }
    names.forEach(function (n) { sel.appendChild(el('option', { value: n, text: n })); });
    if (cur && names.indexOf(cur) >= 0) sel.value = cur;
    else sel.value = names[0];
  }

  function fillWatchdogForm(force) {
    var st = ui.state;
    if (!st) return;
    var wd = st.watchdog || {};
    if (ui.settings.dirty && !force) { renderSettingsStatus(); return; }
    renderWdSwitch(!!wd.enabled);
    var iv = $('wd-interval');
    if (iv) iv.value = wd.intervalSec !== undefined && wd.intervalSec !== null ? String(wd.intervalSec) : '';
    var fs = $('wd-fails');
    if (fs) fs.value = wd.failsToSwitch !== undefined && wd.failsToSwitch !== null ? String(wd.failsToSwitch) : '';
    fillGroupSelect(wd.group);
    var sig = JSON.stringify(wd.targets || []);
    if (force || sig !== wdTargetsSig) {
      renderTargets(wd.targets);
      wdTargetsSig = sig;
    }
    var badge = $('wd-badge-settings');
    if (badge) setBadge(badge, wd.enabled ? 'ok' : 'muted', wd.enabled ? 'включён' : 'выключен');
  }

  function renderTargets(targets) {
    var box = $('wd-targets');
    if (!box) return;
    clear(box);
    var list = Array.isArray(targets) ? targets.slice() : [];
    if (!list.length) list.push({ name: 'YouTube', url: 'https://www.youtube.com/generate_204' });
    list.forEach(function (t) {
      box.appendChild(buildTargetRow(t && t.name ? t.name : '', t && t.url ? t.url : ''));
    });
  }

  function buildTargetRow(name, url) {
    var nameInput = el('input', {
      class: 'input t-name', type: 'text', value: name,
      placeholder: 'Имя (YouTube)', autocomplete: 'off', spellcheck: 'false'
    });
    var urlInput = el('input', {
      class: 'input mono t-url', type: 'url', value: url,
      placeholder: 'https://…/generate_204', inputmode: 'url', autocomplete: 'off', spellcheck: 'false'
    });
    var del = el('button', { type: 'button', class: 'btn small danger t-del', title: 'Удалить цель', text: '✕' });
    var row = el('div', { class: 'target-row' }, [nameInput, urlInput, del]);
    nameInput.addEventListener('input', markWdDirty);
    urlInput.addEventListener('input', markWdDirty);
    del.addEventListener('click', function () {
      if (row.parentNode) row.parentNode.removeChild(row);
      markWdDirty();
    });
    return row;
  }

  function markWdDirty() {
    ui.settings.dirty = true;
    ui.settings.targetsDirty = true;
    var wdStatus = $('wd-status');
    if (wdStatus) {
      wdStatus.textContent = 'есть несохранённые изменения';
      wdStatus.style.color = 'var(--warn)';
    }
  }

  function collectWatchdog() {
    var enabled = !!(ui.state && ui.state.watchdog && ui.state.watchdog.enabled);
    var intervalSec = parseInt($('wd-interval') ? $('wd-interval').value : '', 10);
    var fails = parseInt($('wd-fails') ? $('wd-fails').value : '', 10);
    if (!isFinite(intervalSec) || intervalSec < 3) {
      toast('Интервал проверки: целое число не меньше 3 секунд', 'bad');
      return null;
    }
    if (!isFinite(fails) || fails < 1) {
      toast('Сбоев до переключения: целое число не меньше 1', 'bad');
      return null;
    }
    var group = $('wd-group') ? $('wd-group').value : '';
    if (!group) {
      toast('Не выбрана группа для сторожа', 'bad');
      return null;
    }
    var rows = $('wd-targets') ? $('wd-targets').querySelectorAll('.target-row') : [];
    var targets = [];
    for (var i = 0; i < rows.length; i++) {
      var nameEl = rows[i].querySelector('.t-name');
      var urlEl = rows[i].querySelector('.t-url');
      var name = nameEl ? nameEl.value.trim() : '';
      var url = urlEl ? urlEl.value.trim() : '';
      if (!name && !url) continue;
      if (!url) { toast('У цели «' + (name || '—') + '» не задан URL', 'bad'); return null; }
      if (!/^https?:\/\/\S+$/i.test(url)) {
        toast('URL цели должен начинаться с http:// или https://', 'bad');
        return null;
      }
      targets.push({ name: name || url, url: url });
    }
    if (!targets.length) {
      toast('Добавьте хотя бы одну цель проверки', 'bad');
      return null;
    }
    return { enabled: enabled, group: group, intervalSec: intervalSec, failsToSwitch: fails, targets: targets };
  }

  async function saveWatchdog() {
    var payload = collectWatchdog();
    if (!payload) return;
    var btn = $('btn-wd-save');
    setBusy(btn, true, 'Сохраняю…');
    try {
      await postJson('/api/watch', payload, 15000);
      ui.settings.dirty = false;
      ui.settings.targetsDirty = false;
      var status = $('wd-status');
      if (status) {
        status.style.color = 'var(--ok)';
        status.textContent = 'сохранено в ' + new Date().toLocaleTimeString('ru-RU');
      }
      toast('Настройки сторожа сохранены', 'ok');
      await pollState();
    } catch (e) {
      toast('Не удалось сохранить настройки сторожа: ' + friendlyError(e), 'bad');
    } finally {
      setBusy(btn, false, 'Сохранить');
    }
  }

  function resetForApiChange() {
    stopTrafficStream();
    stopLogStream();
    stopSysPoll();
    stopUpdTimer();
    setUpdSpinning(false);
    ui.state = null;
    ui.seen = false;
    ui.link = { ok: false, err: '', fails: 0, version: '' };
    ui.conns.list = [];
    ui.conns.at = 0;
    ui.conns.lastTry = 0;
    ui.conns.up = 0;
    ui.conns.down = 0;
    ui.conns.err = '';
    ui.conns.device = '';
    ui.conns.sort = { key: 'time', dir: 'desc' };
    devSig = '';
    devCountsSig = '';
    ui.rules.list = [];
    ui.rules.at = 0;
    ui.rules.err = '';
    ui.traffic = { up: 0, down: 0, at: 0, histD: [], histU: [] };
    delay.map = Object.create(null);
    delay.testing = Object.create(null);
    delay.running = false;
    delay.lastAuto = 0;
    ui.servers.autoTested = false;
    ui.servers.group = '';
    ui.sys = { data: null, at: 0, triedAt: 0, loading: false, err: '' };
    ui.ver = { data: null, at: 0, triedAt: 0, loading: false, err: '' };
    ui.sub = { at: 0, loading: false, err: '', data: null, edit: '' };
    ui.upd = { kind: '', running: false, startedAt: 0, timer: null };
    ui.pendingSelect = Object.create(null);
    ui.journal.logs = [];
    var logList = $('log-list');
    if (logList) clear(logList);
    setLogCount();
    eventsSig = '';
    serversSig = null;
    showUpdLog([], false);
    setUpdProgress(null);
    hideBanner();
    renderTopbar();
    renderActive();
    renderSpeedCard();
    renderUpdates();
    if (!document.hidden) startTrafficStream();
    if (ui.view === 'connections') loadConnections();
    if (ui.view === 'rules') loadRules();
    if (ui.view === 'overview') startSysPoll();
  }

  function applyApi() {
    var input = $('set-api');
    var raw = input ? input.value.trim() : '';
    var norm = normBase(raw);
    if (raw) {
      try { new URL(norm); } catch (e) { toast('Некорректный адрес: ' + raw, 'bad'); return; }
    }
    saveApi(norm);
    if (input) input.value = norm;
    ui.api = norm || defaultBase();
    resetForApiChange();
    renderSettingsStatus();
    toast('Адрес демона: ' + ui.api, 'ok', 3500);
    pollState(true);
  }

  function resetApi() {
    saveApi('');
    var input = $('set-api');
    if (input) input.value = '';
    ui.api = defaultBase();
    resetForApiChange();
    renderSettingsStatus();
    toast('Адрес сброшен: ' + ui.api, 'ok', 3500);
    pollState(true);
  }

  async function testDaemon() {
    var input = $('set-api');
    var typed = input ? normBase(input.value.trim()) : '';
    if (typed && typed !== ui.api) {
      toast('Сначала нажмите «Применить» — проверяется адрес ' + ui.api, 'warn');
      return;
    }
    var btn = $('btn-api-test');
    setBusy(btn, true, 'Проверяю…');
    try {
      var res = await apiJson('/api/ping', null, 6000);
      var status = $('set-api-status');
      if (status) status.textContent = 'Связь есть: демон ' + ((res && res.version) || '?') + ' · ' + ui.api;
      toast('Демон ответил: ' + ui.api, 'ok');
    } catch (e) {
      var st = $('set-api-status');
      if (st) st.textContent = 'Нет связи: ' + friendlyError(e);
      toast('Нет связи: ' + friendlyError(e), 'bad');
    } finally {
      setBusy(btn, false, 'Проверить связь');
    }
  }

  /* --------------------------- действия обзора --------------------------- */

  async function switchToBest() {
    var st = ui.state;
    if (!st) { toast('Нет данных о группах — дождитесь ответа демона', 'warn'); return; }
    if (delay.running) { toast('Проверка задержки уже идёт', 'warn'); return; }
    var wd = st.watchdog || {};
    var groupName = wd.group || (st.groups[0] && st.groups[0].name) || '';
    var group = groupName ? groupByName(groupName) : null;
    if (!group) { toast('Группа для переключения не найдена', 'bad'); return; }
    var nodes = groupNodes(group);
    if (!nodes.length) { toast('В группе «' + group.name + '» нет узлов', 'warn'); return; }

    var btn = $('btn-best');
    setBusy(btn, true);
    try {
      await runTest(nodes, { silent: true });
      var best = null;
      nodes.forEach(function (n) {
        var d = delay.map[n];
        if (d && !d.err && (!best || d.delay < best.delay)) best = { name: n, delay: d.delay };
      });
      if (!best) { toast('Живых серверов не найдено — переключение отменено', 'bad'); return; }
      await postJson('/api/select', { group: group.name, name: best.name }, 15000);
      group.now = best.name;
      toast('Переключено на ' + nodeLabel(best.name) + ' (' + fmtDelay(best.delay) + ')', 'ok', 5000);
      pollState();
      if (ui.view === 'servers') renderServers();
    } catch (e) {
      toast('Не удалось переключить на лучший: ' + friendlyError(e), 'bad');
    } finally {
      setBusy(btn, false);
    }
  }

  async function refreshAll() {
    var btn = $('btn-refresh');
    if (btn) btn.classList.add('spinning');
    try {
      await pollState(true);
      if (ui.view === 'rules') await loadRules(true);
      if (ui.view === 'connections') await loadConnections(true);
      if (ui.seen) toast('Данные обновлены', 'ok', 1600);
    } finally {
      setTimeout(function () { if (btn) btn.classList.remove('spinning'); }, 500);
    }
  }

  /* ------------------------------ привязки ------------------------------- */

  function bindUi() {
    var nav = $('nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.nav-item') : null;
        if (btn && btn.dataset.view) activate(btn.dataset.view);
      });
    }

    var burger = $('burger');
    if (burger) burger.addEventListener('click', function () {
      var sb = $('sidebar');
      if (sb && sb.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
    var scrim = $('scrim');
    if (scrim) scrim.addEventListener('click', closeSidebar);

    var refreshBtn = $('btn-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshAll);

    var themeBtn = $('btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setThemeMenu(!themeMenuOpen());
    });
    var themeMenuNode = $('theme-menu');
    if (themeMenuNode) themeMenuNode.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function (e) {
      if (!themeMenuOpen()) return;
      if (e.target && e.target.closest && e.target.closest('.theme-wrap')) return;
      setThemeMenu(false);
    });

    var drawerCloseBtn = $('drawer-close');
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', function () { closeDrawer(); });
    var drawerScrimNode = $('drawer-scrim');
    if (drawerScrimNode) drawerScrimNode.addEventListener('click', function () { closeDrawer(); });

    var logListNode = $('log-list');
    if (logListNode) {
      logListNode.addEventListener('click', function (e) {
        var line = e.target && e.target.closest ? e.target.closest('.log-line') : null;
        if (!line || !line.__log) return;
        var item = line.__log;
        openDrawer('log', String(item.t) + '|' + trim(item.text, 40), item);
      });
    }

    var bannerRetry = $('banner-retry');
    if (bannerRetry) bannerRetry.addEventListener('click', function () { pollState(true); });
    var bannerSettings = $('banner-settings');
    if (bannerSettings) bannerSettings.addEventListener('click', function () { activate('settings'); });

    var btnBest = $('btn-best');
    if (btnBest) btnBest.addEventListener('click', switchToBest);
    var btnTestAll = $('btn-test-all');
    if (btnTestAll) btnTestAll.addEventListener('click', function () { runTest(null); });
    var btnSubUpdate = $('btn-sub-update');
    if (btnSubUpdate) btnSubUpdate.addEventListener('click', function () { refreshSubscriptions(btnSubUpdate); });
    var btnProvidersUpdateAll = $('btn-providers-update-all');
    if (btnProvidersUpdateAll) btnProvidersUpdateAll.addEventListener('click', function () { refreshSubscriptions(btnProvidersUpdateAll); });

    var srvTabs = $('srv-tabs');
    if (srvTabs) {
      srvTabs.addEventListener('click', function (e) {
        var tab = e.target && e.target.closest ? e.target.closest('.gtab') : null;
        if (!tab || !tab.dataset.group) return;
        if (tab.dataset.group === ui.servers.group) return;
        ui.servers.group = tab.dataset.group;
        serversSig = null;
        renderServers();
        var act = srvTabs.querySelector('.gtab.active');
        if (act && typeof act.focus === 'function') act.focus();
      });
      srvTabs.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        var tabs = Array.prototype.slice.call(srvTabs.querySelectorAll('.gtab'));
        var idx = tabs.indexOf(document.activeElement);
        if (idx < 0) return;
        e.preventDefault();
        idx = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        tabs[idx].focus();
        tabs[idx].click();
      });
    }

    var srvSearch = $('srv-search');
    if (srvSearch) srvSearch.addEventListener('input', function () {
      ui.servers.search = srvSearch.value;
      serversSig = null;
      renderServers();
    });
    var srvTestAll = $('btn-srv-test-all');
    if (srvTestAll) srvTestAll.addEventListener('click', function () { runTest(null); });

    var connSearch = $('conn-search');
    if (connSearch) connSearch.addEventListener('input', function () {
      ui.conns.search = connSearch.value;
      renderConnections();
    });
    var connSortSel = $('conn-sort');
    if (connSortSel) connSortSel.addEventListener('change', function () {
      var parts = String(connSortSel.value || '').split(':');
      if (parts.length === 2) setConnSort(parts[0], parts[1] === 'asc' ? 'asc' : 'desc');
    });
    var connThead = document.querySelector('#conn-table thead');
    if (connThead) connThead.addEventListener('click', function (e) {
      var th = e.target && e.target.closest ? e.target.closest('th[data-sort]') : null;
      if (!th) return;
      setConnSort(th.getAttribute('data-sort'));
    });
    var connDevice = $('conn-device');
    if (connDevice) connDevice.addEventListener('change', function () {
      ui.conns.device = connDevice.value || '';
      renderConnections();
    });
    var closeAllBtn = $('btn-conn-close-all');
    if (closeAllBtn) closeAllBtn.addEventListener('click', closeAllConnections);

    var connWrap = $('conn-table-wrap');
    if (connWrap) {
      connWrap.addEventListener('mouseenter', function () {
        if (!canHover()) return;
        ui.conns.hover = true;
        renderConnMeta();
      });
      connWrap.addEventListener('mouseleave', function () {
        if (!ui.conns.hover) return;
        ui.conns.hover = false;
        renderConnMeta();
        if (ui.view === 'connections' && !document.hidden) loadConnections();
      });
    }

    var rulesSearch = $('rules-search');
    if (rulesSearch) rulesSearch.addEventListener('input', function () {
      ui.rules.search = rulesSearch.value;
      renderRules();
    });

    var jrnTabs = $('jrn-tabs');
    if (jrnTabs) jrnTabs.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
      if (b) setJournalTab(b.dataset.tab);
    });
    var evFilters = $('ev-filters');
    if (evFilters) evFilters.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-filter]') : null;
      if (!b) return;
      ui.journal.filter = b.dataset.filter;
      renderEvents();
    });
    var jrnQ = $('jrn-search');
    if (jrnQ) {
      jrnQ.value = ui.journal.q || '';
      jrnQ.addEventListener('input', function () { setJournalQuery(jrnQ.value); });
      jrnQ.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); jrnQ.value = ''; setJournalQuery(''); }
      });
    }
    var jrnRegexBtn = $('btn-jrn-regex');
    if (jrnRegexBtn) {
      jrnRegexBtn.classList.toggle('on', !!ui.journal.regex);
      jrnRegexBtn.setAttribute('aria-pressed', ui.journal.regex ? 'true' : 'false');
      jrnRegexBtn.addEventListener('click', function () {
        ui.journal.regex = !ui.journal.regex;
        jrnRegexBtn.classList.toggle('on', ui.journal.regex);
        jrnRegexBtn.setAttribute('aria-pressed', ui.journal.regex ? 'true' : 'false');
        setJournalQuery(ui.journal.q);
      });
    }
    var jrnQClear = $('btn-jrn-q-clear');
    if (jrnQClear) jrnQClear.addEventListener('click', function () {
      if (jrnQ) { jrnQ.value = ''; try { jrnQ.focus(); } catch (e) { /* ignore */ } }
      setJournalQuery('');
    });
    var logClear = $('btn-log-clear');
    if (logClear) logClear.addEventListener('click', function () {
      ui.journal.logs = [];
      var list = $('log-list');
      if (list) clear(list);
      setLogCount();
      setLogStatus('очищено · ' + (ui.journal.tab === 'logs' ? 'ожидание строк' : ''));
    });
    var logLevel = $('log-level');
    if (logLevel) logLevel.addEventListener('change', function () {
      ui.journal.logLevel = logLevel.value;
      if (ui.journal.tab === 'logs' && ui.view === 'journal') startLogStream();
    });
    var logAutoscroll = $('log-autoscroll');
    if (logAutoscroll) logAutoscroll.addEventListener('change', function () {
      ui.journal.autoscroll = !!logAutoscroll.checked;
    });

    var langBtn = $('btn-lang');
    if (langBtn) langBtn.addEventListener('click', function () { setLang(LANG === 'en' ? 'ru' : 'en'); });
    var curCheckBtn = $('btn-cur-check');
    if (curCheckBtn) curCheckBtn.addEventListener('click', function () {
      var i = $('cur-url');
      try { localStorage.setItem('xrock.checkUrl', i ? i.value : ''); } catch (e) {}
      checkUrlThrough();
    });
    var curUrl = $('cur-url');
    if (curUrl) {
      try { curUrl.value = localStorage.getItem('xrock.checkUrl') || ''; } catch (e) {}
      curUrl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (curCheckBtn) curCheckBtn.click(); }
      });
    }
    var setupBtn = $('btn-setup-connect');
    if (setupBtn) setupBtn.addEventListener('click', connectFromSetup);
    var setupSkip = $('btn-setup-skip');
    if (setupSkip) setupSkip.addEventListener('click', function () { closeSetup(true); });
    var setupInput = $('setup-url');
    if (setupInput) setupInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connectFromSetup(); }
    });
    var apiApply = $('btn-api-apply');
    if (apiApply) apiApply.addEventListener('click', applyApi);
    var apiReset = $('btn-api-reset');
    if (apiReset) apiReset.addEventListener('click', resetApi);
    var apiTest = $('btn-api-test');
    if (apiTest) apiTest.addEventListener('click', testDaemon);
    var apiInput = $('set-api');
    if (apiInput) apiInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applyApi(); }
    });

    var wdToggle = $('btn-wd-toggle');
    if (wdToggle) wdToggle.addEventListener('click', function () { setWatchdogEnabled(wdToggle.dataset.on !== '1'); });
    var wdQuick = $('wd-quick-toggle');
    if (wdQuick) wdQuick.addEventListener('click', function () {
      setWatchdogEnabled(!(ui.state && ui.state.watchdog && ui.state.watchdog.enabled));
    });
    var topTest = $('btn-top-test');
    if (topTest) topTest.addEventListener('click', function () { runTest(null); });

    ['wd-interval', 'wd-fails', 'wd-group'].forEach(function (id) {
      var node = $(id);
      if (node) node.addEventListener('change', markWdDirty);
      if (node && (node.type === 'number' || node.tagName === 'INPUT') && node.type !== 'checkbox') {
        node.addEventListener('input', markWdDirty);
      }
    });
    var wdTargets = $('wd-targets');
    if (wdTargets) wdTargets.addEventListener('input', markWdDirty);
    var wdAdd = $('btn-wd-add');
    if (wdAdd) wdAdd.addEventListener('click', function () {
      var box = $('wd-targets');
      if (!box) return;
      box.appendChild(buildTargetRow('', ''));
      markWdDirty();
      var rows = box.querySelectorAll('.target-row');
      var last = rows[rows.length - 1];
      var input = last ? last.querySelector('.t-name') : null;
      if (input) input.focus();
    });
    var wdSave = $('btn-wd-save');
    if (wdSave) wdSave.addEventListener('click', saveWatchdog);

    var updCore = $('btn-upd-core');
    if (updCore) updCore.addEventListener('click', upgradeCore);
    var updPanel = $('btn-upd-panel');
    if (updPanel) updPanel.addEventListener('click', upgradePanel);
    var updCheck = $('btn-upd-check');
    if (updCheck) updCheck.addEventListener('click', function () {
      setBusy(updCheck, true, 'Проверяю…');
      loadVersions(true).then(function () {
        setBusy(updCheck, false, 'Проверить версии');
      }, function () {
        setBusy(updCheck, false, 'Проверить версии');
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopTrafficStream();
        stopLogStream();
        stopSysPoll();
        return;
      }
      if (!streams.traffic && !document.hidden) startTrafficStream();
      if (!ui.link.ok) pollState();
      if (ui.view === 'connections') loadConnections();
      if (ui.view === 'journal' && ui.journal.tab === 'logs') startLogStream();
      if (ui.view === 'overview') startSysPoll();
    });

    window.addEventListener('online', function () { pollState(); });
    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace(/^#/, '');
      if (h && VIEWS.indexOf(h) >= 0 && h !== ui.view) activate(h);
    });

    document.addEventListener('keydown', function (e) {
      var modal = $('modal-root');
      if (modal && !modal.hidden) return;
      if (e.key === 'Escape') {
        if (themeMenuOpen()) { setThemeMenu(false); return; }
        if (ui.drawer.open) { closeDrawer(); return; }
        closeSidebar();
        return;
      }
      var t = e.target || {};
      var tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || t.isContentEditable) return;
      if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
        e.preventDefault();
        refreshAll();
      } else if (e.key === '/') {
        var s = document.querySelector('.view:not([hidden]) .input.search');
        if (s) { e.preventDefault(); s.focus(); }
      }
    });
  }

  /* --------------------------------- старт ------------------------------- */

  function init() {
    var saved = normBase(readSavedApi());
    // с https-страницы http-адрес демона браузер всё равно заблокирует —
    // такой сохранённый адрес считаем негодным и ищем демона на своём origin
    var mixed = location.protocol === 'https:' && saved.indexOf('http://') === 0;
    var boot = (!saved || mixed) ? probeOwnOrigin() : Promise.resolve('');
    boot.then(function (own) {
      if (own) {
        ui.api = own;
        saveApi(own);
      } else {
        ui.api = saved || defaultBase();
      }
      startApp();
    });
  }

  function startApp() {
    ui.pendingSelect = Object.create(null);
    document.documentElement.lang = LANG;
    document.title = LANG === 'en' ? 'xrock — mihomo panel' : 'xrock — панель mihomo';
    renderLangBtn();
    if (LANG === 'en') {
      // динамические части (таблицы, карточки) перерисовываются чаще, чем renderActive
      setInterval(function () { if (!document.hidden) applyLang(); }, 1500);
    }
    applyTheme(readThemeMode(), false);
    watchSystemTheme();
    applyStaticIcons();
    bindUi();
    initSettings();
    renderTopbar();

    var hash = (location.hash || '').replace(/^#/, '');
    activate(VIEWS.indexOf(hash) >= 0 ? hash : 'overview', true);

    startPolling();
    pollState();
    startTrafficStream();
    renderSpeedCard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
