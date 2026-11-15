# Flying over Hendo

Fly over 50 miles of real terrain around **Flat Rock, Henderson County, North Carolina**, in the browser. No account, no API key, no install: open the page and take off.

Live: https://mthiriez.github.io/flyingoverhendo/

## Controls

- **Steer**: drag anywhere on the screen with one finger (keyboard: arrows or WASD).
- **Speed**: vertical slider on the right edge, 150 to 380 km/h.
- **Pause**: top right button.
- Best used in landscape.

## What is real

- **Aerial imagery**: USGS National Map, `USGSImageryOnly`, from zoom 11 (whole 160 km area) to 16 (close detail).
- **Elevation**: Terrarium tiles, decoded in the browser as `(R * 256 + G + B / 256) - 32768` metres.
- **Place names**: reverse geocoding through Nominatim, throttled to one request every 2.5 seconds.

Three layers of imagery follow the aircraft: a fixed 160 km base at zoom 11, a 34 km layer at zoom 13, and a 3 km close layer at zoom 16. Each moving layer is painted offscreen and swapped in one go, so the ground never flashes.

## Limits

- No 3D buildings. The French version of this engine extrudes IGN BD TOPO footprints; there is no equivalent nationwide footprint layer wired up here.
- Imagery stops at zoom 16, so very low passes show roughly 2.4 m per pixel.
- The first load pulls about 2.5 MB of imagery and 3 MB of elevation.
- Tested on desktop Chrome; not yet tested on a physical iPhone with this build.

## Data credits

- Aerial imagery: USGS National Map, public domain.
- Elevation: Terrarium tiles, Mapzen / AWS Open Data.
- Place names: © OpenStreetMap contributors.

## Run locally

Serve the folder over HTTP (module imports need it):

```
npx serve .
```

Then open `http://localhost:3000`. Three.js is vendored in `vendor/three.module.min.js`, so nothing is fetched from a CDN.
