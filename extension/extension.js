/**
 * Powerzoid Memory — extension.js
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
// Se agrupan por nombre (comm) sumando su RSS: apps como Spotify o Electron
// suelen abrir varios procesos con el mismo nombre, y verlos por separado
// solo satura la lista sin aportar información útil.
function parseProcesses(output) {
    const groups = new Map();
    for (const rawLine of output.split('\n')) {
        const m = rawLine.trim().match(/^(\d+)\s+(\S+)\s+(\d+)$/);
        if (!m) continue;
        const pid  = parseInt(m[1]);
        const name = m[2];
        const kb   = parseInt(m[3]);

        let g = groups.get(name);
        if (!g) {
            g = { name, pids: [], kb: 0 };
            groups.set(name, g);
        }
        g.pids.push(pid);
        g.kb += kb;
    }

    return [...groups.values()]
        .filter(g => g.kb >= PROC_MIN_KB)
        .sort((a, b) => b.kb - a.kb)
        .slice(0, PROC_MAX_ITEMS);
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

function fmtPct(pct) {
    return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

// Nombres de proceso (`comm`, truncado a 15 caracteres por `ps`) → nombre
// de la app tal como la conoce el usuario. Lo que no está en el mapa se
// formatea genéricamente (guiones → espacios, may. inicial) en vez de
// mostrarse en kebab-case crudo.
const FRIENDLY_PROCESS_NAMES = {
    'vivaldi-bin'      : 'Vivaldi',
    'claude-desktop'   : 'Claude Desktop',
    'spotify'          : 'Spotify',
    'rambox'           : 'Rambox',
    'gnome-shell'      : 'GNOME Shell',
    'gnome-software'   : 'GNOME Software',
    'claude'           : 'Claude',
    'node'             : 'Node',
    'gjs'              : 'GJS',
    'systemd-journal'  : 'systemd-journald',
    'xdg-desktop-por'  : 'xdg-desktop-portal',
    'ibus-engine-tb'   : 'IBus',
    'ibus-x11'         : 'IBus',
    'mutter-x11-fram'  : 'Mutter',
    'abrt-dump-journ'  : 'ABRT',
    'evolution-alarm'  : 'Evolution',
    'evolution-sourc'  : 'Evolution',
    'dnf5daemon-serv'  : 'DNF5',
    'python3'          : 'Python',
};

function friendlyProcessName(name) {
    if (FRIENDLY_PROCESS_NAMES[name]) return FRIENDLY_PROCESS_NAMES[name];
    return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
        // 0.5 → el menú se centra bajo el indicador (en vez de colgar hacia
        // un lado, lo que lo sacaba de pantalla estando tan a la derecha).
        super._init(0.5, 'Powerzoid Memory');

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
            style_class: 'powerzoid-memory-bar',
        });

        // Texto "usado/total G"
        this._infoLabel = new St.Label({
            y_align    : Clutter.ActorAlign.CENTER,
            style_class: 'powerzoid-memory-info',
        });

        box.add_child(this._barLabel);
        box.add_child(this._infoLabel);
        this.add_child(box);

        // ── Clic izquierdo → RAM · clic derecho → procesos ──
        // PanelMenu.Button trae un único Clutter.ClickGesture que abre el
        // menú con cualquier botón (required-button = 0). Lo desactivamos y
        // usamos dos gestos propios, uno por botón, cada uno fija el modo
        // del menú antes de abrirlo (o de repoblarlo si ya estaba abierto
        // en el otro modo) para que siempre muestre el contenido correcto.
        this._clickGesture?.set_enabled(false);

        this._leftClickGesture = new Clutter.ClickGesture();
        this._leftClickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        this._leftClickGesture.set_recognize_on_press(true);
        this._leftClickGesture.connect('recognize', () => this._activateMode('ram'));
        this.add_action(this._leftClickGesture);

        this._rightClickGesture = new Clutter.ClickGesture();
        this._rightClickGesture.set_required_button(Clutter.BUTTON_SECONDARY);
        this._rightClickGesture.set_recognize_on_press(true);
        this._rightClickGesture.connect('recognize', () => this._activateMode('processes'));
        this.add_action(this._rightClickGesture);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._populateMenu();
        });

        // ── Pasar el mouse sobre el ícono también abre el listado de
        // procesos, sin necesidad de clic derecho. El cierre queda a cargo
        // de los mecanismos propios de GNOME (clic afuera, Escape, o clic
        // de nuevo en el ícono): un cierre automático por "salida de hover"
        // resultó poco fiable, porque el menú recién abierto no queda
        // marcado como hovered hasta el primer movimiento del mouse sobre
        // él, así que se cerraba solo apenas se abría.
        this.connect('notify::hover', () => this._onIndicatorHoverChanged());

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

    // ── Apertura / cambio de modo del menú ──
    _activateMode(mode) {
        if (this.menu.isOpen && this._menuMode === mode) {
            this.menu.close();
            return;
        }
        this._menuMode = mode;
        if (this.menu.isOpen)
            this._populateMenu();   // ya abierto en el otro modo: solo repoblar
        else
            this.menu.open();       // dispara open-state-changed → _populateMenu()
    }

    _populateMenu() {
        if (this._menuMode === 'processes')
            this._openProcessMenu();
        else if (!this._menuBar)
            this._buildRamMenu();
    }

    _onIndicatorHoverChanged() {
        if (!this.hover) return;

        if (!this.menu.isOpen) {
            this._menuMode = 'processes';
            this.menu.open();
        } else if (this._menuMode !== 'processes') {
            this._menuMode = 'processes';
            this._populateMenu();
        }
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
        for (const group of procs)
            this.menu.addMenuItem(this._buildProcessItem(group));
    }

    // % de RAM que representa `kb` sobre el total del sistema (según la
    // última lectura de /proc/meminfo). Cadena vacía si aún no hay dato.
    _fmtPctOfTotal(kb) {
        if (!this._lastMem) return '';
        const totalKb = this._lastMem.total_gb * 1_048_576;
        if (!totalKb) return '';
        return fmtPct((kb / totalKb) * 100);
    }

    _buildProcessItem(group) {
        // PopupSubMenuMenuItem expande/colapsa sin cerrar el menú principal:
        // el clic derecho (o el hover) abre este menú, un primer clic
        // despliega la confirmación y un segundo clic (sobre el ítem de
        // confirmación) ejecuta el kill de todos los PID del grupo.
        const count       = group.pids.length;
        const displayName = friendlyProcessName(group.name);
        const pctLabel    = this._fmtPctOfTotal(group.kb);

        const item = new PopupMenu.PopupSubMenuMenuItem(
            pctLabel ? `  ${displayName}  —  ${pctLabel}` : `  ${displayName}`);

        const confirmText = count > 1
            ? `  Terminar ${count} procesos de "${displayName}" (confirmar)`
            : `  Terminar "${displayName}" (confirmar)`;
        const confirmItem = new PopupMenu.PopupMenuItem(confirmText);
        confirmItem.label.style = 'color: #f38ba8;';
        confirmItem.connect('activate', () => this._killProcessGroup(group.pids, group.name));
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

    async _killProcessGroup(pids, name) {
        await Promise.all(pids.map(pid => sendSignal(pid, '-15')));
        await this._sleep(KILL_CHECK_MS);
        if (this._destroyed) return;

        let survivors = pids.filter(isProcessAlive);
        if (survivors.length === 0) return;

        await Promise.all(survivors.map(pid => sendSignal(pid, '-9')));
        await this._sleep(300);
        if (this._destroyed) return;

        survivors = survivors.filter(isProcessAlive);
        if (survivors.length > 0) {
            console.error(
                `[Powerzoid Memory] No se pudo terminar ${survivors.length} proceso(s) ` +
                `de "${name}" (pids: ${survivors.join(', ')})`);
        }
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
