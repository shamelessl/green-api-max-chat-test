import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppServer } from './server.mjs'

async function withServer(fetchImpl, run) {
  const server = createAppServer({ fetchImpl, apiBase: 'https://api.green-api.com', staticDir: 'missing-dist' })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

const localOrigin = 'http://127.0.0.1:5173'

test('connects, receives a text notification, and deletes it after processing', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' })
    if (String(url).includes('/getStateInstance/')) return Response.json({ stateInstance: 'authorized' })
    if (String(url).includes('/receiveNotification/')) return Response.json({
      receiptId: 77,
      body: {
        typeWebhook: 'incomingMessageReceived',
        instanceData: { idInstance: 7105000000, typeInstance: 'v3' },
        timestamp: 1792117361,
        idMessage: 'incoming-1',
        senderData: { senderPhoneNumber: 79991234567, chatId: 'chat-1' },
        messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Привет!' } },
      },
    })
    if (String(url).includes('/deleteNotification/')) return Response.json({ result: true, reason: '' })
    throw new Error(`Unexpected API call: ${url}`)
  }

  await withServer(fetchImpl, async (base) => {
    const connected = await fetch(`${base}/api/connect`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ idInstance: '7105000000', apiTokenInstance: 'test-token-123456' }),
    })
    assert.equal(connected.status, 200)
    assert.deepEqual(await connected.json(), { connected: true, stateInstance: 'authorized' })

    const response = await fetch(`${base}/api/notifications?phone=79991234567`, { headers: { origin: localOrigin } })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.messages.length, 1)
    assert.deepEqual(result.messages[0], {
      id: 'incoming-1', text: 'Привет!', direction: 'incoming', sentAt: 1792117361000,
    })
    assert.equal(calls[1].method, 'GET')
    assert.match(calls[1].url, /receiveNotification/)
    assert.equal(calls[2].method, 'DELETE')
    assert.match(calls[2].url, /deleteNotification\/test-token-123456\/77$/)
  })
})

test('does not call an unauthorized MAX instance connected or send messages through it', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/getStateInstance/')) return Response.json({ stateInstance: 'notAuthorized' })
    throw new Error(`Unexpected API call: ${url}`)
  }

  await withServer(fetchImpl, async (base) => {
    const connected = await fetch(`${base}/api/connect`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ idInstance: '7105000000', apiTokenInstance: 'test-token-123456' }),
    })
    assert.equal(connected.status, 409)
    assert.match((await connected.json()).error, /не авторизован/i)

    const response = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '79991234567', text: 'Не должно отправиться' }),
    })
    assert.equal(response.status, 401)
  })
})

test('does not show or duplicate a notification until GREEN-API confirms deletion', async () => {
  let deleteAttempts = 0
  const notification = {
    receiptId: 78,
    body: {
      typeWebhook: 'incomingMessageReceived', timestamp: 1792117362, idMessage: 'incoming-retry',
      senderData: { senderPhoneNumber: 79991234567, chatId: '79991234567' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Повтор' } },
    },
  }
  const fetchImpl = async (url) => {
    if (String(url).includes('/getStateInstance/')) return Response.json({ stateInstance: 'authorized' })
    if (String(url).includes('/receiveNotification/')) return Response.json(notification)
    if (String(url).includes('/deleteNotification/')) return Response.json({ result: ++deleteAttempts > 1 })
    throw new Error(`Unexpected API call: ${url}`)
  }

  await withServer(fetchImpl, async (base) => {
    await fetch(`${base}/api/connect`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ idInstance: '7105000000', apiTokenInstance: 'test-token-123456' }),
    })
    const first = await fetch(`${base}/api/notifications?phone=79991234567`, { headers: { origin: localOrigin } })
    assert.equal(first.status, 502)

    const second = await fetch(`${base}/api/notifications?phone=79991234567`, { headers: { origin: localOrigin } })
    assert.equal(second.status, 200)
    const data = await second.json()
    assert.equal(data.messages.length, 1)
    assert.equal(data.messages[0].id, 'incoming-retry')
  })
})

test('sends only validated text messages and keeps the API token on the server', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/getStateInstance/')) return Response.json({ stateInstance: 'authorized' })
    if (String(url).includes('/sendMessage/')) return Response.json({ idMessage: 'outgoing-1' })
    throw new Error(`Unexpected API call: ${url}`)
  }

  await withServer(fetchImpl, async (base) => {
    await fetch(`${base}/api/connect`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ idInstance: '7105000000', apiTokenInstance: 'server-only-secret' }),
    })
    const invalid = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '79991234567', text: 'x'.repeat(4001) }),
    })
    assert.equal(invalid.status, 400)
    assert.equal(calls.length, 1)

    const response = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+7 (999) 123-45-67', text: 'Тестовое сообщение' }),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.message.id, 'outgoing-1')
    assert.equal(data.message.direction, 'outgoing')
    assert.match(calls[1].url, /sendMessage/)
    assert.equal(JSON.parse(calls[1].options.body).chatId, '79991234567@c.us')
    assert.equal(JSON.parse(calls[1].options.body).message, 'Тестовое сообщение')
    assert.equal(JSON.stringify(data).includes('server-only-secret'), false)
  })
})

test('rejects cross-site credential and message requests', async () => {
  let upstreamCalls = 0
  await withServer(async () => {
    upstreamCalls += 1
    return Response.json({ stateInstance: 'authorized' })
  }, async (base) => {
    const response = await fetch(`${base}/api/connect`, {
      method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ idInstance: '7105000000', apiTokenInstance: 'test-token-123456' }),
    })
    assert.equal(response.status, 403)
    assert.equal(upstreamCalls, 0)
  })
})
