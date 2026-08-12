# Waffled-Bite device audio — the sound machine (implementation plan)

The Waffled-Bite's Sounds tile was fully wired end to end — parent web panel, device
screen, settings sync — and made **no sound at all**, because nothing in
`apps/waffled-bite-firmware` touched I2S. This plan closes that, in two phases.

**Status: phases 1 and 1b work.** The synthesis engine (§3.2, §8) and the `wb_audio` HAL
(§3.4) are both built, and the sound machine plays through the device's speaker from the
Sounds tile and from a parent's panel, with live volume and no pops. **Phase 1b (§5) is
built too**: the device parses `settings.alarm`, five of the six wake tones are
synthesised (birdsong needs a recording and moves to §6), the alarm has its own volume,
and decision D4's pause/resume sequence runs. **The sleep timer's auto-off is built
too** — `wb_sleep_timer.{h,cpp}`, another pure decision in the same shape as `wb_alarm`.
Remaining: the sampled sounds (§6).

The alarm's phase logic lives in `wb_audio_seq` — a pure state machine both backends
drive — specifically so D4 is unit-testable. It replaced hand-rolled sequencing inside the
I2S task, where none of it could be checked without standing next to the device at 6:45am.
The case that justified the extraction: `main.cpp` reconciles playback with settings on
every poll, so about four polls land inside a 20-second alarm, and each would otherwise
have started the sound machine up underneath the tone.

Two hardware findings, now recorded in `wb_audio_esp32.cpp` rather than here: the vendor's
I2S pins are correct and the P4 hits 22.05 kHz exactly, and **the NS4168 enable on GPIO30
is active LOW** — the opposite of what the pin name implies, and silent-with-no-errors when
wired the other way.

Written as a follow-on to the firmware's milestone 8 (see
`apps/waffled-bite-firmware/README.md`). Read that first for the board, the two build
environments, and the HAL conventions this plan reuses.

## 1. Scope

**In:** actual audio output for the sound machine (`settings.sound`), the one-shot morning-alarm
tones, and the fade/volume/timer behaviours around them.

**Out (deliberately):** the microphone, voice control, and anything TTS. The board's mic
array is a separate PDM-RX path into the P4 (`sdkconfig.defaults` confirms
`CONFIG_SOC_I2S_SUPPORTS_PDM_RX` and even LP-I2S voice-activity detection) and has nothing
to do with playing white noise. It is a "Hey Waffles" feature for a much later milestone;
scoping it in here would triple the work for zero benefit to a kid trying to sleep.

## 2. What already exists

| Piece | Status |
| --- | --- |
| `settings.sound.{on,sound,volume,timerMin}` in the API | Done (`waffledBites.ts`) |
| Parent-side control (7 sounds, volume, sleep timer) | Done (`apps/web/src/kiosk/WaffledBiteDevice.tsx:22`) |
| Device-side control screen + device-authed write | Done (`src/ui/control_detail_screen.cpp`, `PATCH /api/waffled-bites/device/settings`) |
| Device state struct | Done (`WbSoundSettings`, `src/wb_state.h:22`) |
| 5s poll keeping both sides in sync | Done (`wb_do_poll` in `main.cpp`) |
| Sound generation (`wb_synth`, 5 recipes, 11 unit tests) | **Done** — `src/wb_synth.{h,cpp}`, `test/test_synth/` |
| I2S output + amp sequencing + fades (`wb_audio`) | **Done, hardware-verified** — `src/wb_audio_{esp32,native}.cpp` |
| Wake tones (`wb_tone`, 5 recipes) + alarm timing (`wb_alarm`) | **Done** — `src/wb_tone.{h,cpp}`, `src/wb_alarm.{h,cpp}`, `test/test_alarm/` |
| D4 alarm sequence (pause -> tone -> hand back) | **Done** — `src/wb_audio_seq.{h,cpp}`, `test/test_audio_seq/` |
| Sleep timer auto-off (`wb_sleep_timer`, 12 unit tests) | **Done** — `src/wb_sleep_timer.{h,cpp}`, `test/test_sleep_timer/` |
| Sampled sounds | Still open (§6) |

