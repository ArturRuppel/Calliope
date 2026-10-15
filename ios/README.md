# Calliope for iPad

A native shell around the Calliope web app, built from Linux with
[xtool](https://xtool.sh) and sideloaded onto the iPad. With an external
display attached (cable or AirPlay), presenting a deck puts the audience view
on the display and the speaker view on the iPad. Without one, the app is
Calliope in a web view.

Why native: Safari on iPadOS cannot put a window on a second screen, and an
app run from Swift Playgrounds never receives the external-display scene (the
Playgrounds host keeps it — verified 2026-10-14, `UIScreen.screens` stays at 1).
A standalone app does.

## How it hangs together

- `Sources/Calliope/Presenter.swift` holds both web views and relays
  `speaker.js` messages between them: each page gets a `window.svgdeckNative`
  object (injected at document start) whose `postMessage` reaches native code,
  and native code delivers to the other page as a `svgdeck:native` DOM event.
  `speaker.js` uses this instead of `window.open`/`postMessage` when the object
  exists.
- Links the page opens in a new window (`Present`, `Speaker view`) are routed:
  a presenter page `/d/<deck>/` becomes a speaker + audience pair sharing one
  `session`; anything else loads in place.
- `CalliopeApp.swift`: `AppDelegate.configurationForConnecting` gives the
  external-display scene role `ExternalSceneDelegate` and the main role
  `MainSceneDelegate` (hosts `ContentView`). `Info.plist` declares the same
  scene manifest.
- `xtool.yml` names the bundle ID and the `Info.plist` to merge.

## Build and install

One-time: install Swift, `usbmuxd` and xtool, run `xtool setup` (Apple ID +
`Xcode.xip`), enable Developer Mode on the iPad. Then, with the iPad on USB:

```
cd ~/Projects/Calliope/ios/Calliope
xtool dev
```

With a free Apple ID the signature lasts 7 days; run `xtool dev` again to
re-sign. The built bundle lands in `./xtool/` (gitignored).

First launch: set the server address under the gear icon.
