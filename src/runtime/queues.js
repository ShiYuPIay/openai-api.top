import { 数据转Uint8Array } from "./bytes.js";
import { 上行合包目标字节, 上行队列最大字节, 上行队列最大条目, 下行Grain低水位字节, 下行Grain包字节, 下行Grain尾部阈值, 下行Grain最大等待轮次 } from "./constants.js";
import { log } from "./logging.js";
import { WebSocket发送并等待, closeSocketQuietly } from "./sockets.js";

export function 创建Grain收纳器(容量, 复制合包结果 = false) {
	let 队列 = [];
	let 头 = 0;
	let 字节数 = 0;
	let 合包缓冲 = null;

	const 为空 = () => 头 >= 队列.length;
	const 压缩 = () => {
		if (头 > 32 && 头 * 2 >= 队列.length) {
			队列 = 队列.slice(头);
			头 = 0;
		}
	};
	const 取出 = () => {
		if (为空()) return null;
		const item = 队列[头];
		队列[头++] = undefined;
		字节数 -= item.chunk.byteLength;
		压缩();
		return item;
	};

	return {
		get 字节数() { return 字节数 },
		get 条目数() { return 队列.length - 头 },
		get 为空() { return 为空() },
		清空(处理项目 = null) {
			if (处理项目) {
				for (let i = 头; i < 队列.length; i++) {
					if (队列[i]) 处理项目(队列[i]);
				}
			}
			队列 = [];
			头 = 0;
			字节数 = 0;
		},
		收纳(item) {
			if (!item?.chunk?.byteLength) return false;
			队列.push(item);
			字节数 += item.chunk.byteLength;
			return true;
		},
		合包() {
			const first = 取出();
			if (!first) return null;
			const items = [first];
			if (为空() || first.chunk.byteLength >= 容量) return { chunk: first.chunk, items };

			let totalBytes = first.chunk.byteLength;
			let end = 头;
			while (end < 队列.length) {
				const nextBytes = totalBytes + 队列[end].chunk.byteLength;
				if (nextBytes > 容量) break;
				totalBytes = nextBytes;
				end++;
			}
			if (end === 头) return { chunk: first.chunk, items };

			const output = (合包缓冲 ||= new Uint8Array(容量));
			output.set(first.chunk, 0);
			let offset = first.chunk.byteLength;
			while (头 < end) {
				const next = 队列[头];
				队列[头++] = undefined;
				字节数 -= next.chunk.byteLength;
				items.push(next);
				output.set(next.chunk, offset);
				offset += next.chunk.byteLength;
			}
			压缩();
			const bundled = output.subarray(0, totalBytes);
			return { chunk: 复制合包结果 ? bundled.slice() : bundled, items };
		}
	};
}

