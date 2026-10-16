import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type ChatMessage = {
  id: string
  text: string
  direction: 'incoming' | 'outgoing'
  sentAt: number
}

type ConnectionState = 'checking' | 'connected' | 'disconnected'

const digitsOnly = (value: string) => value.replace(/\D/g, '')

function Icon({ name }: { name: 'search' | 'plus' | 'send' | 'message' | 'lock' | 'logout' }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths = {
    search: <><circle cx="11" cy="11" r="6.5" {...common} /><path d="m16 16 4 4" {...common} /></>,
    plus: <path d="M12 5v14M5 12h14" {...common} />,
    send: <><path d="m21 3-7.2 18-3.9-7.9L2 9.2 21 3Z" {...common} /><path d="M10 13.1 15.5 7.5" {...common} /></>,
    message: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2v-5a7.5 7.5 0 1 1 17-4.5Z" {...common} /><path d="M8 11h.01M12 11h.01M16 11h.01" {...common} /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" {...common} /><path d="M8 10V7a4 4 0 1 1 8 0v3" {...common} /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" {...common} /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" {...common} /></>,
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">{paths[name]}</svg>
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(value)
}

function App() {
  const [instanceId, setInstanceId] = useState('')
  const [token, setToken] = useState('')
  const [connected, setConnected] = useState(false)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [phoneInput, setPhoneInput] = useState('')
  const [activePhone, setActivePhone] = useState('')
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const activePhoneRef = useRef(activePhone)

  useEffect(() => {
    activePhoneRef.current = activePhone
  }, [activePhone])

  const loadMessages = useCallback(async (phone: string, signal?: AbortSignal) => {
    if (!phone || !connected) return true
    try {
      const response = await fetch(`/api/notifications?phone=${encodeURIComponent(phone)}`, { signal })
      const data = await response.json() as { messages?: ChatMessage[]; error?: string }
      if (!response.ok) throw new Error(data.error || 'Не удалось получить сообщения')
      if (activePhoneRef.current === phone) setMessages(data.messages ?? [])
      return true
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return true
      if (activePhoneRef.current === phone) setError(cause instanceof Error ? cause.message : 'Ошибка получения сообщений')
      return false
    }
  }, [connected])

  useEffect(() => {
    if (!connected || !activePhone) return
    const controller = new AbortController()
    let stopped = false
    let retryDelay = 350
    const poll = async () => {
      while (!stopped) {
        const succeeded = await loadMessages(activePhone, controller.signal)
        retryDelay = succeeded ? 350 : Math.min(Math.max(700, retryDelay * 2), 5000)
        if (!stopped) await new Promise((resolve) => window.setTimeout(resolve, retryDelay))
      }
    }
    void poll()
    return () => {
      stopped = true
      controller.abort()
    }
  }, [activePhone, connected, loadMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setConnectionState('checking')
    try {
      const response = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idInstance: instanceId.trim(), apiTokenInstance: token.trim() }),
      })
      const data = await response.json() as { error?: string; stateInstance?: string }
      if (!response.ok) throw new Error(data.error || 'Не удалось подключиться')
      setConnected(true)
      setConnectionState('connected')
      setToken('')
    } catch (cause) {
      setConnectionState('disconnected')
      setError(cause instanceof Error ? cause.message : 'Проверьте данные инстанса')
    }
  }

  async function disconnect() {
    setError('')
    try {
      const response = await fetch('/api/disconnect', { method: 'POST' })
      const data = await response.json() as { error?: string }
      if (!response.ok) throw new Error(data.error || 'Не удалось отключить инстанс')
      activePhoneRef.current = ''
      setConnected(false)
      setConnectionState('disconnected')
      setActivePhone('')
      setMessages([])
      setInstanceId('')
      setToken('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отключить инстанс')
    }
  }

  function openChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const phone = digitsOnly(phoneInput)
    if (!phone || phone.length < 10 || phone.length > 15) {
      setError('Введи номер телефона с кодом страны, например 79991234567')
      return
    }
    setError('')
    setPhoneInput(phone)
    setMessages([])
    activePhoneRef.current = phone
    setActivePhone(phone)
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!activePhone || !text || sending) return
    setSending(true)
    setError('')
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: activePhone, text }),
      })
      const data = await response.json() as { message?: ChatMessage; error?: string }
      if (!response.ok) throw new Error(data.error || 'Сообщение не отправлено')
      if (data.message && activePhoneRef.current === activePhone) {
        setMessages((current) => [...current, data.message!])
      }
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить сообщение')
    } finally {
      setSending(false)
    }
  }

  const shownPhone = activePhone ? `+${activePhone}` : ''
  const searchMatches = !activePhone || shownPhone.includes(search.trim())

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Чаты">
        <header className="sidebar-header">
          <div className="brand"><span className="brand-mark"><Icon name="message" /></span><span>Чаты</span></div>
          <button className="icon-button" aria-label="Поиск чатов" onClick={() => document.getElementById('chat-search')?.focus()}><Icon name="search" /></button>
        </header>

        <label className="search-box">
          <Icon name="search" />
          <input id="chat-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск" aria-label="Поиск чатов" />
        </label>

        <form className="new-chat-form" onSubmit={openChat}>
          <label htmlFor="phone-number">Новый чат</label>
          <div className="new-chat-row">
            <input id="phone-number" inputMode="tel" autoComplete="tel" placeholder="Номер с кодом страны" value={phoneInput} onChange={(event) => setPhoneInput(event.target.value)} disabled={!connected} />
            <button className="icon-button add-button" aria-label="Открыть чат" disabled={!connected || !phoneInput.trim()}><Icon name="plus" /></button>
          </div>
        </form>

        <div className="chat-list">
          {connected && activePhone && searchMatches ? (
            <button className="chat-item active" onClick={() => setActivePhone(activePhone)}>
              <span className="avatar">{activePhone.slice(-2)}</span>
              <span className="chat-item-copy"><strong>+{activePhone}</strong><small>{messages.at(-1)?.text ?? 'Открытый чат'}</small></span>
            </button>
          ) : (
            <div className="empty-list"><span className="empty-icon"><Icon name="message" /></span><strong>{connected ? 'Пока нет чатов' : 'Подключи инстанс'}</strong><span>{connected ? 'Введи номер выше, чтобы начать переписку.' : 'Данные соединения останутся только в памяти сервера.'}</span></div>
          )}
        </div>

        <footer className="sidebar-footer">
          <span className={`status-dot ${connectionState}`} />
          <span className="status-copy">{connectionState === 'checking' ? 'Подключаемся…' : connected ? 'Подключено к GREEN-API' : 'Нет подключения'}</span>
          {connected && <button className="icon-button logout-button" onClick={disconnect} aria-label="Отключиться"><Icon name="logout" /></button>}
        </footer>
      </aside>

      <section className="conversation" aria-label="Переписка">
        {connected && activePhone ? (
          <>
            <header className="conversation-header">
              <span className="avatar large">{activePhone.slice(-2)}</span>
              <div className="contact-title"><strong>{shownPhone}</strong><span><i className="online-dot" /> MAX</span></div>
            </header>
            <div className="message-area" aria-live="polite" aria-label="Сообщения">
              <div className="date-chip">Сегодня</div>
              {messages.length === 0 ? (
                <div className="empty-conversation"><span className="empty-icon"><Icon name="message" /></span><strong>Начни переписку</strong><span>Напиши первое сообщение. Ответ появится здесь автоматически.</span></div>
              ) : messages.map((message) => (
                <div className={`message-row ${message.direction}`} key={message.id}>
                  <article className="message-bubble"><p>{message.text}</p><time>{formatTime(message.sentAt)}</time>{message.direction === 'outgoing' && <span className="message-check" aria-label="Отправлено">✓</span>}</article>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <form className="composer" onSubmit={sendMessage}>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Написать сообщение" aria-label="Текст сообщения" rows={1} maxLength={4000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              <span className="char-count">{draft.length > 3600 ? `${draft.length}/4000` : ''}</span>
              <button className="send-button" disabled={!draft.trim() || sending} aria-label="Отправить сообщение"><Icon name="send" /></button>
            </form>
          </>
        ) : (
          <div className="welcome-pane">
            <div className="welcome-card">
              <span className="welcome-icon"><Icon name="message" /></span>
              <h1>Сообщения MAX</h1>
              <p>Подключи GREEN-API, чтобы открыть чат и переписываться текстом.</p>
              <form className="credentials-form" onSubmit={connect}>
                <label htmlFor="instance-id">ID инстанса</label>
                <input id="instance-id" value={instanceId} onChange={(event) => setInstanceId(event.target.value)} placeholder="Например, 7105000000" inputMode="numeric" autoComplete="off" required disabled={connected} />
                <label htmlFor="api-token">Токен API</label>
                <input id="api-token" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Вставь apiTokenInstance" type="password" autoComplete="new-password" required disabled={connected} />
                <button className="connect-button" disabled={!instanceId.trim() || !token.trim() || connectionState === 'checking'}>{connectionState === 'checking' ? 'Проверяем подключение…' : 'Подключиться'}</button>
              </form>
              <div className="privacy-note"><Icon name="lock" /><span>Токен используется только на этом сервере и удаляется при отключении или остановке приложения.</span></div>
              {error && <p className="inline-error" role="alert">{error}</p>}
            </div>
          </div>
        )}
        {activePhone && error && <div className="toast-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Закрыть">×</button></div>}
      </section>
    </main>
  )
}

export default App
