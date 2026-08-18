# Powerzoid Memory — GNOME Shell Extension

Extensión para GNOME Shell que muestra el uso de RAM en tiempo real directamente en la barra superior del sistema, con indicador de color según el nivel de riesgo.

```
█████░░░░░ 6.9/15G
```

## Características

- **Barra de progreso** que se llena según la RAM ocupada
- **Uso en GB** mostrado como `usado/total`
- **Indicador de color** que cambia según el riesgo:
  - 🟢 Verde — uso normal (< 60%)
  - 🟡 Amarillo — uso elevado (60–84%)
  - 🔴 Rojo — riesgo de bloqueo (≥ 85%)
- **Actualización cada 3 segundos**, sin dependencias externas
- Lee directamente desde `/proc/meminfo`

## Requisitos

- Fedora 44 (o cualquier distro con GNOME Shell 45–50)
- Sin dependencias adicionales

## Instalación

```bash
# Descomprimir
unzip -o powerzoid-memory.zip
cd powerzoid-memory

# Instalar
bash install.sh

# Cerrar sesión y volver a entrar (necesario en Wayland)
gnome-session-quit --logout
```

Al iniciar sesión de nuevo, la barra de RAM aparecerá automáticamente en la barra superior.

### Instalación desde el repositorio

```bash
git clone https://github.com/ChristianLeal1978/powerzoid-memory.git
cd powerzoid-memory
bash install.sh
gnome-session-quit --logout
```

## Desinstalar

```bash
gnome-extensions disable powerzoid-memory@cleal.cl
rm -rf ~/.local/share/gnome-shell/extensions/powerzoid-memory@cleal.cl
```

## Cómo funciona

La extensión lee `/proc/meminfo` cada 3 segundos y calcula:

```
RAM usada = MemTotal - MemAvailable
```

`MemAvailable` incluye la memoria de caché que el kernel puede liberar cuando sea necesario, por lo que el porcentaje refleja la RAM **realmente comprometida por procesos**, no el uso bruto del sistema.

## Menú desplegable

Al hacer clic en el indicador se muestra el detalle:

```
  RAM
  █████░░░░░  43%
  Usada        6.9 GB
  Disponible   9.1 GB
  Total       16.0 GB
```

## Compatibilidad

| GNOME Shell | Fedora  | Estado |
|-------------|---------|--------|
| 50          | 44      | ✅ Probado |
| 48          | 42–43   | ✅ Compatible |
| 45–47       | 39–41   | ✅ Compatible |

## Licencia

GPL-2.0 — ver [LICENSE](LICENSE)
