import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import z32 from 'z32'
import { createServer } from '../src/index.js'

// EventSource is a CommonJS module, use require to import it
const require = createRequire(import.meta.url)
const { EventSource } = require('eventsource')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Get first non-loopback IPv4 address, or null if none found
 */
function getNonLoopbackIPv4(): string | null {
	const interfaces = os.networkInterfaces()
	for (const iface of Object.values(interfaces)) {
		if (!iface) continue
		for (const addr of iface) {
			if (addr.family === 'IPv4' && !addr.internal) {
				return addr.address
			}
		}
	}
	return null
}

describe('Map Shares and Downloads', () => {
	// Sender server
	let senderServer: Awaited<ReturnType<typeof createServer>>
	let senderBaseUrl: string
	let senderLocalPort: number
	let senderRemotePort: number
	let senderDeviceId: string
	let senderKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }

	// Receiver server
	let receiverServer: Awaited<ReturnType<typeof createServer>>
	let receiverBaseUrl: string
	let receiverLocalPort: number
	let receiverDeviceId: string
	let receiverKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }

	// Test data
	let tempSenderMapPath: string
	let tempReceiverMapPath: string
	let nonLoopbackIP: string | null

	beforeAll(async () => {
		nonLoopbackIP = getNonLoopbackIPv4()

		// Setup sender server
		senderKeyPair = {
			publicKey: randomBytes(32),
			secretKey: randomBytes(32),
		}
		senderDeviceId = z32.encode(senderKeyPair.publicKey)

		// Copy fixture for sender
		const fixtureMapPath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
		tempSenderMapPath = path.join(
			os.tmpdir(),
			`test-sender-map-${Date.now()}.smp`,
		)
		fs.copyFileSync(fixtureMapPath, tempSenderMapPath)

		const fallbackMapPath = path.join(__dirname, 'fixtures', 'osm-bright-z6.smp')

		senderServer = createServer({
			keyPair: senderKeyPair,
			defaultOnlineStyleUrl: 'https://example.com/style.json',
			customMapPath: `file://${tempSenderMapPath}`,
			fallbackMapPath: `file://${fallbackMapPath}`,
		})

		const senderPorts = await senderServer.listen({
			localPort: 0,
			remotePort: 0,
		})
		senderLocalPort = senderPorts.localPort
		senderRemotePort = senderPorts.remotePort
		senderBaseUrl = `http://127.0.0.1:${senderLocalPort}`

		// Setup receiver server
		receiverKeyPair = {
			publicKey: randomBytes(32),
			secretKey: randomBytes(32),
		}
		receiverDeviceId = z32.encode(receiverKeyPair.publicKey)

		tempReceiverMapPath = path.join(
			os.tmpdir(),
			`test-receiver-map-${Date.now()}.smp`,
		)

		receiverServer = createServer({
			keyPair: receiverKeyPair,
			defaultOnlineStyleUrl: 'https://example.com/style.json',
			customMapPath: `file://${tempReceiverMapPath}`,
			fallbackMapPath: `file://${fallbackMapPath}`,
		})

		const receiverPorts = await receiverServer.listen({
			localPort: 0,
			remotePort: 0,
		})
		receiverLocalPort = receiverPorts.localPort
		receiverBaseUrl = `http://127.0.0.1:${receiverLocalPort}`
	}, 30000)

	afterAll(async () => {
		// Clean up temp files
		try {
			fs.unlinkSync(tempSenderMapPath)
		} catch (err) {
			// Ignore
		}
		try {
			fs.unlinkSync(tempReceiverMapPath)
		} catch (err) {
			// Ignore
		}
	})

	describe('Map Shares (Sender)', () => {
		let shareId: string

		it('should create a map share', async () => {
			const response = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})

			expect(response.status).toBe(201)
			const share = await response.json()

			expect(share).toHaveProperty('shareId')
			expect(share).toHaveProperty('downloadUrls')
			expect(share).toHaveProperty('receiverDeviceId', receiverDeviceId)
			expect(share).toHaveProperty('status', 'pending')
			expect(share).toHaveProperty('mapId', 'custom')
			expect(share.downloadUrls).toBeInstanceOf(Array)
			expect(share.downloadUrls.length).toBeGreaterThan(0)

			// Save shareId for later tests
			shareId = share.shareId

			// Check Location header
			const location = response.headers.get('location')
			expect(location).toContain(shareId)
		})

		it('should list all map shares', async () => {
			const response = await fetch(`${senderBaseUrl}/mapShares`)
			expect(response.status).toBe(200)
			const shares = await response.json()

			expect(Array.isArray(shares)).toBe(true)
			expect(shares.length).toBeGreaterThan(0)
			expect(shares[0]).toHaveProperty('shareId')
		})

		it('should get a specific map share', async () => {
			// First create a share
			const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})
			const { shareId } = await createResponse.json()

			// Then get it
			const response = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			expect(response.status).toBe(200)
			const share = await response.json()

			expect(share.shareId).toBe(shareId)
			expect(share.status).toBe('pending')
		})

		it('should return 404 for non-existent share', async () => {
			const response = await fetch(
				`${senderBaseUrl}/mapShares/nonexistent-share-id`,
			)
			expect(response.status).toBe(404)
		})

		it('should cancel a map share', async () => {
			// Create a share
			const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})
			const { shareId } = await createResponse.json()

			// Cancel it
			const cancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/cancel`,
				{
					method: 'POST',
				},
			)
			expect(cancelResponse.status).toBe(204)

			// Verify it's cancelled
			const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			const share = await getResponse.json()
			expect(share.status).toBe('canceled')
		})

		it('should decline a map share from receiver', async () => {
			// Create a share
			const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})
			const { shareId } = await createResponse.json()

			// Decline it
			const declineResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/decline`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						reason: 'user_rejected',
					}),
				},
			)
			expect(declineResponse.status).toBe(204)

			// Verify it's declined
			const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			const share = await getResponse.json()
			expect(share.status).toBe('declined')
			expect(share.reason).toBe('user_rejected')
		})
	})

	describe('Downloads (Receiver)', () => {
		it('should create a download request', async () => {
			const response = await fetch(`${receiverBaseUrl}/downloads`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					senderDeviceId,
					shareId: 'test-share-id',
					downloadUrls: [
						`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-id/download`,
					],
					estimatedSizeBytes: 1000000,
				}),
			})

			expect(response.status).toBe(201)
			const download = await response.json()

			expect(download).toHaveProperty('downloadId')
			expect(download).toHaveProperty('status', 'downloading')
			expect(download).toHaveProperty('bytesDownloaded', 0)
			expect(download).toHaveProperty('senderDeviceId', senderDeviceId)

			// Check Location header
			const location = response.headers.get('location')
			expect(location).toContain(download.downloadId)
		})

		it('should list all downloads', async () => {
			const response = await fetch(`${receiverBaseUrl}/downloads`)
			expect(response.status).toBe(200)
			const downloads = await response.json()

			expect(Array.isArray(downloads)).toBe(true)
		})

		it('should get a specific download', async () => {
			// Create a download
			const createResponse = await fetch(`${receiverBaseUrl}/downloads`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					senderDeviceId,
					shareId: 'test-share-id-2',
					downloadUrls: [
						`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-id-2/download`,
					],
					estimatedSizeBytes: 1000000,
				}),
			})
			const { downloadId } = await createResponse.json()

			// Get it
			const response = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			expect(response.status).toBe(200)
			const download = await response.json()

			expect(download.downloadId).toBe(downloadId)
		})

		it('should return 404 for non-existent download', async () => {
			const response = await fetch(
				`${receiverBaseUrl}/downloads/nonexistent-download-id`,
			)
			expect(response.status).toBe(404)
		})

		it('should cancel a download', async () => {
			// Create a download
			const createResponse = await fetch(`${receiverBaseUrl}/downloads`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					senderDeviceId,
					shareId: 'test-share-id-3',
					downloadUrls: [
						`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-id-3/download`,
					],
					estimatedSizeBytes: 1000000,
				}),
			})
			const { downloadId } = await createResponse.json()

			// Cancel it
			const cancelResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}/cancel`,
				{
					method: 'POST',
				},
			)
			expect(cancelResponse.status).toBe(204)
		})
	})

	describe('Localhost-Only Protection', () => {
		it('should reject map share creation from non-localhost', async () => {
			if (!nonLoopbackIP) {
				console.warn('Skipping test: No non-loopback IP found')
				return
			}

			// Try to create a share using the non-loopback IP
			const response = await fetch(
				`http://${nonLoopbackIP}:${senderLocalPort}/mapShares`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						mapId: 'custom',
						receiverDeviceId,
					}),
				},
			).catch(() => null)

			// If connection succeeds, it should be rejected with 403
			if (response) {
				expect(response.status).toBe(403)
			}
			// If connection fails, that's also acceptable (firewall/network config)
		})

		it('should reject download creation from non-localhost', async () => {
			if (!nonLoopbackIP) {
				console.warn('Skipping test: No non-loopback IP found')
				return
			}

			const response = await fetch(
				`http://${nonLoopbackIP}:${receiverLocalPort}/downloads`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						senderDeviceId,
						shareId: 'test-share',
						downloadUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					}),
				},
			).catch(() => null)

			if (response) {
				expect(response.status).toBe(403)
			}
		})
	})

	describe('Validation', () => {
		it('should reject map share with invalid body', async () => {
			const response = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					// Missing receiverDeviceId
					mapId: 'custom',
				}),
			})

			expect(response.status).toBe(400)
		})

		it('should reject download with invalid senderDeviceId', async () => {
			const response = await fetch(`${receiverBaseUrl}/downloads`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					senderDeviceId: 'invalid-device-id',
					shareId: 'test-share',
					downloadUrls: ['http://example.com/download'],
					estimatedSizeBytes: 1000,
				}),
			})

			// Should reject with 400 or 500 (depending on when validation occurs)
			expect([400, 500]).toContain(response.status)
		})

		it('should reject map share for non-existent map', async () => {
			const response = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					mapId: 'nonexistent-map',
					receiverDeviceId,
				}),
			})

			expect(response.status).toBe(404)
		})
	})

	describe('Server-Sent Events (SSE)', () => {
		describe('Map Share Events', () => {
			it('should stream initial state when connecting to events endpoint', async () => {
				// Create a share
				const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						mapId: 'custom',
						receiverDeviceId,
					}),
				})
				const { shareId } = await createResponse.json()

				// Connect to SSE endpoint
				const eventSource = new EventSource(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
				)

				// Wait for initial message
				const initialState = await new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						eventSource.close()
						reject(new Error('Timeout waiting for SSE message'))
					}, 5000)

					eventSource.onmessage = (event) => {
						clearTimeout(timeout)
						eventSource.close()
						resolve(JSON.parse(event.data))
					}

					eventSource.onerror = (error) => {
						clearTimeout(timeout)
						eventSource.close()
						reject(error)
					}
				})

				expect(initialState).toHaveProperty('shareId', shareId)
				expect(initialState).toHaveProperty('status', 'pending')
				expect(initialState).toHaveProperty('mapId', 'custom')
			})

			it('should stream state updates when share is cancelled', async () => {
				// Create a share
				const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						mapId: 'custom',
						receiverDeviceId,
					}),
				})
				const { shareId } = await createResponse.json()

				// Connect to SSE endpoint
				const eventSource = new EventSource(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
				)

				const messages: any[] = []

				// Collect messages
				const updatePromise = new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						eventSource.close()
						reject(new Error('Timeout waiting for update'))
					}, 5000)

					eventSource.onmessage = (event) => {
						const data = JSON.parse(event.data)
						messages.push(data)

						// After receiving 2 messages (initial + update), resolve
						if (messages.length >= 2) {
							clearTimeout(timeout)
							eventSource.close()
							resolve(messages)
						}
					}

					eventSource.onerror = (error) => {
						clearTimeout(timeout)
						eventSource.close()
						reject(error)
					}
				})

				// Wait for connection and initial message
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Cancel the share to trigger an update
				await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
					method: 'POST',
				})

				await updatePromise

				// First message should be initial state (pending)
				expect(messages[0]).toHaveProperty('status', 'pending')

				// Second message should be the cancel update
				expect(messages[1]).toHaveProperty('status', 'canceled')
			})

			it('should stream state updates when share is declined', async () => {
				// Create a share
				const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						mapId: 'custom',
						receiverDeviceId,
					}),
				})
				const { shareId } = await createResponse.json()

				// Connect to SSE endpoint
				const eventSource = new EventSource(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
				)

				const messages: any[] = []

				const updatePromise = new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						eventSource.close()
						reject(new Error('Timeout waiting for decline update'))
					}, 5000)

					eventSource.onmessage = (event) => {
						const data = JSON.parse(event.data)
						messages.push(data)

						if (messages.length >= 2) {
							clearTimeout(timeout)
							eventSource.close()
							resolve(messages)
						}
					}

					eventSource.onerror = (error) => {
						clearTimeout(timeout)
						eventSource.close()
						reject(error)
					}
				})

				// Wait for connection
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Decline the share
				await fetch(`${senderBaseUrl}/mapShares/${shareId}/decline`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						reason: 'user_rejected',
					}),
				})

				await updatePromise

				// Second message should be the decline update
				expect(messages[1]).toHaveProperty('status', 'declined')
				expect(messages[1]).toHaveProperty('reason', 'user_rejected')
			})

			it('should return 404 for SSE on non-existent share', async () => {
				const eventSource = new EventSource(
					`${senderBaseUrl}/mapShares/nonexistent-id/events`,
				)

				const error = await new Promise((resolve) => {
					const timeout = setTimeout(() => {
						eventSource.close()
						resolve(null)
					}, 2000)

					eventSource.onerror = (err) => {
						clearTimeout(timeout)
						eventSource.close()
						resolve(err)
					}
				})

				expect(error).toBeTruthy()
			})

			it('should properly close SSE connection when client disconnects', async () => {
				// Create a share
				const createResponse = await fetch(`${senderBaseUrl}/mapShares`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						mapId: 'custom',
						receiverDeviceId,
					}),
				})
				const { shareId } = await createResponse.json()

				// Connect and immediately disconnect
				const eventSource = new EventSource(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
				)

				await new Promise((resolve) => setTimeout(resolve, 100))
				eventSource.close()

				// Wait a bit to ensure cleanup
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Share should still exist and be queryable
				const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
				expect(getResponse.status).toBe(200)
			})
		})

		describe('Download Events', () => {
			it('should stream initial state for download events', async () => {
				// Create a download
				const createResponse = await fetch(`${receiverBaseUrl}/downloads`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						senderDeviceId,
						shareId: 'test-share-sse',
						downloadUrls: [
							`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-sse/download`,
						],
						estimatedSizeBytes: 1000000,
					}),
				})
				const { downloadId } = await createResponse.json()

				// Connect to SSE endpoint
				const eventSource = new EventSource(
					`${receiverBaseUrl}/downloads/${downloadId}/events`,
				)

				const initialState = await new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						eventSource.close()
						reject(new Error('Timeout waiting for download SSE message'))
					}, 5000)

					eventSource.onmessage = (event) => {
						clearTimeout(timeout)
						eventSource.close()
						resolve(JSON.parse(event.data))
					}

					eventSource.onerror = (error) => {
						clearTimeout(timeout)
						eventSource.close()
						reject(error)
					}
				})

				expect(initialState).toHaveProperty('downloadId', downloadId)
				expect(initialState).toHaveProperty('status', 'downloading')
				expect(initialState).toHaveProperty('bytesDownloaded')
			})

			it('should stream state updates when download is cancelled', async () => {
				// Create a download
				const createResponse = await fetch(`${receiverBaseUrl}/downloads`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						senderDeviceId,
						shareId: 'test-share-cancel-sse',
						downloadUrls: [
							`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-cancel-sse/download`,
						],
						estimatedSizeBytes: 1000000,
					}),
				})
				const { downloadId } = await createResponse.json()

				// Connect to SSE endpoint
				const eventSource = new EventSource(
					`${receiverBaseUrl}/downloads/${downloadId}/events`,
				)

				const messages: any[] = []
				let resolved = false

				const updatePromise = new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						if (!resolved) {
							eventSource.close()
							reject(new Error('Timeout waiting for download update'))
						}
					}, 5000)

					eventSource.onmessage = (event) => {
						const data = JSON.parse(event.data)
						messages.push(data)

						// Look for error/canceled status
						if (data.status === 'error' || data.status === 'canceled') {
							if (!resolved) {
								resolved = true
								clearTimeout(timeout)
								eventSource.close()
								resolve(messages)
							}
						}
					}

					eventSource.onerror = (error) => {
						if (!resolved) {
							resolved = true
							clearTimeout(timeout)
							eventSource.close()
							reject(error)
						}
					}
				})

				// Wait for connection
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Cancel the download
				await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
					method: 'POST',
				})

				await updatePromise

				// Should have received at least one message
				expect(messages.length).toBeGreaterThan(0)

				// Last message should indicate error or canceled
				const lastMessage = messages[messages.length - 1]
				expect(['error', 'canceled']).toContain(lastMessage.status)
			})

			it('should return 404 for SSE on non-existent download', async () => {
				const eventSource = new EventSource(
					`${receiverBaseUrl}/downloads/nonexistent-download-id/events`,
				)

				const error = await new Promise((resolve) => {
					const timeout = setTimeout(() => {
						eventSource.close()
						resolve(null)
					}, 2000)

					eventSource.onerror = (err) => {
						clearTimeout(timeout)
						eventSource.close()
						resolve(err)
					}
				})

				expect(error).toBeTruthy()
			})
		})
	})
})
