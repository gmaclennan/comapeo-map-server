import type { TypedEventTarget } from 'typed-event-target'

import type { DownloadRequest } from './download-request.js'
import type { DownloadResponse } from './map-share.js'

const encoder = new TextEncoder()

type EventTargetStateUpdater = TypedEventTarget<
	Readonly<Event & { type: 'update' }>
> & {
	state: any
}

/**
 * Create a Server-Sent Events stream for an EventTarget with a `state` property
 * that emits 'update' events with state updates.
 *
 * You must pass an AbortSignal that will cancel the stream if the client disconnects.
 */
export function createEventStreamResponse(
	eventTarget: EventTargetStateUpdater,
	{ signal }: { signal: AbortSignal },
): Response {
	let listener: (event: Event & { type: 'update' }) => void | undefined
	let controller: ReadableStreamDefaultController<Uint8Array>
	const stream = new ReadableStream({
		start(ctrl) {
			controller = ctrl
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify(eventTarget.state)}\n\n`),
			)
			listener = (event) => {
				const { type, ...update } = event
				try {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(update)}\n\n`),
					)
				} catch {
					// Stream may be closed, ignore
				}
			}
			eventTarget.addEventListener('update', listener)
		},
		cancel() {
			listener && eventTarget.removeEventListener('update', listener)
		},
	})
	signal.addEventListener(
		'abort',
		() => {
			try {
				controller?.close()
			} catch {
				// Stream may already be closed, ignore
			}
			listener && eventTarget.removeEventListener('update', listener)
		},
		{ once: true },
	)
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}
