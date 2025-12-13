# @comapeo/map-server

An embedded HTTP server for peer-to-peer (P2P) map sharing on local networks. Designed to run within applications to enable encrypted, direct device-to-device transfer of offline map data.

## Architecture

The server runs two HTTP servers simultaneously:

1. **Local Server** (localhost only) - Provides a control API for the embedding application
2. **Remote Server** (network accessible) - Enables P2P communication with other devices using encrypted connections

```
┌─────────────────────────────────────────────────────────────────┐
│                       Application Process                        │
│                                                                   │
│  ┌────────────────┐                    ┌─────────────────────┐  │
│  │ Local Server   │                    │  Remote Server      │  │
│  │ (127.0.0.1)    │                    │  (0.0.0.0)          │  │
│  │                │                    │                     │  │
│  │ Control API    │                    │  P2P API            │  │
│  │ - Create share │                    │  - Download maps    │  │
│  │ - Start download│                   │  - Decline shares   │  │
│  │ - Monitor status│                   │  (Encrypted)        │  │
│  └────────────────┘                    └─────────────────────┘  │
│         ↑                                       ↑                │
└─────────┼───────────────────────────────────────┼────────────────┘
          │                                       │
    Your App Code                          Other Devices
                                           (via secret-stream)
```

### Security Model

