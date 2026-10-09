#!/usr/bin/env bash
# Сборка .deb пакета для Debian (тестируется на Debian 13)
# Результат: dist/mybaby_<version>_<arch>.deb
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json)
ARCH=$(dpkg --print-architecture)
PKG="mybaby_${VERSION}_${ARCH}"
TREE="build/deb/${PKG}"

echo "==> Сборка бинаря"
bun run build

echo "==> Сборка дерева пакета ${PKG}"
rm -rf build/deb
mkdir -p \
  "${TREE}/DEBIAN" \
  "${TREE}/usr/bin" \
  "${TREE}/lib/systemd/system" \
  "${TREE}/var/lib/mybaby"

cp mybaby "${TREE}/usr/bin/mybaby"
chmod 755 "${TREE}/usr/bin/mybaby"

sed -e "s/__VERSION__/${VERSION}/" -e "s/__ARCH__/${ARCH}/" packaging/control \
  > "${TREE}/DEBIAN/control"
for f in postinst prerm postrm; do
  cp "packaging/${f}" "${TREE}/DEBIAN/${f}"
  chmod 755 "${TREE}/DEBIAN/${f}"
done

cp packaging/mybaby.service "${TREE}/lib/systemd/system/mybaby.service"

echo "==> dpkg-deb"
mkdir -p dist
dpkg-deb --build --root-owner-group "${TREE}" "dist/${PKG}.deb"

echo "==> Готово: dist/${PKG}.deb"
echo "    Установка:  sudo apt install ./dist/${PKG}.deb"
echo "    Сервис:     systemctl start mybaby"
echo "    Данные БД:  /var/lib/mybaby/sleep.db"
