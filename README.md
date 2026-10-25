# JTV for LG webOS

This repository contains the JTV webOS application and its on-TV JavaScript service.

## Privacy

This source tree contains no account credentials, OTPs, access tokens, device addresses, TV pairing keys, or generated installation packages. The app asks for Jio sign-in details only on the TV and stores any resulting session locally on that TV. Those runtime values are not source-controlled.

## Features

- Jio account sign-in from the TV with a one-time password.
- Bengali as the default language filter, with Hindi and English filters.
- Selecting the active category again clears only that category while retaining the selected language.
- Remote-friendly navigation, direct channel-ID tuning, and a centered channel-ID overlay.
- Best-quality-first HLS playback with step-down on sustained buffering and gradual recovery after stable playback.
- DASH playback when supported by the TV, with a same-channel HLS retry when appropriate.

## Build

Use the LG webOS CLI to package the app and service together:

```sh
ares-package . service/com.codex.jtvwebos.service --outdir dist
```

Install the resulting IPK with `ares-install`, then launch `com.codex.jtvwebos`.

## Notes

Stream access and playback remain subject to the account's Jio entitlement, the current Jio service response, and the TV's media and DRM support. The app does not bypass subscription or DRM checks.

`SHAKA-LICENSE.txt` applies to the bundled Shaka Player component.
