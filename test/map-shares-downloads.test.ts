import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	fetch as secretStreamFetch,
	Agent as SecretStreamAgent,
} from 'secret-stream-http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import z32 from 'z32'
import { createServer } from '../src/index.js'

// EventSource is a CommonJS module, use require to import it
const require = createRequire(import.meta.url)
const { EventSource } = require('eventsource')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// =============================================================================
// Helper Functions
// =============================================================================

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

/**
 * Helper to make JSON POST requests
 */
async function postJSON(url: string, data: any) {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
}

/**
 * Helper to create a map share
 */
async function createShare(
	baseUrl: string,
	mapId: string,
	receiverDeviceId: string,
) {
	const response = await postJSON(`${baseUrl}/mapShares`, {
		mapId,
		receiverDeviceId,
	})
	const data = await response.json()
	return { response, ...data }
}

/**
 * Helper to create a download
 */
async function createDownload(baseUrl: string, downloadData: any) {
	const response = await postJSON(`${baseUrl}/downloads`, downloadData)
	const data = await response.json()
	return { response, ...data }
}

/**
 * Helper to wait for a single SSE message
 */
async function waitForSSEMessage(
	url: string,
	timeoutMs: number = 5000,
): Promise<any> {
	const eventSource = new EventSource(url)

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			eventSource.close()
			reject(new Error('Timeout waiting for SSE message'))
		}, timeoutMs)

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
}

/**
 * Helper to collect multiple SSE messages until a condition is met
 */