## 3. The load-bearing decisions

### 3.1 Audio is generated and played on-device. Never streamed.

Two reasons, the first decisive:

**The failure mode is a kid's bedroom.** If the self-hosted box reboots for an upgrade at
2am, or Wi-Fi blips, streamed audio stops and a child wakes up in silence. Continuous
overnight playback must have no network dependency whatsoever. The device already has an
offline screen and a poll-failure streak (`wb_mark_poll_failed`) precisely because the
network is assumed to be unreliable — audio has to hold to the same standard.

**The Wi-Fi path is the weakest link on this board.** The ESP32-P4 has no radio. Wi-Fi is
remoted through the on-board ESP32-C6 co-processor over ESP-HOSTED/SDIO — extra latency,
extra jitter, and CPU cost per packet, on a link that already needed a crash-loop fix
during bring-up. It is the worst available transport to hang ten continuous hours of audio
off.

Playback must therefore keep running unchanged through a total network outage. That is a
testable requirement, not a nice-to-have (see §8).

### 3.2 Phase 1 ships zero audio assets — the sounds are synthesised

Of the seven sounds in the web UI, **five are filtered noise plus a slow modulator**, which
the P4 generates with CPU to spare:

These five are **built and tested** — `src/wb_synth.{h,cpp}`, 11 unit tests in
`test/test_synth/`. The recipes below are as-implemented, not as-imagined:

| Sound | Recipe | Level |
| --- | --- | --- |
| `white` | Noise through one 6 kHz pole, so it's recognisably white without the harsh top | rms 0.24 |
| `fan` | Two cascaded 900 Hz poles (dull, no hiss) + a 120 Hz motor hum carried by its 2nd harmonic | rms 0.20 |
| `rain` | Noise minus its own 1.5 kHz lowpass (= hiss) + randomly pitched, exponentially decaying droplets | rms 0.18 |
| `ocean` | 200 Hz–1.3 kHz band-passed noise under a ~7 s swell, squared for a sharper crest | rms 0.155 |
| `heartbeat` | Two enveloped harmonic thumps (110 Hz lub, 88 Hz dub 0.32 s later) at 60 bpm, silent between | peak 0.87 |
| `forest` | **Needs real recordings** (birds, crickets) — phase 2 |  |
| `lullaby` | **Needs a real recording** (a synthesised melody sounds cheap) — phase 2 |  |

The levels are measured, not nominal, and they're deliberately close together: switching
sounds must not change how loud the room is. `ocean` sits lowest on purpose — band-passed
noise is near-Gaussian and peaks at ~5.5x its own RMS, so matching the others' loudness
would drive its crests into the clamp. `white`, being barely-filtered uniform noise, has a
crest factor of about 2 and can sit much hotter for the same peak.

**`heartbeat` was inaudible on the real speaker, and is fixed.** This was predicted here
and then confirmed on hardware: its thumps were 52/44 Hz fundamentals, and D5's 30×20 mm
cavity driver has essentially no output that low, so the sound played and *nothing came
out*. A speaker limit, not broken plumbing.

The fix moved the energy up rather than up-pitching the sound: each thump is now a harmonic
stack (fundamental + 2nd + 3rd + 5th) at 110 Hz (lub) and 88 Hz (dub), so most of the
energy sits in 220–550 Hz where the driver actually moves air, while the ear still infers
the low pitch from the harmonic series. The rhythm was always doing most of the work — a
lub-dub at 60 bpm reads as a heartbeat nearly regardless of timbre.

Locked by `test_heartbeat_survives_a_speaker_with_no_low_end`, which asserts the thump
carries more than twice the high-frequency energy of a pure 55 Hz sine. That's a physical
property rather than a taste, so it can't silently regress.

