// ThinkFan Control - author: growlnx
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { QuickSlider, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

const LEVELS = [
    { id: 'auto', label: 'Auto' },
    { id: '1', label: 'Silent (1)' },
    { id: '2', label: 'Quiet (2)' },
    { id: '3', label: 'Light (3)' },
    { id: '4', label: 'Balanced (4)' },
    { id: '5', label: 'Strong (5)' },
    { id: '6', label: 'High (6)' },
    { id: '7', label: 'Max (7)' },
    { id: 'full-speed', label: 'Turbo' },
    // { id: 'disengaged', label: 'Disengaged (max, unsafe)' },
];

function readFan() {
    try {
        const [ok, bytes] = GLib.file_get_contents('/proc/acpi/ibm/fan');
        if (!ok) return null;
        const t = new TextDecoder().decode(bytes);
        return {
            rpm: (t.match(/^speed:\s*(\d+)/m) ?? [])[1] ?? '?',
            level: (t.match(/^level:\s*(\S+)/m) ?? [])[1] ?? '?',
        };
    } catch (_e) {
        return null;
    }
}

// Slider = one equal zone per entry in LEVELS (same order). Never 0/off: unsafe.
const ZONES = LEVELS.length;
const zoneOf = v => Math.min(ZONES - 1, Math.floor(v * ZONES));
const levelOfZone = z => LEVELS[z].id;

const CONF = GLib.build_filenamev([GLib.get_user_config_dir(), 'thinkfan-growlnx.json']);
const VALID = new Set(LEVELS.map(l => l.id));

function loadLevel() {
    try {
        const [ok, bytes] = GLib.file_get_contents(CONF);
        if (!ok) return null;
        const level = JSON.parse(new TextDecoder().decode(bytes)).level;
        return VALID.has(level) ? level : null;
    } catch (_e) {
        return null;
    }
}

function saveLevel(level) {
    try {
        GLib.file_set_contents(CONF, JSON.stringify({ level }));
    } catch (e) {
        console.error(`thinkfan: could not save config: ${e.message}`);
    }
}

const FanSlider = GObject.registerClass(
    class FanSlider extends QuickSlider {
        _init() {
            super._init({ iconName: 'weather-windy-symbolic', iconReactive: true, menuEnabled: true });
            this.menu.setHeader('weather-windy-symbolic', 'ThinkPad Fan', '');
            this._updating = false;
            this._debounce = 0;
            this._items = new Map();

            // Menu (arrow button, like the volume slider): all levels
            for (const { id, label } of LEVELS) {
                const item = new PopupMenu.PopupMenuItem(label);
                item.connect('activate', () => this._set(id));
                this.menu.addMenuItem(item);
                this._items.set(id, item);
            }

            // Click on the icon = back to auto (like the mute toggle).
            this.connectObject('icon-clicked', () => this._set('auto'), this);

            this.slider.connectObject('notify::value', () => {
                if (this._updating) return;
                if (this._debounce) GLib.source_remove(this._debounce);
                this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._debounce = 0;
                    this._set(levelOfZone(zoneOf(this.slider.value)));
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
            this.refresh();
        }

        _set(level) {
            try {
                const p = Gio.Subprocess.new(['pkexec', '/usr/bin/thinkfan-set', level],
                    Gio.SubprocessFlags.STDERR_PIPE);
                p.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, , err] = proc.communicate_utf8_finish(res);
                        if (!proc.get_successful())
                            Main.notifyError('ThinkFan', err || 'failed to set fan level');
                        // Remember-last-level disabled for now:
                        // else saveLevel(level);
                    } catch (e) {
                        Main.notifyError('ThinkFan', `${e.message}`);
                    }
                    this.refresh();
                });
            } catch (e) {
                Main.notifyError('ThinkFan', `${e.message}`);
            }
        }

        refresh() {
            const s = readFan();
            if (!s) {
                this.menu.setHeader('weather-windy-symbolic', 'ThinkPad Fan', 'unavailable');
                return;
            }
            this.menu.setHeader('weather-windy-symbolic', 'ThinkPad Fan',
                `${s.rpm} RPM · ${s.level}`);
            for (const [id, item] of this._items)
                item.setOrnament(id === s.level ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

            // Don't fight the user while dragging / pending change.
            if (this._debounce || this.slider._dragging) return;
            // Level not in LEVELS (e.g. disengaged while hidden) -> last zone.
            const i = LEVELS.findIndex(l => l.id === s.level);
            const z = i < 0 ? ZONES - 1 : i;
            // Auto sits exactly at 0; other levels at the middle of their zone.
            const target = z === 0 ? 0 : (z + 0.5) / ZONES;
            if (z === 0 ? this.slider.value === 0 : zoneOf(this.slider.value) === z) return;
            this._updating = true;
            this.slider.value = target;
            this._updating = false;
        }

        // Re-apply the level saved in the last session (auto is the boot default).
        restore() {
            const level = loadLevel();
            if (!level || level === 'auto') return;
            if (readFan()?.level === level) return;
            this._set(level);
        }

        destroy() {
            if (this._debounce) GLib.source_remove(this._debounce);
            this._debounce = 0;
            super.destroy();
        }
    });

const FanIndicator = GObject.registerClass(
    class FanIndicator extends SystemIndicator {
        _init() {
            super._init();
            this.slider = new FanSlider();
            this.quickSettingsItems.push(this.slider);
        }
    });

export default class ThinkFanExtension extends Extension {
    enable() {
        this._ind = new FanIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._ind, 2);
        // The system items (volume etc.) are added to the grid after extensions
        // are enabled at login, so re-place whenever the grid gets a new child.
        this._grid = this._ind.slider.get_parent();
        this._gridId = this._grid.connect('child-added', () => this._queuePlace());
        this._queuePlace();
        // Remember-last-level disabled for now:
        // this._restoreId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        //     this._restoreId = 0;
        //     this._ind?.slider.restore();
        //     return GLib.SOURCE_REMOVE;
        // });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._ind.slider.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _queuePlace() {
        if (this._placeId) return;
        this._placeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._placeId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _place() {
        try {
            const mine = this._ind?.slider;
            const grid = this._grid;
            if (!mine || !grid) return;
            const kids = grid.get_children();
            // Volume output = first slider-like child in the grid that isn't ours.
            const vol = kids.find(c => c !== mine && c.slider);
            if (!vol) return;
            if (kids.indexOf(mine) === kids.indexOf(vol) + 1) return;
            grid.set_child_above_sibling(mine, vol);
        } catch (e) {
            console.error(`thinkfan: could not reposition slider: ${e.message}`);
        }
    }

    disable() {
        if (this._placeId) GLib.source_remove(this._placeId);
        this._placeId = 0;
        if (this._restoreId) GLib.source_remove(this._restoreId);
        this._restoreId = 0;
        if (this._gridId) {
            try { this._grid.disconnect(this._gridId); } catch (_e) { /* grid gone */ }
        }
        this._gridId = 0;
        this._grid = null;
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._ind?.quickSettingsItems.forEach(i => i.destroy());
        this._ind?.destroy();
        this._ind = null;
    }
}
