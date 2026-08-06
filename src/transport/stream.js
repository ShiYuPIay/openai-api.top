import { 数据转Uint8Array, 有效数据长度 } from "../runtime/bytes.js";
import { 下行Grain低水位字节, 下行Grain包字节, 下行Grain尾部阈值, 下行Grain最大等待轮次 } from "../runtime/constants.js";
import { log } from "../runtime/logging.js";
import { 创建下行Grain发送器 } from "../runtime/queues.js";
import { closeSocketQuietly, closeTCPSocketQuietly } from "../runtime/sockets.js";

export async function connectStreams(remoteSocket, webSocket, headerData, retryFunc, isCurrentSocket = null, remoteConnWrapper = null) {
	let header = headerData, hasData = false, reader, useBYOB = false, readError = null;
	const BYOB单次读取上限 = 64 * 1024;
	const 当前连接仍有效 = () => !isCurrentSocket || isCurrentSocket();
	const 下行发送器 = 创建下行Grain发送器(webSocket, header, 当前连接仍有效);
	header = null;
	const 下行控制器 = { 停止并刷新: () => 下行发送器.停止并刷新() };
	if (remoteConnWrapper) remoteConnWrapper.downlinkController = 下行控制器;
	try {
		const closedPromise = remoteSocket.closed;
		if (closedPromise && typeof closedPromise.catch === 'function') {
			void closedPromise.catch((error) => {
				const message = error?.message || `${error}`;
				if (!message.includes('Network connection lost') && !message.includes('ReadableStream is closed')) {
					log(`[TCP下行] Socket关闭异常: ${message}`);
				}
			});
		}
	} catch (_) { }

	try { reader = remoteSocket.readable.getReader({ mode: 'byob' }); useBYOB = true }
	catch (e) { reader = remoteSocket.readable.getReader() }

	try {
		if (!useBYOB) {
			while (true) {
				const { done, value } = await reader.read();
				if (!当前连接仍有效()) break;
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				hasData = true;
				if (value.byteLength >= 下行Grain包字节) {
					await 下行发送器.flush();
					await 下行发送器.直接发送(value);
				} else {
					await 下行发送器.发送(value);
				}
			}
		} else {
			let readBuffer = new ArrayBuffer(BYOB单次读取上限);
			while (true) {
				const { done, value } = await reader.read(new Uint8Array(readBuffer, 0, BYOB单次读取上限));
				if (!当前连接仍有效()) break;
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				hasData = true;
				if (value.byteLength >= 下行Grain包字节) {
					await 下行发送器.flush();
					await 下行发送器.直接发送(value);
					readBuffer = new ArrayBuffer(BYOB单次读取上限);
				} else {
					await 下行发送器.发送(value.slice());
					readBuffer = value.buffer.byteLength >= BYOB单次读取上限 ? value.buffer : new ArrayBuffer(BYOB单次读取上限);
				}
			}
		}
		if (当前连接仍有效()) await 下行发送器.flush();
	} catch (err) { readError = err }
	finally {
		if (当前连接仍有效() && webSocket.readyState === WebSocket.OPEN) {
			try { await 下行发送器.停止并刷新() } catch (err) { readError ||= err }
		}
		if (remoteConnWrapper?.downlinkController === 下行控制器) remoteConnWrapper.downlinkController = null;
		try { await reader.cancel() } catch (e) { }
		try { reader.releaseLock() } catch (e) { }
		closeTCPSocketQuietly(remoteSocket);
	}
	if (!hasData && retryFunc && webSocket.readyState === WebSocket.OPEN && 当前连接仍有效()) {
		try {
			await retryFunc();
			return;
		} catch (err) {
			readError ||= err;
		}
	}
	if (!当前连接仍有效()) return;
	if (readError) {
		const message = readError?.message || `${readError}`;
		if (message.includes('Network connection lost') || message.includes('ReadableStream is closed')) {
			log(`[TCP下行] 连接结束: ${message}`);
		} else {
			log(`[TCP下行] 读取失败: ${message}`);
		}
	}
	closeSocketQuietly(webSocket);
}

export function isSpeedTestSite(hostname) {
	const speedTestDomains = ['speed.cloudflare.com', 'cp.cloudflare.com'];
	hostname = hostname.toLowerCase();
	return speedTestDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}

export function 构造本地204响应(respHeader = null) {
	const 本地204响应 = new TextEncoder().encode(
		'HTTP/1.1 204 No Content\r\n' +
		'Content-Length: 0\r\n' +
		'Connection: close\r\n' +
		'\r\n'
	);
	if (有效数据长度(respHeader) === 0) return 本地204响应;
	const 协议响应头 = 数据转Uint8Array(respHeader);
	const response = new Uint8Array(协议响应头.byteLength + 本地204响应.byteLength);
	response.set(协议响应头, 0);
	response.set(本地204响应, 协议响应头.byteLength);
	log(`[TCP转发] 构造本地204响应: ${response.byteLength}B`);
	return response;
}

export function 构造WS本地204响应(respHeader = null) {
	const WS本地204响应 = new TextEncoder().encode(
		'HTTP/1.1 204 No Content\r\n' +
		'Content-Length: 0\r\n' +
		'Connection: keep-alive\r\n' +
		'\r\n'
	);
	if (有效数据长度(respHeader) === 0) return WS本地204响应;
	const 协议响应头 = 数据转Uint8Array(respHeader);
	const response = new Uint8Array(协议响应头.byteLength + WS本地204响应.byteLength);
	response.set(协议响应头, 0);
	response.set(WS本地204响应, 协议响应头.byteLength);
	return response;
}
