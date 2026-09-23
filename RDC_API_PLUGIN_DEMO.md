# RDC API Plugin — 2-Minute Demo Script

A concise feature overview of the `sauce-api-mcp-rdc` MCP plugin for Sauce Labs Real Device Cloud.

**How it works:** You type natural language into your AI assistant (Claude, Gemini, etc.) → the `sauce-api-mcp-rdc` MCP server translates that into deterministic API calls → the Sauce Labs RDC REST API returns live real-device data and session controls.

**Context:** This demo is built from real customer conversations (JPMC, Disney, Home Depot, SAP). The pattern is always the same: developers want to stay in their toolbench — IDE + AI assistant — and they need *real* device telemetry and direct device control, not simulated data, to power their LLM workflows.

---

## Pre-Demo (5 sec)

Ensure your AI assistant (Claude Desktop, VS Code Copilot, Gemini CLI, etc.) is open with the RDC server connected.

```
Status bar should show: "Sauce API RDC" as an active MCP server.
```

---

## Demo Flow

### 0:00–0:15 — The Hook: "What's Actually Available?"

**🎤 Say:** *"When you're about to run a mobile test, the first question is always: what real devices are actually available right now — and what's their real operational state?"*

**💬 Prompt** *(type into the AI assistant chat):*
```
What private devices are available to me right now?
```

**📺 Screen shows:** The AI assistant calls `list_device_status` with `privateOnly=true` and returns your allocated private devices — real hardware with availability states (AVAILABLE, IN_USE, CLEANING, MAINTENANCE, REBOOTING, OFFLINE). No guesswork, no shared public pool.

> **Talking point:** These are your dedicated devices — not shared, not simulated. You get real hardware telemetry through live session APIs. And your private fleet always shows up first.

---

### 0:15–0:35 — Deep Dive: "Show Me the Real Device"

**🎤 Say:** *"I can drill down instantly. Show me my private Galaxy A51 — I want to know what I'm working with before I schedule anything."*

**💬 Prompt** *(type into the AI assistant chat):*
```
Show me the status of my Galaxy A51
```

**📺 Screen shows:** `list_device_status` with `deviceName=Galaxy A51` returns your private device with its current state (AVAILABLE, REBOOTING, CLEANING, etc.). The AI assistant may suggest allocating it.

> **Talking point:** This is the "emulator gap." We run on real chips, real batteries, real thermal profiles. That operational reality is what feeds better tests — and better AI insights.

---

### 0:35–0:55 — Reserve & Control: "I Want This Device"

**🎤 Say:** *"I'm ready to test. Allocate my Galaxy A51 — I want a live session on real hardware."*

**💬 Prompt** *(type into the AI assistant chat):*
```
Allocate my Galaxy A51 device
```

**📺 Screen shows:** `allocate_device_and_create_session` returns a session ID, device allocation status, and session state (PENDING → CREATING → ACTIVE). The device is allocated and ready for control.

> **Talking point:** Same authentication as your CI/CD pipeline. Same audit trail. But now you're controlling it from your IDE or AI assistant — no dashboard context switching.

---

### 0:55–1:20 — Real Telemetry, Real Time: "What's the Device Actually Doing?"

**🎤 Say:** *"While my device session is active, I need real telemetry. What's the current session state and device info?"*

**💬 Prompt** *(type into the AI assistant chat):*
```
Get the details for my active device session
```

**📺 Screen shows:** `get_session_details` returns real-time session info: device model, OS version, session state, and runtime context pulled live from the device.

**🎤 Say:** *"Now let me install my app with network capture enabled so I can inspect traffic during the test."*

**💬 Prompt** *(type into the AI assistant chat):*
```
Install my app with network capture enabled
```

*(The AI assistant will call `install_app_from_storage` with `features={"networkCapture": true}`.)*

**📺 Screen shows:** App installation queued on the device. Network capture is enabled as an instrumentation feature.

> **Talking point:** This is where RDC stands apart. You get live device control — install apps, enable network capture, open URLs, execute shell commands — all while the session is running. Not when it ends. That real-time operational data is the "AI fuel" that makes your LLM insights actually meaningful.

