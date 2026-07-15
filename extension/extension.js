/**
 * RAM Monitor — extension.js
 * Muestra uso de RAM en la barra superior de GNOME Shell.
 * Lee /proc/meminfo directamente, sin dependencias externas.
 *
 * Panel:  ██████░░░░ 7.4/16G
 * Colores: verde (<60%) · amarillo (60-84%) · rojo (≥85%)
 */

import GLib    from 'gi://GLib';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { Extension }    from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu   from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu   from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main        from 'resource:///org/gnome/shell/ui/main.js';

// ── Configuración ──────────────────────────────────────────────────────────
const REFRESH_MS  = 3000;   // actualizar cada 3 segundos
const BAR_SEGS    = 10;     // segmentos de la barra

// Umbrales de color (% de RAM usada)
const WARN_PCT    = 60;     // verde → amarillo
const DANGER_PCT  = 85;     // amarillo → rojo

// ── Lectura de /proc/meminfo ───────────────────────────────────────────────
function readMem() {
    try {
        const [ok, bytes] = GLib.file_get_contents('/proc/meminfo');
        if (!ok) return null;

        const kv = {};
        new TextDecoder().decode(bytes).split('\n').forEach(line => {
            const m = line.match(/^(\w+):\s+(\d+)/);
            if (m) kv[m[1]] = parseInt(m[2]);  // valores en kB
        });

        const total = kv['MemTotal']     ?? 0;
        const avail = kv['MemAvailable'] ?? 0;  // incluye caché reclaimable
        const used  = total - avail;
        const pct   = total > 0 ? Math.round(used / total * 100) : 0;

        return {
            total_gb : total / 1_048_576,
            used_gb  : used  / 1_048_576,
            avail_gb : avail / 1_048_576,
            pct,
        };
    } catch (_) {
        return null;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtGb(gb) {
    // Sin decimales si ≥ 10 GB, un decimal si < 10 GB
    return gb >= 10 ? `${Math.round(gb)}` : gb.toFixed(1);
}

function makeBar(pct) {
    const filled = Math.round(Math.min(100, Math.max(0, pct)) / 100 * BAR_SEGS);
    return '█'.repeat(filled) + '░'.repeat(BAR_SEGS - filled);
}

function colorFor(pct) {
    if (pct >= DANGER_PCT) return '#f38ba8';   // rojo
    if (pct >= WARN_PCT)   return '#f9e2af';   // amarillo
    return '#a6e3a1';                           // verde
}

// ── Indicador ──────────────────────────────────────────────────────────────
const RamIndicator = GObject.registerClass(
class RamIndicator extends PanelMenu.Button {

    _init() {
        super._init(0.0, 'RAM Monitor');

        // ── Widget en la barra superior ──
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        // Barra de progreso (fuente monospace para que los bloques sean uniformes)
        this._barLabel = new St.Label({
            y_align    : Clutter.ActorAlign.CENTER,
            style_class: 'ram-monitor-bar',
        });

        // Texto "usado/total G"
        this._infoLabel = new St.Label({
            y_align    : Clutter.ActorAlign.CENTER,
            style_class: 'ram-monitor-info',
        });

        box.add_child(this._barLabel);
        box.add_child(this._infoLabel);
        this.add_child(box);

        // ── Menú desplegable ──
        this._menuTitle = new PopupMenu.PopupMenuItem('  RAM', { reactive: false });
        this._menuTitle.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(this._menuTitle);

        this._menuBar   = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._menuBar.label.style = 'font-family: monospace;';
        this.menu.addMenuItem(this._menuBar);

        this._menuUsed  = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._menuAvail = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._menuTotal = new PopupMenu.PopupMenuItem('', { reactive: false });
        this.menu.addMenuItem(this._menuUsed);
        this.menu.addMenuItem(this._menuAvail);
        this.menu.addMenuItem(this._menuTotal);

        // ── Arrancar ──
        this._refresh();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        const m = readMem();
        if (!m) {
            this._barLabel.set_text('??');
            this._infoLabel.set_text('');
            return;
        }

        const color = colorFor(m.pct);
        const bar   = makeBar(m.pct);
        const used  = fmtGb(m.used_gb);
        const total = fmtGb(m.total_gb);
        const avail = fmtGb(m.avail_gb);

        // ── Panel ──
        this._barLabel.set_text(bar);
        this._barLabel.set_style(
            `color: ${color}; font-family: monospace; letter-spacing: 0px;`
        );
        this._infoLabel.set_text(` ${used}/${total}G`);
        this._infoLabel.set_style(`color: ${color};`);

        // ── Menú ──
        this._menuBar.label.set_text(`  ${bar}  ${m.pct}%`);
        this._menuBar.label.set_style(`font-family: monospace; color: ${color};`);
        this._menuUsed.label.set_text(`  Usada      ${used} GB`);
        this._menuAvail.label.set_text(`  Disponible ${avail} GB`);
        this._menuTotal.label.set_text(`  Total      ${total} GB`);
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        super.destroy();
    }
});

// ── Extensión ──────────────────────────────────────────────────────────────
export default class RamMonitorExtension extends Extension {
    enable() {
        this._indicator = new RamIndicator();
        // Añadir a la derecha del panel, antes de otros indicadores de sistema
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
