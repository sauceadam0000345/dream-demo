# MCP Setup for Sauce Labs Integration

This document describes how to set up the Sauce Labs MCP (Model Context Protocol) servers to enable AI assistant integration with Sauce Labs testing platforms.

## Overview

The Dream Demo project integrates two MCP servers:

- **sauce-api-mcp-core** - Full Sauce Labs API integration (account, devices, jobs, builds, storage, tunnels)
- **sauce-api-mcp-rdc** - Real Device Cloud (RDC) focused server with OpenAPI schema discovery

These servers allow AI assistants (Claude Desktop, Gemini CLI) to interact with Sauce Labs via natural language, enabling tasks like:
- "What Android devices are available?"
- "Show me my recent test failures"
- "Get logs for job XYZ"
- "List available devices in us-west-1"

---

## Prerequisites

- Python 3.10+ (installed via Homebrew or system)
- `pipx` package manager (for isolated CLI tool installation)
- Sauce Labs account with API credentials
- MCP-compatible LLM client (Claude Desktop or Gemini CLI)

---

## Installation

### Step 1: Install sauce-api-mcp via pipx

`pipx` installs Python CLI tools in isolated environments while making them available globally:

```bash
# Install pipx if not already installed
brew install pipx

# Install sauce-api-mcp (includes both core and RDC servers)
pipx install sauce-api-mcp

# Verify installation
which sauce-api-mcp
which sauce-api-mcp-rdc
# Expected: ~/.local/bin/sauce-api-mcp and ~/.local/bin/sauce-api-mcp-rdc
```

**Note**: The package is already installed in this project. If you need to reinstall or upgrade:

```bash
pipx upgrade sauce-api-mcp
# or force reinstall:
pipx reinstall sauce-api-mcp
```

### Step 2: Verify Servers are Callable

Both servers are designed to be run by MCP clients, not interactively. They will output an informational message when invoked:

```bash
sauce-api-mcp --help 2>&1 | head -5
# Should show: "INFO: SauceAPI client initialized..."

sauce-api-mcp-rdc --help 2>&1 | head -5
# Should show: "INFO: SauceAPI client initialized..."
```

If you see "Error: This server is not meant to be run interactively", that's expected correct behavior.

---

## Configuration

### Sauce Labs Credentials

1. Get your Sauce Labs credentials:
   - Log into https://app.saucelabs.com
   - Navigate to **Account → User Settings**
   - Copy your **Username** (or use the oauth-style username provided)
   - Copy your **Access Key** (API key)

2. Add credentials to your shell environment (recommended):

```bash
# Add to ~/.zshrc or ~/.bash_profile
export SAUCE_USERNAME="your-username"
export SAUCE_ACCESS_KEY="your-access-key"
export SAUCE_REGION="us-west-1"  # or eu-central-1, apac-southeast-1

# Reload shell
source ~/.zshrc
```

3. Alternatively, credentials are already configured in the project's MCP client configs (see below).

### Configure Claude Desktop

Claude Desktop configuration file location (macOS):
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add both MCP servers:

```json
{
  "mcpServers": {
    "sauce-api-mcp-core": {
      "command": "/Users/yourusername/.local/bin/sauce-api-mcp",
      "env": {
        "SAUCE_USERNAME": "${SAUCE_USERNAME}",
        "SAUCE_ACCESS_KEY": "${SAUCE_ACCESS_KEY}",
        "SAUCE_REGION": "us-west-1"
      }
    },
    "sauce-api-mcp-rdc": {
      "command": "/Users/yourusername/.local/bin/sauce-api-mcp-rdc",
      "env": {
        "SAUCE_USERNAME": "${SAUCE_USERNAME}",
        "SAUCE_ACCESS_KEY": "${SAUCE_ACCESS_KEY}",
        "SAUCE_REGION": "us-west-1"
      }
    }
  }
}
```

**Important**: Use the actual path from `which sauce-api-mcp`. On this machine it's:
- `/Users/adam.toth-fejel/.local/bin/sauce-api-mcp`
- `/Users/adam.toth-fejel/.local/bin/sauce-api-mcp-rdc`

After saving, **restart Claude Desktop** to load the MCP servers.

### Configure Gemini CLI

Gemini CLI configuration file location:
```
~/.gemini/settings.json
```