Drawing the phase boundary here is the whole point of the plan. Synthesis-only kills, in
one stroke: the audio **licensing** question (no CC-BY assets in an AGPL repo), the
**storage** question, the **download/cache-invalidation** question, and the
**download-progress UI** question. It also sidesteps the single hardest quality problem in
a sleep device — an audible loop seam — because there is no loop.

Until phase 2, `forest` and `lullaby` render as disabled chips with a short "coming soon"
note rather than silently playing the wrong thing — and that's **three** surfaces, not one:
the device's own Sounds screen (`src/ui/control_detail_screen.cpp`), the parent web panel
(`WaffledBiteDevice.tsx:22`), and the iOS panel (`WaffledBitesModel.swift:18`), which
carries its own hardcoded copy of the same seven-sound list. All three have to agree, or a
parent picks a sound on their phone that the device won't play.

### 3.3 NS4168 is an amplifier, not a codec

The product page calls it an "audio codec"; it isn't. It's a class-D amp with an I2S
digital input, fixed hardware gain, and a shutdown pin. **No I2C register configuration, no
codec init sequence, no driver library.** You write I2S frames and it makes sound. This is
a meaningful chunk of expected effort that simply doesn't exist.

Consequences:

- **Volume 0–100 is applied in software** by scaling PCM before it hits I2S. It must use a
  logarithmic curve — with linear scaling the bottom half of the slider does nothing
  audible, which will read as a bug.
- **The amp's enable pin must be sequenced around fades** (enable → fade in; fade out →
  short wait → disable) or every toggle pops. On a bedtime device a pop at lights-out is
  disqualifying, so this is a correctness requirement, not polish.

### 3.4 A `wb_audio` HAL, mirroring `wb_http` / `wb_wifi` / `wb_store`

The firmware already has a clean three-file pattern for everything hardware-dependent, and
audio gets the same:

```
src/wb_audio.h          // interface — start(sound, volume), stop(), set_volume(), fade
src/wb_audio_esp32.cpp  // I2S TX to the NS4168 + amp enable GPIO
src/wb_audio_native.cpp // SDL2 audio callback
src/wb_synth.cpp/.h     // pure DSP — no platform, no LVGL, unit-testable
```

Screens never learn which target they're on, exactly as with networking today.

