import { once } from 'node:events'
import http from 'node:http'
import { type AddressInfo } from 'node:net'

import { createServerAdapter } from '@whatwg-node/server'
import pDefer from 'p-defer'
import { createServer as createSecretStreamServer } from 'secret-stream-http'

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

export function createServer({ keyPair, ...contextOptions }: ServerOptions) {
	const deferredListen = pDefer<ListenResult>()
	const context = new Context({
		...contextOptions,
		getRemotePort: async () => {
			const listenOptions = await deferredListen.promise
			return listenOptions.remotePort
		},
	})
	const router = RootRouter({ base: '/' }, context)
	const serverAdapter = createServerAdapter<FetchContext>((request, context) =>
		router.fetch(request, context),
	)
	const localHttpServer = http.createServer(async (req, res) => {
		try {
			const request = new Request(`http://${req.headers.host}${req.url}`, {
				method: req.method,
				headers: req.headers as HeadersInit,
				body:
					req.method !== 'GET' && req.method !== 'HEAD'
						? (req as unknown as ReadableStream)
						: undefined,
			})

			const response = await router.fetch(request, { isLocalhost: true })

			res.statusCode = response.status
			response.headers.forEach((value, key) => {
				res.setHeader(key, value)
			})

			if (response.body) {
				const reader = response.body.getReader()
				const pump = async () => {
					while (true) {
						const { done, value } = await reader.read()
						if (done) break
						res.write(value)
					}
					res.end()
				}
				await pump()
			} else {
				res.end()
			}
		} catch (err) {
			console.error('Error handling request:', err)
			res.statusCode = 500
			res.end('Internal Server Error')
		}
	})
	const remoteHttpServer = http.createServer((req, res) => {
		serverAdapter.handleNodeRequestAndResponse(req, res, {
			isLocalhost: false,
			// @ts-expect-error - the types for this are too hard and making them work would not add any type safety.
			remoteDeviceId: req.socket.remotePublicKey,
		})
	})
	const secretStreamServer = createSecretStreamServer(remoteHttpServer, {
		keyPair,
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
