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
const RATE_WINDOW_FRACTION = 0.15; // rate window = 15% of time-to-reset
const MAX_DELTA_AGE_MS = 7 * 24 * 3600000; // prune deltas older than 7 days
const TAG = '[ai-usage]';

function detectClaudeCodeVersion() {
    try {
        const link = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
        const info = Gio.File.new_for_path(link).query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        const target = info.get_symlink_target();
        if (target) {
            const basename = GLib.path_get_basename(target);
            if (/^\d+\.\d+\.\d+$/.test(basename)) return basename;
        }
    } catch (_) {}
    return '2.1.71'; // fallback
}

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
            return { token, refreshToken: json.claudeAiOauth.refreshToken ?? null, _raw: json };
        },

        buildRequest(creds) {
            const msg = Soup.Message.new('GET', 'https://api.anthropic.com/api/oauth/usage');
            msg.request_headers.append('Authorization', `Bearer ${creds.token}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            msg.request_headers.append('User-Agent', `claude-code/${detectClaudeCodeVersion()}`);
            return msg;
        },

        parseResponse(data) {
            const windows = [];
            if (data?.five_hour && typeof data.five_hour.utilization === 'number')
                windows.push({ key: 'five_hour', label: '5-Hour', utilization: data.five_hour.utilization, resetsAt: data.five_hour.resets_at });
            if (data?.seven_day && typeof data.seven_day.utilization === 'number')
                windows.push({ key: 'seven_day', label: '7-Day', utilization: data.seven_day.utilization, resetsAt: data.seven_day.resets_at });
            return windows.length > 0 ? windows : null;
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
            const windows = [];
            const rl = data?.rate_limit?.primary_window;
            if (rl)
                windows.push({ key: 'weekly', label: 'Weekly', utilization: rl.used_percent ?? 0, resetsAt: new Date(rl.reset_at * 1000).toISOString() });
            const cr = data?.code_review_rate_limit?.primary_window;
            if (cr)
                windows.push({ key: 'code_review', label: 'Code review', utilization: cr.used_percent ?? 0, resetsAt: new Date(cr.reset_at * 1000).toISOString() });
            return windows.length > 0 ? windows : null;
        },
    };
}

// --- Indicator ---

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'AI Usage Indicator');

        this._destroyed = false;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();

        // Refresh as soon as connectivity returns (e.g. extension enabled
        // at session start before Wi-Fi is up)
        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._netChangedId = this._netMonitor.connect('network-changed', (_m, available) => {
            if (available) this._refreshAll();
        });

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

        // Popup menu sections (rows added dynamically on first data)
        for (const p of this._providers) {
            this.menu.addMenuItem(p.menu.section);
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

    _log(msg) {
        if (this._settings.get_boolean('debug'))
            console.log(`${TAG} ${msg}`);
    }

    _createSession() {
        // Without a timeout, a connection opened while the network is down
        // hangs forever and poisons every later request on the session
        return new Soup.Session({ timeout: 15 });
    }

    // --- Provider init ---

    _initProvider(config) {
        const panel = this._createPanelSection(config.iconPath, config.textLabel);
        this._box.add_child(panel.container);

        const menuSection = new PopupMenu.PopupMenuSection();

        const provider = {
            config,
            state: {
                retryAttempt: 0, loading: false, data: null, error: null,
                history: {},
            },
            panel,
            menu: { section: menuSection, rows: {} },
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
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._tickAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _tickAll() {
        for (const p of this._providers) {
            if (!p.state.data) continue;
            this._computeMargins(p);
            this._updatePanel(p);
            this._updateMenu(p);
        }
    }

    _refreshAll() {
        for (const p of this._providers) this._refreshProvider(p);
    }

    // --- Generic provider fetch pipeline ---

    _refreshProvider(p) {
        if (!this._netMonitor.network_available) {
            this._log(`${p.config.name}: skipping — network unavailable`);
            return;
        }
        if (p._cooldownUntil && Date.now() < p._cooldownUntil) {
            this._log(`${p.config.name}: skipping — cooldown for ${Math.round((p._cooldownUntil - Date.now()) / 1000)}s more`);
            return;
        }
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
                p._lastCreds = creds;
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
            if (this._destroyed) return;
            try {
                const bytes = session.send_and_read_finish(result);

                if (msg.status_code === 401 || msg.status_code === 403) {
                    this._log(`${p.config.name}: HTTP ${msg.status_code} — auth error`);
                    this._setError(p, '🚨');
                    return;
                }
                if (msg.status_code === 429) {
                    p._backoffCount = (p._backoffCount ?? 0) + 1;
                    const backoffSecs = Math.min(600, 60 * Math.pow(2, p._backoffCount - 1));
                    this._log(`${p.config.name}: HTTP 429 — backing off ${backoffSecs}s (attempt ${p._backoffCount})`);
                    // Skip next N regular refreshes by setting a cooldown timestamp
                    p._cooldownUntil = Date.now() + backoffSecs * 1000;
                    return;
                }
                if (msg.status_code !== 200) {
                    this._log(`${p.config.name}: HTTP ${msg.status_code} — retrying`);
                    this._retry(p, '⚠️');
                    return;
                }

                const raw = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._log(`${p.config.name}: raw response: ${JSON.stringify(raw)}`);
                const data = p.config.parseResponse(raw);
                if (!data) {
                    this._log(`${p.config.name}: parseResponse returned null`);
                    this._setError(p, '⚠️');
                    return;
                }
                this._log(`${p.config.name}: parsed windows: ${JSON.stringify(data)}`);

                p.state.retryAttempt = 0;
                p.state.error = null;
                p._backoffCount = 0;
                p._cooldownUntil = null;

                // Record utilization deltas for rate estimation
                const now = Date.now();
                for (const w of data) {
                    if (!p.state.history[w.key])
                        p.state.history[w.key] = { prev: null, deltas: [] };
                    const h = p.state.history[w.key];
                    if (h.prev !== null) {
                        const increase = Math.max(0, w.utilization - h.prev);
                        if (increase > 0) {
                            h.deltas.push({ ts: now, increase });
                            this._log(`${p.config.name}/${w.key}: delta +${increase.toFixed(2)}% (prev=${h.prev.toFixed(2)} new=${w.utilization.toFixed(2)})`);
                        }
                    }
                    h.prev = w.utilization;
                }

                p.state.data = data;
                this._computeMargins(p);
                this._updatePanel(p);
                this._updateMenu(p);
            } catch (e) {
                console.error(`${p.config.name}: fetch error:`, e.message);
                // A stale pooled connection can fail every future request:
                // drop the whole session and start clean on retry
                this._session.abort();
                this._session = this._createSession();
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
        for (const row of Object.values(p.menu.rows))
            this._setMenuRowError(row, emoji);
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
        for (const w of d) {
            const deltas = p.state.history[w.key]?.deltas ?? [];
            const m = this._marginForWindow(w.utilization, w.resetsAt, deltas, now);
            windows.push({ key: w.key, label: w.label, ...m });
        }

        for (const w of windows)
            this._log(`${p.config.name}/${w.key}: util=${w.utilization.toFixed(1)}% margin=${(w.marginMs / 60000).toFixed(1)}min`);

        const willHit = windows.filter(m => m.marginMs < 0);
        const picked = willHit.length > 0
            ? willHit.reduce((a, b) => a.marginMs < b.marginMs ? a : b)
            : windows.reduce((a, b) => a.marginMs < b.marginMs ? a : b);

        this._log(`${p.config.name}: picked=${picked.key} marginMs=${(picked.marginMs / 60000).toFixed(1)}min`);
        p.state.margins = { windows, picked };
    }

    _marginForWindow(utilization, resetsAt, deltas, now) {
        // Prune deltas older than 7 days (hard cap)
        const ageCutoff = now - MAX_DELTA_AGE_MS;
        const before = deltas.length;
        while (deltas.length > 0 && deltas[0].ts < ageCutoff)
            deltas.shift();
        if (before !== deltas.length)
            this._log(`pruned ${before - deltas.length} expired deltas, ${deltas.length} remaining`);

        const resetTime = new Date(resetsAt).getTime();
        const timeToReset = Math.max(0, resetTime - now);
        const remaining = 100 - utilization;

        // Dynamic rate window: fraction of time-to-reset
        const rateWindowMs = timeToReset * RATE_WINDOW_FRACTION;
        const rateCutoff = now - rateWindowMs;
        const rateDeltas = deltas.filter(d => d.ts >= rateCutoff);

        const totalIncrease = rateDeltas.reduce((sum, d) => sum + d.increase, 0);
        const rate = rateWindowMs > 0 ? totalIncrease / rateWindowMs : 0; // % per ms
        const ratePerMin = rate * 60000;

        this._log(`rate: ${ratePerMin.toFixed(4)}%/min (${rateDeltas.length}/${deltas.length} deltas in ${(rateWindowMs / 60000).toFixed(1)}min window, total +${totalIncrease.toFixed(2)}%) remaining=${remaining.toFixed(1)}% resetIn=${(timeToReset / 60000).toFixed(1)}min`);

        let marginMs;
        if (utilization >= 100) {
            marginMs = -timeToReset;
        } else if (rate <= 0) {
            marginMs = timeToReset;
        } else {
            marginMs = (remaining / rate) - timeToReset;
        }

        const projectedAtReset = rate > 0
            ? Math.min(100, utilization + rate * timeToReset)
            : utilization;

        return { utilization, resetsAt, marginMs, projectedAtReset };
    }

    // --- Panel update ---

    _updatePanel(p) {
        const panel = p.panel;
        const m = p.state.margins;
        if (!m) return;

        panel.errorLabel.hide();
        panel.gauge.show();

        const picked = m.picked;
        if (!picked) return;

        panel.gauge._usage = picked.utilization;
        panel.gauge.queue_repaint();

        panel.marginLabel.remove_style_class_name('margin-over');

        panel.marginLabel.show();
        const resetPassed = picked.resetsAt && new Date(picked.resetsAt) <= new Date();
        if (resetPassed) {
            panel.marginLabel.set_text('stale');
            panel.marginLabel.add_style_class_name('margin-over');
        } else if (picked.marginMs > 0) {
            panel.marginLabel.set_text(`→${Math.round(picked.projectedAtReset)}%`);
        } else {
            const formatted = this._formatDuration(Math.abs(picked.marginMs));
            panel.marginLabel.set_text(`+${formatted}`);
            panel.marginLabel.add_style_class_name('margin-over');
        }
    }

    // --- Menu update ---

    _updateMenu(p) {
        const m = p.state.margins;
        if (!m) return;

        const activeKeys = new Set(m.windows.map(w => w.key));

        for (const w of m.windows) {
            if (!p.menu.rows[w.key]) {
                const row = this._createMenuRow(p.config.iconPath, p.config.textLabel, w.label);
                p.menu.rows[w.key] = row;
                p.menu.section.addMenuItem(row.item);
            }
            p.menu.rows[w.key].item.show();
            this._updateMenuRow(p.menu.rows[w.key], w);
        }

        for (const [key, row] of Object.entries(p.menu.rows)) {
            if (!activeKeys.has(key)) row.item.hide();
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

        const resetPassed = resetsAt && new Date(resetsAt) <= new Date();

        if (resetPassed) {
            row.resetLabel.set_text('Reset passed — data stale');
            row.marginLabel.remove_style_class_name('menu-margin-over');
            row.marginLabel.set_text('likely 0% now');
            return;
        }

        row.resetLabel.set_text(resetsAt ? `Resets in ${this._formatResetTime(resetsAt)}` : '');

        row.marginLabel.remove_style_class_name('menu-margin-over');

        if (!resetsAt) { row.marginLabel.set_text(''); return; }

        if (marginMs > 0) {
            row.marginLabel.set_text(`→${Math.round(margin.projectedAtReset)}% at reset`);
        } else {
            const absDur = Math.abs(marginMs);
            const formatted = absDur < 60000 ? 'soon' : this._formatDuration(absDur);
            row.marginLabel.set_text(`▲ ${formatted} before reset`);
            row.marginLabel.add_style_class_name('menu-margin-over');
        }
    }

    // --- Utilities ---

    _formatDuration(ms) {
        if (ms < 60000) return '<1m';
        const mins = Math.floor(ms / 60000);
        const hours = Math.floor(mins / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${mins % 60}m`;
        return `${mins}m`;
    }

    _formatResetTime(iso) {
        try {
            const diff = new Date(iso) - new Date();
            if (diff <= 0) return 'passed — data stale';
            return this._formatDuration(diff);
        }
        catch (e) { return '\u2014'; }
    }

    destroy() {
        this._destroyed = true;
        this._stopTimer();
        if (this._netChangedId) { this._netMonitor.disconnect(this._netChangedId); this._netChangedId = null; }
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