**SDL2 is already linked for the simulator** (`platformio.ini`'s `[env:native]` links
`-lSDL2` for LovyanGFX's display panel), so `native` audio costs an audio callback and
nothing else. The entire synth engine can be written, heard, and tuned on a desktop with no
board attached, then bring-up on hardware becomes purely an I2S-plumbing exercise (§7).

### 3.5 A local tap is instant; only parent-side changes wait for the poll

The device's own Sounds screen must start/stop audio **immediately** on tap, then PATCH.
Routing local taps through the 5s poll would mean a kid taps "off" and waits five seconds
in the dark — indistinguishable from broken. Parent-side changes made from the web app
legitimately arrive on the next poll; that's fine and already how every other setting
behaves.

This mirrors the existing optimistic path in `wb_patch_settings`.

### 3.6 Phase 2 is server-as-library, device-as-cache — still not streaming

When real recordings land, the server hosts them and the device **downloads once, caches
locally, and plays from flash**. That keeps the upside people actually want from
server-hosted audio — add or replace sounds without reflashing firmware, and eventually
parent-recorded voice or a bedtime story — with none of the runtime fragility of §3.1.

The cache goes in the **`spiffs` partition, which already exists and is entirely unused**
(`default_16MB.csv` reserves `0x360000` = 3.5 MB; `LV_USE_FS_LITTLEFS` is `0` and nothing
mounts it — fonts and the mascot are compiled-in C arrays). Two reasons that beats both an
SD card and compiled-in assets:

- **It survives OTA.** `app0`/`app1` get overwritten by an update; the data partition
  doesn't. Re-downloading the whole sound library after every firmware update would be
  absurd.
- **No SD card required.** At mono 22.05 kHz, a 30-second forest loop is roughly 360 KB as
  MP3. The full library fits several times over in 3.5 MB.

Genuine streaming stays reserved for short, ephemeral, failure-survivable one-shots (a
parent's recorded voice message, later TTS nudges) — and even those should buffer fully
before playing.

### 3.7 22.05 kHz, 16-bit, mono

Settled up front rather than left to whoever writes the I2S init, because it constrains
everything downstream — synth cost, ring-buffer size, and phase 2's storage budget.

- **22.05 kHz.** The included speaker is a 30×20 mm cavity driver; it reproduces nothing
  meaningful above ~10 kHz, so a higher rate spends cycles and PSRAM on band the hardware
  throws away. 11 kHz of Nyquist covers everything that will actually come out. It's also a
  standard rate the I2S clock divider hits exactly.
- **Mono, duplicated to both I2S channels.** I2S Philips framing makes you write both
  channels regardless, so mono is a *synthesis* choice, not an output one — and it's free
  whether the board turns out to have one speaker connector or two. Stereo buys a sleep
  device nothing: there is no stereo image in a fan.
- **16-bit.** The amp's noise floor is far above anything 24-bit would resolve.

Anything that changes this rate changes what the recipes sound like — white noise most of
all, since it's the sound with the most energy near Nyquist. Retune by ear if it ever moves.

### 3.8 Hearing it before touching hardware

`tools/audio/render_wav.cpp` renders any recipe straight to a WAV from the real `wb_synth`,
so the sound design can be judged by ear on a laptop with no board, no flash cycle, and no
speaker wired up:

```
clang++ -std=c++14 -O2 -Isrc tools/audio/render_wav.cpp src/wb_synth.cpp -o /tmp/wb_render
/tmp/wb_render ~/Desktop/waffled-bite-sounds 20   # 20s of each sound
/tmp/wb_render --measure                          # levels only, writes nothing
```

It renders in 512-sample blocks on purpose, exercising the same
continue-from-where-you-stopped path the device's ring buffer will use — so a seam bug
shows up in the preview rather than at 2am.

**It writes outside the repo, deliberately.** Phase 1 ships zero audio assets (§3.2), and
committed `.wav` files would read like shipped assets to the next person who opens the
tree. Regenerate rather than store.

Two caveats when listening. Laptop speakers and headphones are far better than the target
driver, so the preview flatters every recipe — `white` and `rain` will lose most of their
top end on the real speaker. And the final judgement has to happen on the device anyway
(§7).

**If something sounds wrong, these are the knobs** (all in `wb_synth.cpp`, all one-liners —
re-run `--measure` afterwards, since changing a recipe changes its level):

| Complaint | Knob |
| --- | --- |
| **Anything is too quiet except near 100%** | Almost certainly not the recipe — check the 24 dB range in `wb_synth_gain` and whether the sound's energy sits above ~300 Hz. Both hardware bugs so far were one of these two |
| Rain sounds like a shaker or wind chime, not rain | Droplets are pure decaying sines firing ~30x/sec. Widen the `dropWait` range (`250u + rng % 900u`), drop the pitch range (`600 + 1800 Hz`), or lengthen the `0.028f` decay so each droplet is less tick-like |
| The fan whines instead of rumbling | The hum is 120 Hz plus its 2nd harmonic. Lower `0.030f` (the harmonic carries most of what you hear on this speaker) |
| The fan is muddy, or too hissy | The two cascaded `lpCoeff(900.0f)` poles set the character. Lower for duller — but not far below ~600 Hz, or the speaker stops reproducing it at all |
| White noise is harsh | Lower the `lpCoeff(6000.0f)` shelf |
| Ocean surges too fast or too evenly | Swell rate `0.14f` Hz and the `0.22f + 0.78f * u * u` shape — the square is what sharpens the crest |
| Heartbeat is weak or thin | It's peak-limited, so raising the multipliers just clips. Lengthen the envelope (`0.010f` attack / `0.110f` decay) to carry more energy under the same peak, or lift the harmonic weights in `thump` |

## 4. Phase 1 — the sound machine, synthesised

1. **`wb_synth`** — an xorshift noise source, a small biquad set, an LFO, and a per-sound
   parameter table implementing §3.2's five recipes. Pure C++, no platform headers.
2. **`wb_audio` HAL** — ring buffer filled by the synth, drained by an I2S write task
   pinned to its own core on `esp32-p4`, and by the SDL audio callback on `native`.
3. **Volume + fades** — log curve; fade in/out over ~400 ms; amp enable/disable sequenced
   around the fades per §3.3.
4. **State wiring** — `wb_do_poll` already parses `settings.sound`; playback reacts to
   deltas on `{on, tone, volume}`. Local taps call the HAL directly first (§3.5).
5. **Sleep timer** — `timerMin` (0/15/30/60/120) fades out and stops, and must survive a
   poll failure: the countdown is local, not server-driven.
6. **Interaction with the locks — none.** Quiet time and the wake-light `sleep`/`warn`
   states force-navigate the UI, and audio is deliberately **independent of all of them**
   (decision D1). The sound machine keeps playing through quiet time and through bedtime,
   unchanged. Nothing in the lock code paths should touch `wb_audio` — that's the whole
   point of a sound machine, and coupling them would be a bug, not a feature.

## 5. Phase 1b — the morning alarm tone (small, high value) — BUILT

*Built. The three gaps below were the plan; here's how each was actually closed.*
*Gap 1: `WbAlarmSettings` + a parse in `wb_state.cpp`, fired from a pure decision*
*(`wb_alarm_step`) that latches so the dozen polls of the alarm's minute ring once.*
*Gap 2: `alarm.volume` exists, with a slider on both parent surfaces; it runs through*
*`wb_synth_gain`, the sound machine's own curve, so "50" means one thing on the device.*
*Gap 3 was sidestepped rather than settled — see Q2 in §10.*

*One constraint the plan didn't anticipate: every tone had to clear the >300 Hz bar D5*
*describes, which ruled out the obvious low-fundamental takes on "Ocean tide". All five*
*sit at 440 Hz or above and are held against the same brightness floor the heartbeat fix*
*introduced.*

*And one the plan couldn't have: **CPU cost is a tuning constraint here, not just an***
*implementation detail. The first version computed each note analytically — around 18*
*sines and 12 exponentials per sample — which measured correctly and rendered a clean WAV*
*but came out audibly scratchy on the device, because that's the core drawing the screen*
*and on the P4 those calls cost hundreds of cycles each. The tones are now a voice pool of*
*coupled-form resonators with one-pole envelopes: multiply-and-add per sample, ~3.5-7.6x*
*cheaper on the host and much more than that on the board. Rendering the same audio to a*
*WAV and listening on a laptop is what separated "the recipe is wrong" from "the device*
*can't play it" — worth reaching for first next time.*

The web UI already offers six `ALARM_TONES` (`WaffledBiteDevice.tsx:26`) that do nothing.
**An alarm that makes no sound is not an alarm.** Worth doing in the same body of work as
phase 1 while the audio path is fresh.

One-shot tones are the easy case: a few seconds long, no looping problem, trivially small,
and — for chime, bells, harp, ocean tide and twinkle — synthesisable as enveloped sine
partials, so phase 1b keeps §3.2's zero-assets rule. **Birdsong is the one exception**: it
needs a real recording, so it moves to phase 2 alongside `forest` and `lullaby` and is shown
disabled until then.

**Careful: the alarm and the wake light are two different features.** The tones belong to
`settings.alarm` (`{on, hour, min, tone}`) and fire at that clock time. The wake light is
the separate per-day schedule driving `WbWakeLightInfo`'s `sleep`/`warn`/`wake` glow, and it
stays silent by default (D1's scope note), so don't wire tones to the wake-light transitions.

Three concrete gaps this opens up:

1. **The device never parses `alarm` at all.** `GET /device/state` already returns the whole
   settings blob verbatim (`settings: deviceRow?.settings ?? {}`), so the alarm *is* on the
   wire today — but `WbDeviceState` (`wb_state.h:94`) has no alarm field, so
   `wb_state_from_json` drops it. Add the struct field + parse, and a local minute-tick
   comparison against `nowHour`/`nowMin` (already present) to fire it. The device has no RTC,
   so a missed alarm during an offline stretch is expected and acceptable.
2. **Wake tones get their own volume** (decision D3) — a new `alarm.volume`, independent of
   `sound.volume`. This needs **no API change**: the parent route
   `PATCH /api/waffled-bites/:id/settings` deep-merges arbitrary JSON with no allowlist
   (`waffledBites.ts:531`), so the field simply starts existing. It does need a slider on the
   **web panel and the iOS panel**, and a parse on the device. It does *not* belong in
   `DEVICE_WRITABLE_SETTINGS_KEYS` — alarm stays parent-only, and the device has no alarm UI.
3. **`alarm.tone` is a display string, not a key.** It's stored as `'Sunrise chime'`, unlike
   the sound list which uses stable keys (`white`, `ocean`). Matching on prose in firmware is
   fragile — a copy tweak silently breaks the alarm, and it can never be localised. Recommend
   migrating to keys with a back-compat mapping for existing rows as part of this work, since
   phase 1b is the first thing that actually reads the field.

## 6. Phase 2 — sampled sounds (`forest`, `lullaby`, birdsong)

Deferred deliberately, but the shape is known:

- **Distribution.** A versioned sound pack published as a release asset (**not** committed
  binaries in git), fetched over the existing HTTP client into `spiffs`, with a manifest so
  the device knows what it has. Every asset must be CC0 or otherwise AGPL-compatible, with
  provenance recorded in-repo.
- **The thing that will actually bite is gapless looping, not decode cost.** MP3 encoder
  padding makes seam-free loops painful. With 32 MB of PSRAM, decode the whole loop to PCM
  **once** at track start and loop the buffer with a short crossfade — keep the decoder out
  of the audio path entirely.
- **Cache eviction / partial-download recovery**, plus what the device plays if the
  selected sound isn't cached yet and the server is unreachable (proposal: fall back to the
  nearest synth bed rather than silence).

## 7. Verification path

The board **is** in hand — the README's two "no board in hand yet (ordered)" notes are
stale leftovers from the 20 Jul port commit, superseded three days later by real-hardware
WiFi bring-up including reboot testing (`a9e9121b`). They're corrected as part of this
work. So both halves of the verification are available:

- **Desktop first.** The synth, fades, volume curve, and sleep timer are all written,
  unit-tested, and *listened to* with no board attached — the synth and its levels are done
  (§3.2, §3.8), the rest follows. This is where the sound design actually happens.
- **Then hardware**, which reduces to I2S plumbing plus the things no desktop can prove:
  amp-enable pop timing, how the recipes survive a 30×20 mm cavity driver (§D5), and
  current draw at volume (relevant if the battery socket is ever used).
- The vendor repo (`Elecrow-RD/CrowPanel-Advanced-7inch-…`) documents the I2S pins
  (`AUDIO_GPIO_LRCLK 21`, `BCLK 22`, `SDATA 23`, `AUDIO_GPIO_CTRL 30` for amp enable) and
  ships Eagle schematics under `Eagle_SCH&PCB/`. **Confirm against the schematic** before
  trusting those numbers — the same board family has an ESP32-S3 variant and vendor docs
  mix them up.

## 8. TDD plan

The synth is the rare firmware component that unit-tests cleanly, so it gets real TDD
rather than the simulator-verification fallback the LVGL screens rely on.

`pio test -e native_test` already exists (`test/test_boot_flow/`, Unity).

**Done** — `test/test_synth/`, 11 tests, with `wb_synth.cpp` added to `build_src_filter`:

1. ✅ Each sound key parses; unknown and phase-2 keys **fail closed** (silence, not a
   substitute sound — a kid who asks for a lullaby and gets white noise is worse off than
   one who gets nothing).
2. ✅ The volume curve is logarithmic and monotonic across all 101 steps, 0 is true digital
   silence, 100 doesn't clip, and out-of-range values from a bad payload clamp.
3. ✅ No recipe clips at full volume, and the continuous ones are loudness-matched within
   ~5 dB so switching sounds doesn't change the volume of the room.
4. ✅ Brightness goes the direction each recipe's name promises (`fan` duller than `white`,
   `rain` brighter than `fan`) — measured as mean sample-to-sample change **normalised by
   RMS**, so a sound can't pass merely by being quieter.
5. ✅ Consecutive `render()` calls join without a seam. This is the no-audible-loop
   guarantee, and it holds because there *is* no loop: state carries across calls, so the
   caller can use any block size. Asserted on `fan`/`heartbeat`/`ocean`, where a state
   reset would be an audible step.
6. ✅ Rendering is deterministic for a given seed (and differs across seeds) — the property
   every other test depends on.
7. ✅ The preview WAV header is well-formed. Not firmware, but the most likely reason a
   rendered file "plays as silence".

**Still to write, with the code they cover:**

8. Fade in/out reaches its target in the expected sample count and starts/ends at zero
   amplitude — the anti-pop guarantee, asserted on samples.
9. The sleep timer stops output after exactly `timerMin`, driven by injected time (the same
   pattern `wb_tick_hal` already uses).
10. The D4 alarm sequence: the sound machine pauses, the tone plays for 20 s at
    `alarm.volume`, and playback resumes at the previous level.
11. **Playback survives a simulated network outage**: with the HTTP layer stubbed to fail
    past the offline threshold, audio state is unchanged. This is §3.1 as an executable
    assertion and is the single most important test here.

Then: a listening pass for tuning (§3.8), and a hardware pass on the real speaker.

## 9. Decisions (signed off)

**D1 — The sound machine is independent of quiet time and bedtime.** It plays right through
both. No ducking, no auto-stop, no auto-start; **the quiet-time and wake-light lock screens
must not touch `wb_audio`** (§4.6). Simplest option and the right one — a sound machine that
switches itself off at bedtime is backwards.

*Scope note:* D1 constrains **the lock screens specifically**, not the audio subsystem in
general. Alarm time is a separate trigger and does legitimately interrupt the sound machine
— that's D4, and it does not violate this rule. Likewise the wake light going green
stays **silent** by default (it's a visual cue for kids who can't read a clock); revisit only
if someone asks for a chime.

**D2 — No reboot persistence.** A power blip mid-sleep is a rare enough edge case that
persisting "was playing" to NVS and resuming pre-poll isn't worth the complexity. Explicitly
out of scope; don't build it. (After a reboot the device simply comes up silent and the next
poll restores the *settings*, not playback.)

