# DegaluKainos

Web app for comparing Lithuania's daily fuel prices from ENA and finding stations that lie along a selected route.

## What it does

- Fetches the current day's ENA Excel workbook on the server
- Parses station prices for 95 benzinas, dyzelinas, and SND
- Matches stations to OpenStreetMap fuel locations and caches coordinates
- Falls back to limited address geocoding for stations that were not matched yet
- Lets the user click map points **A** and **B** and highlights stations near the route
- Supports two route modes: all stations along the route or the cheapest stop based on fuel price, planned liters, and estimated detour cost

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Build and run production mode

```bash
npm run build
npm run start
```

## Notes

- Location cache files are stored in `data/cache/`.
- The route corridor is configurable in the UI.
- Stations without known coordinates still appear in the list, but not on the route map.
