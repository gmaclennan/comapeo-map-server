import assert from 'node:assert'
import { once } from 'node:events'
import http from 'node:http'
import { type AddressInfo } from 'node:net'

import { createServerAdapter } from '@whatwg-node/server'
import pDefer from 'p-defer'
import { createServer as createSecretStreamServer } from 'secret-stream-http'
import z32 from 'z32'

import { Context } from './context.js'
import { RootRouter } from './routes/root.js'
import type { FetchContext } from './types.js'

export type ServerOptions = {
	defaultOnlineStyleUrl: string
	customMapPath: string
	fallbackMapPath: string
	keyPair: {
		publicKey: Uint8Array
		secretKey: Uint8Array
	}
}

export type ListenOptions = {
	localPort?: number
	remotePort?: number
}

type ListenResult = {
	localPort: number
	remotePort: number
}

export function createServer(options: ServerOptions) {
	// Validate required parameters
	assert(
		options.defaultOnlineStyleUrl,
		new TypeError('defaultOnlineStyleUrl is required'),
	)
	assert(options.customMapPath, new TypeError('customMapPath is required'))
	assert(options.fallbackMapPath, new TypeError('fallbackMapPath is required'))

	// Validate keyPair
	assert(
		options.keyPair && typeof options.keyPair === 'object',
		new TypeError('keyPair is required and must be an object'),
	)
	assert(
		options.keyPair.publicKey instanceof Uint8Array,
		new TypeError('keyPair.publicKey must be a Uint8Array'),
	)
	assert(
		options.keyPair.secretKey instanceof Uint8Array,
		new TypeError('keyPair.secretKey must be a Uint8Array'),
	)

	// Support both 32-byte (Noise XX) and 64-byte (Hypercore/secret-stream) keys
	const validKeySizes = [32, 64]
	assert(
		validKeySizes.includes(options.keyPair.publicKey.length),
		new TypeError(
			`keyPair.publicKey must be 32 or 64 bytes, got ${options.keyPair.publicKey.length}`,
		),
	)
	assert(
		validKeySizes.includes(options.keyPair.secretKey.length),
		new TypeError(
			`keyPair.secretKey must be 32 or 64 bytes, got ${options.keyPair.secretKey.length}`,
		),
	)

	const deferredListen = pDefer<ListenResult>()
	const context = new Context({
		...options,
		getRemotePort: async () => {
			const listenOptions = await deferredListen.promise
			return listenOptions.remotePort
		},
	})
	const router = RootRouter({ base: '/' }, context)
	const serverAdapter = createServerAdapter<FetchContext>((request, context) =>
		router.fetch(request, context),
	)
	// Use requestListener instead of handleNodeRequestAndResponse
	// requestListener actually sends the response, handleNodeRequestAndResponse only returns it
	const localHttpServer = http.createServer((req, res) => {
		serverAdapter.requestListener(req, res, { isLocalhost: true })
	})
	const remoteHttpServer = http.createServer((req, res) => {
		serverAdapter.requestListener(req, res, {
			isLocalhost: false,
			// @ts-expect-error - the types for this are too hard and making them work would not add any type safety.
			remoteDeviceId: req.socket.remotePublicKey
				? z32.encode(req.socket.remotePublicKey)
				: undefined,
		})
	})
	const secretStreamServer = createSecretStreamServer(remoteHttpServer, {
		keyPair: options.keyPair,
	})

	return {
		async listen(opts: ListenOptions = {}) {
			localHttpServer.listen(opts.localPort, '127.0.0.1')
			secretStreamServer.listen(opts.remotePort, '0.0.0.0')
			await Promise.all([
				once(localHttpServer, 'listening'),
				once(secretStreamServer, 'listening'),
			])
			const localPort = (localHttpServer.address() as AddressInfo).port
			const remotePort = (secretStreamServer.address() as AddressInfo).port
			deferredListen.resolve({ localPort, remotePort })
			return { localPort, remotePort }
		},
	}
}