**D3 — Wake tones get their own volume**, independent of the sound-machine volume — a new
`alarm.volume`. Implementation consequences in §5, gap 2: no API change needed, but a slider on
both parent surfaces and a parse on the device.

**D4 — The alarm pauses the sound machine, then hands it back.** The sequence at alarm time:

1. Fade the sound machine down (~400 ms) — pause, not stop.
2. Play the tone at `alarm.volume` for **20 seconds**.
3. Fade the tone out, then fade the sound machine back in where it left off.

**Only if it was actually playing at alarm time.** That's the minority case, not the
default: the sleep timer caps at 120 minutes, so a kid who went to bed at 8pm with a
60-minute timer has had silence since 9pm and there is nothing to resume. If nothing was
playing, the tone plays alone and the device returns to silence — the alarm must never
*start* the sound machine.

Two things this deliberately is not. It is **not** ducking — the tone doesn't compete with
white noise underneath it, which is the whole reason an alarm over a sound machine goes
unheard. And "the sound machine stops for good at alarm time" was considered and rejected:
the sleep timer already exists for a parent who wants silence after wake-up, and stopping
here would either lose the parent's `sound.on` state or contradict it. Pausing keeps the
device's playback local and leaves the synced setting untouched.

Note this costs nothing extra to build. Nothing touches audio today, so the sleep timer's
fade-and-stop path doesn't exist yet either — pause/resume and stop-for-good are the same
amount of work, and pause is the better behaviour.

