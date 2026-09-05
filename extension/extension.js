/**
 * Powerzoid Memory — extension.js
 * Muestra uso de RAM en la barra superior de GNOME Shell.
 * Lee /proc/meminfo directamente, sin dependencias externas.
 *
 * Panel:  ██████░░░░ 7.4/16G
 * Colores: verde (<60%) · amarillo (60-84%) · rojo (≥85%)
 *
 * Clic izquierdo  → procesos activos ordenados por RAM, con opción de matarlos.
 * Clic derecho    → configuración (alineación, tamaño de letra, ocultar sesión).
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
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

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

// Posición en barra y tamaño de letra (mismo patrón que el resto de Powerzoid)
const VALID_ALIGNS      = ['left', 'center', 'right'];
const DEFAULT_FONT_SIZE = 12;
const MIN_FONT_SIZE     = 8;
const MAX_FONT_SIZE     = 20;

const CONFIG_DIR      = `${GLib.get_home_dir()}/.config/powerzoid-memory`;
const POSITION_PATH   = `${CONFIG_DIR}/panel-position`;
const FONT_SIZE_PATH  = `${CONFIG_DIR}/font-size`;

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

// Confirmación de cierre de proceso vía diálogo modal (el mismo mecanismo
// que usa GNOME para "Apagar"/"Cerrar sesión"): queda siempre centrado y
// visible sin importar cuán chica sea la pantalla, a diferencia del
// submenú expandible que usábamos antes, cuyo ítem de confirmación podía
// quedar fuera del área visible/desplazable en pantallas pequeñas.
function confirmKillDialog(text) {
    return new Promise(resolve => {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const label = new St.Label({ text, style: 'padding: 12px 4px; max-width: 320px;' });
        label.clutter_text.set_line_wrap(true);
        dialog.contentLayout.add_child(label);

        let resolved = false;
        const finish = result => {
            if (resolved) return;
            resolved = true;
            dialog.close();
            resolve(result);
        };

        dialog.setButtons([
            { label: 'Cancelar', action: () => finish(false), key: Clutter.KEY_Escape },
            { label: 'Terminar',  action: () => finish(true),  default: true },
        ]);

        dialog.open();
    });
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

    _init(extension, initialAlign = 'right', initialFontSize = DEFAULT_FONT_SIZE) {
        // 0.5 → el menú se centra bajo el indicador (en vez de colgar hacia
        // un lado, lo que lo sacaba de pantalla estando tan a la derecha).
        super._init(0.5, 'Powerzoid Memory');

        this._ext             = extension;
        this._currentAlign    = initialAlign;
        this._fontSize         = initialFontSize;
        this._fontSizeItem    = null;
        this._alignItems      = {};

        this._menuMode        = 'processes';   // 'processes' | 'config'
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

        // ── Clic izquierdo → procesos · clic derecho → configuración ──
        // Se maneja en la fase de captura ('captured-event'): la señal
        // clásica 'button-press-event' nunca llega a dispararse en esta
        // versión de GNOME Shell (ni tampoco el gesto de clic por defecto
        // de PanelMenu.Button, ni gestos Clutter.ClickGesture propios),
        // pero 'captured-event' sí recibe el BUTTON_PRESS de forma fiable.
        this.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;

            const button = event.get_button();
            const mode = button === Clutter.BUTTON_SECONDARY ? 'config' : 'processes';

            // Se difiere al próximo ciclo de inactividad: abrir/cerrar el
            // menú en el mismo tick en que todavía se está procesando el
            // evento de clic (fase de captura) interfiere con el propio
            // mecanismo de apertura de PopupMenu (mismo patrón que usa el
            // resto de Powerzoid para esto).
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;

                if (this.menu.isOpen && this._menuMode === mode) {
                    this.menu.close();
                } else {
                    this._menuMode = mode;
                    if (this.menu.isOpen)
                        this._populateMenu();
                    else
                        this.menu.open();
                }
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._populateMenu();
        });

        // Construcción inicial sincrónica: un PopupMenu completamente vacío
        // (sin ítems todavía) parece negarse a abrir la primera vez —
        // nunca llega a emitir 'open-state-changed' — así que se precarga
        // con contenido antes de que exista la posibilidad de un clic.
        this._populateMenu();

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

        const bar   = makeBar(m.pct);
        const used  = fmtGb(m.used_gb);
        const total = fmtGb(m.total_gb);

        // ── Panel ──
        this._barLabel.set_text(bar);
        this._infoLabel.set_text(` ${used}/${total}G`);
        this._applyPanelStyle(m);
    }

    _applyPanelStyle(m) {
        const color = colorFor(m.pct);
        this._barLabel.set_style(
            `color: ${color}; font-family: monospace; letter-spacing: 0px; font-size: ${this._fontSize}px;`
        );
        this._infoLabel.set_style(`color: ${color}; font-size: ${this._fontSize}px;`);
    }

    _populateMenu() {
        if (this._menuMode === 'processes')
            this._openProcessMenu();
        else
            this._buildConfigMenu();
    }

    // ── Menú: configuración (clic derecho) — alineación, tamaño de letra
    // y ocultar sesión, mismo patrón que el resto de Powerzoid ──
    _buildConfigMenu() {
        this.menu.removeAll();

        const title = new PopupMenu.PopupMenuItem('  Configuración', { reactive: false });
        title.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(title);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const posSubMenu = new PopupMenu.PopupSubMenuMenuItem('Posición en barra');
        this.menu.addMenuItem(posSubMenu);

        this._alignItems = {};
        [
            ['← Alinear a la izquierda', 'left'],
            ['↔ Alinear al centro',       'center'],
            ['→ Alinear a la derecha',    'right'],
        ].forEach(([label, align]) => {
            const item = new PopupMenu.PopupMenuItem(label);
            this._alignItems[align] = item;
            item.connect('activate', () => this._setAlignment(align));
            posSubMenu.menu.addMenuItem(item);
        });
        this._updateAlignMarks(this._currentAlign);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._fontSizeItem = new PopupMenu.PopupMenuItem(this._fontSizeLabel(), { reactive: false });
        this._fontSizeItem.label.set_style('color: #aaa; font-style: italic;');
        this.menu.addMenuItem(this._fontSizeItem);

        const increaseItem = new PopupMenu.PopupMenuItem('A+   Aumentar letra');
        increaseItem.connect('activate', () => this._changeFontSize(1));
        this.menu.addMenuItem(increaseItem);

        const decreaseItem = new PopupMenu.PopupMenuItem('A−   Reducir letra');
        decreaseItem.connect('activate', () => this._changeFontSize(-1));
        this.menu.addMenuItem(decreaseItem);

        const resetItem = new PopupMenu.PopupMenuItem('↺    Restablecer tamaño');
        resetItem.connect('activate', () => {
            this._fontSize = DEFAULT_FONT_SIZE;
            this._applyFontSize();
            this._ext.saveFontSize(this._fontSize);
        });
        this.menu.addMenuItem(resetItem);

        this._addHideItem();
    }

    _fontSizeLabel() {
        return `Tamaño: ${this._fontSize} px`;
    }

    _changeFontSize(delta) {
        this._fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, this._fontSize + delta));
        this._applyFontSize();
        this._ext.saveFontSize(this._fontSize);
    }

    _applyFontSize() {
        if (this._lastMem) this._applyPanelStyle(this._lastMem);
        this._fontSizeItem?.label.set_text(this._fontSizeLabel());
    }

    _setAlignment(align) {
        if (align === this._currentAlign) return;
        this._ext.savePanelPosition(align);

        // Reinicio completo de la extensión: evita un bug de rendering de
        // GNOME Shell al reubicar actores directamente entre boxes del
        // panel. disable/enable no pueden encadenarse en el mismo tick, así
        // que se separan en dos ciclos de idle (mismo patrón que el resto
        // de Powerzoid).
        const uuid = this._ext.uuid;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(uuid);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                Main.extensionManager.enableExtension(uuid);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateAlignMarks(activeAlign) {
        Object.entries(this._alignItems).forEach(([align, item]) => {
            item.setOrnament(
                align === activeAlign ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE
            );
        });
    }

    // Oculta el indicador solo en memoria (sin tocar la config en disco):
    // vuelve a aparecer normalmente en el próximo inicio de sesión.
    _hideForSession() {
        this.menu.close();
        this.hide();
    }

    // ── Menú: procesos activos ──
    _addProcessHeader() {
        const header = new PopupMenu.PopupMenuItem('  Procesos activos', { reactive: false });
        header.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _openProcessMenu() {
        this.menu.removeAll();

        this._addProcessHeader();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('  Cargando…', { reactive: false }));
        this._addHideItem();

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
        } else if (procs.length === 0) {
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('  Sin procesos relevantes', { reactive: false }));
        } else {
            for (const group of procs)
                this.menu.addMenuItem(this._buildProcessItem(group));
        }

        this._addHideItem();
    }

    // Ítem para ocultar el indicador solo en memoria (sin tocar la config en
    // disco): vuelve a aparecer normalmente en el próximo inicio de sesión.
    // Compartido entre el menú de procesos y el de configuración (clic
    // izq. / der.).
    _addHideItem() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const hideItem = new PopupMenu.PopupMenuItem('🙈  Ocultar esta sesión');
        hideItem.connect('activate', () => this._hideForSession());
        this.menu.addMenuItem(hideItem);
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
        // Un clic cierra el menú y abre un diálogo modal de confirmación
        // (mismo mecanismo que "Apagar" en GNOME): siempre queda centrado y
        // visible, sin depender de que el menú tenga espacio para expandir
        // una confirmación en línea.
        const count       = group.pids.length;
        const displayName = friendlyProcessName(group.name);
        const pctLabel    = this._fmtPctOfTotal(group.kb);

        const item = new PopupMenu.PopupMenuItem(
            pctLabel ? `  ${displayName}  —  ${pctLabel}` : `  ${displayName}`);
        item.connect('activate', () => this._confirmAndKill(group, displayName, count));

        return item;
    }

    async _confirmAndKill(group, displayName, count) {
        const text = count > 1
            ? `¿Terminar ${count} procesos de "${displayName}"?`
            : `¿Terminar "${displayName}"?`;
        const confirmed = await confirmKillDialog(text);
        if (!confirmed || this._destroyed) return;
        this._killProcessGroup(group.pids, group.name);
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
        const align    = this._loadPanelPosition();
        const fontSize = this._loadFontSize();
        this._indicator = new RamIndicator(this, align, fontSize);
        // Antes de otros indicadores de sistema, en la posición guardada
        // (por defecto: derecha, como siempre).
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, align);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    // ── Posición en barra ────────────────────────────────────────────────
    _loadPanelPosition() {
        try {
            const file = Gio.File.new_for_path(POSITION_PATH);
            const [, bytes] = file.load_contents(null);
            const val = new TextDecoder().decode(bytes).trim();
            return VALID_ALIGNS.includes(val) ? val : 'right';
        } catch (_e) {}
        return 'right';
    }

    savePanelPosition(align) {
        try {
            Gio.File.new_for_path(CONFIG_DIR).make_directory_with_parents(null);
        } catch (_e) {}
        try {
            const file = Gio.File.new_for_path(POSITION_PATH);
            file.replace_contents(
                new TextEncoder().encode(align),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (_e) {}
    }

    // ── Tamaño de letra ──────────────────────────────────────────────────
    _loadFontSize() {
        try {
            const file = Gio.File.new_for_path(FONT_SIZE_PATH);
            const [, bytes] = file.load_contents(null);
            const val = parseInt(new TextDecoder().decode(bytes).trim(), 10);
            if (Number.isInteger(val))
                return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, val));
        } catch (_e) {}
        return DEFAULT_FONT_SIZE;
    }

    saveFontSize(size) {
        try {
            Gio.File.new_for_path(CONFIG_DIR).make_directory_with_parents(null);
        } catch (_e) {}
        try {
            const file = Gio.File.new_for_path(FONT_SIZE_PATH);
            file.replace_contents(
                new TextEncoder().encode(String(size)),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (_e) {}
    }
}
