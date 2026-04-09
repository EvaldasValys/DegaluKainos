# DegaluKainos

Web app for comparing Lithuania's fuel prices from ENA using a **published backend snapshot** and finding stations along a route.

## Features

- Serves public users from a **latest published snapshot** instead of fetching ENA data on every request
- Parses ENA workbook prices for **95 benzinas**, **dyzelinas**, and **SND**
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

They do **not** trigger ENA workbook download/parsing/geocoding for the daily price snapshot.

### Admin refresh flow
You publish fresh price data yourself:

1. download the latest ENA workbook
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

For public hosting, publish the latest ENA dataset yourself instead of letting visitors trigger ingestion:

```bash
npm run build
npm run refresh:snapshot
```

This writes:

- `data/snapshots/latest.json`
- `data/snapshots/YYYY-MM-DD.json`

## Optional protected refresh endpoint

You can also trigger publishing remotely through:

- `POST /api/admin/refresh`

Set this environment variable on the server:

```bash
ADMIN_REFRESH_TOKEN=your-secret-token
```

Then send the token in the request header:

```bash
x-admin-refresh-token: your-secret-token
```

If `ADMIN_REFRESH_TOKEN` is not configured, the admin refresh endpoint stays disabled.

## Recommended public hosting model

For a public deployment:

1. run the app with `npm run start`
2. publish fresh data yourself with `npm run refresh:snapshot`
3. optionally automate that command with cron, your host scheduler, or a protected remote trigger

This keeps ENA workbook ingestion off the public request path.

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
