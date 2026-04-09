import {
  buildKugouUpstreamAuthCookie,
  mergeKugouSetCookies,
  requestKugouUpstream
} from './kugou-upstream-auth.js'
import { buildKugouUpstreamRuntimeHeaders } from './kugou-upstream-runtime.js'

const normalizeText = (value) => String(value || '').trim()

const extractMessage = (body) => {
  return normalizeText(
    body?.msg ||
    body?.message ||
    body?.error ||
    body?.err_msg ||
    body?.error_msg ||
    body?.statusText
  )
}

const isSuccessBody = (body) => {
  if (!body || typeof body !== 'object') return false

  if (body.status !== undefined && body.status !== null && body.status !== '') {
    return Number(body.status) === 1
  }

  if (body.errcode !== undefined && body.errcode !== null && body.errcode !== '') {
    return Number(body.errcode) === 0
  }

  if (body.error_code !== undefined && body.error_code !== null && body.error_code !== '') {
    return Number(body.error_code) === 0
  }

  return Boolean(body.data)
}

const buildResult = (response) => {
  const body = response?.body || null

  return {
    ok: Boolean(response?.ok) && isSuccessBody(body),
    body,
    message: extractMessage(body),
    cookieMap: mergeKugouSetCookies(response?.cookies || [])
  }
}

export const performKugouLiteVipListen = async (cookie, pool = 'general') => {
  const headers = await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
  const response = await requestKugouUpstream('/youth/listen/song', {
    query: {
      timestamp: Date.now()
    },
    cookie: buildKugouUpstreamAuthCookie({ cookie }),
    headers
  })

  return buildResult(response)
}

export const performKugouLiteVipClaim = async (cookie, pool = 'general') => {
  const headers = await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
  const response = await requestKugouUpstream('/youth/vip', {
    query: {
      timestamp: Date.now()
    },
    cookie: buildKugouUpstreamAuthCookie({ cookie }),
    headers
  })

  return buildResult(response)
}

export const fetchKugouVipDetail = async (cookie, pool = 'general') => {
  const headers = await buildKugouUpstreamRuntimeHeaders(pool, { cookie })
  const response = await requestKugouUpstream('/user/vip/detail', {
    query: {
      timestamp: Date.now()
    },
    cookie: buildKugouUpstreamAuthCookie({ cookie }),
    headers
  })

  return buildResult(response)
}
