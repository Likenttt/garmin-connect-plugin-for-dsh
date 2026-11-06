import { downloadGarminAvatar, garminAvatarUrl, MAX_AVATAR_BYTES } from '../src/account-avatar'

const GLOBAL = 'https://s3.amazonaws.com/garmin-connect-prod/profile_images/small.png'
const CHINA = 'https://s3.cn-north-1.amazonaws.com.cn/garmin-connect-prod/profile_images/small.png'
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const JPEG = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217])

it('selects the small official avatar first and rejects unsafe origins, credentials, ports and S3 buckets', () => {
  expect(garminAvatarUrl({ profileImageUrlSmall: CHINA, profileImageUrlMedium: GLOBAL })).toBe(CHINA)
  expect(garminAvatarUrl({ profileImageUrlSmall: GLOBAL, profileImageUrlLarge: CHINA })).toBe(GLOBAL)
  expect(garminAvatarUrl({ profileImageUrlSmall: 'http://127.0.0.1/private', profileImageUrlMedium: GLOBAL })).toBe(GLOBAL)
  for (const url of [
    GLOBAL.replace('https:', 'http:'), 'https://127.0.0.1/avatar.png',
    'https://localhost/avatar.png', 'https://user:secret@s3.amazonaws.com/garmin-connect-prod/profile_images/a.png',
    GLOBAL.replace('s3.amazonaws.com/', 's3.amazonaws.com:7443/'),
    GLOBAL.replace('/garmin-connect-prod/', '/other-bucket/'),
    GLOBAL.replace('/profile_images/', '/private/'),
    'https://s3.amazonaws.com.evil.test/garmin-connect-prod/profile_images/a.png',
  ]) expect(garminAvatarUrl({ profileImageUrlSmall: url })).toBeUndefined()
})

it('downloads avatar PNG and JPEG bytes without authentication or redirects and emits raster data URLs', async () => {
  for (const [url, bytes, mime] of [[GLOBAL, PNG, 'image/png'], [CHINA, JPEG, 'image/jpeg']] as const) {
    const request = jest.fn(async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    expect(await downloadGarminAvatar(url, request as typeof fetch)).toBe(`data:${mime};base64,${bytes.toString('base64')}`)
    expect(request).toHaveBeenCalledWith(url, {
      credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
    })
    expect((request.mock.calls[0] as unknown[])[1]).not.toHaveProperty('headers')
  }
})

it('rejects disguised SVG avatars and cancels the response after exceeding 128 KiB', async () => {
  const svg = jest.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    { headers: { 'content-type': 'image/png' } }))
  expect(await downloadGarminAvatar(GLOBAL, svg as typeof fetch)).toBeUndefined()
  const cancel = jest.fn()
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(PNG)
    controller.enqueue(new Uint8Array(MAX_AVATAR_BYTES))
  }, cancel })
  const request = jest.fn(async () => new Response(stream, { headers: { 'content-type': 'image/png' } }))
  expect(await downloadGarminAvatar(GLOBAL, request as typeof fetch)).toBeUndefined()
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('treats avatar network failures as optional and never requests a forbidden URL', async () => {
  const request = jest.fn(async () => { throw new Error('offline') })
  expect(await downloadGarminAvatar('http://127.0.0.1/private', request as typeof fetch)).toBeUndefined()
  expect(request).not.toHaveBeenCalled()
  expect(await downloadGarminAvatar(GLOBAL, request as typeof fetch)).toBeUndefined()
  expect(request).toHaveBeenCalledTimes(1)
})