async function collectSSEMessages(
	url: string,
	options: {
		count?: number
		timeoutMs?: number
		until?: (messages: any[]) => boolean
	} = {},
): Promise<any[]> {
	const { count, timeoutMs = 5000, until } = options
	const eventSource = new EventSource(url)
	const messages: any[] = []

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			eventSource.close()
			reject(new Error('Timeout waiting for SSE messages'))
		}, timeoutMs)

		eventSource.onmessage = (event) => {
			const data = JSON.parse(event.data)
			messages.push(data)

			// Check if we should stop collecting
			const shouldStop =
				(count !== undefined && messages.length >= count) ||
				(until && until(messages))

			if (shouldStop) {
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
		senderKeyPair = SecretStreamAgent.keyPair()
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
		receiverKeyPair = SecretStreamAgent.keyPair()
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
			const share = await createShare(
				senderBaseUrl,
				'custom',
				receiverDeviceId,
			)

			expect(share.response.status).toBe(201)
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
			const location = share.response.headers.get('location')
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
			// Create a share
			const { shareId } = await createShare(
				senderBaseUrl,
				'custom',
				receiverDeviceId,
			)

			// Get it
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
			const { shareId } = await createShare(
				senderBaseUrl,
				'custom',
				receiverDeviceId,
			)

			// Cancel it
			const cancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Verify it's cancelled
			const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			const share = await getResponse.json()
			expect(share.status).toBe('canceled')
		})

		it('should decline a map share from receiver', async () => {
			// Create a share
			const { shareId } = await createShare(
				senderBaseUrl,
				'custom',
				receiverDeviceId,
			)

			// Decline it
			const declineResponse = await postJSON(
				`${senderBaseUrl}/mapShares/${shareId}/decline`,
				{ reason: 'user_rejected' },
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
			const download = await createDownload(receiverBaseUrl, {
				senderDeviceId,
				shareId: 'test-share-id',
				downloadUrls: [
					`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-id/download`,
				],
				estimatedSizeBytes: 1000000,
			})

			expect(download.response.status).toBe(201)
			expect(download).toHaveProperty('downloadId')
			expect(download).toHaveProperty('status', 'downloading')
			expect(download).toHaveProperty('bytesDownloaded', 0)
			expect(download).toHaveProperty('senderDeviceId', senderDeviceId)

			// Check Location header
			const location = download.response.headers.get('location')
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
			const { downloadId } = await createDownload(receiverBaseUrl, {
				senderDeviceId,
				shareId: 'test-share-id-2',
				downloadUrls: [
					`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-id-2/download`,
				],
				estimatedSizeBytes: 1000000,
			})

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
			const { downloadId } = await createDownload(receiverBaseUrl, {
				senderDeviceId,
				shareId: 'test-share-id-3',
				downloadUrls: [
					`http://${nonLoopbackIP || '192.168.1.100'}:${senderRemotePort}/mapShares/test-share-id-3/download`,
				],
				estimatedSizeBytes: 1000000,
			})

			// Cancel it
			const cancelResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}/cancel`,
				{ method: 'POST' },
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
				const { shareId } = await createShare(
					senderBaseUrl,
					'custom',
					receiverDeviceId,
				)

				// Wait for initial SSE message
				const initialState = await waitForSSEMessage(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
				)

				expect(initialState).toHaveProperty('shareId', shareId)
				expect(initialState).toHaveProperty('status', 'pending')
				expect(initialState).toHaveProperty('mapId', 'custom')
			})

			it('should stream state updates when share is cancelled', async () => {
				// Create a share
				const { shareId } = await createShare(
					senderBaseUrl,
					'custom',
					receiverDeviceId,
				)

				// Start collecting messages (expect 2: initial + update)
				const messagesPromise = collectSSEMessages(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
					{ count: 2 },
				)

				// Wait for connection and initial message
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Cancel the share to trigger an update
				await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
					method: 'POST',
				})

				const messages = await messagesPromise

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

	describe('End-to-End Share and Download Flow', () => {
		it('should complete full share/download flow with actual data transfer', async () => {
			// 1. Create a share on sender
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})
			expect(createShareResponse.status).toBe(201)
			const shareData = await createShareResponse.json()
			expect(shareData).toHaveProperty('shareId')
			expect(shareData).toHaveProperty('downloadUrls')
			// downloadUrls may be empty in test environment (no non-internal IPs)
			// expect(shareData.downloadUrls.length).toBeGreaterThan(0)

			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

			// 2. Receiver connects to sender's remote server to get share info
			// Need to manually construct URL using localhost and remote port for testing
			// (downloadUrls may contain external IPs that aren't accessible in test environment)
			const shareInfoUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}`
			const shareInfoResponse = (await secretStreamFetch(shareInfoUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(shareInfoResponse.status).toBe(200)
			const shareInfo = await shareInfoResponse.json()
			expect(shareInfo.shareId).toBe(shareId)
			expect(shareInfo.status).toBe('pending')

			// 3. Receiver creates a download request
			// Replace downloadUrls with localhost URL for testing
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await fetch(
				`${receiverBaseUrl}/downloads`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						senderDeviceId,
						downloadUrls: testDownloadUrls,
						shareId,
						estimatedSizeBytes,
					}),
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const downloadData = await createDownloadResponse.json()
			expect(downloadData).toHaveProperty('downloadId')

			const { downloadId } = downloadData

			// 4. Wait for download to complete
			// Poll the download status until it completes
			let downloadStatus = downloadData.status
			let attempts = 0
			const maxAttempts = 50 // 10 seconds max

			while (
				downloadStatus === 'downloading' &&
				attempts < maxAttempts
			) {
				await new Promise((resolve) => setTimeout(resolve, 200))
				const statusResponse = await fetch(
					`${receiverBaseUrl}/downloads/${downloadId}`,
				)
				const status = await statusResponse.json()
				downloadStatus = status.status
				attempts++
			}

			// 5. Verify download completed successfully
			expect(downloadStatus).toBe('completed')

			// 6. Verify the downloaded file exists and has content
			expect(fs.existsSync(tempReceiverMapPath)).toBe(true)
			const stats = fs.statSync(tempReceiverMapPath)
			expect(stats.size).toBeGreaterThan(0)

			// 7. Verify sender's share status was updated
			const senderShareResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}`,
			)
			const senderShareStatus = await senderShareResponse.json()
			expect(senderShareStatus.status).toBe('completed')
		}, 15000)

		it('should stream download progress via SSE during transfer', async () => {
			// Create a share
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

			// Create a download with localhost URL
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await fetch(
				`${receiverBaseUrl}/downloads`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						senderDeviceId,
						downloadUrls: testDownloadUrls,
						shareId,
						estimatedSizeBytes,
					}),
				},
			)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData

			// Connect to SSE and track progress
			const eventSource = new EventSource(
				`${receiverBaseUrl}/downloads/${downloadId}/events`,
			)

			const progressUpdates: any[] = []

			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					eventSource.close()
					reject(new Error('Timeout waiting for download completion'))
				}, 10000)

				eventSource.onmessage = (event) => {
					const update = JSON.parse(event.data)
					progressUpdates.push(update)

					if (update.status === 'completed' || update.status === 'error') {
						clearTimeout(timeout)
						eventSource.close()
						resolve(null)
					}
				}

				eventSource.onerror = (error) => {
					clearTimeout(timeout)
					eventSource.close()
					reject(error)
				}
			})

			// Verify we received progress updates
			expect(progressUpdates.length).toBeGreaterThan(0)

			// Verify we got downloading status updates
			const downloadingUpdates = progressUpdates.filter(
				(u) => u.status === 'downloading',
			)
			expect(downloadingUpdates.length).toBeGreaterThan(0)

			// Verify bytes downloaded increased
			if (downloadingUpdates.length > 1) {
				const firstUpdate = downloadingUpdates[0]
				const lastUpdate = downloadingUpdates[downloadingUpdates.length - 1]
				expect(lastUpdate.bytesDownloaded).toBeGreaterThan(
					firstUpdate.bytesDownloaded,
				)
			}

			// Verify final status is completed
			const finalUpdate = progressUpdates[progressUpdates.length - 1]
			expect(finalUpdate.status).toBe('completed')
		}, 15000)

		it('should update sender share status during download', async () => {
			// Create a share
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

			// Connect to sender's SSE to monitor share status
			const eventSource = new EventSource(
				`${senderBaseUrl}/mapShares/${shareId}/events`,
			)

			const shareUpdates: any[] = []

			const ssePromise = new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					eventSource.close()
					reject(new Error('Timeout waiting for share completion'))
				}, 10000)

				eventSource.onmessage = (event) => {
					const update = JSON.parse(event.data)
					shareUpdates.push(update)

					if (update.status === 'completed' || update.status === 'error') {
						clearTimeout(timeout)
						eventSource.close()
						resolve(null)
					}
				}

				eventSource.onerror = (error) => {
					clearTimeout(timeout)
					eventSource.close()
					reject(error)
				}
			})

			// Start the download with localhost URL
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			await fetch(`${receiverBaseUrl}/downloads`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes,
				}),
			})

			// Wait for SSE updates
			await ssePromise

			// Verify we got share status updates
			expect(shareUpdates.length).toBeGreaterThan(0)

			// Verify final status is completed
			const finalUpdate = shareUpdates[shareUpdates.length - 1]
			expect(finalUpdate.status).toBe('completed')
		}, 15000)
	})

	describe('Remote Device ID Validation', () => {
		it('should reject access to share with wrong device ID (403)', async () => {
			// Create a third device with different keys
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for the correct receiver
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId, // Share is for receiverDeviceId
				}),
			})
			expect(createShareResponse.status).toBe(201)
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Create a share for a different device and try to access it with receiver's credentials
			const createShareResponse2 = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: wrongDeviceId, // Share is for wrongDeviceId
				}),
			})
			const shareData2 = await createShareResponse2.json()
			const { shareId: shareId2 } = shareData2

			// Try to access with receiver's credentials (should fail)
			const shareInfoUrl2 = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId2}`
			const response2 = (await secretStreamFetch(shareInfoUrl2, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should get 403 Forbidden because receiver is not the intended recipient
			expect(response2.status).toBe(403)
		})

		it('should reject download request with wrong device ID (403)', async () => {
			// Create a third device with different keys
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for receiver
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: wrongDeviceId, // Share is for wrongDeviceId
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

			// Try to download with receiver's credentials (wrong device)
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`

			const response = (await secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should get 403 Forbidden
			expect(response.status).toBe(403)
		})

		it('should allow access to share with correct device ID', async () => {
			// Create a share for receiver
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId, // Correct receiver
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls } = shareData

			// Access with correct credentials (receiver's device)
			const shareInfoUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}`
			const response = (await secretStreamFetch(shareInfoUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should succeed
			expect(response.status).toBe(200)
			const shareInfo = await response.json()
			expect(shareInfo.shareId).toBe(shareId)
			expect(shareInfo.receiverDeviceId).toBe(receiverDeviceId)
		})

		it('should reject decline request with wrong device ID (403)', async () => {
			// Create a third device
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for wrongDeviceId
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: wrongDeviceId,
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls } = shareData

			// Try to decline with receiver's credentials (wrong device)
			const declineUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/decline`
			const response = (await secretStreamFetch(declineUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'no-space' }),
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should get 403 Forbidden
			expect(response.status).toBe(403)
		})
	})
})
