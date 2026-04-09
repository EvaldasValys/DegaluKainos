import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PriceSnapshot } from '../../shared/types.js'

const snapshotsDir = path.join(process.cwd(), 'data', 'snapshots')

function getSnapshotPath(fileName: string) {
  return path.join(snapshotsDir, fileName)
}

async function ensureSnapshotsDir() {
  await mkdir(snapshotsDir, { recursive: true })
}

async function readSnapshotFile(fileName: string) {
  try {
    const contents = await readFile(getSnapshotPath(fileName), 'utf-8')
    return JSON.parse(contents) as PriceSnapshot
  } catch {
    return null
  }
}

export async function readLatestPublishedSnapshot() {
  return readSnapshotFile('latest.json')
}

export async function writePublishedSnapshot(snapshot: PriceSnapshot) {
  await ensureSnapshotsDir()

  const payload = JSON.stringify(snapshot, null, 2)

  await writeFile(getSnapshotPath(`${snapshot.snapshotDate}.json`), payload, 'utf-8')
  await writeFile(getSnapshotPath('latest.json'), payload, 'utf-8')
}
