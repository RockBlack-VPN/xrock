#!/bin/sh
# Установка xrock на Keenetic/Netcraze с Entware + XKeen (ядро mihomo).
#   sh install.sh            — установить/обновить
#   sh install.sh --uninstall — убрать панель (mihomo и его конфиг не трогаем)
#
# Панель (UI) больше не «копируется файлами»: в config.yaml прописываются
#   external-ui: xrock
#   external-ui-url: https://github.com/RockBlack-VPN/xrock/releases/latest/download/xrock-ui.zip
# и mihomo сам скачивает/обновляет её. Если GitHub недоступен,
# установщик упадёт на копию UI из архива (офлайн-запас).
set -e
# Абсолютный путь к самому установщику: его копия остаётся в /opt/share/xrock,
# чтобы документированное удаление работало в любой момент, а не только пока
# распакован архив во /tmp.
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
SELF="$SELF_DIR/$(basename "$0")"
cd "$SELF_DIR"

MIHOMO_DIR=/opt/etc/mihomo
CONF="$MIHOMO_DIR/config.yaml"
UI_DIR="$MIHOMO_DIR/xrock"
UI_URL="https://github.com/RockBlack-VPN/xrock/releases/latest/download/xrock-ui.zip"
BIN_DIR=/opt/sbin
INIT=/opt/etc/init.d/S99xrock
SHARE_DIR=/opt/share/xrock
STATE=/opt/etc/xrock.json
PORT=9091

if [ "$1" = "--uninstall" ]; then
  [ -x "$INIT" ] && "$INIT" stop >/dev/null 2>&1 || true
  rm -f "$INIT" "$BIN_DIR/xrock"
  rm -rf "$UI_DIR"
  echo "xrock удалён. В $CONF остались external-ui/external-ui-url — при необходимости удалите их."
  echo "Журнал и настройки сторожа сохранены: $STATE (удалить: rm -f $STATE)"
  if [ -f "$SHARE_DIR/install.sh" ]; then
    echo "Установщик оставлен для переустановки: $SHARE_DIR/install.sh (убрать всё: rm -rf $SHARE_DIR)"
  fi
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

# 1. бинарник демона
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

# 1b. копия установщика в /opt/share/xrock — чтобы удаление работало и после
#     того, как распакованный архив из /tmp пропал:
#       sh /opt/share/xrock/install.sh --uninstall
mkdir -p "$SHARE_DIR" 2>/dev/null || true
if [ -d "$SHARE_DIR" ] && [ -f "$SELF" ] && [ "$SELF" != "$SHARE_DIR/install.sh" ]; then
  cp "$SELF" "$SHARE_DIR/install.sh" 2>/dev/null || echo "Внимание: не смог сохранить установщик в $SHARE_DIR"
fi
chmod 755 "$SHARE_DIR/install.sh" 2>/dev/null || true

# 2. конфиг mihomo: external-ui: xrock + адрес архива UI
BACKUP="$CONF.xrock-backup.$(date +%Y%m%d-%H%M%S)"
cp "$CONF" "$BACKUP"
echo "Резервная копия конфига: $BACKUP"

if grep -qE '^external-ui:' "$CONF"; then
  sed -i 's|^external-ui:.*|external-ui: xrock|' "$CONF"
else
  printf 'external-ui: xrock\n' >> "$CONF"
fi
if grep -qE '^external-ui-url:' "$CONF"; then
  sed -i "s|^external-ui-url:.*|external-ui-url: $UI_URL|" "$CONF"
elif grep -qE '^# external-ui-url:' "$CONF"; then
  sed -i "s|^# external-ui-url:.*|external-ui-url: $UI_URL|" "$CONF"
else
  printf 'external-ui-url: %s\n' "$UI_URL" >> "$CONF"
fi

# 3. secret: если на API нет пароля — генерируем и сообщаем
if grep -qE '^secret:[[:space:]]*"?[A-Za-z0-9]' "$CONF"; then
  SECRET=$(sed -n 's/^secret:[[:space:]]*"\{0,1\}\([^"#]*\)"\{0,1\}.*/\1/p' "$CONF" | head -1 | tr -d ' \r')
  echo "Clash API уже с secret — оставляю как есть"
else
  SECRET=$(head -c 24 /dev/urandom | md5sum | cut -d' ' -f1)
  [ -z "$SECRET" ] && SECRET=$(head -c 24 /dev/urandom | md5sum | cut -c1-32)
  if grep -qE '^secret:' "$CONF"; then
    sed -i "s|^secret:.*|secret: \"$SECRET\"|" "$CONF"
  else
    printf 'secret: "%s"\n' "$SECRET" >> "$CONF"
  fi
  echo "Придуман пароль к Clash API (secret) — записан в $CONF"
fi

# 4. init-скрипт демона
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

# 5. чистим старую UI, чтобы mihomo скачал свежую по external-ui-url
if [ -d "$UI_DIR" ]; then
  rm -rf "$UI_DIR.old"
  mv "$UI_DIR" "$UI_DIR.old"
fi

echo "Перезапускаю XKeen (mihomo) — он сам скачает панель по external-ui-url…"
xkeen -restart || echo "Не удалось перезапустить — выполните: xkeen -restart"

# 6. ждём, пока mihomo скачает UI; если не вышло — офлайн-запас из архива
i=0
UI_OK=0
while [ $i -lt 30 ]; do
  sleep 2
  i=$((i+2))
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:9090/ui" && [ -f "$UI_DIR/index.html" ]; then
    UI_OK=1
    break
  fi
done
if [ "$UI_OK" = "1" ]; then
  echo "Панель скачана mihomo по external-ui-url"
  rm -rf "$UI_DIR.old"
elif [ -d "./web" ]; then
  echo "GitHub недоступен — ставлю панель из архива (офлайн-запас)"
  mkdir -p "$UI_DIR"
  cp -r ./web/. "$UI_DIR/"
else
  echo "Внимание: панель не скачалась и нет папки ./web для офлайн-запаса"
fi

sleep 1
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
echo "Обновить панель потом: «Настройки → Обновления» или просто перезапуск mihomo."
echo "Удалить панель:        sh $SHARE_DIR/install.sh --uninstall"
