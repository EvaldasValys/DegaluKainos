import express from 'express'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchTodaySnapshot } from './lib/price-service.js'
import { fetchRoute } from './lib/routing-service.js'

const projectRoot = process.cwd()
const isProduction = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT ?? 5173)

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

async function createServer() {
  const app = express()

  app.disable('x-powered-by')

  app.get('/api/prices/today', async (_request, response) => {
    try {
      const snapshot = await fetchTodaySnapshot()
      response.json(snapshot)
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to fetch today’s workbook',
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
      response.json(route)
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to calculate the route',
      })
    }
  })

  if (isProduction) {
    const clientDist = path.join(projectRoot, 'dist', 'client')
    app.use(express.static(clientDist))
    app.use(async (_request, response) => {
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
