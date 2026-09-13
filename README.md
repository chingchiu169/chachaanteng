# ChaChaanTeng

<p align="center">
  <img src="public/logo.png" width="96" alt="ChaChaanTeng logo" />
</p>

A Windows desktop GUI for [llama.cpp](https://github.com/ggml-org/llama.cpp) — run, chat with, and benchmark local LLMs. Built with **Tauri 2 + Rust + React**.

## Features

- **Engine management** — auto-detects hardware (nvidia-smi / PowerShell CIM), downloads the right llama.cpp Windows build (CUDA / Vulkan / CPU / SYCL) with SHA256 verification, multi-version coexistence, or point at your own binary
- **Quick Launch & Configure** — one-click launch tabs, plus a full flag editor with categories, presets, and modified-from-default indicators
- **Chat** — streaming markdown, thinking-effort control, collapsed reasoning, context capacity check, text/image attachments, web search (DDG / SearXNG), per-conversation server pick
- **Models** — Hugging Face download with progress + cancel, publisher/arch/params metadata enrichment, display aliases, vision `.mmproj` pairing & cascade delete
- **Benchmarks** — llama-bench and perplexity runners with history
- **Monitor** — live tok/s tiles (total + active-time averages), slot busy state, GPU/RAM telemetry via nvidia-smi
- **External servers** — register remote OpenAI-compatible endpoints; API keys encrypted in Windows Credential Manager (own wincred FFI)
- **Cloudflare tunnel** — expose a local server over cloudflared
- **Auto-update** — git-based engine/app update flow
- 5 themes (dark fallback + light), English / 繁體中文 UI

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2.x (Rust core), NSIS installer |
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
