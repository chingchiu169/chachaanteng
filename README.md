# ChaChaanTeng

<p align="center">
  <img src="logo/icon-rounded.png" width="96" alt="ChaChaanTeng icon" />
</p>

A desktop GUI for [llama.cpp](https://github.com/ggml-org/llama.cpp) on Windows and macOS (Apple Silicon / Intel) — run, chat with, and benchmark local LLMs. Built with **Tauri 2 + Rust + React**.

## Features

- **Engine management** — auto-detects hardware (nvidia-smi / PowerShell CIM on Windows), downloads the right llama.cpp build (CUDA / Vulkan / CPU / SYCL on Windows, Metal / CPU on macOS) with SHA256 verification, multi-version coexistence, or point at your own binary
- **Quick Launch & Configure** — one-click launch tabs, plus a full flag editor with categories, presets, and modified-from-default indicators
- **Chat** — streaming markdown, thinking-effort control, collapsed reasoning, context capacity check, text/image attachments, web search (DDG / SearXNG), per-conversation server pick
- **Models** — Hugging Face download with progress + cancel, publisher/arch/params metadata enrichment, display aliases, vision `.mmproj` pairing & cascade delete
- **Benchmarks** — llama-bench and perplexity runners with history
- **Monitor** — live tok/s tiles (total + active-time averages), slot busy state, CPU/RAM/disk telemetry (+ NVIDIA GPU via nvidia-smi on Windows)
- **External servers** — register remote OpenAI-compatible endpoints; API keys encrypted in the OS credential store (Windows Credential Manager / macOS Keychain)
- **Cloudflare tunnel** — expose a local server over cloudflared
- **Auto-update** — git-based engine/app update flow
- Dark and Light theme, English / 繁體中文 UI

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2.x (Rust core), NSIS installer (Windows) / DMG (macOS) |
| Frontend | React 18 + TypeScript + Vite, Tailwind v4 + daisyUI, Zustand |
| Rust crates | tokio, reqwest, rusqlite (bundled), zip, sha2, tauri-plugin-dialog |
| External binaries | llama.cpp releases (GitHub), cloudflared, git CLI |

## Getting started

Prerequisites: Windows 10/11 with WebView2, [Rust](https://rustup.rs) (MSVC toolchain + VS Build Tools), Node.js ≥ 20.

```sh
npm install
npm run tauri dev      # development
npm run tauri build    # release installer (NSIS)
```

### Building on macOS

Prerequisites: Xcode command-line tools (`xcode-select --install`), [Rust](https://rustup.rs), Node.js ≥ 20.

```sh
npm install
npm run tauri build    # → src-tauri/target/release/bundle/dmg/*.dmg (+ .app)
```

The build is **unsigned** — first launch needs a Gatekeeper bypass: right-click the app → *Open* (or `xattr -dr com.apple.quarantine /path/to/ChaChaanTeng.app`).

The app downloads its own llama.cpp engine on first launch — no manual setup needed.

## Project layout

```
src/                  React frontend
  components/         views: Chat, Models, Configure, QuickLaunch, Benchmarks, Monitor, Settings…
  flags/              flag definitions + arg building
  i18n/               en / zh-tw strings
  lib/                API bridge, monitor sync, model meta/aliases, themes
src-tauri/src/        Rust core
  builds.rs           engine release fetch / verify / install
  engine.rs           spawn server/cli/bench + output streaming
  chat.rs             SSE proxy, context capacity check
  hf.rs               Hugging Face download + metadata
  bench.rs            llama-bench / perplexity runner
  external.rs         external server registry (wincred-encrypted API keys)
  metrics.rs          server metrics proxy (llamacpp:* Prometheus)
  tunnel.rs           cloudflared tunnel
  gitupdate.rs        git-based auto-update
  hw.rs               hardware detection (nvidia-smi / CIM)
  system_stats.rs     CPU/RAM/disk + GPU telemetry
```

## Status & Roadmap

### Shipped (v0.1)

- [x] Engine install — CUDA / Vulkan / CPU / SYCL (Windows), Metal / CPU (macOS), SHA256 verified, multi-version coexistence
- [x] Quick Launch tabs + full flag editor (~165 flags: categories, scopes, presets, modified-from-default indicators)
- [x] Chat — streaming markdown, thinking effort + collapsed reasoning, context capacity bar, text/image attachments, web search (DDG / SearXNG), per-conversation server pick
- [x] Models — HF search/download with progress + cancel, metadata enrichment, display aliases, mmproj pairing & cascade delete, sortable columns
- [x] Benchmarks — llama-bench + perplexity runners with history
- [x] Monitor — live tok/s (total + active-time averages), slot busy state, per-process CPU/RAM/GPU telemetry
- [x] External servers address book (OS credential-store key encryption) + Cloudflare tunnel
- [x] Conversation search — case-insensitive across titles and message contents, match snippets in the sidebar
- [x] Export conversation — any chat as Markdown or JSON via save dialog
- [x] Trash & undo — soft delete with 6s Undo notice; trash view (restore / permanent delete / empty), 30-day auto-purge
- [x] Auto-update for installer users — tauri-plugin-updater + GitHub Releases manifest (NSIS / DMG); the git-based flow still covers source installs
- [x] macOS support · dark/light theme · EN / 繁體中文

### Up next

- [ ] **Model comparison chat** — send one prompt to several running servers, side-by-side replies with per-server tok/s
- [ ] **Per-reply stats** — prompt tokens / generation time / t/s in each assistant bubble footer (data already available)
- [ ] **Speculative decoding wizard** — one-click "speed up" that picks draft/ngram settings from the VRAM fit estimate
- [ ] **Local RAG / document chat** — lightweight knowledge base over local files (needs an embedding pipeline)
- [ ] **Agent / MCP surface** — tool-calling for the built-in web search + external servers
- [ ] **Preset sharing** — export/import preset JSON, community presets later

## Releasing

Installer users update through `tauri-plugin-updater`, which fetches a static
`latest.json` manifest from GitHub Releases:

```
https://github.com/chingchiu169/chachaanteng/releases/latest/download/latest.json
```

**One-time setup** — generate the updater signing keypair (keep the private key OUT of the repo):

```sh
./node_modules/.bin/tauri signer generate -w "$HOME/.tauri/chachaanteng-updater.key" --ci
# paste the printed public key into src-tauri/tauri.conf.json → plugins.updater.pubkey
```

**Per release:**

1. Bump the version in **both** `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (a mismatch fails `tauri build`). Keep tags as `vX.Y.Z` — the git-based flow for source installs relies on them.
2. Build with the signing key exported:

   ```sh
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/chachaanteng-updater.key"
   npm run tauri build
   ```

3. New artifacts beyond the usual installer: `*-setup.exe.sig` (Windows) and, on macOS, `*.app.tar.gz` + its `.sig`. The macOS updater downloads the **tarball, not the dmg** — upload both.
4. Author `latest.json` for the release (do not commit it):

   ```json
   {
     "version": "0.2.0",
     "notes": "Release notes…",
     "pub_date": "2026-09-17T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "url": "https://github.com/chingchiu169/chachaanteng/releases/download/v0.2.0/ChaChaanTeng_0.2.0_x64-setup.exe",
         "signature": "<contents of the .sig file>"
       },
       "darwin-aarch64": {
         "url": "https://github.com/chingchiu169/chachaanteng/releases/download/v0.2.0/ChaChaanTeng_0.2.0_aarch64.app.tar.gz",
         "signature": "<contents of the .sig file>"
       }
     }
   }
   ```

5. Create the release with all assets (installer, `.sig` files, `app.tar.gz`, `latest.json`). The portable build is intentionally not part of auto-update — it updates by manual download.
