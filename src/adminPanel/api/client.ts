import axios from 'axios'
import { API_OK, ApiError, type ApiEnvelope } from './common'

// 唯一的 axios 实例。
//
// 直连后端，不走主进程代理是刻意的：换成主进程转发就得给每个接口配一条 IPC
// 通道，这套代码将来单独拎出去做 Web 站时也用不了。主窗口的 CSP 为此放行了
// connect-src（见 src/renderer/index.html）。代价是 token 存在 localStorage 里。

// 8088 那个检索服务是独立部署的另一套，回包未必按 { code: 2000 } 的约定来。
// 与其在页面里写「把异常当成功」的代码，不如给这一类请求一个显式开关。
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 跳过业务码检查：请求本身就说明这一路不按 { code: 2000 } 回包 */
    skipEnvelopeCheck?: boolean
  }
}

const client = axios.create({
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' }
})

// 与 ctbapp 的 main.js 同一个约定：token 放自定义请求头
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers['token'] = token
  return config
})

// 业务码在这一层就翻成异常 —— 后端这套接口永远是 HTTP 200，成败写在 body 的
// code 里。如果每个调用点都自己去判 code，25 个页面就是 25 处漏判的机会；
// 统一到拦截器里抛出，页面只需要 try/catch，拿到的一定是成功的结果。
client.interceptors.response.use((response) => {
  if (response.config.skipEnvelopeCheck) return response
  const env = response.data as ApiEnvelope<unknown> | undefined
  if (env && typeof env === 'object' && typeof env.code === 'number' && env.code !== API_OK) {
    throw new ApiError(env.code, env.msg || `请求失败（code ${env.code}）`)
  }
  return response
})

export default client
