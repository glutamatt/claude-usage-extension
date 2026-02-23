import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GAUGE_SIZE = 18;
const GAUGE_LINE = 2.5;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [5, 10, 20];
const FIVE_HOUR_MS = 5 * 3600000;
const SEVEN_DAY_MS = 7 * 86400000;

// --- Provider definitions ---
// Each provider only specifies what's unique: where to find credentials,
// how to build the HTTP request, and how to normalize the response.

function claudeConfig(extensionPath) {
    return {
        name: 'Claude',
        iconPath: GLib.build_filenamev([extensionPath, 'claude-icon-22.png']),
        textLabel: null,

        credentialsPath() {
            const dir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
                GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
            return GLib.build_filenamev([dir, '.credentials.json']);
        },

        extractCredentials(json) {
            const token = json?.claudeAiOauth?.accessToken;
            if (!token || typeof token !== 'string' || token.trim() === '')
                return null;
            return { token };
        },

        buildRequest(creds) {
            const msg = Soup.Message.new('GET', 'https://api.anthropic.com/api/oauth/usage');
            msg.request_headers.append('Authorization', `Bearer ${creds.token}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            return msg;
        },

        parseResponse(data) {
            if (!data?.five_hour || !data?.seven_day) return null;
            if (typeof data.five_hour.utilization !== 'number') return null;
            if (typeof data.seven_day.utilization !== 'number') return null;
            return {
                fiveHour: { utilization: data.five_hour.utilization, resetsAt: data.five_hour.resets_at },
                sevenDay: { utilization: data.seven_day.utilization, resetsAt: data.seven_day.resets_at },
            };
        },
    };
}

function codexConfig(extensionPath) {
    return {
        name: 'Codex',
        iconPath: GLib.build_filenamev([extensionPath, 'codex-icon-22.png']),
        textLabel: null,

        credentialsPath() {
            const dir = GLib.getenv('CODEX_HOME') ??
                GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
            return GLib.build_filenamev([dir, 'auth.json']);
        },

        extractCredentials(json) {
            const token = json?.tokens?.access_token;
            const accountId = json?.tokens?.account_id;
            if (!token || !accountId) return null;
            return { token, accountId };
        },

        buildRequest(creds) {
            const msg = Soup.Message.new('GET', 'https://chatgpt.com/backend-api/wham/usage');
            msg.request_headers.append('Authorization', `Bearer ${creds.token}`);
            msg.request_headers.append('chatgpt-account-id', creds.accountId);
            return msg;
        },

        parseResponse(data) {
            const primary = data?.rate_limit?.primary_window;
            if (!primary) return null;
            const secondary = data?.rate_limit?.secondary_window;
            return {
                fiveHour: {
                    utilization: primary.used_percent ?? 0,
                    resetsAt: new Date(primary.reset_at * 1000).toISOString(),
                },
                sevenDay: secondary ? {
                    utilization: secondary.used_percent ?? 0,
                    resetsAt: new Date(secondary.reset_at * 1000).toISOString(),
                } : null,
            };
        },
    };
}

// --- Indicator ---

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'AI Usage Indicator');

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = new Soup.Session();

        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        // Build providers from config
        this._providers = [
            this._initProvider(claudeConfig(extensionPath)),
            this._initProvider(codexConfig(extensionPath)),
        ];

        // Add a left margin to every provider after the first
        for (let i = 1; i < this._providers.length; i++)
            this._providers[i].panel.container.set_style('margin-left: 8px;');

        this.add_child(this._box);

        // Popup menu rows + settings
        for (const p of this._providers) {
            this.menu.addMenuItem(p.menu.fiveHour.item);
            this.menu.addMenuItem(p.menu.sevenDay.item);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(settingsItem);

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') this._restartTimer();
        });

        this._refreshAll();
        this._startTimer();
    }

    // --- Provider init ---

    _initProvider(config) {
        const panel = this._createPanelSection(config.iconPath, config.textLabel);
        this._box.add_child(panel.container);

        const provider = {
            config,
            state: { retryAttempt: 0, loading: false, data: null, error: null },
            panel,
            menu: {
                fiveHour: this._createMenuRow(config.iconPath, config.textLabel, '5-Hour'),
                sevenDay: this._createMenuRow(config.iconPath, config.textLabel, '7-Day'),
            },
        };
        return provider;
    }

    // --- UI builders ---

    _createPanelSection(iconPath, textLabel) {
        const container = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });

        if (iconPath) {
            container.add_child(new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                style_class: 'panel-icon',
                icon_size: 16,
            }));
        } else if (textLabel) {
            container.add_child(new St.Label({
                text: textLabel,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-provider-label',
            }));
        }

        const gauge = new St.DrawingArea({
            width: GAUGE_SIZE,
            height: GAUGE_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        gauge._usage = 0;
        gauge.connect('repaint', () => this._drawGauge(gauge));
        container.add_child(gauge);

        const marginLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-margin',
        });
        container.add_child(marginLabel);

        const errorLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-error',
        });
        errorLabel.hide();
        container.add_child(errorLabel);

        return { container, gauge, marginLabel, errorLabel };
    }

    _createMenuRow(iconPath, textLabel, windowLabel) {
        const box = new St.BoxLayout({ style_class: 'menu-metric', vertical: true });

        // Line 1: [icon] Window : DD% [========----]
        const line1 = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });

        if (iconPath) {
            line1.add_child(new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                style_class: 'menu-metric-icon',
                icon_size: 14,
            }));
        } else if (textLabel) {
            line1.add_child(new St.Label({
                text: textLabel,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'menu-metric-provider',
            }));
        }

        const headerLabel = new St.Label({
            text: `${windowLabel} : ...`,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'menu-metric-header',
        });
        line1.add_child(headerLabel);

        const progressBg = new St.Widget({
            style_class: 'menu-bar-bg',
            x_expand: true,
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const progressBar = new St.Widget({ style_class: 'menu-bar-fill usage-low' });
        progressBg.add_child(progressBar);
        progressBg.connect('notify::allocation', () => this._syncMenuBarWidth(progressBar));
        line1.add_child(progressBg);
        box.add_child(line1);

        // Line 2: Resets in Xh Ym          Xh Ym to spare
        const line2 = new St.BoxLayout({ vertical: false });
        const resetLabel = new St.Label({ text: '', style_class: 'menu-metric-reset' });
        line2.add_child(resetLabel);
        const marginLabel = new St.Label({
            text: '',
            style_class: 'menu-metric-margin',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        line2.add_child(marginLabel);
        box.add_child(line2);

        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.add_child(box);

        return { item, headerLabel, progressBg, progressBar, resetLabel, marginLabel, windowLabel };
    }

    _drawGauge(gauge) {
        const cr = gauge.get_context();
        const [w, h] = gauge.get_surface_size();
        const cx = w / 2, cy = h / 2;
        const radius = Math.min(w, h) / 2 - GAUGE_LINE / 2;

        cr.setLineWidth(GAUGE_LINE);
        cr.setLineCap(1); // ROUND

        // Background ring
        cr.setSourceRGBA(1, 1, 1, 0.2);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Usage arc (from 12 o'clock, clockwise)
        const usage = Math.min(100, Math.max(0, gauge._usage));
        if (usage > 0) {
            cr.setSourceRGBA(1, 1, 1, 1);
            const start = -Math.PI / 2;
            cr.arc(cx, cy, radius, start, start + (usage / 100) * 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }

    _syncMenuBarWidth(bar) {
        const usage = bar._usage;
        if (usage === undefined) return;
        const parent = bar.get_parent();
        if (!parent) return;
        const w = parent.get_allocation_box().get_width();
        if (w <= 0) return;
        bar.set_width(Math.round((Math.min(100, Math.max(0, usage)) / 100) * w));
    }

    // --- Timer ---

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refreshAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _refreshAll() {
        for (const p of this._providers) this._refreshProvider(p);
    }

    // --- Generic provider fetch pipeline ---

    _refreshProvider(p) {
        const path = p.config.credentialsPath();
        const file = Gio.File.new_for_path(path);

        file.load_contents_async(null, (f, result) => {
            try {
                const [success, contents] = f.load_contents_finish(result);
                if (!success) {
                    this._setError(p, '⚠️');
                    return;
                }
                const json = JSON.parse(new TextDecoder().decode(contents));
                const creds = p.config.extractCredentials(json);
                if (!creds) {
                    this._setError(p, '⚠️');
                    return;
                }
                this._fetchProvider(p, creds);
            } catch (e) {
                console.error(`${p.config.name}: credentials error:`, e.message);
                this._setError(p, '⚠️');
            }
        });
    }

    _fetchProvider(p, creds) {
        if (p.state.loading) return;
        p.state.loading = true;

        const msg = p.config.buildRequest(creds);

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            p.state.loading = false;
            try {
                const bytes = session.send_and_read_finish(result);

                if (msg.status_code === 401 || msg.status_code === 403) {
                    this._retry(p, '🚨');
                    return;
                }
                if (msg.status_code !== 200) {
                    this._retry(p, '⚠️');
                    return;
                }

                const raw = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const data = p.config.parseResponse(raw);
                if (!data) {
                    this._setError(p, '⚠️');
                    return;
                }

                p.state.retryAttempt = 0;
                p.state.error = null;
                p.state.data = data;
                this._computeMargins(p);
                this._updatePanel(p);
                this._updateMenu(p);
            } catch (e) {
                console.error(`${p.config.name}: fetch error:`, e.message);
                this._retry(p, '⚠️');
            }
        });
    }

    // --- Error / retry ---

    _setError(p, emoji) {
        p.state.error = emoji;
        p.state.data = null;
        const panel = p.panel;
        panel.gauge.hide();
        panel.marginLabel.hide();
        panel.errorLabel.set_text(emoji);
        panel.errorLabel.show();
        this._setMenuRowError(p.menu.fiveHour, emoji);
        this._setMenuRowError(p.menu.sevenDay, emoji);
    }

    _retry(p, emoji) {
        if (p.state.retryAttempt < MAX_RETRY_ATTEMPTS) {
            const delay = RETRY_DELAYS[p.state.retryAttempt];
            p.panel.gauge.hide();
            p.panel.marginLabel.hide();
            p.panel.errorLabel.set_text('⏳');
            p.panel.errorLabel.show();
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                p.state.retryAttempt++;
                this._refreshProvider(p);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._setError(p, emoji);
        }
    }

    // --- Compute margins once, reuse everywhere ---

    _computeMargins(p) {
        const d = p.state.data;
        if (!d) { p.state.margins = null; return; }

        const now = Date.now();
        const windows = [];
        if (d.fiveHour) {
            const m = this._marginForWindow(d.fiveHour.utilization, d.fiveHour.resetsAt, FIVE_HOUR_MS, now);
            windows.push({ key: 'fiveHour', ...m });
        }
        if (d.sevenDay) {
            const m = this._marginForWindow(d.sevenDay.utilization, d.sevenDay.resetsAt, SEVEN_DAY_MS, now);
            windows.push({ key: 'sevenDay', ...m });
        }

        const willHit = windows.filter(m => m.marginMs < 0);
        const picked = willHit.length > 0
            ? willHit.reduce((a, b) => a.marginMs < b.marginMs ? a : b)
            : windows.reduce((a, b) => a.marginMs < b.marginMs ? a : b);

        p.state.margins = { windows, picked };
    }

    _marginForWindow(utilization, resetsAt, windowMs, now) {
        const resetTime = new Date(resetsAt).getTime();
        const elapsed = Math.max(0, Math.min(windowMs - (resetTime - now), windowMs));
        const delta = utilization - (elapsed / windowMs) * 100;
        const marginMs = -(delta / 100) * windowMs;
        return { utilization, resetsAt, marginMs, delta };
    }

    // --- Panel update ---

    _updatePanel(p) {
        const panel = p.panel;
        const m = p.state.margins;
        if (!m) return;

        panel.errorLabel.hide();
        panel.gauge.show();
        panel.marginLabel.show();

        const picked = m.picked;
        if (!picked) return;

        panel.gauge._usage = picked.utilization;
        panel.gauge.queue_repaint();

        panel.marginLabel.remove_style_class_name('margin-ok');
        panel.marginLabel.remove_style_class_name('margin-over');

        const formatted = this._formatDuration(Math.abs(picked.marginMs));
        if (picked.marginMs > 0) {
            panel.marginLabel.set_text(`-${formatted}`);
            panel.marginLabel.add_style_class_name('margin-ok');
        } else {
            panel.marginLabel.set_text(`+${formatted}`);
            panel.marginLabel.add_style_class_name('margin-over');
        }
    }

    // --- Menu update ---

    _updateMenu(p) {
        const m = p.state.margins;
        if (!m) return;

        const fiveHour = m.windows.find(w => w.key === 'fiveHour');
        const sevenDay = m.windows.find(w => w.key === 'sevenDay');

        if (fiveHour) this._updateMenuRow(p.menu.fiveHour, fiveHour);
        if (sevenDay) {
            p.menu.sevenDay.item.show();
            this._updateMenuRow(p.menu.sevenDay, sevenDay);
        } else {
            p.menu.sevenDay.item.hide();
        }
    }

    _setMenuRowError(row, emoji) {
        row.headerLabel.set_text(`${row.windowLabel} : ${emoji}`);
        row.progressBg.hide();
        row.resetLabel.set_text('');
        row.marginLabel.set_text('');
    }

    _updateMenuRow(row, margin) {
        const { utilization, resetsAt, marginMs } = margin;

        row.headerLabel.set_text(`${row.windowLabel} : ${Math.round(utilization)}%`);
        row.progressBg.show();

        const bar = row.progressBar;
        bar._usage = utilization;
        this._syncMenuBarWidth(bar);

        bar.remove_style_class_name('usage-low');
        bar.remove_style_class_name('usage-medium');
        bar.remove_style_class_name('usage-high');
        bar.remove_style_class_name('usage-critical');
        if (utilization >= 90) bar.add_style_class_name('usage-critical');
        else if (utilization >= 70) bar.add_style_class_name('usage-high');
        else if (utilization >= 40) bar.add_style_class_name('usage-medium');
        else bar.add_style_class_name('usage-low');

        row.resetLabel.set_text(resetsAt ? `Resets in ${this._formatResetTime(resetsAt)}` : '');

        row.marginLabel.remove_style_class_name('menu-margin-ok');
        row.marginLabel.remove_style_class_name('menu-margin-over');
        row.marginLabel.remove_style_class_name('menu-margin-neutral');

        if (!resetsAt) { row.marginLabel.set_text(''); return; }

        const formatted = this._formatDuration(Math.abs(marginMs));
        if (marginMs > 0) {
            row.marginLabel.set_text(`${formatted} to spare`);
            row.marginLabel.add_style_class_name('menu-margin-ok');
        } else {
            row.marginLabel.set_text(`▲ ${formatted} over`);
            row.marginLabel.add_style_class_name('menu-margin-over');
        }
    }

    // --- Utilities ---

    _formatDuration(ms) {
        if (ms <= 0) return 'now';
        const mins = Math.floor(ms / 60000);
        const hours = Math.floor(mins / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${mins % 60}m`;
        return `${mins}m`;
    }

    _formatResetTime(iso) {
        try { return this._formatDuration(new Date(iso) - new Date()); }
        catch (e) { return '\u2014'; }
    }

    destroy() {
        this._stopTimer();
        if (this._session) { this._session.abort(); this._session = null; }
        if (this._settingsChangedId) { this._settings.disconnect(this._settingsChangedId); this._settingsChangedId = null; }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new UsageIndicator(this.path, this._settings, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
