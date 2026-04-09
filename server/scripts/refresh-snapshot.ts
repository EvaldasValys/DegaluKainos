import { refreshLatestSnapshot } from '../lib/price-service.js'

try {
  const snapshot = await refreshLatestSnapshot()
  console.log(
    `Published snapshot ${snapshot.snapshotDate} (${snapshot.stations.length} stations, refreshed ${snapshot.fetchedAt})`,
  )
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Failed to refresh and publish the latest snapshot',
  )
  process.exitCode = 1
}