export function 创建上行写入队列({ 获取写入器, 获取连接任务 = null, 释放写入器, 重试连接, 关闭连接, 名称 = '上行队列' }) {
	const grain = 创建Grain收纳器(上行合包目标字节);
	let draining = false;
	let closed = false;
	let idleResolvers = [];
	let activeCompletions = null;

	const settleCompletions = (completions, err = null) => {
		if (!completions) return;
		for (const completion of completions) {
			if (err) completion.reject(err);
			else completion.resolve();
		}
	};

	const resolveIdle = () => {
		if (grain.字节数 || draining || !idleResolvers.length) return;
		const resolvers = idleResolvers;
		idleResolvers = [];
		for (const resolve of resolvers) resolve();
	};

	const clear = (err = null) => {
		const closeErr = err || (closed ? new Error(`${名称}: queue closed`) : null);
		if (closeErr) {
			grain.清空(item => settleCompletions(item.completions, closeErr));
			settleCompletions(activeCompletions, closeErr);
			activeCompletions = null;
		} else grain.清空();
		resolveIdle();
	};

	const bundle = () => {
		const packed = grain.合包();
		if (!packed) return null;
		let allowRetry = true;
		let completions = null;
		for (const item of packed.items) {
			allowRetry = allowRetry && item.allowRetry;
			if (item.completions) completions = completions ? completions.concat(item.completions) : item.completions;
		}
		return { chunk: packed.chunk, allowRetry, completions };
	};

	const 等待可用写入器 = async () => {
		let writer = 获取写入器();
		if (writer) return writer;
		const connectionTask = 获取连接任务?.();
		if (connectionTask) await connectionTask;
		return 获取写入器();
	};

	const drain = async () => {
		if (draining || closed) return;
		draining = true;
		try {
			for (; ;) {
				if (closed) break;
				const item = bundle();
				if (!item) break;
				const completions = item.completions || null;
				activeCompletions = completions;
				try {
					let writer = await 等待可用写入器();
					if (closed) break;
					if (!writer) throw new Error(`${名称}: remote writer unavailable`);
					try {
						await writer.write(item.chunk);
					} catch (err) {
						释放写入器?.();
						if (closed) break;
						if (!item.allowRetry || typeof 重试连接 !== 'function') throw err;
						await 重试连接();
						if (closed) break;
						writer = 获取写入器();
						if (!writer) throw err;
						await writer.write(item.chunk);
					}
					settleCompletions(completions);
				} catch (err) {
					settleCompletions(completions, err);
					throw err;
				} finally {
					if (activeCompletions === completions) activeCompletions = null;
				}
			}
		} catch (err) {
			closed = true;
			clear(err);
			log(`[${名称}] 写入失败: ${err?.message || err}`);
			try { 关闭连接?.(err) } catch (_) { }
		} finally {
			draining = false;
			if (!closed && !grain.为空) drain();
			else resolveIdle();
		}
	};

	const enqueue = (data, allowRetry = true, waitForFlush = false) => {
		if (closed) return false;
		// 首包解析阶段既没有 writer 也没有连接任务；返回 false 交给上层继续协议解析。
		// 已建立会话的重拨阶段则先收纳，drain 会等待新 writer，避免数据被误当成首包。
		if (!获取写入器() && !获取连接任务?.()) return false;
		const chunk = 数据转Uint8Array(data);
		if (!chunk.byteLength) return true;
		const nextBytes = grain.字节数 + chunk.byteLength;
		const nextItems = grain.条目数 + 1;
		if (nextBytes > 上行队列最大字节 || nextItems > 上行队列最大条目) {
			closed = true;
			const err = Object.assign(new Error(`${名称}: upload queue overflow (${nextBytes}B/${nextItems})`), { isQueueOverflow: true });
			clear(err);
			log(`[${名称}] 队列超限，关闭连接`);
			try { 关闭连接?.(err) } catch (_) { }
			throw err;
		}
		let completionPromise = null;
		let completions = null;
		if (waitForFlush) {
			completions = [];
			completionPromise = new Promise((resolve, reject) => completions.push({ resolve, reject }));
		}
		grain.收纳({ chunk, allowRetry, completions });
		if (!draining) drain();
		return waitForFlush ? completionPromise.then(() => true) : true;
	};

	return {
		写入(data, allowRetry = true) {
			return enqueue(data, allowRetry, false);
		},
		写入并等待(data, allowRetry = true) {
			return enqueue(data, allowRetry, true);
		},
		async 等待空() {
			if (!grain.字节数 && !draining) return;
			await new Promise(resolve => idleResolvers.push(resolve));
		},
		清空() {
			closed = true;
			clear();
		}
	};
}

