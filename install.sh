#!/usr/bin/env bash
# ══════════════════════════════════════════════════════
#  Powerzoid Memory — Instalador para Fedora 44 / GNOME 50
#  Uso: bash install.sh
# ══════════════════════════════════════════════════════
set -euo pipefail

UUID="powerzoid-memory@cleal.cl"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

G='\033[0;32m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

echo -e "\n${BOLD}=== Powerzoid Memory — Instalador ===${NC}\n"

mkdir -p "$DEST"
cp "$DIR/extension/metadata.json"  "$DEST/"
cp "$DIR/extension/extension.js"   "$DEST/"
cp "$DIR/extension/stylesheet.css" "$DEST/"
echo -e "  ${G}✓${NC}  Archivos instalados en $DEST"

if command -v gnome-extensions &>/dev/null; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
    echo -e "  ${G}✓${NC}  Extensión habilitada"
fi

echo ""
echo -e "${BOLD}Cierra sesión y vuelve a entrar${NC} para que GNOME la cargue."
echo -e "${DIM}(solo necesario la primera vez en Wayland)${NC}"
echo ""
echo -e "Verifica después:  gnome-extensions info $UUID"
echo ""
