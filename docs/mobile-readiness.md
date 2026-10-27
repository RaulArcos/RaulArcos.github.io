# Phone-ready website and game

The responsive changes pass automated tests and Chrome touch emulation. This is **not** real iOS/Safari or Android-device certification, and does not justify a “flawless on every phone” claim.

## Using the game on a phone

1. Choose a circuit, tap the name field and press Start. The name field does not autofocus on touch hardware, and uses 16px text to avoid the usual small-input zoom trigger.
2. Hold the rightmost up-arrow to accelerate; use the two left buttons to steer. The down-arrow brakes/reverses. Multiple fingers work independently. Dragging off a held button keeps its pointer capture; release/cancel or loss of focus clears input and pressed visuals.
3. Tap Leaderboard to show/hide scores without permanently covering the track. Quit stays in the top-right corner.
4. Portrait works; landscape provides a wider view. The complete circuit remains aspect-fitted, not stretched or cropped. Letterboxing is intentional.

## Responsive behavior

- Navigation, language/social/contact actions and mobile game/menu controls have at least 44px target dimensions.
- Site layouts adapt through tablet widths; anchor offsets and content padding account for the wrapped header and safe-area insets.
- The game uses the available mobile viewport with safe-area padding, separate HUD/playfield/thumb-control regions and a scrollable menu.
- Dynamic visualViewport height/offset changes update the dialog for address-bar and software-keyboard changes. Native pinch zoom is retained; zoom is not disabled in the viewport meta tag.
- The background page is scroll-locked only while the modal is open; its previous overflow setting is restored on Quit.
- Canvas resolution uses device pixel ratio capped at 2. Cars and labels have minimum visual sizes on small canvases. Track geometry, collision rules, timing and network cadence are unchanged.
- Below-fold images use native lazy loading and asynchronous decoding. The hero photo is not lazily loaded.

## Repeatable checks

Run `node --test tests/*.test.cjs` for deterministic tests.

For browser checks, serve the site locally and start a disposable Chrome with loopback remote debugging. Then run:

```sh
BROWSER_CDP_URL=http://127.0.0.1:9226 node scripts/check-mobile-browser.cjs --screenshot
```

Use `--help` for preview/debug endpoint options. The checker creates its own browser context and stubs racing/Firebase requests: test scores stay in isolated browser storage and are never submitted to the VPS. Screenshots are saved under `.atl/`.

**Run CDP checkers sequentially:** desktop and mobile checks both depend on foreground focus. Explicit partial TouchEnd events must identify the released finger on the tested Chrome build; the checker verifies both remaining/released button states.

| Verified Chrome viewport | Mode |
| --- | --- |
| 320×568, 390×844, 430×932 | Phone portrait, touch |
| 844×390 | Phone landscape, touch |
| 768×1024 | Tablet, touch |
| 1280×900 at DPR 1, 1.5 and 2 | Explicitly emulated non-touch desktop, keyboard |

EN/ES site layouts, primary target sizes, horizontal overflow, menu input sizing, panel separation, thumb grouping, actual multi-touch movement/drag/independent release, rotation and Quit pass. Desktop Tab does not target the hidden mobile leaderboard button. The desktop/VPS-relay regression also passes. Each viewport row now uses a fresh browser context. Desktop rows explicitly model maxTouchPoints=0 before app code and assert no touch event property/coarse pointer or visible touch buttons; this is emulated hardware, not a statement about the test host (which reports two touch points). Core source is byte-identical; the original desktop menu/keyboard simulation and cleanup match the pre-mobile draft over 120 frames.

## Physical-device checks still needed

Before publishing, check an actual iPhone/Safari and Android/Chrome:

- Soft keyboard opening, typing, dismissal and return to Start without clipping or page zoom.
- Address-bar expansion/collapse, real notch/home-indicator insets and rotation during play.
- Simultaneous steering/throttle, releasing only one finger, interruptions/background/resume and scroll restoration.
- Readability, sustained performance and browser-specific gesture behavior on slower hardware.

No physical-device, real Safari-engine, comprehensive accessibility or mobile performance certification was performed. No backend/deployment change, commit or push is included.

Independent review is complete. The reported minimap overlap, high-DPI minimap sizing and desktop-test profile issues were fixed and rechecked;155 automated tests pass. The minimap retains its114×76 CSS-pixel outer box at DPR1/1.5/2, and the mobile button/open board stay clear of it and the thumb controls. Physical-device verification remains pending; this is not publication approval.
