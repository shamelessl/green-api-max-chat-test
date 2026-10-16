import { createServer as httpCreateServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const maxBodyBytes = 16 * 1024
const maxMessages = 300

function json(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(data))
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    let size = 0
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('Запрос слишком большой'), { status: 413 }))
        request.destroy()
        return
      }
      body += chunk
    })
    request.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {})
      } catch {
        reject(Object.assign(new Error('Некорректный JSON'), { status: 400 }))
      }
    })
    request.on('error', reject)
  })
}

function isLocalOrigin(origin) {
  if (!origin) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function safeApiBase(value) {
  const url = new URL(value || 'https://api.green-api.com')
  if (url.protocol !== 'https:' || !/(^|\.)green-api\.com$/i.test(url.hostname)) {
    throw new Error('API-адрес должен вести на защищённый домен GREEN-API')
  }
  return url.origin
}

function encodePart(value) {
  return encodeURIComponent(String(value))
}

function pathFor(credentials, method, extra = '') {
  const { apiBase, idInstance, apiTokenInstance } = credentials
  return `${apiBase}/waInstance${encodePart(idInstance)}/${method}/${encodePart(apiTokenInstance)}${extra}`
}

function messageFromNotification(body) {
  if (body?.typeWebhook !== 'incomingMessageReceived') return null
  const messageData = body.messageData
  if (messageData?.typeMessage !== 'textMessage') return null
  const text = messageData.textMessageData?.textMessage
  if (typeof text !== 'string') return null
  const sender = body.senderData ?? {}
  const senderPhone = normalizePhone(sender.senderPhoneNumber ?? sender.chatId)
  if (!senderPhone) return null
  const timestamp = Number(body.timestamp)
  return {
    id: String(body.idMessage ?? `${body.timestamp}-${text.length}`),
    text: text.slice(0, 4000),
    direction: 'incoming',
    sentAt: Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : Date.now(),
    phone: senderPhone,
  }
}

export function createAppServer({ fetchImpl = fetch, apiBase = process.env.GREEN_API_BASE, staticDir = resolve(root, 'dist') } = {}) {
  let credentials = null
  const messages = []
  let receiving = null

  async function callApi(url, options = {}) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12_000) })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!response.ok) {
      const detail = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : `GREEN-API вернул код ${response.status}`
      throw new Error(detail.slice(0, 300))
    }
    return data
  }

  async function receiveOne() {
    if (receiving) return receiving
    const current = credentials
    if (!current) return null
    receiving = (async () => {
      const notification = await callApi(`${pathFor(current, 'receiveNotification')}?receiveTimeout=5`)
      if (!credentials || credentials !== current || !notification?.receiptId) return null
      const incoming = notification.body
      const messageToStore = messageFromNotification(incoming)
      const deletion = await callApi(pathFor(current, 'deleteNotification', `/${encodePart(notification.receiptId)}`), { method: 'DELETE' })
      if (deletion?.result !== true) throw Object.assign(new Error('GREEN-API не подтвердил обработку входящего сообщения'), { status: 502 })
      if (messageToStore) {
        messages.push(messageToStore)
        if (messages.length > maxMessages) messages.splice(0, messages.length - maxMessages)
      }
      return incoming
    })().finally(() => { receiving = null })
    return receiving
  }

  const server = httpCreateServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const pathname = url.pathname

    if (pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '') && !isLocalOrigin(request.headers.origin)) {
      return json(response, 403, { error: 'Запрос отклонён: разрешён только локальный источник' })
    }

    try {
      if (request.method === 'GET' && pathname === '/api/status') {
        return json(response, 200, { connected: Boolean(credentials) })
      }

      if (request.method === 'POST' && pathname === '/api/connect') {
        const body = await readBody(request)
        const idInstance = String(body.idInstance ?? '').trim()
        const apiTokenInstance = String(body.apiTokenInstance ?? '').trim()
        if (!/^\d{5,20}$/.test(idInstance) || apiTokenInstance.length < 8 || apiTokenInstance.length > 300) {
          return json(response, 400, { error: 'Проверь ID инстанса и токен GREEN-API' })
        }
        const apiBaseValue = safeApiBase(apiBase)
        const nextCredentials = { idInstance, apiTokenInstance, apiBase: apiBaseValue }
        const state = await callApi(pathFor(nextCredentials, 'getStateInstance'))
        if (!state || typeof state.stateInstance !== 'string') {
          return json(response, 502, { error: 'GREEN-API вернул неожиданный ответ при проверке инстанса' })
        }
        if (state.stateInstance !== 'authorized') {
          return json(response, 409, { error: `Инстанс не авторизован: статус ${state.stateInstance}. Подключи MAX-инстанс в кабинете GREEN-API.` })
        }
        credentials = nextCredentials
        messages.length = 0
        return json(response, 200, { connected: true, stateInstance: state.stateInstance })
      }

      if (request.method === 'POST' && pathname === '/api/disconnect') {
        credentials = null
        messages.length = 0
        return json(response, 200, { connected: false })
      }

      if (request.method === 'POST' && pathname === '/api/messages') {
        if (!credentials) return json(response, 401, { error: 'Сначала подключи GREEN-API' })
        const body = await readBody(request)
        const phone = normalizePhone(body.phone)
        const text = String(body.text ?? '').trim()
        if (phone.length < 10 || phone.length > 15) return json(response, 400, { error: 'Проверь номер телефона' })
        if (!text || text.length > 4000) return json(response, 400, { error: 'Сообщение должно содержать от 1 до 4000 символов' })
        const result = await callApi(pathFor(credentials, 'sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: `${phone}@c.us`, message: text }),
        })
        if (typeof result?.idMessage !== 'string') return json(response, 502, { error: 'GREEN-API не подтвердил отправку сообщения' })
        const message = { id: result.idMessage, text, direction: 'outgoing', sentAt: Date.now(), phone }
        messages.push(message)
        if (messages.length > maxMessages) messages.splice(0, messages.length - maxMessages)
        return json(response, 200, { message })
      }

      if (request.method === 'GET' && pathname === '/api/notifications') {
        if (!credentials) return json(response, 401, { error: 'Сначала подключи GREEN-API' })
        const phone = normalizePhone(url.searchParams.get('phone'))
        if (phone.length < 10 || phone.length > 15) return json(response, 400, { error: 'Проверь номер чата' })
        await receiveOne()
        const selected = messages.filter((message) => message.phone === phone).slice(-100).map(({ phone: _phone, ...message }) => message)
        return json(response, 200, { messages: selected })
      }

      if (pathname.startsWith('/api/')) return json(response, 404, { error: 'Метод API не найден' })
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Метод не поддерживается' })

      const relativePath = pathname === '/' ? 'index.html' : normalize(decodeURIComponent(pathname).replace(/^\/+/, ''))
      const file = resolve(staticDir, relativePath)
      if (!file.startsWith(resolve(staticDir) + sep) && file !== join(resolve(staticDir), 'index.html')) return json(response, 403, { error: 'Недопустимый путь' })
      const target = existsSync(file) && statSync(file).isFile() ? file : join(resolve(staticDir), 'index.html')
      if (!existsSync(target)) return json(response, 503, { error: 'Сборка интерфейса отсутствует. Выполни npm run build.' })
      const mime = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' })[extname(target)] ?? 'application/octet-stream'
      response.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'" })
      if (request.method === 'HEAD') return response.end()
      return createReadStream(target).pipe(response)
    } catch (error) {
      if (response.headersSent) return response.destroy()
      const status = Number(error?.status) || 502
      return json(response, status, { error: status === 502 ? `Ошибка GREEN-API: ${String(error?.message ?? 'проверь подключение').slice(0, 250)}` : String(error?.message ?? 'Ошибка запроса') })
    }
  })

  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4179)
  const host = process.env.HOST ?? '127.0.0.1'
  const server = createAppServer()
  server.listen(port, host, () => console.log(`GREEN-API chat is running at http://${host}:${port}`))
}
