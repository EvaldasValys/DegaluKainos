import * as XLSX from 'xlsx'
import type { PriceSnapshot, StationRecord } from '../../shared/types.js'
import { resolveStationLocations } from './location-service.js'
import { writePublishedSnapshot } from './snapshot-store.js'
import {
  buildStationId,
  formatLithuaniaDate,
  isIsoDateString,
  normalizeText,
  parseFuelValue,
  parseStationAddress,
  parseWorkbookDate,
} from './utils.js'

const HEADERS = {
  date: 'Data',
  network: 'Įmonė (Degalinių tinklas)',
  municipality: 'Degalinės vieta (Savivaldybė)',
  address: 'Degalinės vieta (Gyvenvietė, gatvė)',
  gasoline95: '95 benzinas',
  diesel: 'Dyzelinas',
  lpg: 'SND',
} as const

function buildWorkbookUrl(snapshotDate: string) {
  const year = snapshotDate.slice(0, 4)
  return `https://www.ena.lt/uploads/${year}-EDAC/dk-degalinese-${year}/dk-${snapshotDate}.xlsx`
}

async function downloadWorkbook(snapshotDate: string) {
  const sourceUrl = buildWorkbookUrl(snapshotDate)
  const response = await fetch(sourceUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DegaluKainos/1.0)',
      Accept:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream',
    },
  })

  if (!response.ok) {
    throw new Error(`Workbook download failed with ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return {
    sourceUrl,
    workbook: XLSX.read(Buffer.from(arrayBuffer), { type: 'buffer' }),
  }
}

function parseRow(row: Record<string, unknown>): StationRecord | null {
  const network = String(row[HEADERS.network] ?? '').trim()
  const municipality = String(row[HEADERS.municipality] ?? '').trim()
  const address = String(row[HEADERS.address] ?? '').trim()

  if (!network || !municipality || !address) {
    return null
  }

  const parsedAddress = parseStationAddress(address, municipality)

  return {
    id: buildStationId([network, municipality, address]),
    reportedDate: parseWorkbookDate(row[HEADERS.date]),
    network,
    municipality,
    city: parsedAddress.city,
    address,
    searchableText: normalizeText([network, municipality, parsedAddress.city, address].join(' ')),
    prices: {
      gasoline95: parseFuelValue(row[HEADERS.gasoline95]),
      diesel: parseFuelValue(row[HEADERS.diesel]),
      lpg: parseFuelValue(row[HEADERS.lpg]),
    },
    coordinates: null,
  } satisfies StationRecord
}

function ensureUniqueIds(stations: StationRecord[]) {
  const seenIds = new Map<string, number>()

  for (const station of stations) {
    const baseId = station.id
    const count = seenIds.get(baseId) ?? 0

    if (count > 0) {
      station.id = `${baseId}-${count + 1}`
    }

    seenIds.set(baseId, count + 1)
  }

  return stations
}

export async function fetchTodaySnapshot(): Promise<PriceSnapshot> {
  return fetchSnapshotForDate(formatLithuaniaDate())
}

export async function fetchSnapshotForDate(snapshotDate: string): Promise<PriceSnapshot> {
  if (!isIsoDateString(snapshotDate)) {
    throw new Error('Snapshot date must be in YYYY-MM-DD format.')
  }

  const requestedDate = snapshotDate
  const { sourceUrl, workbook } = await downloadWorkbook(requestedDate)
  const sheetName = workbook.SheetNames.find((name) => normalizeText(name).includes('degalu'))

  if (!sheetName) {
    throw new Error('Could not find the expected "Degalų kainos" worksheet')
  }

  const sheet = workbook.Sheets[sheetName]

  if (!sheet) {
    throw new Error(`Worksheet "${sheetName}" could not be loaded`)
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    range: 7,
    raw: true,
    defval: null,
  })
  const parsedStations = rawRows
    .map(parseRow)
    .filter((station): station is StationRecord => station !== null)
    .sort((left, right) =>
      `${left.network}-${left.city}-${left.address}`.localeCompare(
        `${right.network}-${right.city}-${right.address}`,
        'lt',
      ),
    )
  const stations = ensureUniqueIds(parsedStations)

  if (stations.length === 0) {
    throw new Error('The workbook did not contain any station rows')
  }

  const resolved = await resolveStationLocations(stations)

  return {
    fetchedAt: new Date().toISOString(),
    snapshotDate: stations.at(0)?.reportedDate || requestedDate,
    sourceUrl,
    stations: resolved.stations,
    coverage: resolved.coverage,
    locationNotes: resolved.locationNotes,
  }
}

export async function refreshLatestSnapshot(snapshotDate = formatLithuaniaDate()) {
  const snapshot = await fetchSnapshotForDate(snapshotDate)
  await writePublishedSnapshot(snapshot)
  return snapshot
}
