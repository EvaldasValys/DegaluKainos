const lithuaniaDateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Vilnius',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const streetReplacements: Array<[RegExp, string]> = [
  [/\bg\./g, ' gatve '],
  [/\bpr\./g, ' prospektas '],
  [/\bpl\./g, ' plentas '],
  [/\bkel\./g, ' kelias '],
  [/\bal\./g, ' aleja '],
]

export interface ParsedAddress {
  rawAddress: string
  street: string
  streetKey: string
  houseNumber: string
  houseNumberKey: string
  city: string
  cityKey: string
}

export function formatLithuaniaDate(date = new Date()) {
  return lithuaniaDateFormatter.format(date)
}

export function isIsoDateString(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return false
  }

  const yearValue = Number(match[1])
  const monthValue = Number(match[2])
  const dayValue = Number(match[3])
  const parsedDate = new Date(Date.UTC(yearValue, monthValue - 1, dayValue))

  return (
    parsedDate.getUTCFullYear() === yearValue &&
    parsedDate.getUTCMonth() === monthValue - 1 &&
    parsedDate.getUTCDate() === dayValue
  )
}

export function normalizeText(value: string) {
  const withoutAccents = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/&/g, ' ir ')

  return withoutAccents.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

export function normalizeStreet(value: string) {
  const expanded = streetReplacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  )

  return normalizeText(expanded)
}

export function buildStationId(parts: string[]) {
  return parts.map((part) => normalizeText(part).replace(/\s+/g, '-')).join('--')
}

export function parseWorkbookDate(value: unknown) {
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/[./\s]+/g, '-')
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)

    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`
    }
  }

  return formatLithuaniaDate()
}

export function parseFuelValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value.toFixed(3))
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()

    if (!trimmed || trimmed === 'neprekiauja' || trimmed === 'nėra') {
      return null
    }

    const numeric = Number(trimmed.replace(',', '.'))
    return Number.isFinite(numeric) ? Number(numeric.toFixed(3)) : null
  }

  return null
}

export function municipalityToCity(value: string) {
  return value
    .replace(/\bm\.\s*sav\./i, '')
    .replace(/\br\.\s*sav\./i, '')
    .replace(/\bsav\./i, '')
    .trim()
}

export function parseStationAddress(address: string, municipality: string): ParsedAddress {
  const segments = address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const firstSegment = segments[0] ?? ''
  const lastSegment = segments.at(-1) ?? ''

  const looksLikeCityFirst =
    segments.length >= 2 &&
    !/\d/.test(firstSegment) &&
    /\d/.test(lastSegment) &&
    !/\bk\.$/iu.test(lastSegment)
  const city = looksLikeCityFirst
    ? firstSegment
    : lastSegment || municipalityToCity(municipality)
  const rawStreetPart = looksLikeCityFirst
    ? segments.slice(1).join(', ')
    : (segments.length > 1 ? segments.slice(0, -1).join(', ') : address)
  const streetPart = rawStreetPart.replace(/([A-Za-zĄ-Žą-ž.])(\d)/gu, '$1 $2').trim()
  const match = streetPart.match(/^(.*?)(?:\s+(\d[\dA-Za-z/-]*))?$/u)
  const street = match?.[1]?.trim() || streetPart
  const houseNumber = match?.[2]?.trim() ?? ''

  return {
    rawAddress: address,
    street,
    streetKey: normalizeStreet(street),
    houseNumber,
    houseNumberKey: normalizeText(houseNumber),
    city,
    cityKey: normalizeText(city),
  }
}

export function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
