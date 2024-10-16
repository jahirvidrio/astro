import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Http2ServerResponse } from 'node:http2';
import type { RouteData } from '../../@types/astro.js';
import { deserializeManifest } from './common.js';
import { createOutgoingHttpHeaders } from './createOutgoingHttpHeaders.js';
import { App } from './index.js';
import type { RenderOptions } from './index.js';
import type { SSRManifest, SerializedSSRManifest } from './types.js';

export { apply as applyPolyfills } from '../polyfill.js';

const clientAddressSymbol = Symbol.for('astro.clientAddress');

/**
 * Allow the request body to be explicitly overridden. For example, this
 * is used by the Express JSON middleware.
 */
interface NodeRequest extends IncomingMessage {
	body?: unknown;
}

export class NodeApp extends App {
	match(req: NodeRequest | Request) {
		if (!(req instanceof Request)) {
			req = NodeApp.createRequest(req, {
				skipBody: true,
			});
		}
		return super.match(req);
	}
	render(request: NodeRequest | Request, options?: RenderOptions): Promise<Response>;
	/**
	 * @deprecated Instead of passing `RouteData` and locals individually, pass an object with `routeData` and `locals` properties.
	 * See https://github.com/withastro/astro/pull/9199 for more information.
	 */
	render(request: NodeRequest | Request, routeData?: RouteData, locals?: object): Promise<Response>;
	render(
		req: NodeRequest | Request,
		routeDataOrOptions?: RouteData | RenderOptions,
		maybeLocals?: object,
	) {
		if (!(req instanceof Request)) {
			req = NodeApp.createRequest(req);
		}
		// @ts-expect-error The call would have succeeded against the implementation, but implementation signatures of overloads are not externally visible.
		return super.render(req, routeDataOrOptions, maybeLocals);
	}

	/**
	 * Converts a NodeJS IncomingMessage into a web standard Request.
	 * 
	 * @param req - The NodeJS IncomingMessage to convert.
	 * @param {Object} [options={}] - Configuration options for creating the Request.
	 * @param {boolean} [options.skipBody=false] - If true, the request body will not be included in the Request object.
	 * @param {boolean} [options.trustDownstreamProxy=true] - Determines whether to consider X-Forwarded headers from upstream proxies. 
	 *        If true, these headers will be processed; if false, they will be ignored.
	 * @returns {Request} The web standard Request created from the NodeJS IncomingMessage.
	 *
	 * @example
	 * import { NodeApp } from 'astro/app/node';
	 * import { createServer } from 'node:http';
	 *
	 * const server = createServer(async (req, res) => {
	 *     const request = NodeApp.createRequest(req);
	 *     const response = await app.render(request);
	 *     await NodeApp.writeResponse(response, res);
	 * })
	 */
	static createRequest(req: NodeRequest, { skipBody = false, trustDownstreamProxy = true } = {}): Request {
		const isEncrypted = 'encrypted' in req.socket && req.socket.encrypted;

		/**
		 * Some proxies append values with spaces and some do not.
		 * We need to handle it here and parse the header correctly.
		 * 
		 * @see getFirstForwardedValue
		 */

		/** @example "https, http,http" => "http" */
		const forwardedProtocol = getFirstForwardedValue(req.headers['x-forwarded-proto']);
		const protocol = trustDownstreamProxy && forwardedProtocol
			? forwardedProtocol
			: (isEncrypted ? 'https' : 'http');

		/** @example "example.com,www2.example.com" => "example.com" */
		const forwardedHostname = getFirstForwardedValue(req.headers['x-forwarded-host']);
		const hostname = trustDownstreamProxy && forwardedHostname
			? forwardedHostname
			: req.headers.host ?? req.headers[':authority'];

		/** @example "443,8080,80" => "443" */
		const port = getFirstForwardedValue(req.headers['x-forwarded-port']);

		const portInHostname = typeof hostname === 'string' && /:\d+$/.test(hostname);
		const hostnamePort = portInHostname ? hostname : `${hostname}${port ? `:${port}` : ''}`;

		const url = `${protocol}://${hostnamePort}${req.url}`;
		const options: RequestInit = {
			method: req.method || 'GET',
			headers: makeRequestHeaders(req),
		};
		const bodyAllowed = options.method !== 'HEAD' && options.method !== 'GET' && skipBody === false;
		if (bodyAllowed) {
			Object.assign(options, makeRequestBody(req));
		}

		const request = new Request(url, options);

		/** @example "1.1.1.1,8.8.8.8" => "1.1.1.1" */
		const forwardedClientIp = getFirstForwardedValue(req.headers['x-forwarded-for']);
		const clientIp = trustDownstreamProxy && forwardedClientIp
			? forwardedClientIp
			: req.socket?.remoteAddress;
		if (clientIp) {
			Reflect.set(request, clientAddressSymbol, clientIp);
		}

		return request;
	}