Add both servers under `mcpServers`:

```json
{
  "mcpServers": {
    "sauce-api-mcp-core": {
      "command": "/Users/yourusername/.local/bin/sauce-api-mcp",
      "env": {
        "SAUCE_USERNAME": "${SAUCE_USERNAME}",
        "SAUCE_ACCESS_KEY": "${SAUCE_ACCESS_KEY}",
        "SAUCE_REGION": "us-west-1"
      }
    },
    "sauce-api-mcp-rdc": {
      "command": "/Users/yourusername/.local/bin/sauce-api-mcp-rdc",
      "env": {
        "SAUCE_USERNAME": "${SAUCE_USERNAME}",
        "SAUCE_ACCESS_KEY": "${SAUCE_ACCESS_KEY}",
        "SAUCE_REGION": "us-west-1"
      }
    }
  }
}
```

Restart Gemini CLI for changes to take effect.

---

## Usage Examples

Once configured, you can ask your AI assistant natural language questions about your Sauce Labs data:

### For Web Testing (Core Server)

```
"List all available browsers on Windows 10"
"Show me my recent test jobs"
"Get details for job 123456"
"What's my account's concurrency limit?"
"List active Sauce Connect tunnels"
```

### For Mobile Testing (RDC Server)

```
"What Android devices are available in us-west-1?"
"Show me available iPhone models"
"List real devices currently in use"
"Get details for my RDC job on Pixel 8"
```

### Combined Queries

```
"What devices are available for both web and mobile testing?"
"Compare my recent web and mobile test results"
"Check if any devices are currently reserved"
```

The AI assistant will automatically call the appropriate MCP tools based on your question.

---

## Available MCP Tools

### Core Server Tools

| Tool | Description |
|------|-------------|
| `get_account_info` | Account details, plan limits, usage |
| `lookup_users` | Search org users |
| `lookup_teams` | List teams |
| `get_devices_status` | List all virtual devices (VDC) |
| `get_specific_device` | Get details for a specific device |
| `get_recent_jobs` | Most recent test jobs |
| `get_job_details` | Full job info including logs, video |
| `get_build` | Build details and job list |
| `get_storage_files` | List uploaded apps |
| `get_tunnels_for_user` | Active Sauce Connect tunnels |

### RDC Server Tools

| Tool | Description |
|------|-------------|
| `list_device_status` | Real device availability (filter by state, privateOnly, deviceName) |
| `list_device_sessions` | Active and recent device sessions |
| `get_session_details` | Session info and device context |
| `allocate_device_and_create_session` | Allocate a real device and start a session |
| `close_device_session` | Close and release a device session |
| `install_app_from_storage` | Install app with instrumentation features |
| `launch_app` | Launch an installed app |
| `open_url_or_deeplink` | Open a URL in browser or deeplink |
| `execute_shell_command` | Run adb shell commands (Android) |
| `forward_http_get/post/put/delete/options/head` | Proxy HTTP through the device |

Full tool list is available in the MCP server's resource manifest when connected to Claude/Gemini.

---

## Relationship to Existing RDC Tests

The Dream Demo already includes Appium-based RDC tests in `tests-e2e/conftest_android.py`. The MCP integration complements these tests:

- **Appium tests** - Actively run tests on real devices via RDC
- **MCP server** - Query test results, device catalogs, job metadata via AI

**Typical workflow**:
1. Run `pytest tests-e2e/test_android_app.py` → creates jobs on Sauce Labs
2. Ask Claude: "What were the results of my latest Android test run?"
3. Claude calls MCP tools to fetch job data and summarize outcomes
4. Drill down: "Show me the logs for the failed job"
5. Claude retrieves and presents logs/video links

---

## Troubleshooting

### "MCP server not found" Error

**Problem**: Claude/Gemini can't find the sauce-api-mcp executable.

**Solution**:
1. Verify installation path:
   ```bash
   which sauce-api-mcp
   # Should return: /Users/yourname/.local/bin/sauce-api-mcp
   ```

2. Update config to use absolute path (not just `sauce-api-mcp`):
   ```json
   "command": "/Users/adam.toth-fejel/.local/bin/sauce-api-mcp"
   ```

3. Ensure the path exists and is executable:
   ```bash
   ls -la ~/.local/bin/sauce-api-mcp*
   ```

