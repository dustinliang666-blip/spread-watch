# Spread Watch

Spread Watch lets the person on duty triage a wide bid/ask spread from a 576×288 Even Realities G2 display. The demo uses six synthetic quotes for `DEMO-YES`. A spread of at least 6¢ opens a paper alert. The spread measures the width of the quote in integer cents.

## Start the offline demo

Use Windows x64 and Node **24.22.1**. From this directory, run the following PowerShell commands. The browser preview and Mock inbox work with Node and npm alone.

```powershell
$env:OMP_NUM_THREADS='1'
$env:GOMAXPROCS='1'
npm start
```

Open `http://127.0.0.1:8765/`. `npm start -- --port 9876` changes the local Replay port. Use **Next sample** to advance the clock and the preview buttons to simulate G2 scroll and tap. A connected Even Hub environment sends those inputs through the SDK. **Reset replay** restores the first quote and clears the Replay disposition log and Mock inbox.

| Time | What to look for | What to do |
| --- | --- | --- |
| 00:00 | Watching, with a 2¢ spread | Advance one sample |
| 00:05 | Alert A01 opens at exactly 6¢ | Tap **Snooze 60s** |
| 00:10 | A01 stays snoozed at 8¢ | Advance one sample |
| 01:05 | Review A01 opens at the 60s boundary | Scroll up to **Escalate** and tap. Check `MOCK · R-A01` and the matching Mock inbox entry |
| 01:10 | The spread recovers to 2¢ | Advance one sample |
| 01:15 | Alert A02 opens at 8¢ | Scroll down to **Acknowledge** and tap. Check `Seen A02` |

## G2 and Telegram

`npm ci --ignore-scripts --no-audit --no-fund` installs the locked toolchain when npm access is available. The Even Hub SDK is **0.0.16**, the simulator and its Windows x64 binary are **0.9.5**, and the packaging CLI is **0.2.0**. The browser verifier uses `playwright-core` **1.56.1** with installed Chrome or Edge. Set `SPREAD_WATCH_CHROMIUM` to the path of a compatible Chromium executable to select it explicitly.

Mock delivery is the default. For a real handoff, supply the two variables named in [the empty environment example](.env.example) through the local process environment. Use the numeric chat ID of a chat where the Bot can post. Run `npm start -- --bot` on port 8765, then select **Enable real Bot delivery**. The companion displays whether the configuration is ready. Each launch starts in Mock. The Bot uses the same synthetic quotes, labeled `REPLAY / PAPER`, with its own timeline and disposition log. The bridge sends only Telegram `sendMessage` requests to the configured chat.

The Bot session is stored in `.spread-watch-telegram.json` in the local user profile. Acknowledgements and receipts survive refresh and restart. An explicit rejection displays `FAILED` and enables **Retry failed escalation** in the companion. If the connection drops or the process restarts mid-send, `DELIVERY UNKNOWN` stays in the log for the operator to check with the recipient. This state has no retry action.

## Simulator and offline package

Run from an active Windows desktop session with WebView2 installed and loopback port `9898` available. The smoke runner drives the official simulator over its automation HTTP API. It advances the Replay clock on the local server and sends actions through the simulator's scroll and click endpoints. The runner verifies the 576×288 RGBA frames, compares the open, snoozed and receipt status masks, and checks that the companion recorded exactly one A01 escalation from G2. It prints the evidence directory and verifies that the owned ports can be rebound on exit.

```powershell
$env:OMP_NUM_THREADS='1'
$env:GOMAXPROCS='1'
npm ci --ignore-scripts --no-audit --no-fund
node --test
npm run smoke:sim
npm run pack:offline
$sim = Get-ChildItem -Directory artifacts/sim-* | Sort-Object LastWriteTime -Descending | Select-Object -First 1
npm run verify:bundle -- --log "$($sim.FullName)/console.json" --log "$($sim.FullName)/activity.json"
```

After installation, the pack command works offline. The official CLI uses its bundled SDK metadata and writes `dist/spread-watch-0.1.0.ehpk`. The runner verifies the EHPK checksum, manifest, allowed paths and expected file bytes, then serves only the extracted static assets on loopback. It runs the demo twice from the manifest's entrypoint in a fresh browser context. `EXTRACTED_REPLAY_RUNS=2` and `NON_LOOPBACK_REQUESTS=0` confirm both replays. The command prints the output path, size and SHA-256 after the checks pass. The packaged demo uses Mock delivery.

The bundle check scans the [source allowlist](scripts/bundle-policy.js), a temporary ZIP of the server runtime, the local `.ehpk` when present, and the supplied logs. It requires plaintext, ZIP and EHPK canaries to be blocked and reports `SECRET_HITS=0` for scanned release material. Use `--archive <path>` for an additional ZIP or EHPK and `--log <path>` for each `.log`, `.txt` or `.json` evidence file.

For an optional recording, run `npm start` and open the loopback URL in Even Hub Simulator 0.9.5. Follow the table above with the simulator controls. Capture the G2 display and the companion, including `MOCK · R-A01`, the matching inbox row and `Seen A02`. Keep the recording under 180 seconds.

See the [offline replay walkthrough](#start-the-offline-demo) and [MIT license](LICENSE).
