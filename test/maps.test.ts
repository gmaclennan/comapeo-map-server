import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Maps API', () => {
	let server: Awaited<ReturnType<typeof createServer>>
	let baseUrl: string
	let localPort: number

	beforeAll(async () => {
		// Generate a keypair for the server
		const keyPair = {
			publicKey: randomBytes(32),
			secretKey: randomBytes(32),
		}

		// Create server with test fixtures - need file:// URLs
		const customMapPath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
		const fallbackMapPath = path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')

		server = createServer({
			keyPair,
			defaultOnlineStyleUrl: 'https://example.com/style.json', // This will likely fail, which is expected
			customMapPath: `file://${customMapPath}`,
			fallbackMapPath: `file://${fallbackMapPath}`,
		})

		// Listen on random ports
		const { localPort: port } = await server.listen({
			localPort: 0, // Random port
			remotePort: 0, // Random port
		})

		localPort = port
		baseUrl = `http://127.0.0.1:${localPort}`
	}, 30000) // 30 second timeout for setup

	it('should return 404 for unknown route (sanity check)', async () => {
		const response = await fetch(`${baseUrl}/unknown-route`)
		expect(response.status).toBe(404)
	}, 5000)

	it('should serve custom map style.json', async () => {
		const response = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
		expect(style).toHaveProperty('layers')
	}, 10000)

	it('should serve fallback map style.json', async () => {
		const response = await fetch(`${baseUrl}/maps/fallback/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
		expect(style).toHaveProperty('layers')
	}, 10000)

	it('should handle default map by redirecting to custom', async () => {
		const response = await fetch(`${baseUrl}/maps/default/style.json`, {
			redirect: 'manual', // Don't follow redirects
		})
		expect(response.status).toBe(302)
		const location = response.headers.get('location')
		expect(location).toBeTruthy()
		expect(location).toContain('/maps/custom/style.json')
	}, 10000)
})
