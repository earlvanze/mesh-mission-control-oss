# Mesh Mission Control

A solar-system dashboard for the machines you run AI coding agents on. Each of your computers is a planet on its own orbit: arcs show CPU, RAM, VRAM, GPU and disk use, and every AI CLI process running on it is a moon, coloured by tool. An Android app shows it; a small Python bridge on one of your machines collects it.

It recognises Claude Code, Codex, Gemini, OpenCode, Hermes, Pi, ZCode, DeepSeek, Aider, Goose, Amp, Cursor, Qwen Code, Kimi, Crush, Droid, Copilot, Cline, Kilo, OpenHands, Forge, Plandex, Augment, Junie, Grok and Vibe, including ones installed from npm or pip that run under node, bun or python. Add more in `ALIASES` in `server/agent.py`.

Everything is read-only. Nothing is installed on the machines you monitor.

## How it works

```
Android app ──HTTPS, pinned certificate, bearer token──▶ bridge (server/mmc.py) ──SSH──▶ your hosts
```

The bridge runs on any one machine that can SSH to the others (Linux or macOS, Python 3.8+, `openssl`, `ssh`). Per host it pipes a standard-library script (`server/agent.py`) to `python3 -c` over SSH. The script reads capacity numbers and the names and working directories of your own processes. It does not read terminals, prompts or files.

## Set up the bridge

```sh
git clone https://github.com/earlvanze/mesh-mission-control-oss
cd mesh-mission-control-oss/server
python3 mmc.py serve
```

On first run it creates `~/.config/mesh-mission-control/` (mode 700) with a token and a self-signed certificate, then prints the address, token and certificate fingerprint to enter in the app. Run `python3 mmc.py pair` to print them again. Set `MMC_HOME` to use another directory. For a service, see `deploy/mesh-mission-control.service`.

The bridge needs passwordless SSH to each host (keys or an agent). Host keys are recorded on first connection in `~/.config/mesh-mission-control/known_hosts`; later changes are refused.

### Choose your hosts

Three ways, all equivalent:

- **In the app:** Settings → Hosts. Type a name and IP or hostname, or tap **Discover on LAN** or **Discover on tailnet** and add what it finds.
- **CLI:** `python3 mmc.py add NAME ADDRESS [--user U] [--port N] [--key PATH]`, or `python3 mmc.py discover [--lan] [--tailnet] [--add --user U]`.
- **File:** edit `~/.config/mesh-mission-control/hosts.json`, see `hosts.example.json`.

Use the address `local` for the machine the bridge runs on. LAN discovery probes the SSH port on your own /24 subnets, only when you ask. Tailnet discovery reads `tailscale status` and skips phones and tablets.

## Install the app

Download `mesh-mission-control.apk` from the [latest release](../../releases/latest), allow installs from your browser or file manager, and open it. Android 6.0 or newer.

1. Settings → **Find servers on this network**, or type the bridge's address. Over Tailscale or another VPN, use the bridge machine's 100.x address or MagicDNS name. The default port is 18877.
2. Tap **Check and pair**. The app shows the certificate fingerprint it received. Compare it with the one the bridge printed, then paste the token and confirm.
3. Add hosts in Settings.

The app stores the server address, token and pinned fingerprint in app-private storage with backup disabled, and refuses any other certificate afterwards. The only connection made without the token is the first `hello`, used to read the certificate.

Verify a download with `sha256sum -c mesh-mission-control.apk.sha256`. To build it yourself, see below.

## Peek at a terminal

Off by default. Start the bridge with `--allow-peek` and a **Peek** button appears on process cards. It fetches the last 40 lines of that process's terminal, once, when pressed (never polled). Only tmux panes and Herdr panes can be read; anything else is reported as unreadable. Escape sequences are removed and common credential shapes (API keys, bearer tokens, `token=…`) are masked, but terminal output can still contain sensitive text. Nothing is stored.

## Controls

Drag to rotate. Two fingers: pinch to zoom, slide sideways to pan, slide up or down to tilt. Double-tap empty space to reset.

## Security notes

- The bridge listens on all interfaces by default so the app can find it. Use `--bind ADDRESS` to restrict it (for example to a Tailscale address). Anyone who can reach the port can read `/api/hello`; everything else needs the token.
- The token grants read access to your hosts' load and process names, plus changing the host list. Treat it like a password and rotate it by deleting `~/.config/mesh-mission-control/token` and restarting.
- Hosts you add are reached with the bridge user's SSH keys. Only add machines you control.

## Build the app

Needs the Android SDK (build-tools 35, platform 35) and a JDK:

```sh
ANDROID_SDK_ROOT=~/Android/Sdk android/build.sh
```

The APK is written to `android/build/`, signed with a key created at `~/.config/mesh-mission-control/release.keystore` on first build (override with `MMC_KEYSTORE`). Updating an installed app requires the same key; releases use the maintainer's key.

## Tests

```sh
cd server && python3 -m unittest -v test_server
```

## Licence

MIT. Bundles three.js (MIT), see `android/assets/THREE-LICENSE.txt`.
