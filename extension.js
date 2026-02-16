import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Configuration constants
const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const PANEL_PROGRESS_BAR_WIDTH = 50;
const MENU_PROGRESS_BAR_WIDTH = 200;
const MIN_REFRESH_INTERVAL = 10;
const MAX_REFRESH_INTERVAL = 600;
const DEFAULT_REFRESH_INTERVAL = 300;
const USAGE_WARNING_THRESHOLD = 0.80;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [5, 10, 20]; // seconds for each retry attempt
const STALE_DATA_MULTIPLIER = 2; // Data is stale if older than 2x refresh interval

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Claude Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = new Soup.Session();

        // State tracking for retry logic and notifications
        this._retryAttempt = 0;
        this._lastUpdateTime = null;
        this._lastError = null;
        this._highUsageNotified = { fiveHour: false, sevenDay: false };
        this._consecutiveFailures = 0;
        this._isLoading = false;

        // Suppress error notifications during startup grace period (token may need refresh)
        this._inGracePeriod = true;
        this._graceTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this._inGracePeriod = false;
                this._graceTimerId = null;
                return GLib.SOURCE_REMOVE;
            }
        );

        // Create box for panel button
        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        // Add Claude icon
        const iconPath = GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'claude-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        // Add progress bar (for bar mode)
        this._panelProgressBg = new St.Widget({
            style_class: 'claude-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'claude-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        // Add usage label (after progress bar)
        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this._box.add_child(this._label);

        // Add margin label (colored time margin indicator)
        this._marginLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-margin-label',
        });
        this._box.add_child(this._marginLabel);

        this.add_child(this._box);

        // Create menu items
        this._createMenu();

        // Update display mode and icon visibility
        this._updateDisplayMode();
        this._updateIconVisibility();

        // Connect settings changes
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            }
        });

        // Start refresh timer
        this._refreshUsage();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._marginLabel.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._marginLabel.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._marginLabel.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createMenu() {
        // 5-hour usage section
        const fiveHourBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({ vertical: false });
        const fiveHourLabel = new St.Label({
            text: '5-Hour Usage',
            style_class: 'claude-section-title',
        });
        fiveHourHeader.add_child(fiveHourLabel);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        // Progress bar for 5-hour
        this._fiveHourProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
            clip_to_allocation: true,
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        this._fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        this._fiveHourProgressBg.connect('notify::allocation', () => {
            this._syncProgressBarToAllocation(this._fiveHourProgressBar);
        });
        fiveHourBox.add_child(this._fiveHourProgressBg);

        this._fiveHourMarginLabel = new St.Label({
            text: '',
            style_class: 'claude-menu-margin',
        });
        fiveHourBox.add_child(this._fiveHourMarginLabel);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 7-day usage section
        const sevenDayBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({ vertical: false });
        const sevenDayLabel = new St.Label({
            text: '7-Day Usage',
            style_class: 'claude-section-title',
        });
        sevenDayHeader.add_child(sevenDayLabel);
        this._sevenDayPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        sevenDayHeader.add_child(this._sevenDayPercent);
        sevenDayBox.add_child(sevenDayHeader);

        // Progress bar for 7-day
        this._sevenDayProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
            clip_to_allocation: true,
        });
        this._sevenDayProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        this._sevenDayProgressBg.add_child(this._sevenDayProgressBar);
        this._sevenDayProgressBg.connect('notify::allocation', () => {
            this._syncProgressBarToAllocation(this._sevenDayProgressBar);
        });
        sevenDayBox.add_child(this._sevenDayProgressBg);

        this._sevenDayMarginLabel = new St.Label({
            text: '',
            style_class: 'claude-menu-margin',
        });
        sevenDayBox.add_child(this._sevenDayMarginLabel);

        this._sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        sevenDayBox.add_child(this._sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Settings menu item
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
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

    _refreshUsage() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(null, (file, result) => {
            try {
                const [success, contents] = file.load_contents_finish(result);

                if (!success) {
                    this._handleCredentialsError('Credentials file not found');
                    return;
                }

                const decoder = new TextDecoder('utf-8');
                const contentString = decoder.decode(contents);

                let json;
                try {
                    json = JSON.parse(contentString);
                } catch (parseError) {
                    console.error('Claude Usage: Invalid JSON in credentials file:', parseError.message);
                    this._handleCredentialsError('Invalid credentials file');
                    return;
                }

                const token = json?.claudeAiOauth?.accessToken;

                if (!token || typeof token !== 'string' || token.trim() === '') {
                    this._handleCredentialsError('No access token found');
                    return;
                }

                this._fetchUsage(token);
            } catch (e) {
                console.error('Claude Usage: Failed to read credentials:', e.message);
                this._handleCredentialsError('Failed to read credentials');
            }
        });
    }

    _handleCredentialsError(errorMessage) {
        this._label.set_text('No token');
        this._fiveHourPercent.set_text(errorMessage);
        this._sevenDayPercent.set_text('—');

        // Only show notification once per session, and not during grace period
        if (!this._inGracePeriod && (!this._lastError || !this._lastError.includes('credentials'))) {
            this._showNotification(
                'Claude Usage: Credentials Error',
                `${errorMessage}. Please check ~/.claude/.credentials.json`
            );
        }

        this._lastError = errorMessage;
    }

    _fetchUsage(token) {
        // Prevent multiple concurrent requests
        if (this._isLoading) {
            return;
        }

        this._isLoading = true;
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                this._isLoading = false;

                try {
                    const bytes = session.send_and_read_finish(result);

                    // Handle HTTP errors
                    if (message.status_code === 401 || message.status_code === 403) {
                        this._handleAuthError();
                        return;
                    }

                    if (message.status_code !== 200) {
                        this._handleHttpError(message.status_code);
                        return;
                    }

                    // Parse response
                    const decoder = new TextDecoder('utf-8');
                    const responseText = decoder.decode(bytes.get_data());
                    let data;

                    try {
                        data = JSON.parse(responseText);
                    } catch (parseError) {
                        console.error('Claude Usage: Failed to parse JSON:', parseError.message);
                        this._handleError('Invalid API response format');
                        return;
                    }

                    // Validate response structure
                    if (!this._validateApiResponse(data)) {
                        this._handleError('API returned unexpected data structure');
                        return;
                    }

                    // Success - reset retry counter and update display
                    this._retryAttempt = 0;
                    this._consecutiveFailures = 0;
                    this._lastError = null;
                    this._lastUpdateTime = Date.now();
                    this._updateDisplay(data);

                } catch (e) {
                    console.error('Claude Usage: Network error:', e.message);
                    this._handleNetworkError(e.message);
                }
            }
        );
    }

    _validateApiResponse(data) {
        // Validate that response has expected structure
        if (!data || typeof data !== 'object') {
            return false;
        }

        // Check for required fields
        if (!data.five_hour || !data.seven_day) {
            return false;
        }

        // Validate utilization values
        const fiveHourUtil = data.five_hour.utilization;
        const sevenDayUtil = data.seven_day.utilization;

        if (typeof fiveHourUtil !== 'number' || typeof sevenDayUtil !== 'number') {
            return false;
        }

        return true;
    }

    _handleAuthError() {
        this._consecutiveFailures++;
        this._lastError = 'Authentication failed';

        // Auth errors are often transient (expired token after resume/boot).
        // Retry silently before alarming the user.
        if (this._shouldRetry()) {
            this._label.set_text(`Retry…`);
            this._scheduleRetry();
            return;
        }

        this._label.set_text('Auth Error');
        this._fiveHourPercent.set_text('Check credentials');
        this._sevenDayPercent.set_text('—');

        if (!this._inGracePeriod) {
            this._showNotification(
                'Claude Usage: Authentication Failed',
                'Please check your credentials at ~/.claude/.credentials.json'
            );
        }
    }

    _handleHttpError(statusCode) {
        this._consecutiveFailures++;
        this._lastError = `HTTP ${statusCode}`;

        if (this._shouldRetry()) {
            this._scheduleRetry();
        } else {
            this._label.set_text('Error');
            this._fiveHourPercent.set_text(`HTTP ${statusCode}`);
            this._sevenDayPercent.set_text('—');
        }
    }

    _handleNetworkError(errorMessage) {
        this._consecutiveFailures++;
        this._lastError = errorMessage;

        if (this._shouldRetry()) {
            this._scheduleRetry();
        } else {
            this._label.set_text('Error');
            this._fiveHourPercent.set_text('Network error');
            this._sevenDayPercent.set_text('—');

            if (this._consecutiveFailures >= MAX_RETRY_ATTEMPTS && !this._inGracePeriod) {
                this._showNotification(
                    'Claude Usage: Connection Failed',
                    'Unable to reach Claude API after multiple attempts'
                );
            }
        }
    }

    _handleError(errorMessage) {
        this._consecutiveFailures++;
        this._lastError = errorMessage;
        this._label.set_text('Error');
        this._fiveHourPercent.set_text(errorMessage);
        this._sevenDayPercent.set_text('—');
    }

    _shouldRetry() {
        return this._retryAttempt < MAX_RETRY_ATTEMPTS;
    }

    _scheduleRetry() {
        if (this._retryAttempt >= MAX_RETRY_ATTEMPTS) {
            return;
        }

        const delay = RETRY_DELAYS[this._retryAttempt];
        this._label.set_text(`Retry ${delay}s`);

        GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._retryAttempt++;
                this._refreshUsage();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _updateDisplay(data) {
        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;

        const FIVE_HOUR_MS = 5 * 3600000;
        const SEVEN_DAY_MS = 7 * 86400000;

        // Compute pace and margin for both metrics
        let fiveHourMargin = null;
        let fiveHourWillHit = false;
        if (data.five_hour?.resets_at) {
            const pace = this._computePace(fiveHour, data.five_hour.resets_at, FIVE_HOUR_MS);
            fiveHourMargin = { marginMs: -(pace.delta / 100) * FIVE_HOUR_MS, delta: pace.delta };
            fiveHourWillHit = fiveHourMargin.marginMs < 0;
        }

        let sevenDayMargin = null;
        let sevenDayWillHit = false;
        if (data.seven_day?.resets_at) {
            const pace = this._computePace(sevenDay, data.seven_day.resets_at, SEVEN_DAY_MS);
            sevenDayMargin = { marginMs: -(pace.delta / 100) * SEVEN_DAY_MS, delta: pace.delta };
            sevenDayWillHit = sevenDayMargin.marginMs < 0;
        }

        // Panel: pick which metric's margin to show
        // - Any will-hit: largest negative margin (worst overshoot)
        // - All spare: smallest positive margin (tightest bottleneck)
        let panelUsage, panelMargin;
        if (fiveHourWillHit || sevenDayWillHit) {
            // Pick the worst overshoot (most negative marginMs)
            const fiveMs = fiveHourWillHit ? fiveHourMargin.marginMs : 0;
            const sevenMs = sevenDayWillHit ? sevenDayMargin.marginMs : 0;
            if (fiveMs <= sevenMs) {
                panelUsage = fiveHour;
                panelMargin = fiveHourMargin;
            } else {
                panelUsage = sevenDay;
                panelMargin = sevenDayMargin;
            }
        } else {
            // Pick the tightest spare (smallest positive marginMs)
            const fiveMs = fiveHourMargin?.marginMs ?? Infinity;
            const sevenMs = sevenDayMargin?.marginMs ?? Infinity;
            if (fiveMs <= sevenMs) {
                panelUsage = fiveHour;
                panelMargin = fiveHourMargin;
            } else {
                panelUsage = sevenDay;
                panelMargin = sevenDayMargin;
            }
        }

        // Panel label: just XX%
        this._label.set_text(`${Math.round(panelUsage)}%`);

        // Panel margin label: colored +Xh Ym or -Xh Ym
        this._updatePanelMarginLabel(panelMargin);

        // Panel progress bar
        this._updatePanelProgressBar(panelUsage);

        // Popup: 5-hour section
        this._fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(this._fiveHourProgressBar, fiveHour);
        this._updateMenuMarginLabel(this._fiveHourMarginLabel, fiveHourMargin);

        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(`Resets in ${this._formatResetTime(data.five_hour.resets_at)}`);
        }

        // Popup: 7-day section
        this._sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(this._sevenDayProgressBar, sevenDay);
        this._updateMenuMarginLabel(this._sevenDayMarginLabel, sevenDayMargin);

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(`Resets in ${this._formatResetTime(data.seven_day.resets_at)}`);
        }

        // Check for high usage and send notifications
        this._checkUsageWarnings(fiveHour, sevenDay);
    }

    _updatePanelMarginLabel(margin) {
        this._marginLabel.remove_style_class_name('claude-margin-ok');
        this._marginLabel.remove_style_class_name('claude-margin-over');

        if (!margin || Math.abs(margin.delta) < 3) {
            this._marginLabel.set_text('');
            this._label.remove_style_class_name('claude-usage-label-warn');
            return;
        }

        const absMs = Math.abs(margin.marginMs);
        const formatted = this._formatDuration(absMs);

        if (margin.marginMs > 0) {
            this._marginLabel.set_text(`+${formatted}`);
            this._marginLabel.add_style_class_name('claude-margin-ok');
            this._label.remove_style_class_name('claude-usage-label-warn');
        } else {
            this._marginLabel.set_text(`-${formatted}`);
            this._marginLabel.add_style_class_name('claude-margin-over');
            this._label.add_style_class_name('claude-usage-label-warn');
        }
    }

    _updateMenuMarginLabel(label, margin) {
        label.remove_style_class_name('claude-menu-margin-ok');
        label.remove_style_class_name('claude-menu-margin-over');
        label.remove_style_class_name('claude-menu-margin-neutral');

        if (!margin || Math.abs(margin.delta) < 3) {
            label.set_text('On pace');
            label.add_style_class_name('claude-menu-margin-neutral');
            return;
        }

        const absMs = Math.abs(margin.marginMs);
        const formatted = this._formatDuration(absMs);

        if (margin.marginMs > 0) {
            label.set_text(`${formatted} to spare`);
            label.add_style_class_name('claude-menu-margin-ok');
        } else {
            label.set_text(`\u25B2 ${formatted} over budget`);
            label.add_style_class_name('claude-menu-margin-over');
        }
    }

    _checkUsageWarnings(fiveHour, sevenDay) {
        const fiveHourDecimal = fiveHour / 100;
        const sevenDayDecimal = sevenDay / 100;

        // Check 5-hour usage threshold
        if (fiveHourDecimal >= USAGE_WARNING_THRESHOLD && !this._highUsageNotified.fiveHour) {
            this._showNotification(
                'Claude Usage Warning: 5-Hour Limit',
                `You've used ${fiveHour.toFixed(1)}% of your 5-hour limit`
            );
            this._highUsageNotified.fiveHour = true;
        } else if (fiveHourDecimal < USAGE_WARNING_THRESHOLD) {
            // Reset notification flag when usage drops below threshold
            this._highUsageNotified.fiveHour = false;
        }

        // Check 7-day usage threshold
        if (sevenDayDecimal >= USAGE_WARNING_THRESHOLD && !this._highUsageNotified.sevenDay) {
            this._showNotification(
                'Claude Usage Warning: 7-Day Limit',
                `You've used ${sevenDay.toFixed(1)}% of your 7-day limit`
            );
            this._highUsageNotified.sevenDay = true;
        } else if (sevenDayDecimal < USAGE_WARNING_THRESHOLD) {
            // Reset notification flag when usage drops below threshold
            this._highUsageNotified.sevenDay = false;
        }
    }

    _showNotification(title, message) {
        try {
            // Use GNOME Shell's notification system
            Main.notify(title, message);
        } catch (e) {
            console.error('Claude Usage: Failed to show notification:', e.message);
        }
    }

    _updatePanelProgressBar(usage) {
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * PANEL_PROGRESS_BAR_WIDTH);
        this._panelProgressBar.set_width(width);

        this._panelProgressBar.remove_style_class_name('usage-low');
        this._panelProgressBar.remove_style_class_name('usage-medium');
        this._panelProgressBar.remove_style_class_name('usage-high');
        this._panelProgressBar.remove_style_class_name('usage-critical');

        if (usage >= 90) {
            this._panelProgressBar.add_style_class_name('usage-critical');
        } else if (usage >= 70) {
            this._panelProgressBar.add_style_class_name('usage-high');
        } else if (usage >= 40) {
            this._panelProgressBar.add_style_class_name('usage-medium');
        } else {
            this._panelProgressBar.add_style_class_name('usage-low');
        }
    }

    _updateProgressBar(progressBar, usage) {
        progressBar._usage = usage;
        this._syncProgressBarToAllocation(progressBar);

        // Update color class
        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (usage >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (usage >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (usage >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _syncProgressBarToAllocation(progressBar) {
        const usage = progressBar._usage;
        if (usage === undefined) return;

        const parent = progressBar.get_parent();
        if (!parent) return;

        let bgWidth = MENU_PROGRESS_BAR_WIDTH;
        const alloc = parent.get_allocation_box();
        const allocWidth = alloc.get_width();
        if (allocWidth > 0) bgWidth = allocWidth;

        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * bgWidth);
        progressBar.set_width(width);
    }

    _computePace(utilization, resetsAt, windowMs) {
        const now = Date.now();
        const resetTime = new Date(resetsAt).getTime();
        const remaining = resetTime - now;
        const elapsed = windowMs - remaining;

        // Clamp elapsed to [0, windowMs]
        const elapsedClamped = Math.max(0, Math.min(elapsed, windowMs));
        const idealPace = (elapsedClamped / windowMs) * 100;
        const delta = utilization - idealPace;

        let hint;
        if (Math.abs(delta) < 3) {
            hint = 'on pace';
        } else if (delta > 0) {
            hint = 'slow down';
        } else {
            hint = 'rush!';
        }

        return { elapsedMs: elapsedClamped, idealPace, delta, hint };
    }

    _formatDuration(ms) {
        if (ms <= 0) return 'now';
        const diffMins = Math.floor(ms / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
        if (diffHours > 0) return `${diffHours}h ${diffMins % 60}m`;
        return `${diffMins}m`;
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

        if (this._graceTimerId) {
            GLib.source_remove(this._graceTimerId);
            this._graceTimerId = null;
        }

        // Clean up session
        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        // Clean up settings connection
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        // Reset state
        this._retryAttempt = 0;
        this._lastUpdateTime = null;
        this._lastError = null;
        this._highUsageNotified = null;
        this._isLoading = false;

        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
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
