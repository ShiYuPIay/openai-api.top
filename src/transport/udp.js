import { 创建请求TCP连接器 } from "../proxy/connectors.js";
import { 数据转Uint8Array } from "../runtime/bytes.js";
import { log } from "../runtime/logging.js";
import { WebSocket发送并等待 } from "../runtime/sockets.js";

export async function forwardataudp(udpChunk, webSocket, respHeader, request, 响应封装器 = null) {
	const 请求数据 = 数据转Uint8Array(udpChunk);
	const 请求字节数 = 请求数据.byteLength;
	log(`[UDP转发] 收到 DNS 请求: ${请求字节数}B -> 8.8.4.4:53`);
	try {
		const TCP连接 = 创建请求TCP连接器(request);
		const tcpSocket = TCP连接({ hostname: '8.8.4.4', port: 53 });
		let 魏烈思Header = respHeader;
		const writer = tcpSocket.writable.getWriter();
		await writer.write(请求数据);
		log(`[UDP转发] DNS 请求已写入上游: ${请求字节数}B`);
		writer.releaseLock();
		await tcpSocket.readable.pipeTo(new WritableStream({
			async write(chunk) {
				const 原始响应 = 数据转Uint8Array(chunk);
				log(`[UDP转发] 收到 DNS 响应: ${原始响应.byteLength}B`);
				const 封装结果 = 响应封装器 ? await 响应封装器(原始响应) : 原始响应;
				const 发送片段列表 = Array.isArray(封装结果) ? 封装结果 : [封装结果];
				if (!发送片段列表.length) return;
				if (webSocket.readyState !== WebSocket.OPEN) return;
				for (const fragment of 发送片段列表) {
					const 转发响应 = 数据转Uint8Array(fragment);
					if (!转发响应.byteLength) continue;
					if (魏烈思Header) {
						const response = new Uint8Array(魏烈思Header.length + 转发响应.byteLength);
						response.set(魏烈思Header, 0);
						response.set(转发响应, 魏烈思Header.length);
						await WebSocket发送并等待(webSocket, response.buffer);
						魏烈思Header = null;
					} else {
						await WebSocket发送并等待(webSocket, 转发响应);
					}
				}
			},
		}));
	} catch (error) {
		log(`[UDP转发] DNS 转发失败: ${error?.message || error}`);
	}
}
