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
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
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

		it('should serve glyphs with correct content-type', async () => {
			// Try to fetch glyphs - using a common font stack
			const response = await fetch(
				`${baseUrl}/maps/fallback/glyphs/Noto Sans Regular/0-255.pbf`,
			)
			// Glyphs may or may not exist, but should not 500
			expect([200, 404]).toContain(response.status)

			if (response.status === 200) {
				// Should have protobuf content-type
				const contentType = response.headers.get('content-type')
				expect(contentType).toContain('application/x-protobuf')
			}
		})

		it('should include content-length header for style.json', async () => {
			const response = await fetch(`${baseUrl}/maps/custom/style.json`)
			expect(response.status).toBe(200)

			const contentLength = response.headers.get('content-length')
			expect(contentLength).toBeTruthy()

			// Verify content-length matches actual body length
			const body = await response.text()
			expect(parseInt(contentLength!)).toBe(new TextEncoder().encode(body).length)
		})

		it('should include content-length header for tiles', async () => {
			const response = await fetch(`${baseUrl}/maps/custom/0/0/0.pbf`)

			if (response.status === 200) {
				const contentLength = response.headers.get('content-length')
				expect(contentLength).toBeTruthy()

				// Verify content-length matches actual body length
				const arrayBuffer = await response.arrayBuffer()
				expect(parseInt(contentLength!)).toBe(arrayBuffer.byteLength)
			}
		})

		it('should handle gzip-encoded resources', async () => {
			// Glyphs are typically gzip-encoded
			const response = await fetch(
				`${baseUrl}/maps/fallback/glyphs/Noto Sans Regular/0-255.pbf`,
			)

			if (response.status === 200) {
				const encoding = response.headers.get('content-encoding')
				// May be gzip, or may not be encoded - both are valid
				if (encoding) {
					expect(encoding).toBe('gzip')
				}
			}
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

describe('Online Style Fallback', () => {
	let server: Awaited<ReturnType<typeof createServer>>
	let baseUrl: string

	beforeAll(async () => {
		// Generate a keypair for the server
		const keyPair = {
			publicKey: randomBytes(32),
			secretKey: randomBytes(32),
		}

		const fallbackMapPath = path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')

		// Create server with non-existent custom map path to test online fallback
		server = createServer({
			keyPair,
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
			customMapPath: 'file:///nonexistent/path/to/map.smp',
			fallbackMapPath: `file://${fallbackMapPath}`,
		})

		const { localPort } = await server.listen({
			localPort: 0,
			remotePort: 0,
		})

		baseUrl = `http://127.0.0.1:${localPort}`
	}, 30000)

	it('should redirect to fallback when custom map does not exist', async () => {
		// Request default map, which should redirect to online style or fallback since custom doesn't exist
		const response = await fetch(`${baseUrl}/maps/default/style.json`, {
			redirect: 'manual',
		})
		expect(response.status).toBe(302)
		const location = response.headers.get('location')
		expect(location).toBeTruthy()
		// Should redirect to either online style or fallback map
		expect(
			location.includes('demotiles.maplibre.org') ||
				location.includes('/maps/fallback/'),
		).toBe(true)
	}, 15000)

	it('should serve online style through default map fallback', async () => {
		// Follow the redirect to get the actual style
		const response = await fetch(`${baseUrl}/maps/default/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()

		// Verify it's the MapLibre demo tiles style
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
		expect(style).toHaveProperty('layers')
		expect(style).toHaveProperty('name')
	}, 15000)

	it('should return 404 for custom map resources when map does not exist', async () => {
		// Directly requesting custom map that doesn't exist should return 404
		const response = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(404)
	})

	it('should include CORS headers in redirect to online style', async () => {
		const response = await fetch(`${baseUrl}/maps/default/style.json`, {
			redirect: 'manual',
		})
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('cache-control')).toBe('no-cache')
	})

	it('should still serve fallback map normally', async () => {
		const response = await fetch(`${baseUrl}/maps/fallback/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
	})
})

describe('Map Lifecycle: Upload, Replace, and Delete', () => {
	let server: Awaited<ReturnType<typeof createServer>>
	let baseUrl: string
	let tempCustomMapPath: string
	let tempDir: string

	beforeAll(async () => {
		// Generate a keypair for the server
		const keyPair = {
			publicKey: randomBytes(32),
			secretKey: randomBytes(32),
		}

		// Create temp directory for custom map
		tempDir = path.join(os.tmpdir(), `map-lifecycle-test-${Date.now()}`)
		fs.mkdirSync(tempDir, { recursive: true })
		tempCustomMapPath = path.join(tempDir, 'custom.smp')

		// Start without a custom map (file doesn't exist yet)
		const fallbackMapPath = path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')

		server = createServer({
			keyPair,
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
			customMapPath: `file://${tempCustomMapPath}`,
			fallbackMapPath: `file://${fallbackMapPath}`,
		})

		const { localPort } = await server.listen({
			localPort: 0,
			remotePort: 0,
		})

		baseUrl = `http://127.0.0.1:${localPort}`
	}, 30000)

	afterAll(async () => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch (err) {
			// Ignore errors
		}
	})

	it('should return 404 when custom map does not exist initially', async () => {
		const response = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(404)
	})

	it('should upload a custom map after server initialization', async () => {
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

		// Verify the file was written
		expect(fs.existsSync(tempCustomMapPath)).toBe(true)
	}, 30000)

	it('should serve the newly uploaded custom map', async () => {
		const response = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
		expect(style).toHaveProperty('layers')
	}, 10000)

	it('should return map info for the uploaded custom map', async () => {
		const response = await fetch(`${baseUrl}/maps/custom/info`)
		expect(response.status).toBe(200)
		const info = await response.json()
		expect(info).toHaveProperty('name')
		expect(info).toHaveProperty('size')
		expect(info).toHaveProperty('created')
		expect(info.size).toBeGreaterThan(0)
	}, 10000)

	it('should replace an existing custom map', async () => {
		// Get the current map info
		const infoResponse1 = await fetch(`${baseUrl}/maps/custom/info`)
		const info1 = await infoResponse1.json()

		// Upload a different map (osm-bright instead of demotiles)
		const fixturePath = path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')
		const fileBuffer = fs.readFileSync(fixturePath)

		const uploadResponse = await fetch(`${baseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		expect(uploadResponse.status).toBe(200)

		// Verify the map was replaced by checking size changed
		const infoResponse2 = await fetch(`${baseUrl}/maps/custom/info`)
		const info2 = await infoResponse2.json()
		expect(info2.size).not.toBe(info1.size)
	}, 30000)

	it('should serve the replaced custom map', async () => {
		const response = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		// Should now be osm-bright map
		expect(style).toHaveProperty('sources')
	}, 10000)

	it('should delete the custom map', async () => {
		const response = await fetch(`${baseUrl}/maps/custom`, {
			method: 'DELETE',
		})

		expect(response.status).toBe(204)

		// Verify the file was deleted
		expect(fs.existsSync(tempCustomMapPath)).toBe(false)
	})

	it('should return 404 after custom map is deleted', async () => {
		const response = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(404)
	})

	it('should return 404 when trying to delete already deleted map', async () => {
		const response = await fetch(`${baseUrl}/maps/custom`, {
			method: 'DELETE',
		})

		expect(response.status).toBe(404)
	})

	it('should return 404 when trying to delete fallback map', async () => {
		const response = await fetch(`${baseUrl}/maps/fallback`, {
			method: 'DELETE',
		})

		expect(response.status).toBe(404)
	})

	it('should return 404 when trying to delete default map', async () => {
		const response = await fetch(`${baseUrl}/maps/default`, {
			method: 'DELETE',
		})

		expect(response.status).toBe(404)
	})

	it('should upload custom map again after deletion', async () => {
		// Upload a map again to verify server state is correct
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

		// Verify it's accessible
		const styleResponse = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(styleResponse.status).toBe(200)
	}, 30000)

	it('should handle concurrent upload attempts gracefully', async () => {
		const fixturePath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
		const fileBuffer = fs.readFileSync(fixturePath)

		// Start two concurrent uploads
		const upload1 = fetch(`${baseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		const upload2 = fetch(`${baseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		const [response1, response2] = await Promise.all([upload1, upload2])

		// Both should succeed (one waits for the other)
		expect(response1.status).toBe(200)
		expect(response2.status).toBe(200)

		// Verify map is in a good state
		const styleResponse = await fetch(`${baseUrl}/maps/custom/style.json`)
		expect(styleResponse.status).toBe(200)
	}, 30000)
})