*Sub-question, not blocking:* should tapping the screen during those 20 seconds dismiss the
alarm early (and resume the sound machine immediately)? Almost certainly yes, but it's
additive and phase 1b can ship without it.

***Answered on hardware: yes, and "not blocking" was wrong.*** The first time this ran on a
real device the tone came out of the speaker with the ordinary home screen showing and no
way to silence it, which reads as a malfunction rather than as an alarm. There is now a
full-screen alarm takeover (`src/ui/alarm_screen.cpp`) with a **Stop** button, loaded the
instant the alarm fires rather than on the next poll — a five-second gap between the sound
starting and the screen appearing is its own bug. Stop calls `wb_audio_alarm_dismiss()`,
which cancels **only** the alarm so the sound machine still fades back in; silencing the
room is not what dismissing an alarm means. If nobody taps it, the screen clears itself
when the 20 seconds are up.

**D5 — Use the speaker(s) that came with the board.** No enclosure design, no driver
sourcing. The board carries the amp and a **2-pin JST PH 2.0 header silkscreened `SPK`**;
the included cavity driver (YZ3020, 30×20 mm, 4 Ω 3 W) plugs straight into it with no
soldering and no passives. Vendor sources disagree on whether the 7" board has one such
header or two — check the silkscreen — but §3.7's mono-to-both-channels output is correct
either way.