	/**
	 * Streams a web-standard Response into a NodeJS Server Response.
	 *
	 * @param source WhatWG Response
	 * @param destination NodeJS ServerResponse
	 * 
	 * @example
	 * import { NodeApp } from 'astro/app/node';
	 * import { createServer } from 'node:http';
	 *
	 * const server = createServer(async (req, res) => {
	 *     const request = NodeApp.createRequest(req);
	 *     const response = await app.render(request);
	 *     await NodeApp.writeResponse(response, res);
	 * })
	 */
	static async writeResponse(source: Response, destination: ServerResponse) {
		const { status, headers, body, statusText } = source;
		// HTTP/2 doesn't support statusMessage
		if (!(destination instanceof Http2ServerResponse)) {
			destination.statusMessage = statusText;
		}
		destination.writeHead(status, createOutgoingHttpHeaders(headers));
		if (!body) return destination.end();
		try {
			const reader = body.getReader();
			destination.on('close', () => {
				// Cancelling the reader may reject not just because of
				// an error in the ReadableStream's cancel callback, but
				// also because of an error anywhere in the stream.
				reader.cancel().catch((err) => {
					console.error(
						`There was an uncaught error in the middle of the stream while rendering ${destination.req.url}.`,
						err,
					);
				});
			});
			let result = await reader.read();
			while (!result.done) {
				destination.write(result.value);
				result = await reader.read();
			}
			destination.end();
			// the error will be logged by the "on end" callback above
		} catch {
			destination.end('Internal server error');
		}
	}
}

/**
 * Retrieves the first value from a header that may contain multiple comma-separated values.
 * 
 * This function is intended to handle HTTP headers that might include multiple values, such as the `X-Forwarded-For` header. 
 * If the header contains multiple values separated by commas, it returns the first value. It also trims any extra whitespace from the result.
 * 
 * @param {string | string[]} [multiValueHeader] - The header that contains one or more values. It can be a string with comma-separated values or an array of strings.
 * @returns {string | undefined} The first value from the header, trimmed of any surrounding whitespace, or `undefined` if no value is provided.
 * 
 * @example
 * // Example with a string
 * const header = '192.168.1.1, 192.168.1.2';
 * const firstValue = getFirstForwardedValue(header); // '192.168.1.1'
 * 
 * @example
 * // Example with an array
 * const headerArray = ['192.168.1.1', '192.168.1.2'];
 * const firstValue = getFirstForwardedValue(headerArray); // '192.168.1.1'
 * 
 * @remarks
 * Some proxies append values without spaces, while others add spaces between values. 
 * This function ensures consistent parsing by handling both cases and returning the first value correctly formatted.
 */
function getFirstForwardedValue(multiValueHeader?: string | string[]) {
	return multiValueHeader
		?.toString()
		?.split(',')
		?.at(0)
		?.trim();
}

function makeRequestHeaders(req: NodeRequest): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(name, item);
			}
		} else {
			headers.append(name, value);
		}
	}
	return headers;
}

function makeRequestBody(req: NodeRequest): RequestInit {
	if (req.body !== undefined) {
		if (typeof req.body === 'string' && req.body.length > 0) {
			return { body: Buffer.from(req.body) };
		}

		if (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length > 0) {
			return { body: Buffer.from(JSON.stringify(req.body)) };
		}

		// This covers all async iterables including Readable and ReadableStream.
		if (
			typeof req.body === 'object' &&
			req.body !== null &&
			typeof (req.body as any)[Symbol.asyncIterator] !== 'undefined'
		) {
			return asyncIterableToBodyProps(req.body as AsyncIterable<any>);
		}
	}

	// Return default body.
	return asyncIterableToBodyProps(req);
}

function asyncIterableToBodyProps(iterable: AsyncIterable<any>): RequestInit {
	return {
		// Node uses undici for the Request implementation. Undici accepts
		// a non-standard async iterable for the body.
		// @ts-expect-error
		body: iterable,
		// The duplex property is required when using a ReadableStream or async
		// iterable for the body. The type definitions do not include the duplex
		// property because they are not up-to-date.
		duplex: 'half',
	};
}

export async function loadManifest(rootFolder: URL): Promise<SSRManifest> {
	const manifestFile = new URL('./manifest.json', rootFolder);
	const rawManifest = await fs.promises.readFile(manifestFile, 'utf-8');
	const serializedManifest: SerializedSSRManifest = JSON.parse(rawManifest);
	return deserializeManifest(serializedManifest);
}

export async function loadApp(rootFolder: URL): Promise<NodeApp> {
	const manifest = await loadManifest(rootFolder);
	return new NodeApp(manifest);
}
