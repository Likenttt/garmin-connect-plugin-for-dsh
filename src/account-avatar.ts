/** Only official Garmin image origins; never fetch arbitrary profile URLs. */
export function garminAvatarUrl(profile: unknown): string | undefined {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return undefined
  const data = profile as Record<string, unknown>
  for (const key of ['profileImageUrlSmall', 'profileImageUrlMedium', 'profileImageUrlLarge', 'profileImageUrl']) {
    const value = data[key]
    if (typeof value !== 'string' || value.length > 2048) continue
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) continue
      const garmin = ['garmin.com', 'garmin.cn', 'garmincdn.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
      const s3 = ['s3.amazonaws.com', 's3.cn-north-1.amazonaws.com.cn'].includes(url.hostname)
        && url.pathname.startsWith('/garmin-connect-prod/profile_images/')
      const bucket = ['garmin-connect-prod.s3.amazonaws.com', 'garmin-connect-prod.s3.cn-north-1.amazonaws.com.cn'].includes(url.hostname)
        && url.pathname.startsWith('/profile_images/')
      if (garmin || s3 || bucket) return url.href
    } catch { /* Try the next official image variant. */ }
  }
  return undefined
}

export const MAX_AVATAR_BYTES = 128 * 1024

/** Send no cookies/credentials and return an inert, bounded raster data URL. */
export async function downloadGarminAvatar(url: string, request: typeof fetch = fetch): Promise<string | undefined> {
  if (garminAvatarUrl({ profileImageUrl: url }) !== url) return undefined
  try {
    const response = await request(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(4000) })
    if (!response.ok || !response.body) return undefined
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_AVATAR_BYTES) return undefined
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const bytes = Buffer.concat(chunks)
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : undefined
  } catch { return undefined }
}
