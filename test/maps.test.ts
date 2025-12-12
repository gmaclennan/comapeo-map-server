import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Maps API', () => {
	let server: Awaited<ReturnType<typeof createServer>>
	let baseUrl: string
	let localPort: number
	let tempCustomMapPath: string

	beforeAll(async () => {
		// Generate a keypair for the server
		const keyPair = {
			publicKey: randomBytes(32),
			secretKey: randomBytes(32),
		}

		// Copy fixture to temp location so upload tests don't corrupt the original
		const fixtureCustomMapPath = path.join(
			__dirname,
			'fixtures',
			'demotiles-z2.smp',
		)
		tempCustomMapPath = path.join(
			os.tmpdir(),
			`test-custom-map-${Date.now()}.smp`,
		)
		fs.copyFileSync(fixtureCustomMapPath, tempCustomMapPath)

		const fallbackMapPath = path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')

		server = createServer({
			keyPair,
			defaultOnlineStyleUrl: 'https://example.com/style.json', // This will likely fail, which is expected
			customMapPath: `file://${tempCustomMapPath}`,
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

	afterAll(async () => {
		// Clean up temp file
		try {
			fs.unlinkSync(tempCustomMapPath)
		} catch (err) {
			// Ignore errors
		}
	})

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

	describe('Map Info Endpoints', () => {
		it('should return info for custom map', async () => {
			const response = await fetch(`${baseUrl}/maps/custom/info`)
			expect(response.status).toBe(200)
			const info = await response.json()
			expect(info).toHaveProperty('created')
			expect(info).toHaveProperty('size')
			expect(info).toHaveProperty('name')
			expect(typeof info.created).toBe('number')
			expect(typeof info.size).toBe('number')
			expect(typeof info.name).toBe('string')
		})

		it('should return info for fallback map', async () => {
			const response = await fetch(`${baseUrl}/maps/fallback/info`)
			expect(response.status).toBe(200)
			const info = await response.json()
			expect(info).toHaveProperty('created')
			expect(info).toHaveProperty('size')
			expect(info).toHaveProperty('name')
		})

		it('should return 404 for nonexistent map info', async () => {
			const response = await fetch(`${baseUrl}/maps/nonexistent/info`)
			expect(response.status).toBe(404)
		})
	})

	describe('Tile Serving', () => {
		it('should handle tile requests to custom map', async () => {
			// Try to fetch a tile - it may or may not exist in the fixture
			const response = await fetch(`${baseUrl}/maps/custom/0/0/0.pbf`)
			// Should return either 200 (tile exists) or 404 (tile doesn't exist), not 500
			expect([200, 404]).toContain(response.status)
			if (response.status === 200) {
				expect(response.headers.get('content-type')).toContain(
					'application/x-protobuf',
				)
			}
		})

		it('should handle tile requests to fallback map', async () => {
			const response = await fetch(`${baseUrl}/maps/fallback/0/0/0.pbf`)
			// Should return either 200 (tile exists) or 404 (tile doesn't exist), not 500
			expect([200, 404]).toContain(response.status)
			if (response.status === 200) {
				expect(response.headers.get('content-type')).toContain(
					'application/x-protobuf',
				)
			}
		})

		it('should return 404 for tiles outside zoom range', async () => {
			// demotiles-z2 only goes to zoom 2
			const response = await fetch(`${baseUrl}/maps/custom/10/512/512.pbf`)
			expect(response.status).toBe(404)
		})

		it('should handle sprite resource requests', async () => {
			const response = await fetch(`${baseUrl}/maps/custom/sprite.json`)
			// Should either return the sprite or 404 if not present, not 500
			expect([200, 404]).toContain(response.status)
		})
	})

	describe('Map Upload', () => {
		it('should accept PUT to custom map', async () => {
			// Read the test fixture to upload
			const fixturePath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
			const fileBuffer = fs.readFileSync(fixturePath)

			const response = await fetch(`${baseUrl}/maps/custom`, {
				method: 'PUT',
				body: fileBuffer,
				headers: {
					'Content-Type': 'application/octet-stream',
				},
			})

			expect(response.status).toBe(200)
		}, 30000) // Longer timeout for upload

		it('should reject PUT to fallback map', async () => {
			const fixturePath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
			const fileBuffer = fs.readFileSync(fixturePath)

			const response = await fetch(`${baseUrl}/maps/fallback`, {
				method: 'PUT',
				body: fileBuffer,
				headers: {
					'Content-Type': 'application/octet-stream',
				},
			})

			expect(response.status).toBe(404)
		}, 30000)

		it('should reject PUT to default map', async () => {
			const fixturePath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
			const fileBuffer = fs.readFileSync(fixturePath)

			const response = await fetch(`${baseUrl}/maps/default`, {
				method: 'PUT',
				body: fileBuffer,
				headers: {
					'Content-Type': 'application/octet-stream',
				},
			})

			expect(response.status).toBe(404)
		}, 30000)

		it('should handle PUT with empty body', async () => {
			// Note: fetch() creates an empty ReadableStream for PUT with no body param
			// This is actually valid and will create an empty file
			const response = await fetch(`${baseUrl}/maps/custom`, {
				method: 'PUT',
			})

			// Should succeed (200) as empty body is technically valid
			expect(response.status).toBe(200)
		})
	})

	describe('Default Map Fallback Logic', () => {
		it('should follow redirect and serve custom map style', async () => {
			// Follow the redirect this time
			const response = await fetch(`${baseUrl}/maps/default/style.json`)
			expect(response.status).toBe(200)
			const style = await response.json()
			expect(style).toHaveProperty('version')
		}, 10000)

		it('should include CORS headers in redirect', async () => {
			const response = await fetch(`${baseUrl}/maps/default/style.json`, {
				redirect: 'manual',
			})
			expect(response.headers.get('access-control-allow-origin')).toBe('*')
			expect(response.headers.get('cache-control')).toBe('no-cache')
		})
	})

	describe('Error Handling', () => {
		it('should return 404 for invalid map ID', async () => {
			const response = await fetch(
				`${baseUrl}/maps/invalidmapid/style.json`,
			)
			expect(response.status).toBe(404)
		})

		it('should handle malformed tile requests gracefully', async () => {
			const response = await fetch(`${baseUrl}/maps/custom/abc/def/ghi.pbf`)
			// Malformed requests may return 400, 404, or 500 depending on parsing
			expect([400, 404, 500]).toContain(response.status)
		})

		it('should handle non-existent resources', async () => {
			const response = await fetch(
				`${baseUrl}/maps/custom/nonexistent-resource.json`,
			)
			// May return 404 (not found) or 500 (error reading from SMP)
			expect([404, 500]).toContain(response.status)
		})
	})
})
