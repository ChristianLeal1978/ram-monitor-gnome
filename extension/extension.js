/**
 * RAM Monitor — extension.js
 * Muestra uso de RAM en la barra superior de GNOME Shell.
 * Lee /proc/meminfo directamente, sin dependencias externas.
 *
 * Panel:  ██████░░░░ 7.4/16G
 * Colores: verde (<60%) · amarillo (60-84%) · rojo (≥85%)
 *
 * Clic izquierdo  → detalle de RAM (Usada/Disponible/Total).
 * Clic derecho    → procesos activos ordenados por RAM, con opción de matarlos.
 */

import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';
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

// Menú de procesos
const PROC_MIN_KB    = 10 * 1024;  // ocultar procesos con < 10 MB de RSS
const PROC_MAX_ITEMS = 20;         // tope de procesos listados
const KILL_CHECK_MS  = 1500;       // espera tras SIGTERM antes de verificar

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

// ── Procesos: obtención vía `ps` (Gio.Subprocess, no bloqueante) ──────────
function parseProcesses(output) {
    const procs = [];
    for (const rawLine of output.split('\n')) {
        const m = rawLine.trim().match(/^(\d+)\s+(\S+)\s+(\d+)$/);
        if (!m) continue;
        const kb = parseInt(m[3]);
        if (kb < PROC_MIN_KB) continue;
        procs.push({ pid: parseInt(m[1]), name: m[2], kb });
    }
    // `ps --sort=-rss` ya entrega orden descendente; solo recortamos el top N.
    return procs.slice(0, PROC_MAX_ITEMS);
}

function getProcesses() {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['ps', '-eo', 'pid,comm,rss', '--sort=-rss'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_) {
            resolve(null);  // `ps` no disponible
            return;
        }
        proc.communicate_utf8_async(null, null, (source, res) => {
            try {
                const [, stdout] = source.communicate_utf8_finish(res);
                resolve(parseProcesses(stdout));
            } catch (_) {
                resolve(null);
            }
        });
    });
}

function sendSignal(pid, sig) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['kill', sig, `${pid}`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_) {
            resolve(false);
            return;
        }
        proc.wait_check_async(null, (source, res) => {
            try {
                source.wait_check_finish(res);
                resolve(true);
            } catch (_) {
                resolve(false);  // ej. sin permisos para matar el proceso
            }
        });
    });
}