- **Local API**: Only accessible from localhost (127.0.0.1)
- **Remote API**: Uses [secret-stream-http](https://github.com/holepunchto/secret-stream-http) for end-to-end encrypted connections
- **Device Authentication**: Each device has a keypair; remote access is validated against the intended receiver's device ID
- **Share-specific Access**: Each map share is tied to a specific receiver device ID

## Installation

```bash
npm install @comapeo/map-server
```

## Usage

### Creating a Server

```javascript
import { createServer } from '@comapeo/map-server'
import Hypercore from 'hypercore'

// Generate a keypair for this device (you should persist this)
const keyPair = Hypercore.keyPair()

const server = createServer({
	// URL for online map tiles (fallback when no custom map is available)
	defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',

	// Path to the custom map file (styled-map-package format)
	customMapPath: 'file:///path/to/custom-map.smp',

	// Path to the fallback offline map
	fallbackMapPath: 'file:///path/to/fallback-map.smp',

	// Device keypair for encrypted P2P connections
	keyPair: {
		publicKey: keyPair.publicKey,
		secretKey: keyPair.secretKey,
	},
})

// Start both servers
const { localPort, remotePort } = await server.listen({
	localPort: 8080, // Optional: specify local API port
	remotePort: 9090, // Optional: specify P2P port
})

console.log(`Local API: http://127.0.0.1:${localPort}`)
console.log(`P2P Server: listening on port ${remotePort}`)
```

## API Reference

### Local API (Localhost Only)

Base URL: `http://127.0.0.1:{localPort}`

#### Maps

##### Get Map Info

```http
GET /maps/{mapId}/info
```

Returns metadata about a map.

**Response:**

```json
{
	"name": "Custom Map",
	"size": 12345678,
	"created": 1234567890123
}
```

##### Upload Custom Map

```http
PUT /maps/custom
Content-Type: application/octet-stream

[binary map data]
```

Uploads a new custom map (styled-map-package format).

##### Serve Map Tiles

```http
GET /maps/{mapId}/{z}/{x}/{y}.{format}
GET /maps/{mapId}/style.json
```

Standard map tile and style endpoints. The `default` map ID provides intelligent fallback:

1. Try custom map
2. Try online style
3. Fall back to bundled offline map

#### Map Shares

##### Create Map Share

```http
POST /mapShares
Content-Type: application/json

{
  "mapId": "custom",
  "receiverDeviceId": "z32-encoded-public-key-of-receiver"
}
```

Creates a new map share offer for a specific device.

**Response (201):**

```json
{
	"shareId": "abc123...",
	"receiverDeviceId": "kmx8sejfn...",
	"mapId": "custom",
	"mapName": "My Custom Map",
	"downloadUrls": [
		"http://192.168.1.100:9090/mapShares/abc123.../download",
		"http://10.0.0.5:9090/mapShares/abc123.../download"
	],
	"bounds": [-122.5, 37.5, -122.0, 38.0],
	"minzoom": 0,
	"maxzoom": 14,
	"estimatedSizeBytes": 12345678,
	"status": "pending"
}
```

##### List Map Shares

```http
GET /mapShares
```

Returns array of all active map shares.

##### Get Map Share Status

```http
GET /mapShares/{shareId}
```

Returns current state of a specific share.

##### Monitor Share Events (SSE)

```http
GET /mapShares/{shareId}/events
Accept: text/event-stream
```

Server-Sent Events stream for real-time status updates.

**Event data:**

```json
{
  "shareId": "abc123...",
  "status": "downloading",
  "bytesDownloaded": 1234567,
  ...
}
```

**Possible statuses:**

- `pending` - Awaiting response from receiver
- `downloading` - Receiver is downloading
- `completed` - Download finished
- `declined` - Receiver declined (includes `reason`)
- `canceled` - Sender canceled
- `error` - Error occurred (includes `error`)

##### Cancel Map Share

```http
POST /mapShares/{shareId}/cancel
```

Cancels an active share. Returns 204 No Content.

#### Downloads

##### Start Download

```http
POST /downloads
Content-Type: application/json

{
  "senderDeviceId": "z32-encoded-public-key-of-sender",
  "shareId": "abc123...",
  "downloadUrls": [
    "http://192.168.1.100:9090/mapShares/abc123.../download"
  ],
  "estimatedSizeBytes": 12345678
}
```

Starts downloading a map from a sender.

**Response (201):**

```json
{
	"downloadId": "xyz789...",
	"senderDeviceId": "kmx8sejfn...",
	"shareId": "abc123...",
	"status": "downloading",
	"bytesDownloaded": 0,
	"estimatedSizeBytes": 12345678
}
```

##### List Downloads

```http
GET /downloads
```

Returns array of all downloads.

##### Get Download Status

```http
GET /downloads/{downloadId}
```

Returns current state of a specific download.

##### Monitor Download Events (SSE)

```http
GET /downloads/{downloadId}/events
Accept: text/event-stream
```

Server-Sent Events stream for real-time download progress.

##### Cancel Download

```http
POST /downloads/{downloadId}/cancel
```

Cancels an active download. Returns 204 No Content.

### Remote API (P2P Network)

These endpoints are accessed by other devices over the encrypted P2P connection. They require the requesting device's public key to match the `receiverDeviceId` of the share.

##### Get Map Share

```http
GET /mapShares/{shareId}
```

Allows receiver to view share details.

##### Download Map Data

```http
GET /mapShares/{shareId}/download
```

Streams the map file to the receiver. This is the URL provided in `downloadUrls`.

##### Decline Map Share

```http
POST /mapShares/{shareId}/decline
Content-Type: application/json

{
  "reason": "disk_full" | "user_rejected" | "other reason"
}
```

Receiver declines the map share.

## Example: Sharing a Map Between Two Devices

### Device A (Sender)

```javascript
import { createServer } from '@comapeo/map-server'
import Hypercore from 'hypercore'
import z32 from 'z32'

// Device A's keypair
const deviceAKeyPair = Hypercore.keyPair()
const deviceAId = z32.encode(deviceAKeyPair.publicKey)

// Start server
const serverA = createServer({
	defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
	customMapPath: 'file:///maps/my-map.smp',
	fallbackMapPath: 'file:///maps/fallback.smp',
	keyPair: deviceAKeyPair,
})

const { localPort: localA } = await serverA.listen()

// Device B's public key (received via your app's discovery mechanism)
const deviceBId = 'kmx8sejfn...' // z32-encoded public key

// Create a share for Device B
const shareResponse = await fetch(`http://127.0.0.1:${localA}/mapShares`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		mapId: 'custom',
		receiverDeviceId: deviceBId,
	}),
})

