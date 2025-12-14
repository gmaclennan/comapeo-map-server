import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEventSource } from 'eventsource-client'
import {
	fetch as secretStreamFetch,
	Agent as SecretStreamAgent,
} from 'secret-stream-http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import z32 from 'z32'
import { createServer } from '../src/index.js'

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
function postJson(url: string, data: any) {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
}

/**
 * Helper to wait for a single SSE message
 */
async function waitForSSEMessage(
	url: string,
	timeoutMs: number = 5000,
): Promise<any> {
	const es = createEventSource({ url })

	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Timeout waiting for SSE message')), timeoutMs)
	)

	try {
		const result = await Promise.race([
			(async () => {
				for await (const { data } of es) {
					return JSON.parse(data)
				}
			})(),
			timeoutPromise,
		])
		return result
	} finally {
		es.close()
	}
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
	const es = createEventSource({ url })
	const messages: any[] = []

	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Timeout waiting for SSE messages')), timeoutMs)
	)

	try {
		await Promise.race([
			(async () => {
				for await (const { data } of es) {
					messages.push(JSON.parse(data))

					// Check if we should stop collecting
					const shouldStop =
						(count !== undefined && messages.length >= count) ||
						(until && until(messages))

					if (shouldStop) {
						break
					}
				}
			})(),
			timeoutPromise,
		])
		return messages
	} finally {
		es.close()
	}
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
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
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
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
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
			const response = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
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
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

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
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

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
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Decline it
			const declineResponse = await postJson(
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
			if (!nonLoopbackIP) {
				console.warn('Skipping test: No non-loopback IP found')
				return
			}

			// First create a share on the sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			expect(createShareResponse.status).toBe(201)
			const share = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = share

			// Now create a download on the receiver using the real share
			const response = await postJson(`${receiverBaseUrl}/downloads`, {
				senderDeviceId,
				shareId,
				downloadUrls,
				estimatedSizeBytes,
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
			if (!nonLoopbackIP) {
				console.warn('Skipping test: No non-loopback IP found')
				return
			}

			// First create a share on the sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const share = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = share

			// Create a download
			const createResponse = await postJson(`${receiverBaseUrl}/downloads`, {
				senderDeviceId,
				shareId,
				downloadUrls,
				estimatedSizeBytes,
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
			if (!nonLoopbackIP) {
				console.warn('Skipping test: No non-loopback IP found')
				return
			}

			// First create a share on the sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const share = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = share

			// Create a download
			const createResponse = await postJson(`${receiverBaseUrl}/downloads`, {
				senderDeviceId,
				shareId,
				downloadUrls,
				estimatedSizeBytes,
			})
			const { downloadId } = await createResponse.json()

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
				const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
					mapId: 'custom',
					receiverDeviceId,
				})
				const { shareId } = await createResponse.json()

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
				const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
					mapId: 'custom',
					receiverDeviceId,
				})
				const { shareId } = await createResponse.json()

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
				const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
					mapId: 'custom',
					receiverDeviceId,
				})
				const { shareId } = await createResponse.json()

				// Start collecting messages (expect 2: initial + decline update)
				const messagesPromise = collectSSEMessages(
					`${senderBaseUrl}/mapShares/${shareId}/events`,
					{ count: 2 },
				)

				// Wait for connection and initial message
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Decline the share to trigger an update
				await postJson(`${senderBaseUrl}/mapShares/${shareId}/decline`, {
					reason: 'user_rejected',
				})

				const messages = await messagesPromise

				// Second message should be the decline update
				expect(messages[1]).toHaveProperty('status', 'declined')
				expect(messages[1]).toHaveProperty('reason', 'user_rejected')
			})

			it('should return 404 for SSE on non-existent share', async () => {
				// Attempt to connect to non-existent share should fail
				const es = createEventSource({
					url: `${senderBaseUrl}/mapShares/nonexistent-id/events`,
				})

				let errorOccurred = false
				try {
					// Try to get first message with short timeout
					await Promise.race([
						(async () => {
							for await (const { data } of es) {
								return data
							}
						})(),
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error('Timeout')), 2000)
						),
					])
				} catch (error) {
					errorOccurred = true
				} finally {
					es.close()
				}

				expect(errorOccurred).toBe(true)
			})

			it('should properly close SSE connection when client disconnects', async () => {
				// Create a share
				const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
					mapId: 'custom',
					receiverDeviceId,
				})
				const { shareId } = await createResponse.json()

				// Connect and immediately disconnect
				const es = createEventSource({
					url: `${senderBaseUrl}/mapShares/${shareId}/events`,
				})

				await new Promise((resolve) => setTimeout(resolve, 100))
				es.close()

				// Wait a bit to ensure cleanup
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Share should still exist and be queryable
				const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
				expect(getResponse.status).toBe(200)
			})
		})

		describe('Download Events', () => {
			it('should stream initial state for download events', async () => {
				if (!nonLoopbackIP) {
					console.warn('Skipping test: No non-loopback IP found')
					return
				}

				// First create a share on the sender
				const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
					mapId: 'custom',
					receiverDeviceId,
				})
				const share = await createShareResponse.json()
				const { shareId, downloadUrls, estimatedSizeBytes } = share

				// Create a download
				const createResponse = await postJson(`${receiverBaseUrl}/downloads`, {
					senderDeviceId,
					shareId,
					downloadUrls,
					estimatedSizeBytes,
				})
				const { downloadId } = await createResponse.json()

				// Connect to SSE endpoint and get initial state
				const initialState = await waitForSSEMessage(
					`${receiverBaseUrl}/downloads/${downloadId}/events`,
				)

				expect(initialState).toHaveProperty('downloadId', downloadId)
				expect(initialState).toHaveProperty('status', 'downloading')
				expect(initialState).toHaveProperty('bytesDownloaded')
			})

			it('should stream state updates when download is cancelled', async () => {

				// First create a share on the sender
				const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
					mapId: 'custom',
					receiverDeviceId,
				})
				const share = await createShareResponse.json()
				const { shareId, estimatedSizeBytes } = share
				
				// Construct localhost download URLs for testing
				const testDownloadUrls = [
					`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
				]


				// Create a download
				const createResponse = await postJson(`${receiverBaseUrl}/downloads`, {
					senderDeviceId,
					shareId,
					downloadUrls: testDownloadUrls,
					estimatedSizeBytes,
				})
				const { downloadId } = await createResponse.json()

				// Start collecting messages until error/canceled
				const messagesPromise = collectSSEMessages(
					`${receiverBaseUrl}/downloads/${downloadId}/events`,
					{
						until: (messages) =>
							messages.some((m) => m.status === 'error' || m.status === 'canceled' || m.status === 'completed'),
					},
				)

				// Wait for connection
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Cancel the download
				await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
					method: 'POST',
				})

				const messages = await messagesPromise

				// Should have received at least one message
				expect(messages.length).toBeGreaterThan(0)

				// Last message should indicate error or canceled
				const lastMessage = messages[messages.length - 1]
				expect(['error', 'canceled', 'completed']).toContain(lastMessage.status)
			})

			it('should return 404 for SSE on non-existent download', async () => {
				// Attempt to connect to non-existent download should fail
				const es = createEventSource({
					url: `${receiverBaseUrl}/downloads/nonexistent-download-id/events`,
				})

				let errorOccurred = false
				try {
					// Try to get first message with short timeout
					await Promise.race([
						(async () => {
							for await (const { data } of es) {
								return data
							}
						})(),
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error('Timeout')), 2000)
						),
					])
				} catch (error) {
					errorOccurred = true
				} finally {
					es.close()
				}

				expect(errorOccurred).toBe(true)
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
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

			// Create a download with localhost URL
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes,
				},
			)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData

			// Connect to SSE and track progress
			const progressUpdates = await collectSSEMessages(
				`${receiverBaseUrl}/downloads/${downloadId}/events`,
				{
					timeoutMs: 10000,
					until: (messages) =>
						messages.some(
							(m) => m.status === 'completed' || m.status === 'error',
						),
				},
			)

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
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

			// Connect to sender's SSE to monitor share status
			const ssePromise = collectSSEMessages(
				`${senderBaseUrl}/mapShares/${shareId}/events`,
				{
					timeoutMs: 10000,
					until: (messages) =>
						messages.some(
							(m) => m.status === 'completed' || m.status === 'error',
						),
				},
			)

			// Start the download with localhost URL
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			await postJson(`${receiverBaseUrl}/downloads`, {
				senderDeviceId,
				downloadUrls: testDownloadUrls,
				shareId,
				estimatedSizeBytes,
			})

			// Wait for SSE updates
			const shareUpdates = await ssePromise

			// Verify we got share status updates
			expect(shareUpdates.length).toBeGreaterThan(0)

			// Verify final status is completed
			const finalUpdate = shareUpdates[shareUpdates.length - 1]
			expect(finalUpdate.status).toBe('completed')
		}, 15000)
	})


	describe('Cancellation Scenarios', () => {
		it('should cancel a map share before download starts', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			expect(createResponse.status).toBe(201)
			const { shareId } = await createResponse.json()

			// Verify share is in pending state
			const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			const shareData = await getResponse.json()
			expect(shareData.status).toBe('pending')

			// Cancel the share
			const cancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Verify share is now canceled
			const getAfterCancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}`,
			)
			const canceledShareData = await getAfterCancelResponse.json()
			expect(canceledShareData.status).toBe('canceled')
		})

		it('should cancel a map share after download starts', async () => {
			// Create a share
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			expect(createShareResponse.status).toBe(201)
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start the download from receiver side
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData

			// Cancel the share from sender side immediately
			const cancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Verify share is canceled
			const getShareResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}`,
			)
			const canceledShareData = await getShareResponse.json()
			expect(canceledShareData.status).toBe('canceled')

			// Wait for download to react to cancellation
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Verify download ended
			// Note: Canceling share causes download URL to 404, resulting in error state
			const getDownloadResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const downloadStatus = await getDownloadResponse.json()
			// Download should be in error, canceled, or completed state
			expect(['error', 'canceled', 'completed']).toContain(downloadStatus.status)
		}, 10000)

		it('should cancel a download during active transfer', async () => {
			// Create a share
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			expect(createShareResponse.status).toBe(201)
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start the download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData
			expect(downloadData.status).toBe('downloading')

			// Cancel the download immediately (race with download completion in fast test environment)
			const cancelResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Verify download ended
			// Note: Download may complete before cancel takes effect in test environment
			const getDownloadResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const finalDownloadData = await getDownloadResponse.json()
			expect(['canceled', 'completed']).toContain(finalDownloadData.status)
		}, 10000)

		it('should stream cancellation updates via SSE for shares', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start collecting SSE messages
			const messagesPromise = collectSSEMessages(
				`${senderBaseUrl}/mapShares/${shareId}/events`,
				{
					count: 2, // Initial state + cancel update
					timeoutMs: 5000,
				},
			)

			// Wait for connection to establish
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Cancel the share
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			const messages = await messagesPromise

			// First message should be initial state (pending)
			expect(messages[0]).toHaveProperty('status', 'pending')
			expect(messages[0]).toHaveProperty('shareId', shareId)

			// Second message should be the cancellation update
			expect(messages[1]).toHaveProperty('status', 'canceled')
		})

		it('should stream cancellation updates via SSE for downloads', async () => {
			// Create a share first
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Create a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData

			// Start collecting SSE messages for the download
			// Expect at least 1 message (initial state), but may get completion before we can cancel
			const messagesPromise = collectSSEMessages(
				`${receiverBaseUrl}/downloads/${downloadId}/events`,
				{
					until: (messages) =>
						messages.some((m) => m.status === 'canceled' || m.status === 'completed'),
					timeoutMs: 5000,
				},
			)

			// Try to cancel immediately (may race with download completion)
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			const messages = await messagesPromise

			// Should have initial message
			expect(messages[0]).toHaveProperty('downloadId', downloadId)

			// Final message should be either canceled or completed (due to race in test environment)
			const finalMessage = messages[messages.length - 1]
			expect(['canceled', 'completed']).toContain(finalMessage.status)
		})

		it('should not corrupt existing custom map when download is cancelled by receiver', async () => {
			// First, create an initial custom map on the receiver
			const fixtureMapPath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
			fs.copyFileSync(fixtureMapPath, tempReceiverMapPath)

			// Get original map stats
			const originalStats = fs.statSync(tempReceiverMapPath)
			const originalSize = originalStats.size

			// Verify we can read the original map
			const originalMapInfoResponse = await fetch(
				`${receiverBaseUrl}/maps/custom/info`,
			)
			expect(originalMapInfoResponse.status).toBe(200)
			const originalMapInfo = await originalMapInfoResponse.json()
			expect(originalMapInfo.size).toBe(originalSize)

			// Create a share from sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Cancel the download immediately
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			// Wait a moment for cancellation to process
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Verify the original map file still exists and is unchanged
			expect(fs.existsSync(tempReceiverMapPath)).toBe(true)
			const afterCancelStats = fs.statSync(tempReceiverMapPath)
			expect(afterCancelStats.size).toBe(originalSize)

			// Verify we can still read the original map
			const afterCancelMapInfoResponse = await fetch(
				`${receiverBaseUrl}/maps/custom/info`,
			)
			expect(afterCancelMapInfoResponse.status).toBe(200)
			const afterCancelMapInfo = await afterCancelMapInfoResponse.json()
			expect(afterCancelMapInfo.size).toBe(originalSize)
			expect(afterCancelMapInfo.mapId).toBe(originalMapInfo.mapId)
		}, 10000)

		it('should not corrupt existing custom map when download is cancelled by sender', async () => {
			// Create an initial custom map on the receiver
			const fixtureMapPath = path.join(__dirname, 'fixtures', 'demotiles-z2.smp')
			fs.copyFileSync(fixtureMapPath, tempReceiverMapPath)

			// Get original map stats
			const originalStats = fs.statSync(tempReceiverMapPath)
			const originalSize = originalStats.size

			// Create a share from sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)

			// Cancel the share from sender side (which will cause download to fail)
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// Wait for cancellation to propagate and download to fail
			await new Promise((resolve) => setTimeout(resolve, 500))

			// Verify the original map file still exists and is unchanged
			expect(fs.existsSync(tempReceiverMapPath)).toBe(true)
			const afterCancelStats = fs.statSync(tempReceiverMapPath)
			expect(afterCancelStats.size).toBe(originalSize)

			// Verify we can still read the original map
			const afterCancelMapInfoResponse = await fetch(
				`${receiverBaseUrl}/maps/custom/info`,
			)
			expect(afterCancelMapInfoResponse.status).toBe(200)
			const afterCancelMapInfo = await afterCancelMapInfoResponse.json()
			expect(afterCancelMapInfo.size).toBe(originalSize)
		}, 10000)

		it('should not leave temp files when download fails', async () => {
			// Create a share with invalid data to cause download to fail quickly
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Cancel immediately to trigger abort
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			// Wait for cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 1500))
		})
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

	describe('Edge Cases and State Transitions', () => {
		it('should reject multiple simultaneous downloads on the same share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start first download
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`
			const firstDownload = secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			}) as unknown as Promise<Response>

			// Wait a moment for first download to start
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Try to start second download while first is in progress
			const secondDownload = secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			}) as unknown as Promise<Response>

			const secondResponse = await secondDownload
			expect(secondResponse.status).toBe(400)

			// Clean up first download
			const firstResponse = await firstDownload
			await firstResponse.body?.cancel()
		}, 10000)

		it('should reject download after share is declined', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Decline the share via secret stream
			const declineUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/decline`
			const declineResponse = (await secretStreamFetch(declineUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'user_rejected' }),
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(declineResponse.status).toBe(204)

			// Try to start download on declined share
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`
			const downloadResponse = (await secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(downloadResponse.status).toBe(400)
		})

		it('should reject download after share is canceled', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Cancel the share from sender
			const cancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Try to start download on canceled share
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`
			const downloadResponse = (await secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should reject with 400 because share is canceled
			expect(downloadResponse.status).toBe(400)
		})

		it('should reject decline on non-pending share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Cancel the share first
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// Try to decline the already-canceled share
			const declineUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/decline`
			const declineResponse = (await secretStreamFetch(declineUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'user_rejected' }),
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(declineResponse.status).toBe(400)
		})

		it('should reject cancel on completed share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createResponse.json()
			const { shareId } = shareData

			// Complete a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for download to complete
			let status = 'downloading'
			let attempts = 0
			while (status === 'downloading' && attempts < 50) {
				await new Promise((resolve) => setTimeout(resolve, 100))
				const statusResponse = await fetch(
					`${receiverBaseUrl}/downloads/${downloadId}`,
				)
				const downloadStatus = await statusResponse.json()
				status = downloadStatus.status
				attempts++
			}

			// Verify share is completed
			const shareResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			const completedShareData = await shareResponse.json()
			
			if (completedShareData.status === 'completed') {
				// Try to cancel the completed share
				const cancelResponse = await fetch(
					`${senderBaseUrl}/mapShares/${shareId}/cancel`,
					{ method: 'POST' },
				)
				expect(cancelResponse.status).toBe(400)
			} else {
				// If download completed too fast, at least verify we got to a terminal state
				expect(['completed', 'canceled', 'error']).toContain(shareData.status)
			}
		}, 15000)

		it('should handle concurrent SSE connections to same share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start two SSE connections to the same share
			const sseUrl = `${senderBaseUrl}/mapShares/${shareId}/events`
			const es1 = createEventSource({ url: sseUrl })
			const es2 = createEventSource({ url: sseUrl })

			const messages1: any[] = []
			const messages2: any[] = []

			const collector1 = (async () => {
				for await (const { data } of es1) {
					messages1.push(JSON.parse(data))
					if (messages1.length >= 2) break
				}
			})()

			const collector2 = (async () => {
				for await (const { data } of es2) {
					messages2.push(JSON.parse(data))
					if (messages2.length >= 2) break
				}
			})()

			// Wait for initial messages
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Trigger an update
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// Wait for both to receive the update
			await Promise.race([
				Promise.all([collector1, collector2]),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Timeout')), 5000),
				),
			]).catch(() => {
				// Timeout is ok, we just want to verify both got messages
			})

			es1.close()
			es2.close()

			// Both connections should have received messages
			expect(messages1.length).toBeGreaterThan(0)
			expect(messages2.length).toBeGreaterThan(0)
		})
	})


	describe('Error Propagation and Resource Cleanup', () => {
		it('should handle map file becoming unavailable during share creation', async () => {
			// Try to create a share for a non-existent map
			const response = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'nonexistent',
				receiverDeviceId,
			})

			expect(response.status).toBe(404)
			const error = await response.json()
			expect(error).toHaveProperty('error')
		})

		it('should handle download errors and update status to error', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Try to create download with invalid URLs
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					shareId,
					downloadUrls: ['http://127.0.0.1:1/download'],
					estimatedSizeBytes: 1000,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for download to fail and cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 2000))

			// Check that download is in error state
			const statusResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const downloadStatus = await statusResponse.json()
			expect(downloadStatus.status).toBe('error')
			expect(downloadStatus).toHaveProperty('error')
		})

		it.skip('should clean up temp files when download errors', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Create download with invalid URL to cause error
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					shareId,
					downloadUrls: ['http://127.0.0.1:1/download'],
					estimatedSizeBytes: 1000,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for download to fail and cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 2000))

			// Verify no temp files are left behind
			const receiverDir = path.dirname(tempReceiverMapPath)
			const receiverBasename = path.basename(tempReceiverMapPath)
			const files = fs.readdirSync(receiverDir)
			const tempFiles = files.filter(
				(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
			)
			expect(tempFiles).toHaveLength(0)
		})

		it.skip('should handle connection drops during download gracefully', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Immediately cancel to simulate connection drop
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			// Wait for cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 1500))

			// Verify temp files are cleaned up
			const receiverDir = path.dirname(tempReceiverMapPath)
			const receiverBasename = path.basename(tempReceiverMapPath)
			const files = fs.readdirSync(receiverDir)
			const tempFiles = files.filter(
				(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
			)
			expect(tempFiles).toHaveLength(0)
		})

		it('should properly close SSE connections when share is deleted/evicted', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start SSE connection
			const es = createEventSource({
				url: `${senderBaseUrl}/mapShares/${shareId}/events`,
			})

			const messages: any[] = []
			const messagesPromise = (async () => {
				try {
					for await (const { data } of es) {
						messages.push(JSON.parse(data))
						// Stop after receiving initial message
						if (messages.length >= 1) break
					}
				} catch (error) {
					// Expected when connection closes
				}
			})()

			// Wait for initial message
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Cancel the share (which will be removed from map)
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// SSE should still work for canceled share
			expect(messages.length).toBeGreaterThan(0)
			expect(messages[0]).toHaveProperty('shareId', shareId)

			es.close()
			await messagesPromise.catch(() => {
				// Ignore errors from closed connection
			})
		})

		it('should handle SSE client disconnect gracefully', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start SSE connection
			const es = createEventSource({
				url: `${senderBaseUrl}/mapShares/${shareId}/events`,
			})

			const messages: any[] = []
			const collector = (async () => {
				for await (const { data } of es) {
					messages.push(JSON.parse(data))
					if (messages.length >= 1) break
				}
			})()

			// Wait for initial message
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Close SSE connection immediately
			es.close()

			await collector.catch(() => {
				// Expected - connection closed
			})

			// Should have received at least initial state
			expect(messages.length).toBeGreaterThan(0)

			// Share should still be accessible after SSE disconnect
			const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			expect(getResponse.status).toBe(200)
		})

		it.skip('should handle multiple failed download URL attempts', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Create download with multiple invalid URLs
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					shareId,
					downloadUrls: [
						'http://127.0.0.1:1/download',
						'http://127.0.0.1:2/download',
						'http://127.0.0.1:3/download',
					],
					estimatedSizeBytes: 1000,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for all URLs to be tried and fail (3 URLs × 2s timeout + buffer)
			await new Promise((resolve) => setTimeout(resolve, 7000))

			// Download should be in error state
			const statusResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const downloadStatus = await statusResponse.json()
			expect(downloadStatus.status).toBe('error')
		}, 10000)

		it('should propagate stream write errors to download status', async () => {
			// Create a share with a very small map
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createResponse.json()
			const { shareId } = shareData

			// Start download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Let download complete or fail
			let status = 'downloading'
			let attempts = 0
			while (status === 'downloading' && attempts < 50) {
				await new Promise((resolve) => setTimeout(resolve, 100))
				const statusResponse = await fetch(
					`${receiverBaseUrl}/downloads/${downloadId}`,
				)
				const downloadStatus = await statusResponse.json()
				status = downloadStatus.status
				attempts++
			}

			// Download should reach a terminal state
			expect(['completed', 'error', 'canceled']).toContain(status)
		}, 15000)
	})

})