export function 创建下行Grain发送器(webSocket, headerData = null, isActive = null) {
	const packetCap = 下行Grain包字节;
	const tailBytes = 下行Grain尾部阈值;
	const grain = 创建Grain收纳器(packetCap, true);
	let header = typeof headerData === 'function' ? null : headerData;
	const 获取响应头 = typeof headerData === 'function' ? headerData : () => {
		const value = header;
		header = null;
		return value;
	};
	let flushTimer = null;
	let generation = 0;
	let scheduledGeneration = 0;
	let waitRounds = 0;
	let flushPromise = null;
	let directSendPromise = null;
	let 强制排空 = false;
	let 停止已开始 = false;
	let 活动发送数 = 0;
	let 活动直发数 = 0;
	let 活动发送错误 = null;
	let 活动发送等待者 = [];
	const 等待活动发送完成 = () => {
		if (!活动发送数 && !活动直发数) return Promise.resolve();
		return new Promise(resolve => 活动发送等待者.push(resolve));
	};
	const 标记发送完成 = () => {
		if (活动发送数 || 活动直发数 || !活动发送等待者.length) return;
		const resolvers = 活动发送等待者;
		活动发送等待者 = [];
		for (const resolve of resolvers) resolve();
	};
	const 检查活动发送错误 = () => {
		if (!活动发送错误) return;
		const err = 活动发送错误;
		grain.清空();
		throw err;
	};
	const 当前发送器有效 = () => 强制排空 || !isActive || isActive();
	const 关闭活动连接 = () => {
		if (当前发送器有效()) closeSocketQuietly(webSocket);
	};

	const 发送原始块 = async (chunk) => {
		if (!当前发送器有效()) return;
		if (webSocket.readyState !== WebSocket.OPEN) throw new Error('ws.readyState is not open');
		chunk = 附加响应头(chunk);
		await WebSocket发送并等待(webSocket, chunk);
	};

	const 串行发送原始块 = async (chunk) => {
		while (directSendPromise) await directSendPromise;
		const sendTask = 发送原始块(chunk);
		directSendPromise = sendTask;
		try { await sendTask }
		finally {
			if (directSendPromise === sendTask) directSendPromise = null;
		}
	};

	const 附加响应头 = (chunk) => {
		const responseHeader = 获取响应头();
		if (!responseHeader) return chunk;
		const merged = new Uint8Array(responseHeader.length + chunk.byteLength);
		merged.set(responseHeader, 0);
		merged.set(chunk, responseHeader.length);
		return merged;
	};

	const flush = async () => {
		while (flushPromise) await flushPromise;
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = null;
		waitRounds = 0;
		if (!当前发送器有效()) {
			grain.清空();
			return;
		}
		const 发送任务 = (async () => {
			for (; ;) {
				if (!当前发送器有效()) {
					grain.清空();
					break;
				}
				const packed = grain.合包();
				if (!packed) break;
				await 串行发送原始块(packed.chunk);
			}
		})();
		flushPromise = 发送任务.catch(err => {
			活动发送错误 ||= err;
			throw err;
		}).finally(() => { flushPromise = null });
		return flushPromise;
	};

	const scheduleFlush = () => {
		if (!当前发送器有效()) {
			grain.清空();
			return;
		}
		if (grain.为空 || flushTimer) return;
		if (grain.字节数 >= packetCap || packetCap - grain.字节数 < tailBytes) {
			flush().catch(关闭活动连接);
			return;
		}
		flushTimer = setTimeout(() => {
			flushTimer = null;
			if (!当前发送器有效()) {
				grain.清空();
				return;
			}
			if (grain.为空) return;
			if (grain.字节数 >= packetCap || packetCap - grain.字节数 < tailBytes) {
				flush().catch(关闭活动连接);
				return;
			}
			if (waitRounds < 下行Grain最大等待轮次 && (generation !== scheduledGeneration || grain.字节数 < 下行Grain低水位字节)) {
				waitRounds++;
				scheduledGeneration = generation;
				scheduleFlush();
				return;
			}
			flush().catch(关闭活动连接);
		}, 1);
	};

	return {
		async 直接发送(data) {
			if (停止已开始 || !当前发送器有效()) return;
			活动直发数++;
			try {
				const chunk = 数据转Uint8Array(data);
				if (!chunk.byteLength) return;
				await 串行发送原始块(chunk);
			} catch (err) {
				活动发送错误 ||= err;
				throw err;
			} finally {
				活动直发数--;
				标记发送完成();
			}
		},
		async 发送(data) {
			if (停止已开始 || !当前发送器有效()) return;
			活动发送数++;
			try {
				const chunk = 数据转Uint8Array(data);
				if (!chunk.byteLength) return;
				let offset = 0;
				const totalBytes = chunk.byteLength;
				while (offset < totalBytes) {
					const remainingBytes = totalBytes - offset;
					if (grain.为空 && remainingBytes >= packetCap) {
						const sendBytes = Math.min(packetCap, remainingBytes);
						const view = offset || sendBytes !== totalBytes ? chunk.subarray(offset, offset + sendBytes) : chunk;
						await 串行发送原始块(view);
						offset += sendBytes;
						continue;
					}
					const copyBytes = Math.min(packetCap - grain.字节数, totalBytes - offset);
					if (!copyBytes) {
						await flush();
						continue;
					}
					grain.收纳({ chunk: offset || copyBytes !== totalBytes ? chunk.subarray(offset, offset + copyBytes) : chunk });
					offset += copyBytes;
					generation++;
					if (grain.字节数 >= packetCap || packetCap - grain.字节数 < tailBytes) await flush();
					else scheduleFlush();
				}
			} catch (err) {
				活动发送错误 ||= err;
				throw err;
			} finally {
				活动发送数--;
				标记发送完成();
			}
		},
		flush,
		async 停止并刷新() {
			if (停止已开始) {
				await 等待活动发送完成();
				while (directSendPromise) await directSendPromise;
				检查活动发送错误();
				await flush();
				return;
			}
			停止已开始 = true;
			强制排空 = true;
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = null;
			await 等待活动发送完成();
			while (directSendPromise) await directSendPromise;
			检查活动发送错误();
			await flush();
		}
	};
}
