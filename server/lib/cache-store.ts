import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const cacheDir = path.join(process.cwd(), 'data', 'cache')

async function ensureCacheDir() {
  await mkdir(cacheDir, { recursive: true })
}

export function getCachePath(fileName: string) {
  return path.join(cacheDir, fileName)
}

export async function readJsonCache<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const contents = await readFile(getCachePath(fileName), 'utf-8')
    return JSON.parse(contents) as T
  } catch {
    return fallback
  }
}

export async function writeJsonCache(fileName: string, payload: unknown) {
  await ensureCacheDir()
  await writeFile(getCachePath(fileName), JSON.stringify(payload, null, 2), 'utf-8')
}