const share = await shareResponse.json()
console.log('Share created:', share.shareId)
console.log('Download URLs:', share.downloadUrls)

// Send share details to Device B via your app's messaging system
await yourApp.sendMessage(deviceBId, {
	type: 'map-share-offer',
	share,
})

// Monitor share progress
const eventSource = new EventSource(
	`http://127.0.0.1:${localA}/mapShares/${share.shareId}/events`,
)

eventSource.onmessage = (event) => {
	const state = JSON.parse(event.data)
	console.log('Share status:', state.status)

	if (state.status === 'downloading') {
		const progress = (state.bytesDownloaded / state.estimatedSizeBytes) * 100
		console.log(`Download progress: ${progress.toFixed(1)}%`)
	}

	if (state.status === 'completed') {
		console.log('Download completed!')
		eventSource.close()
	}
}
```

### Device B (Receiver)

```javascript
import { createServer } from '@comapeo/map-server'
import Hypercore from 'hypercore'
import z32 from 'z32'

// Device B's keypair
const deviceBKeyPair = Hypercore.keyPair()
const deviceBId = z32.encode(deviceBKeyPair.publicKey)

// Start server
const serverB = createServer({
	defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
	customMapPath: 'file:///maps/my-map.smp',
	fallbackMapPath: 'file:///maps/fallback.smp',
	keyPair: deviceBKeyPair,
})

const { localPort: localB } = await serverB.listen()

// Receive share offer from Device A (via your app's messaging)
yourApp.onMessage(async (message) => {
	if (message.type === 'map-share-offer') {
		const { share } = message

		// Ask user if they want to accept
		const userAccepts = await showUserPrompt(
			`Accept map "${share.mapName}"? (${formatBytes(share.estimatedSizeBytes)})`,
		)

		if (!userAccepts) {
			// Decline the share
			await fetch(`${share.downloadUrls[0].replace('/download', '/decline')}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'user_rejected' }),
			})
			return
		}

		// Start download
		const downloadResponse = await fetch(
			`http://127.0.0.1:${localB}/downloads`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					senderDeviceId: z32.encode(share.downloadUrls[0]), // Extract from share
					shareId: share.shareId,
					downloadUrls: share.downloadUrls,
					estimatedSizeBytes: share.estimatedSizeBytes,
				}),
			},
		)

		const download = await downloadResponse.json()
		console.log('Download started:', download.downloadId)

		// Monitor download progress
		const eventSource = new EventSource(
			`http://127.0.0.1:${localB}/downloads/${download.downloadId}/events`,
		)

		eventSource.onmessage = (event) => {
			const state = JSON.parse(event.data)

			if (state.status === 'downloading') {
				const progress =
					(state.bytesDownloaded / state.estimatedSizeBytes) * 100
				updateProgressBar(progress)
			}

			if (state.status === 'completed') {
				console.log('Map downloaded successfully!')
				eventSource.close()

				// Map is now available at /maps/custom/
			}

			if (state.status === 'error') {
				console.error('Download failed:', state.error)
				eventSource.close()
			}
		}
	}
})
```

## Network Discovery

This library does not handle network discovery or peer finding. You'll need to implement that separately using technologies like:

- **mDNS/Bonjour** - For local network discovery
- **Hyperswarm** - For DHT-based peer discovery
- **Manual IP entry** - Let users manually enter IP addresses

The sender provides `downloadUrls` with all their local IP addresses, and the receiver will try each one until a connection succeeds.

## Map Format

Maps must be in the [styled-map-package](https://github.com/digidem/styled-map-package) format, which is a single-file package containing:

- Vector tiles
- Sprites
- Fonts
- MapLibre GL style definition

## License

MIT
