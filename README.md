# Presenter (p1-app-pc)

Desktop presenter app (Windows / macOS) + Android phone remote.

## Folder layout
```
main.js            Electron app (line 36 = UPDATE_INFO_URL)
preload.js         safe bridge between the page and the app
server.js          built-in server: pages, phone remote (PIN), devices, workspace sync
public/presenter.html   the Presenter control / live page
public/remote.html      the phone remote page (served at /remote)
mobile/            Android app (Capacitor). www/main.js = launcher, www/remote.html = built-in remote,
                   android/ = native project, ALREADY GENERATED (do not delete it)
.github/workflows/ desktop.yml (Win + Mac) and android.yml (APK)
package.json       app + installer (electron-builder) settings
```

## Run on your computer
```
npm install
npm start          # opens the app
```
Open the app, click **📱 Phone** for the QR code and connection PIN.
Server only (no window): `npm run server` -> http://localhost:8787/ (PIN printed in the console).

## Build on GitHub
1. Upload everything in this folder to https://github.com/mranandkumar4777/p1-app-pc
2. GitHub -> Settings -> Actions -> General -> Workflow permissions -> **Read and write** -> Save.
3. Actions tab -> **Build desktop app** -> Run workflow (and **Build Android remote app (APK)**).
   Or push a tag: `git tag v1.0.1 && git push origin v1.0.1`.

Results appear on the Releases page:
- `desktop-latest`: Windows .exe, Mac .dmg (Intel + Apple Silicon), desktop-version.json
- `mobile-latest`: PresenterRemote.apk

Raise `version` in package.json before tagging a new release so "Check for Updates" sees it.

## Android notes
- `mobile/android/` is committed on purpose, so the build never has to run `cap add android`. The workflow only runs `cap sync`.
- Upload the whole `mobile` folder including `android` (the folder starts with a dot-free name, but contains `gradlew`; the workflow sets it executable).
- Local build (needs Android Studio / JDK 17): `cd mobile && npm install && npx cap sync android && cd android && ./gradlew assembleDebug`

## Notes
- Builds are unsigned: Windows SmartScreen -> More info -> Run anyway; Mac -> right-click -> Open.
- Phone on other networks: install Tailscale on computer and phone, use the computer's Tailscale address.
- AI song search / detection needs your own Gemini API key (Settings). Model can be changed with the
  PRESENTER_GEMINI_MODEL environment variable (default gemini-2.5-flash).
