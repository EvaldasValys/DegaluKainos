import express from 'express'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PriceSnapshot } from '../shared/types.js'
import {
  GEOCODE_CACHE_TTL_MS,
  NEGATIVE_LOOKUP_CACHE_TTL_MS,
  ROUTE_CACHE_TTL_MS,
  STATIC_ASSET_CACHE_MAX_AGE_SECONDS,
  SUGGESTION_CACHE_TTL_MS,
} from '../shared/cache.js'
import { geocodeAddress, suggestAddresses } from './lib/geocoding-service.js'
import { refreshLatestSnapshot } from './lib/price-service.js'
import { fetchRoute } from './lib/routing-service.js'
import { readLatestPublishedSnapshot } from './lib/snapshot-store.js'
import { isIsoDateString } from './lib/utils.js'

const projectRoot = process.cwd()
const isProduction = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT ?? 5173)
const adminRefreshToken = process.env.ADMIN_REFRESH_TOKEN?.trim() ?? ''
const LATEST_SNAPSHOT_CACHE_CONTROL = 'public, no-cache, stale-while-revalidate=31536000'

function setPublicCache(response: express.Response, maxAgeSeconds: number, immutable = false) {
  response.set(
    'Cache-Control',
    immutable ? `public, max-age=${maxAgeSeconds}, immutable` : `public, max-age=${maxAgeSeconds}`,
  )
}

function createSnapshotEtag(snapshot: PriceSnapshot) {
  return `"${snapshot.snapshotDate}-${Date.parse(snapshot.fetchedAt)}-${snapshot.stations.length}"`
}

function isSnapshotFresh(request: express.Request, snapshot: PriceSnapshot) {
  const ifNoneMatch = request.get('if-none-match')
  const snapshotEtag = createSnapshotEtag(snapshot)

  if (ifNoneMatch === snapshotEtag) {
    return true
  }

  const ifModifiedSince = request.get('if-modified-since')

  if (!ifModifiedSince) {
    return false
  }

  return Date.parse(ifModifiedSince) >= Date.parse(snapshot.fetchedAt)
}

function parseRoutePoint(value: string | undefined) {
  if (!value) {
    return null
  }

  const [latValue, lngValue] = value.split(',')
  const lat = Number(latValue)
  const lng = Number(lngValue)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null
  }

  return { lat, lng }
}

function parseSnapshotDate(value: string | undefined) {
  if (!value) {
    return null
  }

  return isIsoDateString(value) ? value : null
}

async function createServer() {
  const app = express()

  app.disable('x-powered-by')

  app.get('/api/prices/latest', async (request, response) => {
    try {
      const snapshot = await readLatestPublishedSnapshot()

      if (!snapshot) {
        response.status(404).json({
          error: 'No published snapshot is available yet. Run an admin refresh first.',
        })
        return
      }

      response.set({
        'Cache-Control': LATEST_SNAPSHOT_CACHE_CONTROL,
        ETag: createSnapshotEtag(snapshot),
        'Last-Modified': new Date(snapshot.fetchedAt).toUTCString(),
      })

      if (isSnapshotFresh(request, snapshot)) {
        response.status(304).end()
        return
      }

      response.json(snapshot)
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to read the latest published snapshot',
      })
    }
  })

  app.post('/api/admin/refresh', async (request, response) => {
    if (!adminRefreshToken) {
      response.status(503).json({
        error: 'Admin refresh endpoint is disabled because ADMIN_REFRESH_TOKEN is not configured.',
      })
      return
    }

    if (request.get('x-admin-refresh-token') !== adminRefreshToken) {
      response.status(401).json({ error: 'Invalid admin refresh token.' })
      return
    }

    const requestedDate = String(request.query.date ?? '').trim()
    const snapshotDate = parseSnapshotDate(requestedDate || undefined)

    if (requestedDate && !snapshotDate) {
      response.status(400).json({ error: 'Snapshot date must use YYYY-MM-DD format.' })
      return
    }

    try {
      const snapshot = await refreshLatestSnapshot(snapshotDate ?? undefined)
      response.json({
        snapshotDate: snapshot.snapshotDate,
        refreshedAt: snapshot.fetchedAt,
        stationCount: snapshot.stations.length,
        sourceUrl: snapshot.sourceUrl,
      })
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to refresh the published snapshot',
      })
    }
  })

  app.get('/api/route', async (request, response) => {
    const start = parseRoutePoint(request.query.from as string | undefined)
    const end = parseRoutePoint(request.query.to as string | undefined)

    if (!start || !end) {
      response.status(400).json({ error: 'Both route points must be provided as lat,lng pairs.' })
      return
    }

    try {
      const route = await fetchRoute(start, end)
      setPublicCache(response, Math.floor(ROUTE_CACHE_TTL_MS / 1000), true)
      response.json(route)
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to calculate the route',
      })
    }
  })

  app.get('/api/geocode', async (request, response) => {
    const query = String(request.query.q ?? '').trim()

    if (!query) {
      response.status(400).json({ error: 'Address query is required.' })
      return
    }

    try {
      const point = await geocodeAddress(query)

      if (!point) {
        setPublicCache(response, Math.floor(NEGATIVE_LOOKUP_CACHE_TTL_MS / 1000))
        response.status(404).json({ error: 'Address could not be geocoded.' })
        return
      }

      setPublicCache(response, Math.floor(GEOCODE_CACHE_TTL_MS / 1000), true)
      response.json(point)
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to geocode the address',
      })
    }
  })

  app.get('/api/geocode/suggest', async (request, response) => {
    const query = String(request.query.q ?? '').trim()

    if (!query) {
      response.status(400).json({ error: 'Address query is required.' })
      return
    }

    try {
      const suggestions = await suggestAddresses(query)
      setPublicCache(
        response,
        Math.floor((suggestions.length > 0 ? SUGGESTION_CACHE_TTL_MS : NEGATIVE_LOOKUP_CACHE_TTL_MS) / 1000),
      )
      response.json(suggestions)
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to fetch address suggestions',
      })
    }
  })

  if (isProduction) {
    const clientDist = path.join(projectRoot, 'dist', 'client')
    app.use(
      express.static(clientDist, {
        index: false,
        maxAge: STATIC_ASSET_CACHE_MAX_AGE_SECONDS * 1000,
        immutable: true,
      }),
    )
    app.use(async (_request, response) => {
      response.set('Cache-Control', 'no-cache')
      response.sendFile(path.join(clientDist, 'index.html'))
    })
    return app
  }

  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: projectRoot,
    server: {
      middlewareMode: true,
    },
    appType: 'custom',
  })

  app.use(vite.middlewares)
  app.use(async (request, response, next) => {
    try {
      const templatePath = path.join(projectRoot, 'index.html')
      const template = await readFile(templatePath, 'utf-8')
      const transformed = await vite.transformIndexHtml(request.originalUrl, template)

      response.status(200).set({ 'Content-Type': 'text/html' }).end(transformed)
    } catch (error) {
      vite.ssrFixStacktrace(error as Error)
      next(error)
    }
  })

  return app
}

const app = await createServer()

app.listen(port, () => {
  console.log(`DegaluKainos app running at http://localhost:${port}`)
})
