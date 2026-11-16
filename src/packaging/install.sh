#!/bin/sh
# Установка xrock на Keenetic/Netcraze с Entware + XKeen (ядро mihomo).
#   sh install.sh            — установить/обновить
#   sh install.sh --uninstall — убрать панель (mihomo и его конфиг не трогаем)
set -e
cd "$(dirname "$0")"

MIHOMO_DIR=/opt/etc/mihomo
CONF="$MIHOMO_DIR/config.yaml"
UI_DIR="$MIHOMO_DIR/xrock"
BIN_DIR=/opt/sbin
INIT=/opt/etc/init.d/S99xrock
PORT=9091

if [ "$1" = "--uninstall" ]; then
  [ -x "$INIT" ] && "$INIT" stop >/dev/null 2>&1 || true
  rm -f "$INIT" "$BIN_DIR/xrock"
  rm -rf "$UI_DIR"
  echo "xrock удалён. Конфиг mihomo и файл настроек /opt/etc/xrock.json оставлены."
  echo "Верните в $CONF external-ui: zashboard (если нужен zashboard) и перезапустите: xkeen -restart"
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) BIN=xrock-arm64 ;;
  mips)          BIN=xrock-mips ;;
  mipsel|mipsle) BIN=xrock-mipsel ;;
  *) echo "Неизвестная архитектура: $(uname -m)"; exit 1 ;;
esac
echo "Архитектура: $(uname -m) → $BIN"

[ -f "$CONF" ] || { echo "Не найден $CONF — сначала установите XKeen с ядром mihomo"; exit 1; }
[ -x /opt/sbin/mihomo ] || { echo "Не найден mihomo — xrock работает только с ядром mihomo"; exit 1; }

# 1. бинарник
if [ -f "$BIN" ]; then
  SRC="$BIN"
elif [ -f "./xrock" ]; then
  SRC="./xrock"
else
  echo "Не найден бинарник $BIN рядом с установщиком"; exit 1
fi
[ -x "$INIT" ] && "$INIT" stop >/dev/null 2>&1 || true
cp "$SRC" "$BIN_DIR/xrock"
chmod 755 "$BIN_DIR/xrock"

# 2. UI в папку mihomo (external-ui)
mkdir -p "$UI_DIR"
cp -r ./web/. "$UI_DIR/"

# 3. конфиг mihomo: external-ui: xrock + secret
BACKUP="$CONF.xrock-backup.$(date +%Y%m%d-%H%M%S)"
cp "$CONF" "$BACKUP"
echo "Резервная копия конфига: $BACKUP"

# внешний UI — наша папка, автозагрузку чужого UI отключаем (иначе mihomo
# перезапишет панель при обновлении)
if grep -qE '^external-ui:' "$CONF"; then
  sed -i 's|^external-ui:.*|external-ui: xrock|' "$CONF"
else
  printf 'external-ui: xrock\n' >> "$CONF"
fi
if grep -qE '^external-ui-url:' "$CONF"; then
  sed -i 's|^external-ui-url:|# external-ui-url:|' "$CONF"
fi

# secret: если на API нет пароля — генерируем и сообщаем
if grep -qE '^secret:[[:space:]]*"?[A-Za-z0-9]' "$CONF"; then
  SECRET=$(sed -n 's/^secret:[[:space:]]*"\{0,1\}\([^"#]*\)"\{0,1\}.*/\1/p' "$CONF" | head -1 | tr -d ' \r')
  echo "Clash API уже с secret — оставляю как есть"
else
  # md5sum есть и в BusyBox, и в Entware (od -A в BusyBox отсутствует)
  SECRET=$(head -c 24 /dev/urandom | md5sum | cut -d' ' -f1)
  [ -z "$SECRET" ] && SECRET=$(head -c 24 /dev/urandom | md5sum | cut -c1-32)
  if grep -qE '^secret:' "$CONF"; then
    sed -i "s|^secret:.*|secret: \"$SECRET\"|" "$CONF"
  else
    printf 'secret: "%s"\n' "$SECRET" >> "$CONF"
  fi
  echo "Придуман пароль к Clash API (secret) — записан в $CONF"
fi

# 4. init-скрипт
cat > "$INIT" <<EOF
#!/bin/sh
ENABLED=yes
PROCS=xrock
ARGS="-listen 0.0.0.0:$PORT -confdir $MIHOMO_DIR -state /opt/etc/xrock.json -log /opt/var/log/xrock.log -ui $UI_DIR"
PREARGS=""
DESC=xrock
PATH=/opt/sbin:/opt/bin:/opt/usr/sbin:/opt/usr/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
chmod 755 "$INIT"
mkdir -p /opt/var/log

# 5. перезапуск mihomo (применит external-ui и secret) и запуск панели
echo "Перезапускаю XKeen (mihomo) — связь прервётся на 5–10 секунд…"
xkeen -restart || echo "Не удалось перезапустить — выполните: xkeen -restart"
sleep 2
"$INIT" start
sleep 1

LAN_IP=$(ip -4 addr show br0 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2);print $2;exit}')
[ -z "$LAN_IP" ] && LAN_IP=$(ip -4 route 2>/dev/null | awk '/br0/ && /src/ {for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
[ -z "$LAN_IP" ] && LAN_IP=192.168.1.1
echo
echo "Готово."
echo "  Панель (её отдаёт сам mihomo): http://$LAN_IP:9090/ui"
echo "  Пароль Clash API (secret):     ${SECRET:-НЕ ЗАДАН — проверьте $CONF}"
echo "  Демон xrock:                   http://$LAN_IP:$PORT/api/state"
echo "  Журнал:                        /opt/var/log/xrock.log"
echo
echo "Открывайте панель — она сама подключится к демону на $LAN_IP:$PORT."
