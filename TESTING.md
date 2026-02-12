# Testing Guide for Claude Usage Extension

This document provides comprehensive testing procedures for the improved Claude Usage Extension.

## Prerequisites

Before testing:
- GNOME Shell 48 or later
- Claude Code installed
- Valid credentials at `~/.claude/.credentials.json`

## Development Workflow

### Reloading the Extension After Code Changes

The reload method depends on your session type and the changes you made:

**For Most Code Changes (Recommended):**
```bash
gnome-extensions disable claude-usage@haletran && gnome-extensions enable claude-usage@haletran
```
This works on both X11 and Wayland and handles most code updates without requiring a full restart.

**When Full GNOME Shell Restart is Required:**

You need to restart GNOME Shell for:
- Changes to `metadata.json`
- Schema changes (after running `glib-compile-schemas`)
- Significant structural changes
- Adding/removing imports

Restart methods by session type:
- **X11**: Press `Alt+F2`, type `r`, press Enter
- **Wayland**: Log out and log back in (no quick reload available)

**Check Your Session Type:**
```bash
echo $XDG_SESSION_TYPE
```

**Development Tip:** If you're on Wayland and need frequent restarts, consider temporarily switching to an X11 session during development for faster iteration.

## Installation for Testing

### Manual Installation

1. Clone or copy the extension to your extensions directory:
   ```bash
   cp -r . ~/.local/share/gnome-shell/extensions/claude-usage@haletran
   ```

2. Compile the schemas:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/claude-usage@haletran/schemas
   glib-compile-schemas .
   ```

3. Restart GNOME Shell:
   - On X11: `Alt+F2`, type `r`, press Enter
   - On Wayland: Log out and log back in

4. Enable the extension:
   ```bash
   gnome-extensions enable claude-usage@haletran
   ```

## Test Cases

### 1. Normal Operation Test

**Objective:** Verify the extension displays usage correctly with valid credentials.

**Steps:**
1. Ensure `~/.claude/.credentials.json` exists with valid token
2. Enable the extension
3. Wait for initial data fetch (should complete within 5 seconds)

**Expected Results:**
- Panel shows usage percentage (e.g., "42%")
- Clicking panel opens menu with 5-hour and 7-day usage
- Progress bars display correctly
- Reset times show countdown (e.g., "4h 32m")
- No error messages displayed

---

### 2. Invalid Credentials Test

**Objective:** Verify proper error handling for missing/invalid credentials.

**Test 2a: Missing Credentials File**

**Steps:**
1. Rename or move `~/.claude/.credentials.json`
2. Restart the extension or wait for refresh

**Expected Results:**
- Panel shows "No token"
- Menu shows "Credentials file not found"
- Notification appears: "Credentials Error: Credentials file not found"
- No crashes or JavaScript errors in logs

**Test 2b: Invalid JSON Format**

**Steps:**
1. Corrupt the credentials file with invalid JSON:
   ```bash
   echo "{ invalid json" > ~/.claude/.credentials.json
   ```
2. Restart the extension or wait for refresh

**Expected Results:**
- Panel shows "No token"
- Menu shows "Invalid credentials file"
- Notification appears with error message
- Extension continues to run without crashing

**Test 2c: Missing Access Token**

**Steps:**
1. Create credentials file without accessToken:
   ```json
   {
     "claudeAiOauth": {
       "refreshToken": "dummy"
     }
   }
   ```
2. Restart the extension or wait for refresh

**Expected Results:**
- Panel shows "No token"
- Menu shows "No access token found"
- Notification appears
- Extension remains stable

---

### 3. Authentication Error Test

**Objective:** Verify handling of invalid/expired tokens.

**Steps:**
1. Replace the access token with an invalid value:
   ```json
   {
     "claudeAiOauth": {
       "accessToken": "invalid_token_12345"
     }
   }
   ```
2. Wait for refresh or restart extension

**Expected Results:**
- Panel shows "Auth Error"
- Menu shows "Check credentials"
- Notification: "Authentication Failed: Please check your credentials"
- No retry attempts (auth errors are not retried)
- Check logs: `journalctl -f -o cat /usr/bin/gnome-shell`

---

### 4. Network Error and Retry Test

**Objective:** Verify retry logic works with network failures.

**Steps:**
1. Block network access to Anthropic API:
   ```bash
   # Add firewall rule (requires sudo)
   sudo iptables -A OUTPUT -d api.anthropic.com -j DROP
   ```
2. Wait for refresh or restart extension
3. Observe retry behavior
4. Restore network access:
   ```bash
   sudo iptables -D OUTPUT -d api.anthropic.com -j DROP
   ```

**Expected Results:**
- Initial failure shows "Retry 5s"
- After 5 seconds, shows "Retry 10s"
- After 10 more seconds, shows "Retry 20s"
- After 3 failed attempts, shows "Network error"
- When network restored, next scheduled refresh succeeds
- Notification appears after multiple failures

---

### 5. High Usage Notification Test

**Objective:** Verify notifications appear at 80% threshold.

**Note:** This test requires modifying the extension code temporarily or waiting for actual high usage.

**Simulated Test (requires code modification):**

1. Temporarily modify `_updateDisplay` to test notifications:
   ```javascript
   // Add this at start of _updateDisplay for testing
   const fiveHour = 85.5; // Simulate high usage
   const sevenDay = 82.3;
   ```

2. Reload extension

**Expected Results:**
- Notification appears: "Claude Usage Warning: 5-Hour Limit - You've used 85.5% of your 5-hour limit"
- Notification appears: "Claude Usage Warning: 7-Day Limit - You've used 82.3% of your 7-day limit"
- Notifications only appear once (not repeatedly)
- When usage drops below 80%, notification flag resets

**Real-World Test:**
- Use Claude Code heavily until approaching limits
- Monitor for notifications as usage crosses 80%

---

### 6. Display Mode Test

**Objective:** Verify all display modes work correctly.

**Steps:**
1. Open extension preferences (click panel → Settings)
2. Test each display mode:
   - **Text (percentage)**: Should show only percentage text
   - **Progress Bar**: Should show only progress bar
   - **Both**: Should show both bar and text
3. Toggle "Show Icon" setting

**Expected Results:**
- Each mode displays correctly in panel
- Switching modes updates immediately
- Icon visibility toggles correctly
- No layout issues or overlapping elements

---

### 7. Refresh Interval Test

**Objective:** Verify refresh interval settings work correctly.

**Steps:**
1. Open extension preferences
2. Set refresh interval to 10 seconds (minimum)
3. Watch logs or observe panel updates
4. Set interval to 600 seconds (maximum)
5. Try to set value outside range (should be constrained)

**Expected Results:**
- Interval updates take effect immediately
- Data refreshes at specified intervals
- Values outside 10-600 range are rejected
- No errors in logs

---

### 8. Concurrent Request Prevention Test

**Objective:** Verify only one API request happens at a time.

**Steps:**
1. Set refresh interval to 10 seconds
2. Rapidly click the panel icon multiple times while request is in progress
3. Monitor network traffic or logs

**Expected Results:**
- Only one request in flight at a time
- Subsequent requests wait for current one to complete
- No duplicate requests or race conditions

---

### 9. Extension Lifecycle Test

**Objective:** Verify proper cleanup on enable/disable.

**Steps:**
1. Enable extension
2. Wait for data to load
3. Disable extension
4. Re-enable extension
5. Repeat 5 times

**Expected Results:**
- No memory leaks
- Timers properly cleaned up
- Session properly aborted
- No orphaned processes
- No JavaScript errors in logs

---

### 10. Schema Validation Test

**Objective:** Verify schema constraints are enforced.

**Steps:**
1. Try to set refresh interval via gsettings:
   ```bash
   # Should succeed (within range)
   gsettings set org.gnome.shell.extensions.claude-usage refresh-interval 60

   # Should fail or be clamped (below minimum)
   gsettings set org.gnome.shell.extensions.claude-usage refresh-interval 5

   # Should fail or be clamped (above maximum)
   gsettings set org.gnome.shell.extensions.claude-usage refresh-interval 1000
   ```

**Expected Results:**
- Valid values (10-600) are accepted
- Invalid values are rejected or clamped to range
- Extension remains stable with all values

---

## Monitoring and Debugging

### Check Extension Logs

```bash
# Follow GNOME Shell logs
journalctl -f -o cat /usr/bin/gnome-shell