---

### 1:20–1:45 — Device Control: "Drive the Device from My Assistant"

**🎤 Say:** *"I want to open a URL directly on the device — right from my chat."*

**💬 Prompt** *(type into the AI assistant chat):*
```
Open https://example.com on my active device
```

**📺 Screen shows:** `open_url_or_deeplink` returns success. The URL is opened on the real device browser.

**🎤 Say:** *"Now let me run an adb shell command to pull real device info and inspect storage."*

**💬 Prompt** *(type into the AI assistant chat):*
```
Run `getprop ro.product.model; getprop ro.build.version.release; ls /sdcard` on my Android device
```

**📺 Screen shows:** `execute_shell_command` proxies the adb command and returns real output from the device — model (`Galaxy A51`), OS version, and the `/sdcard` directory listing.

> **Talking point:** Before, you'd wait for the test to end, then dig through a UI. Now you control the device live, run shell commands, proxy HTTP requests, and catch issues in context. The data is deterministic and ready for your LLM to analyze.

---

### 1:45–2:00 — Cleanup & Close: "Sauce Gives You the Data. The LLM Makes It a Story."

**🎤 Say:** *"When I'm done, I close the session and optionally reboot the device for the next run."*

**💬 Prompt** *(type into the AI assistant chat):*
```
Close my active session and reboot the device
```

**📺 Screen shows:** `close_device_session` with `rebootDevice=true` releases the session and triggers a device reboot.

> **Talking point:** No dashboard clicks. No context switching. Just ask. Sauce Labs gives you the real device telemetry and control, and your LLM turns it into actionable insight — whether that's a JIRA narrative, an executive scorecard, or a root-cause analysis.

---

## Key Talking Points Summary

| Beat | Point |
|------|-------|
| **Hook** | Live real device catalog eliminates "guess and check" before allocating sessions |
| **Drill-down** | Filter by device name, OS, availability state — all programmatically accessible |
| **Allocate** | Same auth as CI/CD, same audit trail, but controlled from IDE/AI assistant |
| **Telemetry** | Real-time session details, app installs with instrumentation features — the "AI fuel" emulators can't provide |
| **Control** | Open URLs, run shell commands, proxy HTTP — drive the device live from chat |
| **Cleanup** | Close and reboot devices programmatically, keeping the fleet healthy |
| **Close** | "Sauce gives you the data, the LLM makes it a story" — integrated into the developer workflow |

---

## On-Screen Checklist

- [ ] AI assistant window visible (Claude, VS Code Copilot, Gemini, etc.)
- [ ] `.mcp.json` shows `sauce-api-mcp-rdc` configured (optional quick flash)
- [ ] Each 💬 **Prompt** typed live into the AI assistant chat (don't paste all at once)
- [ ] Tool call badge visible ("Sauce API RDC" icon in your AI assistant)
- [ ] 📺 **Screen shows** real data, not mock text
- [ ] Emphasize: live device control vs. simulated data
- [ ] Emphasize: no context switching, everything from the IDE/AI assistant

---

## Fallback Prompts

If no private devices or active sessions exist in the account, use these **💬 Prompts** instead:

```
List all available Android devices
```

```
Show me my active device sessions
```

```
Allocate any available iPhone device
```

```
List ongoing app installations for my session
```

---

## Job & Asset Queries (Core MCP Server)

For querying RDC job history and downloading assets (logs, videos, HAR files), use the **`sauce-api-mcp` core server**:

| Capability | Core Server Tool |
|------------|-----------------|
| Show recent RDC jobs | `get_real_device_jobs` |
| Get job details | `get_specific_real_device_job` |
| Download logs/video | `get_specific_real_device_job_asset` |
| List all devices (read-only) | `get_devices_status` |
| Get device details by ID | `get_specific_device` |
| List private devices | `get_private_devices` |

---

## One-Liner Summary

> The RDC API plugin turns Sauce Labs Real Device Cloud into a conversational control interface — discover devices, allocate live sessions, install apps, enable network capture, run shell commands, and proxy HTTP traffic without leaving your AI assistant. Real hardware, real time, real simple.
