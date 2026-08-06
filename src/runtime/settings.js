import { 整理成数组 } from "./arrays.js";

const 默认SOCKS5白名单 = Object.freeze([
  "*tapecontent.net",
  "*cloudatacdn.com",
  "*loadshare.org",
  "*cdn-centaurus.com",
  "scholar.google.com",
]);

export let 调试日志打印 = false;
export let SOCKS5白名单 = [...默认SOCKS5白名单];
export let TCP并发拨号数 = 1;
export let 反代并发拨号数 = 1;
export let 预加载竞速拨号 = false;

let 上次白名单配置 = null;

function 已启用(value) {
  return value === true || value === "1" || String(value).toLowerCase() === "true";
}

function 正整数(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export async function 配置运行时(env = {}) {
  调试日志打印 = 已启用(env.DEBUG);
  预加载竞速拨号 = 已启用(env.PRELOAD_RACE_DIAL);
  TCP并发拨号数 = 正整数(env.TCP_CONCURRENT_DIAL, 1);
  反代并发拨号数 = 正整数(env.PROXY_CONCURRENT_DIAL, 1);

  const 白名单配置 = String(env.GO2SOCKS5 ?? "");
  if (白名单配置 === 上次白名单配置) return;

  const extra = 白名单配置 ? await 整理成数组(白名单配置) : [];
  SOCKS5白名单 = [...new Set([...默认SOCKS5白名单, ...extra])];
  上次白名单配置 = 白名单配置;
}
