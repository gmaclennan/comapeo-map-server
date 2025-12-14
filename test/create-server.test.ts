import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { createServer } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('createServer factory function', () => {
	const validKeyPair = {
		publicKey: randomBytes(32),
		secretKey: randomBytes(32),
	}

	const validCustomMapPath = `file://${path.join(__dirname, 'fixtures', 'demotiles-z2.smp')}`
	const validFallbackMapPath = `file://${path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')}`
	const validOnlineStyleUrl = 'https://demotiles.maplibre.org/style.json'

	describe('Invalid URL parameters', () => {
		it('should throw on invalid defaultOnlineStyleUrl', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: 'not a valid url',
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on empty defaultOnlineStyleUrl', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: '',
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on invalid customMapPath', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: 'invalid path without protocol',
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on empty customMapPath', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: '',
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on invalid fallbackMapPath', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: 'invalid path without protocol',
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on empty fallbackMapPath', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: '',
					keyPair: validKeyPair,
				}),
			).toThrow()
		})
	})

	describe('Invalid keyPair parameters', () => {
		it('should throw when keyPair is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					// @ts-expect-error - Testing missing keyPair
					keyPair: undefined,
				}),
			).toThrow()
		})

		it('should throw when keyPair is null', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					// @ts-expect-error - Testing null keyPair
					keyPair: null,
				}),
			).toThrow()
		})

		it('should throw when keyPair.publicKey is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						// @ts-expect-error - Testing missing publicKey
						publicKey: undefined,
						secretKey: randomBytes(32),
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair.secretKey is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						publicKey: randomBytes(32),
						// @ts-expect-error - Testing missing secretKey
						secretKey: undefined,
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair.publicKey is wrong type', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						// @ts-expect-error - Testing wrong type
						publicKey: 'not a Uint8Array',
						secretKey: randomBytes(32),
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair.secretKey is wrong type', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						publicKey: randomBytes(32),
						// @ts-expect-error - Testing wrong type
						secretKey: 'not a Uint8Array',
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair keys are wrong length', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						publicKey: randomBytes(16), // Wrong length (should be 32)
						secretKey: randomBytes(32),
					},
				}),
			).toThrow()
		})
	})

	describe('Missing required parameters', () => {
		it('should throw when defaultOnlineStyleUrl is missing', () => {
			expect(() =>
				createServer({
					// @ts-expect-error - Testing missing parameter
					defaultOnlineStyleUrl: undefined,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw when customMapPath is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					// @ts-expect-error - Testing missing parameter
					customMapPath: undefined,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw when fallbackMapPath is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					// @ts-expect-error - Testing missing parameter
					fallbackMapPath: undefined,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})
	})

	describe('Valid parameters', () => {
		it('should create server with valid parameters', () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			expect(server).toBeDefined()
			expect(server).toHaveProperty('listen')
			expect(typeof server.listen).toBe('function')
		})

		it('should accept http URLs for defaultOnlineStyleUrl', () => {
			const server = createServer({
				defaultOnlineStyleUrl: 'http://localhost:8080/style.json',
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			expect(server).toBeDefined()
		})

		it('should accept file:// URLs for map paths', () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: 'file:///path/to/custom.smp',
				fallbackMapPath: 'file:///path/to/fallback.smp',
				keyPair: validKeyPair,
			})

			expect(server).toBeDefined()
		})
	})

	describe('listen() method', () => {
		it('should accept empty options', async () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			const result = await server.listen()

			expect(result).toHaveProperty('localPort')
			expect(result).toHaveProperty('remotePort')
			expect(typeof result.localPort).toBe('number')
			expect(typeof result.remotePort).toBe('number')
		})

		it('should accept port options', async () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			const result = await server.listen({
				localPort: 0, // 0 = random port
				remotePort: 0,
			})

			expect(result.localPort).toBeGreaterThan(0)
			expect(result.remotePort).toBeGreaterThan(0)
		})

		it('should accept partial port options', async () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			const result = await server.listen({
				localPort: 0,
				// remotePort omitted
			})

			expect(result.localPort).toBeGreaterThan(0)
			expect(result.remotePort).toBeGreaterThan(0)
		})
	})
})
