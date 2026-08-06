import { 调试日志打印 } from "./settings.js";

export function log(...args) {
	if (调试日志打印) console.log(...args);
}
