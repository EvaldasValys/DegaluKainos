import { refreshLatestSnapshot } from '../lib/price-service.js'
import { isIsoDateString } from '../lib/utils.js'

const requestedDate = process.argv[2]?.trim()

if (requestedDate && !isIsoDateString(requestedDate)) {
  console.error('Snapshot date must use YYYY-MM-DD format.')
  process.exitCode = 1
} else {
  try {
    const snapshot = await refreshLatestSnapshot(requestedDate)
    console.log(
      `Published snapshot ${snapshot.snapshotDate} (${snapshot.stations.length} stations, refreshed ${snapshot.fetchedAt})`,
    )
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Failed to refresh and publish the latest snapshot',
    )
    process.exitCode = 1
  }
}
