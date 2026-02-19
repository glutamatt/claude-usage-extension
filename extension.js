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

const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const PANEL_BAR_WIDTH = 50;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [5, 10, 20];
const FIVE_HOUR_MS = 5 * 3600000;
const SEVEN_DAY_MS = 7 * 86400000;

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'AI Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = new Soup.Session();

        // Per-provider state
        this._claude = { retryAttempt: 0, loading: false, data: null, error: null };
        this._codex = { retryAttempt: 0, loading: false, data: null, error: null };

        // --- Top bar layout ---
        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        // Claude panel section
        this._claudePanel = this._createPanelSection(
            GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']),
            null
        );
        this._box.add_child(this._claudePanel.container);

        // Codex panel section
        this._codexPanel = this._createPanelSection(
            null,
            'Cx'
        );
        this._codexPanel.container.set_style('margin-left: 8px;');
        this._box.add_child(this._codexPanel.container);

        this.add_child(this._box);

        // --- Popup menu ---
        this._createMenu();

        // Settings & timer
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') this._restartTimer();
        });

        this._refreshAll();
        this._startTimer();
    }

    _createPanelSection(iconPath, textLabel) {
        const container = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });

        if (iconPath) {
            const gicon = Gio.icon_new_for_string(iconPath);
            const icon = new St.Icon({
                gicon,
                style_class: 'panel-icon',
                icon_size: 16,
            });
            container.add_child(icon);
        } else if (textLabel) {
            const label = new St.Label({
                text: textLabel,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-provider-label',
            });
            container.add_child(label);
        }

        const progressBg = new St.Widget({
            style_class: 'panel-bar-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const progressBar = new St.Widget({ style_class: 'panel-bar-fill' });
        progressBg.add_child(progressBar);
        container.add_child(progressBg);

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

        return { container, progressBg, progressBar, marginLabel, errorLabel };
    }

    _createMenu() {
        // Claude sections
        this._claudeMenu5h = this._createMenuRow(
            GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']),
            null, '5-Hour'
        );
        this.menu.addMenuItem(this._claudeMenu5h.item);

        this._claudeMenu7d = this._createMenuRow(
            GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']),
            null, '7-Day'
        );
        this.menu.addMenuItem(this._claudeMenu7d.item);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Codex sections
        this._codexMenu5h = this._createMenuRow(null, 'Cx', '5-Hour');
        this.menu.addMenuItem(this._codexMenu5h.item);

        this._codexMenu7d = this._createMenuRow(null, 'Cx', '7-Day');
        this.menu.addMenuItem(this._codexMenu7d.item);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    // Creates a condensed popup row:
    // Line 1: [icon] 5-Hour : 42% [========----]
    // Line 2:        Resets in 3h 15m     2h to spare
    _createMenuRow(iconPath, textLabel, windowLabel) {
        const box = new St.BoxLayout({
            style_class: 'menu-metric',
            vertical: true,
        });

        // Line 1: icon + label + gauge
        const line1 = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });

        if (iconPath) {
            const gicon = Gio.icon_new_for_string(iconPath);
            const icon = new St.Icon({
                gicon,
                style_class: 'menu-metric-icon',
                icon_size: 14,
            });
            line1.add_child(icon);
        } else if (textLabel) {
            const label = new St.Label({
                text: textLabel,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'menu-metric-provider',
            });
            line1.add_child(label);
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
        const progressBar = new St.Widget({
            style_class: 'menu-bar-fill usage-low',
        });
        progressBg.add_child(progressBar);
        progressBg.connect('notify::allocation', () => {
            this._syncMenuBarWidth(progressBar);
        });
        line1.add_child(progressBg);
        box.add_child(line1);

        // Line 2: reset left, margin right
        const line2 = new St.BoxLayout({ vertical: false });

        const resetLabel = new St.Label({
            text: '',
            style_class: 'menu-metric-reset',
        });
        line2.add_child(resetLabel);

        const marginLabel = new St.Label({
            text: '',
            style_class: 'menu-metric-margin',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        line2.add_child(marginLabel);

        box.add_child(line2);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(box);

        return {
            item, headerLabel, progressBg, progressBar,
            resetLabel, marginLabel, windowLabel,
        };
    }

    _syncMenuBarWidth(bar) {
        const usage = bar._usage;
        if (usage === undefined) return;
        const parent = bar.get_parent();
        if (!parent) return;
        const alloc = parent.get_allocation_box();
        const w = alloc.get_width();
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
        this._refreshClaude();
        this._refreshCodex();
    }

    // --- Claude provider ---

    _refreshClaude() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const path = GLib.build_filenamev([configDir, '.credentials.json']);

        this._loadJsonFile(path, (json) => {
            const token = json?.claudeAiOauth?.accessToken;
            if (!token || typeof token !== 'string' || token.trim() === '') {
                this._setProviderError(this._claude, this._claudePanel, 'No token');
                this._updateClaudeMenu();
                return;
            }
            this._fetchClaude(token);
        }, (err) => {
            this._setProviderError(this._claude, this._claudePanel, '⚠️');
            this._updateClaudeMenu();
        });
    }

    _fetchClaude(token) {
        if (this._claude.loading) return;
        this._claude.loading = true;

        const msg = Soup.Message.new('GET', CLAUDE_API_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            this._claude.loading = false;
            try {
                const bytes = session.send_and_read_finish(result);

                if (msg.status_code === 401 || msg.status_code === 403) {
                    this._handleProviderRetry(this._claude, this._claudePanel, '🚨', () => this._refreshClaude());
                    return;
                }
                if (msg.status_code !== 200) {
                    this._handleProviderRetry(this._claude, this._claudePanel, '⚠️', () => this._refreshClaude());
                    return;
                }

                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                if (!data?.five_hour?.utilization === undefined || data?.seven_day?.utilization === undefined) {
                    this._setProviderError(this._claude, this._claudePanel, '⚠️');
                    this._updateClaudeMenu();
                    return;
                }

                this._claude.retryAttempt = 0;
                this._claude.error = null;
                this._claude.data = {
                    fiveHour: { utilization: data.five_hour.utilization, resetsAt: data.five_hour.resets_at },
                    sevenDay: { utilization: data.seven_day.utilization, resetsAt: data.seven_day.resets_at },
                };
                this._updateClaudePanel();
                this._updateClaudeMenu();
            } catch (e) {
                console.error('Claude fetch error:', e.message);
                this._handleProviderRetry(this._claude, this._claudePanel, '⚠️', () => this._refreshClaude());
            }
        });
    }

    _updateClaudePanel() {
        this._updateProviderPanel(this._claude, this._claudePanel);
    }

    _updateClaudeMenu() {
        if (this._claude.error) {
            this._setMenuRowError(this._claudeMenu5h, this._claude.error);
            this._setMenuRowError(this._claudeMenu7d, this._claude.error);
            return;
        }
        if (!this._claude.data) return;
        const d = this._claude.data;
        this._updateMenuRow(this._claudeMenu5h, d.fiveHour.utilization, d.fiveHour.resetsAt, FIVE_HOUR_MS);
        this._updateMenuRow(this._claudeMenu7d, d.sevenDay.utilization, d.sevenDay.resetsAt, SEVEN_DAY_MS);
    }

    // --- Codex provider ---

    _refreshCodex() {
        const codexHome = GLib.getenv('CODEX_HOME') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        const path = GLib.build_filenamev([codexHome, 'auth.json']);

        this._loadJsonFile(path, (json) => {
            const token = json?.tokens?.access_token;
            const accountId = json?.tokens?.account_id;
            if (!token || !accountId) {
                this._setProviderError(this._codex, this._codexPanel, 'No token');
                this._updateCodexMenu();
                return;
            }
            this._fetchCodex(token, accountId);
        }, (err) => {
            this._setProviderError(this._codex, this._codexPanel, '⚠️');
            this._updateCodexMenu();
        });
    }

    _fetchCodex(token, accountId) {
        if (this._codex.loading) return;
        this._codex.loading = true;

        const msg = Soup.Message.new('GET', CODEX_API_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('chatgpt-account-id', accountId);

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            this._codex.loading = false;
            try {
                const bytes = session.send_and_read_finish(result);

                if (msg.status_code === 401 || msg.status_code === 403) {
                    this._handleProviderRetry(this._codex, this._codexPanel, '🚨', () => this._refreshCodex());
                    return;
                }
                if (msg.status_code !== 200) {
                    this._handleProviderRetry(this._codex, this._codexPanel, '⚠️', () => this._refreshCodex());
                    return;
                }

                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const primary = data?.rate_limit?.primary_window;
                const secondary = data?.rate_limit?.secondary_window;
                if (!primary) {
                    this._setProviderError(this._codex, this._codexPanel, '⚠️');
                    this._updateCodexMenu();
                    return;
                }

                this._codex.retryAttempt = 0;
                this._codex.error = null;
                this._codex.data = {
                    fiveHour: {
                        utilization: primary.used_percent ?? 0,
                        resetsAt: new Date(primary.reset_at * 1000).toISOString(),
                    },
                    sevenDay: secondary ? {
                        utilization: secondary.used_percent ?? 0,
                        resetsAt: new Date(secondary.reset_at * 1000).toISOString(),
                    } : null,
                };
                this._updateCodexPanel();
                this._updateCodexMenu();
            } catch (e) {
                console.error('Codex fetch error:', e.message);
                this._handleProviderRetry(this._codex, this._codexPanel, '⚠️', () => this._refreshCodex());
            }
        });
    }

    _updateCodexPanel() {
        this._updateProviderPanel(this._codex, this._codexPanel);
    }

    _updateCodexMenu() {
        if (this._codex.error) {
            this._setMenuRowError(this._codexMenu5h, this._codex.error);
            this._setMenuRowError(this._codexMenu7d, this._codex.error);
            return;
        }
        if (!this._codex.data) return;
        const d = this._codex.data;
        this._updateMenuRow(this._codexMenu5h, d.fiveHour.utilization, d.fiveHour.resetsAt, FIVE_HOUR_MS);
        if (d.sevenDay) {
            this._codexMenu7d.item.show();
            this._updateMenuRow(this._codexMenu7d, d.sevenDay.utilization, d.sevenDay.resetsAt, SEVEN_DAY_MS);
        } else {
            this._codexMenu7d.item.hide();
        }
    }

    // --- Shared provider logic ---

    _loadJsonFile(path, onSuccess, onError) {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (f, result) => {
            try {
                const [success, contents] = f.load_contents_finish(result);
                if (!success) { onError('File not found'); return; }
                const json = JSON.parse(new TextDecoder().decode(contents));
                onSuccess(json);
            } catch (e) {
                onError(e.message);
            }
        });
    }

    _setProviderError(provider, panel, emoji) {
        provider.error = emoji;
        provider.data = null;
        panel.progressBg.hide();
        panel.marginLabel.hide();
        panel.errorLabel.set_text(emoji);
        panel.errorLabel.show();
    }

    _handleProviderRetry(provider, panel, emoji, retryFn) {
        if (provider.retryAttempt < MAX_RETRY_ATTEMPTS) {
            const delay = RETRY_DELAYS[provider.retryAttempt];
            panel.progressBg.hide();
            panel.marginLabel.hide();
            panel.errorLabel.set_text('⏳');
            panel.errorLabel.show();
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                provider.retryAttempt++;
                retryFn();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._setProviderError(provider, panel, emoji);
        }
    }

    _updateProviderPanel(provider, panel) {
        if (provider.error || !provider.data) return;

        panel.errorLabel.hide();
        panel.progressBg.show();
        panel.marginLabel.show();

        const d = provider.data;
        const margins = [];

        if (d.fiveHour) {
            const pace = this._computePace(d.fiveHour.utilization, d.fiveHour.resetsAt, FIVE_HOUR_MS);
            margins.push({
                usage: d.fiveHour.utilization,
                marginMs: -(pace.delta / 100) * FIVE_HOUR_MS,
                delta: pace.delta,
            });
        }
        if (d.sevenDay) {
            const pace = this._computePace(d.sevenDay.utilization, d.sevenDay.resetsAt, SEVEN_DAY_MS);
            margins.push({
                usage: d.sevenDay.utilization,
                marginMs: -(pace.delta / 100) * SEVEN_DAY_MS,
                delta: pace.delta,
            });
        }

        // Pick worst margin for panel display
        const willHit = margins.filter(m => m.marginMs < 0);
        let picked;
        if (willHit.length > 0) {
            picked = willHit.reduce((a, b) => a.marginMs < b.marginMs ? a : b);
        } else if (margins.length > 0) {
            picked = margins.reduce((a, b) => a.marginMs < b.marginMs ? a : b);
        }

        if (!picked) return;

        // Panel bar: always white, just set width
        const width = Math.round((Math.min(100, Math.max(0, picked.usage)) / 100) * PANEL_BAR_WIDTH);
        panel.progressBar.set_width(width);

        // Margin label: colored only when relevant (usage > 3% delta)
        panel.marginLabel.remove_style_class_name('margin-ok');
        panel.marginLabel.remove_style_class_name('margin-over');

        if (Math.abs(picked.delta) < 3) {
            panel.marginLabel.set_text('');
        } else {
            const absMs = Math.abs(picked.marginMs);
            const formatted = this._formatDuration(absMs);
            if (picked.marginMs > 0) {
                panel.marginLabel.set_text(`-${formatted}`);
                panel.marginLabel.add_style_class_name('margin-ok');
            } else {
                panel.marginLabel.set_text(`+${formatted}`);
                panel.marginLabel.add_style_class_name('margin-over');
            }
        }
    }

    // --- Menu row updates ---

    _setMenuRowError(row, emoji) {
        row.headerLabel.set_text(`${row.windowLabel} : ${emoji}`);
        row.progressBg.hide();
        row.resetLabel.set_text('');
        row.marginLabel.set_text('');
    }

    _updateMenuRow(row, utilization, resetsAt, windowMs) {
        row.headerLabel.set_text(`${row.windowLabel} : ${Math.round(utilization)}%`);
        row.progressBg.show();

        // Progress bar
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

        // Reset label
        if (resetsAt) {
            row.resetLabel.set_text(`Resets in ${this._formatResetTime(resetsAt)}`);
        } else {
            row.resetLabel.set_text('');
        }

        // Margin label
        row.marginLabel.remove_style_class_name('menu-margin-ok');
        row.marginLabel.remove_style_class_name('menu-margin-over');
        row.marginLabel.remove_style_class_name('menu-margin-neutral');

        if (!resetsAt) {
            row.marginLabel.set_text('');
            return;
        }

        const pace = this._computePace(utilization, resetsAt, windowMs);
        if (Math.abs(pace.delta) < 3) {
            row.marginLabel.set_text('On pace');
            row.marginLabel.add_style_class_name('menu-margin-neutral');
        } else {
            const marginMs = -(pace.delta / 100) * windowMs;
            const formatted = this._formatDuration(Math.abs(marginMs));
            if (marginMs > 0) {
                row.marginLabel.set_text(`${formatted} to spare`);
                row.marginLabel.add_style_class_name('menu-margin-ok');
            } else {
                row.marginLabel.set_text(`▲ ${formatted} over`);
                row.marginLabel.add_style_class_name('menu-margin-over');
            }
        }
    }

    // --- Utilities ---

    _computePace(utilization, resetsAt, windowMs) {
        const now = Date.now();
        const resetTime = new Date(resetsAt).getTime();
        const remaining = resetTime - now;
        const elapsed = windowMs - remaining;
        const elapsedClamped = Math.max(0, Math.min(elapsed, windowMs));
        const idealPace = (elapsedClamped / windowMs) * 100;
        return { delta: utilization - idealPace };
    }

    _formatDuration(ms) {
        if (ms <= 0) return 'now';
        const mins = Math.floor(ms / 60000);
        const hours = Math.floor(mins / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${mins % 60}m`;
        return `${mins}m`;
    }

    _formatResetTime(isoString) {
        try {
            return this._formatDuration(new Date(isoString) - new Date());
        } catch (e) {
            return '\u2014';
        }
    }

    destroy() {
        this._stopTimer();

        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new UsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
