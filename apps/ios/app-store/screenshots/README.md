# App Store screenshots

Upload-ready screenshots for App Store Connect. Only **two** sizes are needed —
Apple auto-scales each down to every smaller device, so these cover all iPhones/iPads.

| Folder | Device | Size (px) | App Store Connect slot |
|--------|--------|-----------|------------------------|
| `iphone/` | iPhone (Pro Max class) | **1320 × 2868** | 6.9" Display |
| `ipad/` | iPad Pro 13" | **2752 × 2064** (landscape) | 13" Display |

Filenames are numbered in the order they should appear in the listing.

## Regenerating

1. Boot the **iPhone 17 Pro Max** sim (6.9" → 1320×2868) and the **iPad Pro 13"** sim
   (13" → 2752×2064). Capturing on the correct model gives native-resolution shots.
2. Run the app, navigate to each screen, **File → Save Screen (⌘S)** in the Simulator.
3. Drop the files in here (overwrite), keeping the numeric prefixes for ordering.

Note: the current `iphone/` set was captured on a base iPhone 17 (1206×2622, 6.3") and
resampled to 1320×2868 — the aspect ratios differ by <0.05%, so it's visually identical,
but a native Pro Max capture is marginally sharper if you re-shoot.
