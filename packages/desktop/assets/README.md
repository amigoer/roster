# App icons

The mark itself lives at `packages/ui/public/icon.svg`, where the UI already serves it as the favicon. `tray.svg` is the same drawing cut for a template image: black where it paints, clear where the menu bar shows through, and framed tighter because a menu bar item gets 18pt and no margin of its own.

`icon.png`, `icon.icns`, `trayTemplate.png` and `trayTemplate@2x.png` are cut from those two by `node scripts/icons.mjs` (macOS only -- it renders with `sips` and packs with `iconutil`). They are committed because the app runs from source and nothing builds them on the way up; redraw either SVG and run the script again.