This sets the tuning target — and the first version of this paragraph got it **exactly
backwards**, which is worth recording because it caused two real bugs.

It claimed the driver would flatter brown noise and punish hiss, and therefore that `fan`
should be the default. Wrong. A 30×20 mm cavity driver has *almost no low end at all*, so
low-frequency content is the thing it cannot reproduce. On hardware, the two low-frequency
recipes were the two that failed: `fan` (three poles at 420 Hz) needed 75%+ on the slider
to be heard, and `heartbeat` (52/44 Hz) was inaudible outright. The hiss-heavy recipes were
fine.

**The rule this speaker actually imposes:** keep the usable energy above roughly 300 Hz.
Below that, measurements flatter a recipe that the hardware will simply not play. Both
recipes were re-centred accordingly (§3.2), and the volume curve's range was cut from 40 dB
to 24 dB — at 40 dB, volume 50 was only 10% amplitude, which this speaker cannot make
audible for anything but the brightest sounds.

The general lesson holds: recipes get their final tuning pass on the real speaker, never on
headphones (§3.8), because a laptop reproduces a band the device does not have.

## 10. Still open

**Q2 — Should `alarm.tone` migrate from display strings to stable keys?** §5's gap 3. It's
the right change and phase 1b was the natural moment, but it needs a back-compat mapping for
existing rows and touches all three surfaces, so it's worth calling rather than assuming.

*Still open, but no longer blocking anything.* `wb_tone_parse` accepts **both** spellings —
the display strings stored today (`'Sunrise chime'`) and the stable keys a migration would
write (`'sunriseChime'`). Six lines of firmware, and it means the migration can happen
whenever, in its own change, without having to be timed against a firmware release: existing
rows work now, migrated rows work later. The question is now purely "is the cleanup worth
doing", not "does the alarm depend on it".

**Q3 — Does the default sound change from `white` to `fan`?** D5's speaker analysis argues
yes. Cheap to do now, mildly annoying later (it would silently change what an existing
device plays).
