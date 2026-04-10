# DegaluKainos

Web app for comparing Lithuania's fuel prices from LEA using a **published backend snapshot** and finding stations along a route.

## Features

- Serves public users from a **latest published snapshot** instead of fetching LEA data on every request
- Parses LEA workbook prices for **95 benzinas**, **dyzelinas**, and **SND**
- Matches stations to OpenStreetMap fuel locations and caches coordinates
- Falls back to limited station address geocoding when coordinates are missing
- Lets users define route points **A** and **B** on the map or by entering **Lithuanian addresses with autocomplete**
- Supports route comparison modes:
  - all stations along the route
  - cheapest stop based on price, planned liters, and estimated detour cost
- Supports filtering, sorting, and a gas station blacklist
- Excludes blacklisted networks from the list, map, and route results (**Jozita** is blacklisted by default)

## Data flow

### Public users
Public users only read from the already-published dataset:

- `GET /api/prices/latest`
- `GET /api/route`
- `GET /api/geocode`
- `GET /api/geocode/suggest`

They do **not** trigger LEA workbook download/parsing/geocoding for the daily price snapshot.

### Admin refresh flow
You publish fresh price data yourself:

1. download the latest LEA workbook
2. parse and normalize stations
3. resolve station coordinates
4. store the result in `data/snapshots/`
5. serve that stored snapshot to the public app

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the app in development mode |
| `npm run build` | Build frontend and server |
| `npm run start` | Start the production server |
| `npm run refresh:snapshot:dev` | Refresh and publish the latest snapshot in development |
| `npm run refresh:snapshot` | Refresh and publish the latest snapshot from the production build |
| `npm run refresh:snapshot:auto:dev` | Cron-safe development refresh that skips when today is already published |
| `npm run refresh:snapshot:auto` | Cron-safe production refresh that skips when today is already published |

## Local development

Open `http://localhost:5173`.

```bash
npm install
npm run dev
```

In development, the frontend and backend run together through the Express + Vite server.

## Production usage

```bash
npm run build
npm run start
```

## Publish a fresh snapshot manually

For public hosting, publish the latest LEA dataset yourself instead of letting visitors trigger ingestion:

```bash
npm run build
npm run refresh:snapshot
```

To publish a specific date manually:

```bash
npm run refresh:snapshot -- 2026-04-09
```

On Render, the simplest manual path is the web service **Shell**:

```bash
cd /opt/render/project/src
npm run refresh:snapshot -- 2026-04-09
```

This writes:

- `data/snapshots/latest.json`
- `data/snapshots/YYYY-MM-DD.json`

## Cron-safe auto refresh

If you want a cron job to poll during a small time window, use:

```bash
npm run refresh:snapshot:auto
```

This command:

- exits successfully if today's snapshot is already published
- tries to publish today's snapshot if it is not published yet
- exits successfully if today's LEA workbook is still not available
- only fails for real errors that need attention

## Optional protected refresh endpoint

You can also trigger publishing remotely through:

- `POST /api/admin/refresh`
- `POST /api/admin/refresh?date=2026-04-09`

Set this environment variable on the server:

```bash
ADMIN_REFRESH_TOKEN=your-secret-token
```

Then send the token in the request header:

```bash
x-admin-refresh-token: your-secret-token
```

Example with a specific date:

```bash
curl -X POST \
  -H "x-admin-refresh-token: your-secret-token" \
  "https://your-app.onrender.com/api/admin/refresh?date=2026-04-09"
```

If `ADMIN_REFRESH_TOKEN` is not configured, the admin refresh endpoint stays disabled.

## Recommended public hosting model

For a public deployment:

1. run the app with `npm run start`
2. publish fresh data yourself with `npm run refresh:snapshot`
3. optionally automate that command with cron, your host scheduler, or a protected remote trigger

This keeps LEA workbook ingestion off the public request path.

## Data attribution

The app should display this attribution alongside published fuel data:

- **Duomenys: LEA.**
- **Pirminiai šaltiniai: degalinių tinklus valdančios įmonės.**

In the UI, station network/company names are shown directly with each station entry, and the original workbook link is exposed as **Excel šaltinis**.

## Public-request caching

To reduce Render invocations, bandwidth, and third-party traffic, the app now caches public reads at multiple layers:

- `GET /api/prices/latest`
  - validator-based HTTP caching with `ETag` and `Last-Modified`
  - browser local cache for up to 24 hours
- `GET /api/route`
  - persistent disk cache in `data/cache/route-cache.json`
  - browser and HTTP cache for 7 days
  - cache keys round route points to 4 decimal places so nearby repeated requests reuse the same route
- `GET /api/geocode`
  - persistent disk cache in `data/cache/address-geocode-cache.json`
  - browser and HTTP cache for 90 days
  - failed lookups are cached for 1 hour
- `GET /api/geocode/suggest`
  - persistent disk cache in `data/cache/address-suggestion-cache.json`
  - browser and HTTP cache for 24 hours
  - empty suggestion sets are cached for 1 hour
- built frontend assets
  - served with long-lived immutable caching for 1 year

## External services still used live

Even with published snapshots, the public app still makes live backend requests for:

- route calculation
- address geocoding
- address autocomplete

Those currently rely on OpenStreetMap-based public services, so if traffic grows you should consider:

- rate limiting
- response caching
- self-hosting routing/geocoding services
- restricting some public features

## Notes

- Location cache files are stored in `data/cache/`.
- Published snapshots are stored in `data/snapshots/`.
- The route corridor is configurable in the UI.
- Stations without known coordinates still appear in the list, but not on the route map.