function isProcessAlive(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtGb(gb) {
    // Sin decimales si ≥ 10 GB, un decimal si < 10 GB
    return gb >= 10 ? `${Math.round(gb)}` : gb.toFixed(1);
}

function fmtProcMem(kb) {
    const mb = kb / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.round(mb)} MB`;
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

        this._menuMode        = 'ram';   // 'ram' | 'processes'
        this._lastMem         = null;
        this._procRequestId   = 0;
        this._pendingSources  = new Set();
        this._destroyed       = false;

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

        // ── Clic izquierdo → RAM · clic derecho → procesos ──
        // PanelMenu.Button trae un único Clutter.ClickGesture que abre el
        // menú con cualquier botón (required-button = 0). Lo desactivamos y
        // usamos dos gestos propios, uno por botón, cada uno fija el modo
        // del menú *antes* de abrirlo para que open-state-changed sepa qué
        // contenido construir.
        this._clickGesture?.set_enabled(false);

        this._leftClickGesture = new Clutter.ClickGesture();
        this._leftClickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        this._leftClickGesture.set_recognize_on_press(true);
        this._leftClickGesture.connect('recognize', () => {
            this._menuMode = 'ram';
            this.menu.toggle();
        });
        this.add_action(this._leftClickGesture);

        this._rightClickGesture = new Clutter.ClickGesture();
        this._rightClickGesture.set_required_button(Clutter.BUTTON_SECONDARY);
        this._rightClickGesture.set_recognize_on_press(true);
        this._rightClickGesture.connect('recognize', () => {
            this._menuMode = 'processes';
            this.menu.toggle();
        });
        this.add_action(this._rightClickGesture);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) return;
            if (this._menuMode === 'processes')
                this._openProcessMenu();
            else if (!this._menuBar)
                this._buildRamMenu();
        });

        // ── Menú desplegable (contenido inicial: detalle de RAM) ──
        this._buildRamMenu();

        // ── Arrancar ──
        this._refresh();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        const m = readMem();
        this._lastMem = m;
        if (!m) {
            this._barLabel.set_text('??');
            this._infoLabel.set_text('');
            return;
        }

        const color = colorFor(m.pct);
        const bar   = makeBar(m.pct);
        const used  = fmtGb(m.used_gb);
        const total = fmtGb(m.total_gb);

        // ── Panel ──
        this._barLabel.set_text(bar);
        this._barLabel.set_style(
            `color: ${color}; font-family: monospace; letter-spacing: 0px;`
        );
        this._infoLabel.set_text(` ${used}/${total}G`);
        this._infoLabel.set_style(`color: ${color};`);

        // ── Menú (solo si está mostrando el detalle de RAM) ──
        this._applyRamLabels(m);
    }

    // ── Menú: detalle de RAM ──
    _buildRamMenu() {
        this.menu.removeAll();

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

        this._applyRamLabels(this._lastMem);
    }

    _applyRamLabels(m) {
        if (!m || !this._menuBar) return;

        const color = colorFor(m.pct);
        const bar   = makeBar(m.pct);
        const used  = fmtGb(m.used_gb);
        const total = fmtGb(m.total_gb);
        const avail = fmtGb(m.avail_gb);

        this._menuBar.label.set_text(`  ${bar}  ${m.pct}%`);
        this._menuBar.label.set_style(`font-family: monospace; color: ${color};`);
        this._menuUsed.label.set_text(`  Usada      ${used} GB`);
        this._menuAvail.label.set_text(`  Disponible ${avail} GB`);
        this._menuTotal.label.set_text(`  Total      ${total} GB`);
    }

    // ── Menú: procesos activos ──
    _addProcessHeader() {
        const header = new PopupMenu.PopupMenuItem('  Procesos activos', { reactive: false });
        header.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(header);
    }

    _openProcessMenu() {
        this.menu.removeAll();
        this._menuTitle = this._menuBar = this._menuUsed =
            this._menuAvail = this._menuTotal = null;

        this._addProcessHeader();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('  Cargando…', { reactive: false }));

        const requestId = ++this._procRequestId;
        getProcesses().then(procs => {
            if (this._destroyed) return;
            if (requestId !== this._procRequestId) return;      // el menú cambió mientras tanto
            if (this._menuMode !== 'processes' || !this.menu.isOpen) return;
            this._renderProcessList(procs);
        });
    }

    _renderProcessList(procs) {
        this.menu.removeAll();
        this._addProcessHeader();

        if (procs === null) {
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('  Error al obtener procesos', { reactive: false }));
            return;
        }
        if (procs.length === 0) {
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('  Sin procesos relevantes', { reactive: false }));
            return;
        }
        for (const proc of procs)
            this.menu.addMenuItem(this._buildProcessItem(proc));
    }

    _buildProcessItem(proc) {
        // PopupSubMenuMenuItem expande/colapsa sin cerrar el menú principal:
        // el clic derecho abre este menú, un primer clic despliega la
        // confirmación y un segundo clic (sobre el ítem de confirmación)
        // ejecuta el kill.
        const item = new PopupMenu.PopupSubMenuMenuItem(
            `  ${proc.name}  —  ${fmtProcMem(proc.kb)}`);

        const confirmItem = new PopupMenu.PopupMenuItem(
            `  Terminar "${proc.name}" (confirmar)`);
        confirmItem.label.style = 'color: #f38ba8;';
        confirmItem.connect('activate', () => this._killProcess(proc.pid, proc.name));
        item.menu.addMenuItem(confirmItem);

        return item;
    }

    // ── Matar proceso: SIGTERM, y si sigue vivo, SIGKILL ──
    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._pendingSources.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._pendingSources.add(id);
        });
    }

    async _killProcess(pid, name) {
        await sendSignal(pid, '-15');
        await this._sleep(KILL_CHECK_MS);
        if (this._destroyed || !isProcessAlive(pid)) return;

        await sendSignal(pid, '-9');
        await this._sleep(300);
        if (this._destroyed) return;
        if (isProcessAlive(pid))
            console.error(`[RAM Monitor] No se pudo terminar el proceso "${name}" (pid ${pid})`);
    }

    destroy() {
        this._destroyed = true;

        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        for (const id of this._pendingSources)
            GLib.source_remove(id);
        this._pendingSources.clear();

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
