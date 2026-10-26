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

## Install on an LG webOS TV (Developer Mode)

This is an unofficial sideloading workflow for personal testing. Use the generated webOS `.ipk` package; Android `.apk` files cannot be installed on LG webOS TVs.

### What you need

- An LG webOS TV and a computer on the same local network.
- A free [LG webOS Developer account](https://webostv.developer.lge.com/).
- A built `.ipk` package. This repository's build command above packages the app and service into `dist`; use the resulting IPK file.

### 1. Enable Developer Mode on the TV

1. Sign in or create an account at [LG webOS TV Developer](https://webostv.developer.lge.com/).
2. On the TV, open the LG Content Store / Apps area, search for **Developer Mode**, install it, and launch it.
3. Sign in with your LG Developer account.
4. Switch **Dev Mode Status** on. The TV will reboot.
5. After reboot, reopen Developer Mode and enable **Key Server**. Note the TV's IP address and the six-character passphrase shown on screen.

**Screenshots from LG's Developer Mode documentation** (the exact layout may vary by TV/webOS version):

![LG Developer Mode login screen](https://res.cloudinary.com/dcsdn4mzr/image/upload/v1649914917/webOS-TV/images/docs/guides/Login_of_Dev_Mode_App_l87hq9.png)

![LG Developer Mode status enabled](https://res.cloudinary.com/dcsdn4mzr/image/upload/v1649914915/webOS-TV/images/docs/guides/Dev_Mode_Status_On_qqzjd4.png)

![LG Developer Mode Key Server enabled](https://res.cloudinary.com/dcsdn4mzr/image/upload/v1649914918/webOS-TV/images/docs/guides/Key_Server_On_ql4tls.png)

> **Session expiry:** Developer Mode is time-limited. If the app provides **Remain Session**, keep it enabled and use **EXTEND** before the session expires. LG notes that disabling Developer Mode removes apps installed through that development session. Do not assume sideloaded apps are permanent.

### 2. Install with webOS Dev Manager (graphical option)

[webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) is a community desktop app for connecting to a Developer Mode TV and installing IPK packages.

1. Download the installer for your operating system from [webOS Dev Manager releases](https://github.com/webosbrew/dev-manager-desktop/releases/latest).
2. Launch Dev Manager and add/connect to the TV using the IP address shown in Developer Mode. Follow the pairing flow and enter the current passphrase if prompted.
3. Choose the app/package installation option and select the JTV webOS `.ipk` file.
4. Wait for the install to finish, then open **JTV** from the TV launcher. If it does not appear immediately, return to the home screen and check again.

**Example screenshots from the Dev Manager project:**

![webOS Dev Manager device setup](https://user-images.githubusercontent.com/830358/215522596-196d9629-3942-4533-bebb-5a81ba62ebc0.png)

![webOS Dev Manager installed apps view](https://user-images.githubusercontent.com/830358/215522298-eadebc84-661b-40ad-b6a9-9379710f88dc.png)

### 3. Alternative: install with LG's webOS CLI

1. Install [Node.js](https://nodejs.org/) and LG's CLI:

   ```sh
   npm install -g @webos-tools/cli
   ares -V
   ```

2. Run the device setup wizard and add a device named `tv`. Use the TV's current IP address, port `9922`, username `prisoner`, and no password:

   ```sh
   ares-setup-device
   ares-setup-device --list
   ```

3. Ensure **Key Server** is enabled on the TV, then fetch the device key. Enter the six-character passphrase shown on the TV when prompted:

   ```sh
   ares-novacom --device tv --getkey
   ```

4. Install the package (replace the sample path with the actual IPK path):

   ```sh
   ares-install --device tv ./dist/JTV-webOS.ipk
   ```

5. Launch the app:

   ```sh
   ares-launch --device tv com.codex.jtvwebos
   ```

If your build generated the IPK under a different filename or directory, use that exact path. The app ID above matches this repository's build instructions.

### Troubleshooting

- **TV not reachable:** Confirm the TV and computer are on the same Wi-Fi/LAN, check the TV's current IP address, and avoid guest Wi-Fi with client isolation.
- **Pairing fails:** Reopen Developer Mode, ensure **Key Server** is on, and retry with the current passphrase. Confirm the session has not expired.
- **Installation fails:** Check that the package is a successfully built webOS `.ipk`, not an Android `.apk`.
- **App disappears later:** Check Developer Mode session status and extend it before expiry. Disabling Developer Mode removes development-installed apps.
- **App installs but will not launch:** Confirm the package build succeeded and use the app ID `com.codex.jtvwebos`. Collect logs before opening an issue. Never post the TV passphrase, private SSH keys, Jio OTPs, or session tokens.

### Official references

- [LG: Developer Mode app setup and testing](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
- [LG: Install the webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation)
- [LG: CLI developer guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
- [webOS Dev Manager downloads](https://github.com/webosbrew/dev-manager-desktop/releases/latest)

## Notes

Stream access and playback remain subject to the account's Jio entitlement, the current Jio service response, and the TV's media and DRM support. The app does not bypass subscription or DRM checks.

`SHAKA-LICENSE.txt` applies to the bundled Shaka Player component.
