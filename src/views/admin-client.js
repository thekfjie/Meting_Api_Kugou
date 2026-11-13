/* global document, localStorage, sessionStorage, location, FormData, HTMLDialogElement */
(() => {
  const toast = (message, error = false) => {
    const element = document.getElementById('toast')
    if (!element) return
    element.textContent = message
    element.classList.toggle('error', error)
    element.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => { element.hidden = true }, 6000)
  }
  const reload = (message, error = false) => {
    try { sessionStorage.setItem('meting-toast', JSON.stringify({ message, error })) } catch {}
    location.reload()
  }
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-open]')
    if (open) {
      const dialog = document.getElementById(open.dataset.open)
      if (dialog instanceof HTMLDialogElement) {
        document.querySelectorAll('dialog[open]').forEach(other => other.close())
        dialog.showModal()
      }
    }
    if (event.target.closest('[data-close]')) event.target.closest('dialog')?.close()
    if (event.target.closest('[data-theme-toggle]')) {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = theme
      try { localStorage.setItem('theme', theme) } catch {}
    }
    const tab = event.target.closest('[data-tab]')
    if (tab) {
      const dialog = tab.closest('dialog')
      dialog.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button === tab)))
      dialog.querySelectorAll('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== tab.dataset.tab })
    }
    const nav = event.target.closest('.nav-link')
    if (nav) {
      document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link === nav))
    }
  })
  document.addEventListener('submit', async event => {
    const form = event.target
    if (!form.matches('[data-enhance]')) return
    event.preventDefault()
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return
    const button = event.submitter || form.querySelector('button[type=submit]')
    const label = button?.textContent
    if (button) { button.disabled = true; button.textContent = '处理中…' }
    try {
      const url = new URL(form.action)
      url.searchParams.set('format', 'json')
      const response = await fetch(url, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(45000) })
      if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) {
        location.assign(response.url)
        return
      }
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || '操作失败，请稍后重试')
      const dialog = form.closest('[data-login-dialog]')
      if (url.pathname.endsWith('/qr/start')) {
        if (!payload.ok || !payload.login?.base64) throw new Error(payload.message || '二维码生成失败')
        const image = document.createElement('img')
        image.src = payload.login.base64
        image.alt = '酷狗登录二维码'
        const status = document.createElement('p')
        status.dataset.qrStatus = ''
        status.textContent = '请使用对应版本的酷狗 App 扫码'
        dialog.querySelector('[data-qr-stage]').replaceChildren(image, status)
        dialog.querySelector('[data-qr-followup]').hidden = false
        dialog.querySelector('[data-qr-save]').hidden = true
        return
      }
      if (url.pathname.endsWith('/qr/check')) {
        const status = Number(payload.status)
        const labels = { 0: '二维码已过期，请重新生成', 1: '等待扫码', 2: '已扫码，请在 App 中确认', 4: '授权成功，请选择保存方式' }
        const line = dialog.querySelector('[data-qr-status]')
        if (line) line.textContent = labels[status] || '状态暂不可用，请重试'
        dialog.querySelector('[data-qr-save]').hidden = status !== 4
        return
      }
      if (url.pathname.endsWith('/captcha/send')) {
        if (payload.ok === false || Number(payload.body?.status) === 0) throw new Error(payload.message || payload.body?.msg || '验证码发送失败')
        toast('验证码已发送，请在当前版本下输入验证码')
        return
      }
      const failed = payload.ok === false
      if (failed && dialog) throw new Error(payload.message || '登录失败，请检查后重试')
      reload(payload.message || (failed ? '操作未成功，请查看状态详情' : '操作已完成'), failed)
    } catch (error) {
      toast(error.name === 'TimeoutError' ? '请求超时，请先查看结果再重试' : error.message || '无法连接服务，请稍后重试', true)
    } finally {
      if (button) { button.disabled = false; button.textContent = label }
    }
  })
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect()
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close()
    })
  })
  try {
    const previous = JSON.parse(sessionStorage.getItem('meting-toast') || 'null')
    if (previous) { toast(previous.message, previous.error); sessionStorage.removeItem('meting-toast') }
  } catch {}
})()