# Filter for Claude Usage messages
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "claude"
```

### Check Extension Status

```bash
# List all extensions
gnome-extensions list

# Check specific extension info
gnome-extensions info claude-usage@haletran

# Enable/disable for testing
gnome-extensions enable claude-usage@haletran
gnome-extensions disable claude-usage@haletran
```

### Inspect Settings

```bash
# Show all settings
gsettings list-recursively org.gnome.shell.extensions.claude-usage

# Get specific setting
gsettings get org.gnome.shell.extensions.claude-usage refresh-interval

# Reset to defaults
gsettings reset-recursively org.gnome.shell.extensions.claude-usage
```

## Common Issues and Solutions

### Extension Doesn't Load

- Check GNOME Shell version compatibility (requires 48+)
- Verify schemas are compiled: `glib-compile-schemas schemas/`
- Check for syntax errors: `journalctl -f -o cat /usr/bin/gnome-shell`
- Ensure metadata.json is valid JSON

### No Data Displayed

- Verify credentials exist: `cat ~/.claude/.credentials.json`
- Check token is valid (not expired)
- Test API manually: `curl -H "Authorization: Bearer YOUR_TOKEN" https://api.anthropic.com/api/oauth/usage`
- Check network connectivity to api.anthropic.com

### Notifications Not Appearing

- Verify GNOME notifications are enabled
- Check Do Not Disturb mode is off
- Test with simulated high usage values
- Check logs for notification errors

### High Memory Usage

- Disable and re-enable extension
- Check for timer leaks (should cleanup properly)
- Report issue with logs and system info

## Performance Benchmarks

Expected resource usage:
- **Memory:** < 5 MB
- **CPU:** < 1% (negligible when idle)
- **Network:** One API call per refresh interval (< 1 KB per request)

## Regression Testing

After any code changes, run through all test cases to ensure:
- No existing functionality breaks
- Error handling still works
- Notifications still trigger
- UI updates correctly
- No new memory leaks

## Automated Testing (Future)

Consider implementing:
- Unit tests for validation functions
- Mock API responses for integration tests
- UI automation tests with Selenium
- Memory leak detection with valgrind

## Reporting Issues

When reporting issues, include:
1. GNOME Shell version: `gnome-shell --version`
2. Extension version/commit
3. Relevant logs from journalctl
4. Steps to reproduce
5. Expected vs actual behavior
6. Screenshots if applicable