### "Authentication failed" Error

**Problem**: Invalid Sauce Labs credentials.

**Solution**:
1. Verify credentials are correct in `~/.gemini/settings.json` or `claude_desktop_config.json`
2. Test credentials via API:
   ```bash
   curl -u "username:access-key" https://api.us-west-1.saucelabs.com/rest/v1/users/me
   ```
3. Ensure SAUCE_REGION matches your account's region (check in Sauce Labs UI)

### "No devices found" or Empty Results

**Problem**: Account may not have RDC access or region mismatch.

**Solution**:
1. Confirm your Sauce Labs plan includes Real Device Cloud (RDC)
2. Verify SAUCE_REGION is correct (default us-west-1)
3. Check team device quotas haven't been exceeded
4. Try querying VDC devices first to confirm API access:
   - "List available Windows 10 browsers"

### MCP Server Fails to Start

**Problem**: Server crashes silently.

**Diagnose**:
```bash
# Run server directly to see error output
/Users/yourname/.local/bin/sauce-api-mcp

# Should print startup logs then wait. Press Ctrl+C to exit.
```

Common causes:
- Python version mismatch (need 3.10+)
- Missing dependencies (reinstall with `pipx reinstall sauce-api-mcp`)
- Network/firewall blocking API access

### Claude/Gemini Not Using MCP Tools

**Problem**: AI responds without calling tools.

**Solution**:
1. Ensure you're asking questions that require Sauce Labs data
2. Try: "What devices are available in Sauce Labs?" (explicit mention)
3. Check that MCP server appears in client's connected tools list
   - Claude: Look for "Sauce API" in tool list
   - Gemini: Check MCP status in settings

---

## Visualization: Sauce Insights

All test results automatically appear in **Sauce Insights**, Sauce Labs' native analytics platform.

### Accessing Insights

1. Log into Sauce Labs: https://app.saucelabs.com
2. Click **Insights** in the left sidebar
3. Filter by:
   - **Source**: Real Devices (RDC) or Virtual Devices (VDC)
   - **Build**: Your build name (e.g., "DreamDemo-Android-Build-1")
   - **Date range**: Last 7/30/custom days

### Key Dashboards

| Dashboard | What It Shows |
|-----------|---------------|
| **Overview** | Pass/fail rates, total jobs, test coverage by platform |
| **Test Cases** | Individual test performance, duration trends, flaky detection |
| **Errors** | Failure breakdown, stack traces, affected devices, ML insights |
| **Jobs** | Build trends over time, parallelization efficiency |

### Sharing Insights

- **Team members**: Automatically visible to all org members with access
- **Direct links**: Copy filtered view URL to share with teammates (requires Sauce Labs account)
- **Scheduled reports**: Configure email snapshots (plan-dependent)

### Demo Talking Points

When showcasing the Dream Demo:
1. "All test results are automatically aggregated in Sauce Insights"
2. "Here's the pass rate trend over the last 7 days"
3. "ML-powered failure analysis identifies root causes"
4. "We can filter by platform, build, team to slice the data"
5. "Anyone on the team can access these dashboards"

---

## Maintenance

### Updating the MCP Servers

```bash
pipx upgrade sauce-api-mcp
```

Check for updates periodically:
```bash
pipx list | grep sauce-api-mcp
```

### Testing MCP Integration

A simple verification checklist:

- [ ] `which sauce-api-mcp` returns a valid path
- [ ] `sauce-api-mcp --help` runs without error
- [ ] Claude Desktop config has both servers defined with correct paths
- [ ] Gemini CLI settings.json has both servers
- [ ] After restart, LLM client shows MCP tools as available
- [ ] Ask: "List available devices" → returns device catalog
- [ ] Run one RDC test → verify job appears in Insights

---

## References

- Sauce Labs MCP GitHub: https://github.com/saucelabs/sauce-api-mcp
- Sauce Labs Docs: https://docs.saucelabs.com
- Sauce Insights: https://docs.saucelabs.com/insights/
- MCP Protocol: https://modelcontextprotocol.io

---

## Next Steps

- Create custom prompts for analyzing test failures using MCP data
- Integrate MCP queries into CI/CD for build monitoring
- Explore test asset retrieval (logs, videos) via MCP
- Set up Insights alerts for failure rate spikes
