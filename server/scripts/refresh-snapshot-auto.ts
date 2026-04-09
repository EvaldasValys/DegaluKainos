import { refreshLatestSnapshot } from '../lib/price-service.js'
import { readLatestPublishedSnapshot } from '../lib/snapshot-store.js'
import { formatLithuaniaDate } from '../lib/utils.js'

function isWorkbookUnavailableError(error: unknown) {
  return error instanceof Error && /Workbook download failed with 404\b/.test(error.message)
}

const today = formatLithuaniaDate()
const latestSnapshot = await readLatestPublishedSnapshot()

if (latestSnapshot?.snapshotDate === today) {
  console.log(`Snapshot for ${today} is already published. Skipping refresh.`)
} else {
  try {
    const snapshot = await refreshLatestSnapshot()
    console.log(
      `Published snapshot ${snapshot.snapshotDate} (${snapshot.stations.length} stations, refreshed ${snapshot.fetchedAt})`,
    )
  } catch (error) {
    if (isWorkbookUnavailableError(error)) {
      console.log(`Workbook for ${today} is not available yet. Skipping refresh for now.`)
    } else {
      console.error(
        error instanceof Error
          ? error.message
          : 'Failed to refresh and publish the latest snapshot automatically',
      )
      process.exitCode = 1
    }
  }
}
