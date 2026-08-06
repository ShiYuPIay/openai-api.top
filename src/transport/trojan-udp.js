import { 创建请求TCP连接器 } from "../proxy/connectors.js";
import { 拼接字节数据, 数据转Uint8Array } from "../runtime/bytes.js";
import { log } from "../runtime/logging.js";
import { closeSocketQuietly, closeTCPSocketQuietly } from "../runtime/sockets.js";
import { connectStreams } from "./stream.js";
import { 连接木马反代 } from "./trojan-proxy.js";
import { forwardataudp } from "./udp.js";

export async function 转发木马UDP反代数据(chunk, webSocket, 上下文, request) {
	const data = 数据转Uint8Array(chunk);
	if (!上下文.反代Socket) {
		const TCP连接 = 创建请求TCP连接器(request);
		const socket = await 连接木马反代(data, TCP连接, 上下文.反代地址);
		上下文.反代Socket = socket;
		void socket.closed.catch((error) => {
			const message = error?.message || `${error}`;
			if (!message.includes('Network connection lost') && !message.includes('ReadableStream is closed')) {
				log(`[木马UDP反代] TCP Socket关闭异常: ${message}`);
			}
		}).finally(() => closeSocketQuietly(webSocket));
		void connectStreams(socket, webSocket, null, null).catch((error) => {
			log(`[木马UDP反代] 下行转发失败: ${error?.message || error}`);
			closeTCPSocketQuietly(socket);
			closeSocketQuietly(webSocket);
		});
		return;
	}
	if (!data.byteLength) return;
	const writer = 上下文.反代Socket.writable.getWriter();
	try { await writer.write(data) }
	finally { try { writer.releaseLock() } catch (e) { } }
}

export async function 转发木马UDP数据(chunk, webSocket, 上下文, request) {
	const 当前块 = 数据转Uint8Array(chunk);
	if (上下文?.反代地址) return 转发木马UDP反代数据(当前块, webSocket, 上下文, request);
	const 缓存块 = 上下文?.缓存 instanceof Uint8Array ? 上下文.缓存 : new Uint8Array(0);
	const input = 缓存块.byteLength ? 拼接字节数据(缓存块, 当前块) : 当前块;
	let cursor = 0;

	while (cursor < input.byteLength) {
		const packetStart = cursor;
		const atype = input[cursor];
		let addrCursor = cursor + 1;
		let addrLen = 0;
		if (atype === 1) addrLen = 4;
		else if (atype === 4) addrLen = 16;
		else if (atype === 3) {
			if (input.byteLength < addrCursor + 1) break;
			addrLen = 1 + input[addrCursor];
		} else throw new Error(`invalid trojan udp addressType: ${atype}`);

		const portCursor = addrCursor + addrLen;
		if (input.byteLength < portCursor + 6) break;

		const port = (input[portCursor] << 8) | input[portCursor + 1];
		const payloadLength = (input[portCursor + 2] << 8) | input[portCursor + 3];
		if (input[portCursor + 4] !== 0x0d || input[portCursor + 5] !== 0x0a) throw new Error('invalid trojan udp delimiter');

		const payloadStart = portCursor + 6;
		const payloadEnd = payloadStart + payloadLength;
		if (input.byteLength < payloadEnd) break;

		const 地址端口头 = input.slice(packetStart, portCursor + 2);
		const payload = input.slice(payloadStart, payloadEnd);
		cursor = payloadEnd;

		if (port !== 53) throw new Error('UDP is not supported');
		if (!payload.byteLength) continue;

		let tcpDNS查询 = payload;
		if (payload.byteLength < 2 || ((payload[0] << 8) | payload[1]) !== payload.byteLength - 2) {
			tcpDNS查询 = new Uint8Array(payload.byteLength + 2);
			tcpDNS查询[0] = (payload.byteLength >>> 8) & 0xff;
			tcpDNS查询[1] = payload.byteLength & 0xff;
			tcpDNS查询.set(payload, 2);
		}

		const dns响应上下文 = { 缓存: new Uint8Array(0) };
		await forwardataudp(tcpDNS查询, webSocket, null, request, (dnsRespChunk) => {
			const 当前响应块 = 数据转Uint8Array(dnsRespChunk);
			const 响应输入 = dns响应上下文.缓存.byteLength ? 拼接字节数据(dns响应上下文.缓存, 当前响应块) : 当前响应块;
			const 响应帧列表 = [];
			let responseCursor = 0;
			while (responseCursor + 2 <= 响应输入.byteLength) {
				const dnsLen = (响应输入[responseCursor] << 8) | 响应输入[responseCursor + 1];
				const dnsStart = responseCursor + 2;
				const dnsEnd = dnsStart + dnsLen;
				if (dnsEnd > 响应输入.byteLength) break;
				const dnsPayload = 响应输入.slice(dnsStart, dnsEnd);
				const frame = new Uint8Array(地址端口头.byteLength + 4 + dnsPayload.byteLength);
				frame.set(地址端口头, 0);
				frame[地址端口头.byteLength] = (dnsPayload.byteLength >>> 8) & 0xff;
				frame[地址端口头.byteLength + 1] = dnsPayload.byteLength & 0xff;
				frame[地址端口头.byteLength + 2] = 0x0d;
				frame[地址端口头.byteLength + 3] = 0x0a;
				frame.set(dnsPayload, 地址端口头.byteLength + 4);
				响应帧列表.push(frame);
				responseCursor = dnsEnd;
			}
			dns响应上下文.缓存 = 响应输入.slice(responseCursor);
			return 响应帧列表.length ? 响应帧列表 : new Uint8Array(0);
		});
	}

	if (上下文) 上下文.缓存 = input.slice(cursor);
}
